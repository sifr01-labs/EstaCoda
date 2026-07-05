import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "../security/workspace-approval-controller.js";
import { GatewayApprovalQueue, createCommandHash, createCommandPreview, type PendingApproval } from "./approval-queue.js";

async function setup(options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-approval-queue-"));
  const sessionDb = await createSQLiteSessionDB({ path: join(directory, "sessions.sqlite") });
  let nextId = 0;
  const queue = new GatewayApprovalQueue({
    db: sessionDb.db,
    controller: new WorkspaceApprovalController({
      store: new WorkspaceApprovalStore({ path: join(directory, "workspace-approvals.json") })
    }),
    idFactory: () => `approval-${++nextId}`,
    pollIntervalMs: 1,
    now: options.now
  });

  return { directory, sessionDb, queue };
}

function approval(overrides: Partial<Omit<PendingApproval, "id" | "status">> = {}): Omit<PendingApproval, "id" | "status"> {
  const command = overrides.commandPayload ?? "rm -rf ./build";
  return {
    sessionId: "session-a",
    profileId: "profile-a",
    commandPreview: createCommandPreview(command),
    commandHash: createCommandHash(command),
    commandPayload: command,
    toolName: "terminal.run",
    requestedAt: new Date("2026-05-18T10:00:00.000Z"),
    expiresAt: new Date("2099-05-18T10:05:00.000Z"),
    channel: "telegram",
    chatId: "chat-a",
    ...overrides
  };
}

function insertPending(
  db: Awaited<ReturnType<typeof setup>>["sessionDb"]["db"],
  row: Partial<Omit<PendingApproval, "requestedAt" | "expiresAt">> & {
    id: string;
    requestedAt?: Date;
    expiresAt?: Date;
  }
): void {
  const payload = row.commandPayload ?? "rm -rf ./build";
  db.query(
    `insert into pending_approvals (
      id,
      session_id,
      profile_id,
      command_preview,
      command_hash,
      command_payload,
      tool_name,
      requested_at,
      expires_at,
      status,
      resolved_at,
      resolved_by,
      channel,
      chat_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?)`
  ).run(
    row.id,
    row.sessionId ?? "session-a",
    row.profileId ?? "profile-a",
    row.commandPreview ?? createCommandPreview(payload),
    row.commandHash ?? createCommandHash(payload),
    payload,
    row.toolName ?? "terminal.run",
    (row.requestedAt ?? new Date("2026-05-18T10:00:00.000Z")).toISOString(),
    (row.expiresAt ?? new Date("2099-05-18T10:05:00.000Z")).toISOString(),
    row.channel ?? "telegram",
    row.chatId ?? "chat-a"
  );
}

async function waitForPending(queue: GatewayApprovalQueue, profileId = "profile-a"): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pending = await queue.listPending({ profileId });
    if (pending[0] !== undefined) {
      return pending[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for pending approval");
}

describe("GatewayApprovalQueue", () => {
  it("inserts a pending approval with a concrete profileId", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const pendingResult = queue.requestApproval(approval());
      const pending = await waitForPending(queue);

      expect(pending.profileId).toBe("profile-a");
      expect(pending.commandPayload).toBeUndefined();

      await queue.resolveApproval(pending.id, "denied", "tester", { profileId: "profile-a" });
      await expect(pendingResult).resolves.toMatchObject({ status: "denied" });
    } finally {
      sessionDb.close();
    }
  });

  it("rejects missing profileId before insert", async () => {
    const { sessionDb, queue } = await setup();
    try {
      await expect(queue.requestApproval(approval({ profileId: "" }))).rejects.toThrow(/profileId is required/);
      expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
    } finally {
      sessionDb.close();
    }
  });

  it("lists pending approvals by profile and isolates other profiles", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-a", profileId: "profile-a" });
      insertPending(sessionDb.db, { id: "approval-b", profileId: "profile-b" });

      expect((await queue.listPending({ profileId: "profile-a" })).map((item) => item.id)).toEqual(["approval-a"]);
      expect((await queue.listPending({ profileId: "profile-c" })).map((item) => item.id)).toEqual([]);
    } finally {
      sessionDb.close();
    }
  });

  it("does not allow one profile to resolve another profile's approval", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-b", profileId: "profile-b" });

      await expect(
        queue.resolveApproval("approval-b", "approved", "tester", { profileId: "profile-a" })
      ).rejects.toThrow(/not found/);

      expect((await queue.listPending({ profileId: "profile-b" })).map((item) => item.id)).toEqual(["approval-b"]);
    } finally {
      sessionDb.close();
    }
  });

  it("does not allow session-scoped resolution from another session", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-a", sessionId: "session-a" });

      await expect(
        queue.resolveApproval("approval-a", "approved", "tester", {
          profileId: "profile-a",
          sessionId: "session-b"
        })
      ).rejects.toThrow(/not found/);
    } finally {
      sessionDb.close();
    }
  });

  it("approves a pending request and redacts its payload", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const pendingResult = queue.requestApproval(approval({ commandPayload: "rm -rf ./build TOKEN=secret" }));
      const pending = await waitForPending(queue);

      await queue.resolveApproval(pending.id, "approved", "tester", { profileId: "profile-a" });

      await expect(pendingResult).resolves.toMatchObject({ status: "approved" });
      expect(sessionDb.db.query<{ command_payload: string | null }>(
        "select command_payload from pending_approvals where id = ?"
      ).get(pending.id)?.command_payload).toBeNull();
    } finally {
      sessionDb.close();
    }
  });

  it("denies a pending request", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const pendingResult = queue.requestApproval(approval());
      const pending = await waitForPending(queue);

      await queue.resolveApproval(pending.id, "denied", "tester", { profileId: "profile-a" });

      await expect(pendingResult).resolves.toMatchObject({ status: "denied" });
    } finally {
      sessionDb.close();
    }
  });

  it("does not approve expired approvals later", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, {
        id: "approval-expired",
        expiresAt: new Date("2000-01-01T00:00:00.000Z")
      });

      await expect(
        queue.resolveApproval("approval-expired", "approved", "tester", { profileId: "profile-a" })
      ).rejects.toThrow(/expired|already expired/);
    } finally {
      sessionDb.close();
    }
  });

  it("does not resolve already resolved approvals twice", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-a" });

      await queue.resolveApproval("approval-a", "approved", "tester", { profileId: "profile-a" });
      await expect(
        queue.resolveApproval("approval-a", "denied", "tester", { profileId: "profile-a" })
      ).rejects.toThrow(/already approved/);
    } finally {
      sessionDb.close();
    }
  });

  it("duplicate approve only lets the first resolver win", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-a" });

      await queue.resolveApproval("approval-a", "approved", "tester-a", { profileId: "profile-a" });
      await expect(
        queue.resolveApproval("approval-a", "approved", "tester-b", { profileId: "profile-a" })
      ).rejects.toThrow(/already approved/);
    } finally {
      sessionDb.close();
    }
  });

  it("deny racing approve only lets one decision win", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, { id: "approval-a" });

      await queue.resolveApproval("approval-a", "denied", "tester-a", { profileId: "profile-a" });
      await expect(
        queue.resolveApproval("approval-a", "approved", "tester-b", { profileId: "profile-a" })
      ).rejects.toThrow(/already denied/);
    } finally {
      sessionDb.close();
    }
  });

  it("approve racing expiry reports expiry and redacts payload when expiry wins", async () => {
    let now = new Date("2026-05-18T10:00:00.000Z");
    const { sessionDb, queue } = await setup({ now: () => now });
    try {
      insertPending(sessionDb.db, {
        id: "approval-a",
        commandPayload: "sudo apt update SECRET=abc",
        expiresAt: new Date("2026-05-18T10:01:00.000Z")
      });
      now = new Date("2026-05-18T10:02:00.000Z");

      await expect(
        queue.resolveApproval("approval-a", "approved", "tester", { profileId: "profile-a" })
      ).rejects.toThrow(/expired/);

      const row = sessionDb.db.query<{ status: string; command_payload: string | null }>(
        "select status, command_payload from pending_approvals where id = ?"
      ).get("approval-a");
      expect(row).toMatchObject({ status: "expired", command_payload: null });
    } finally {
      sessionDb.close();
    }
  });

  it("expires stale approvals and redacts payloads", async () => {
    const { sessionDb, queue } = await setup();
    try {
      insertPending(sessionDb.db, {
        id: "approval-expired",
        commandPayload: "sudo apt update TOKEN=secret",
        expiresAt: new Date("2000-01-01T00:00:00.000Z")
      });

      await expect(queue.expireStaleApprovals()).resolves.toBe(1);
      const row = sessionDb.db.query<{ status: string; command_payload: string | null }>(
        "select status, command_payload from pending_approvals where id = ?"
      ).get("approval-expired");
      expect(row).toMatchObject({ status: "expired", command_payload: null });
    } finally {
      sessionDb.close();
    }
  });

  it("allows multiple pending approvals to resolve independently", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const first = queue.requestApproval(approval({ sessionId: "session-a" }));
      const second = queue.requestApproval(approval({ sessionId: "session-b", chatId: "chat-b" }));

      for (const pending of await queue.listPending({ profileId: "profile-a" })) {
        await queue.resolveApproval(pending.id, "approved", "tester", {
          profileId: "profile-a",
          sessionId: pending.sessionId
        });
      }

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: "approved" }),
        expect.objectContaining({ status: "approved" })
      ]);
    } finally {
      sessionDb.close();
    }
  });

  it("uses preview and hash for list output without exposing raw payload", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const payload = "sudo apt update SECRET_TOKEN=abc123";
      insertPending(sessionDb.db, {
        id: "approval-a",
        commandPayload: payload,
        commandPreview: "sudo apt update SECRET_...",
        commandHash: createCommandHash(payload)
      });

      const [pending] = await queue.listPending({ profileId: "profile-a" });

      expect(pending).toMatchObject({
        id: "approval-a",
        commandPreview: "sudo apt update SECRET_...",
        commandHash: createCommandHash(payload),
        commandPayload: undefined
      });
    } finally {
      sessionDb.close();
    }
  });

  it("exposes setup request payload without command payload and redacts it after resolution", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const pending = await queue.createPendingApproval(approval({
        toolName: "python-env.setup",
        commandPreview: "Install managed Python capability pdf-extraction",
        commandHash: createCommandHash("Install managed Python capability pdf-extraction"),
        commandPayload: undefined,
        approvalKind: "managed_python_capability_install",
        requestPayload: {
          capabilityId: "pdf-extraction",
          groups: [],
          packages: ["pymupdf==1.27.2.3"],
          originalMessage: {
            id: "msg-1",
            channel: "telegram",
            sessionKey: { platform: "telegram", chatId: "chat-a", userId: "user-1" },
            sender: { id: "user-1", displayName: "Test User" },
            text: "extract this pdf",
            receivedAt: "2026-05-18T10:00:00.000Z"
          }
        }
      }));

      const withRequestPayload = await queue.getApprovalRequest(pending.id, {
        profileId: "profile-a",
        sessionId: "session-a"
      });

      expect(withRequestPayload?.commandPayload).toBeUndefined();
      expect(withRequestPayload?.requestPayload?.capabilityId).toBe("pdf-extraction");
      expect(withRequestPayload?.requestPayload?.originalMessage?.text).toBe("extract this pdf");

      await queue.resolveApproval(pending.id, "approved", "tester", {
        profileId: "profile-a",
        sessionId: "session-a"
      });
      const resolved = await queue.getApprovalRequest(pending.id, {
        profileId: "profile-a",
        sessionId: "session-a"
      });

      expect(resolved?.status).toBe("approved");
      expect(resolved?.requestPayload).toBeUndefined();
    } finally {
      sessionDb.close();
    }
  });

  it("does not queue hardline commands for later approval", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const result = await queue.requestApproval(approval({
        commandPreview: "rm -rf /",
        commandPayload: "rm -rf /",
        commandHash: createCommandHash("rm -rf /")
      }));

      expect(result.status).toBe("denied");
      expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
    } finally {
      sessionDb.close();
    }
  });

  it("rejects high-severity hardBlock commands without inserting a durable row", async () => {
    const { sessionDb, queue } = await setup();
    try {
      const result = await queue.requestApproval(approval({
        commandPreview: "sudo apt update",
        commandPayload: "sudo apt update",
        commandHash: createCommandHash("sudo apt update")
      }));

      expect(result).toMatchObject({
        status: "denied",
        approval: {
          commandPayload: undefined,
          resolvedBy: "security-policy"
        }
      });
      expect(await queue.listPending({ profileId: "profile-a" })).toEqual([]);
      expect(sessionDb.db.query<{ count: number }>("select count(*) as count from pending_approvals").get()?.count).toBe(0);
    } finally {
      sessionDb.close();
    }
  });
});
