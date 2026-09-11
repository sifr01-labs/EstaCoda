import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ensureRuntimeSession } from "../session/session-workspace-ownership.js";
import { ControlReceipts, createControlOperationId } from "./control-receipts.js";
import { validateControlRequest, type ControlContext, type MethodRequest } from "../../apps/desktop/src/control-protocol.js";

it("accepts core-generated Desktop operation IDs and reconciles retries beyond the fresh acceptance window", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-receipts-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  const clock = vi.spyOn(Date, "now");
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const target = (await db.getSession("session"))!.executionTarget!;
    const context: ControlContext = { profileId: "default", instanceId: "bridge", capabilities: { methods: ["sessions.send", "operations.inspect"], events: [] } };
    const operationId = createControlOperationId();
    const request: MethodRequest<"sessions.send"> = { jsonrpc: "2.0", id: "r", method: "sessions.send", params: {
      operationId, sessionId: "session", target: { targetId: target.targetId, targetGeneration: target.targetGeneration }, text: "hello",
    } };
    expect(validateControlRequest(request, context)).toEqual(request);
    const coreRequest = { method: "send" as const, sessionId: "session", targetId: target.targetId, operationId, text: "hello" };
    const receipts = new ControlReceipts(db.db, "default", "host");
    expect(receipts.accept(coreRequest).inserted).toBe(true);
    clock.mockReturnValue(Date.now() + 6 * 60_000);
    expect(validateControlRequest(request, context)).toEqual(request);
    expect(receipts.accept(coreRequest).inserted).toBe(false);
    expect(() => receipts.accept({ ...coreRequest, text: "changed" })).toThrow("different input");
    const inspect: MethodRequest<"operations.inspect"> = { jsonrpc: "2.0", id: "inspect", method: "operations.inspect", params: {
      operationId, sessionId: "session", target: request.params.target, method: "sessions.send",
    } };
    expect(validateControlRequest(inspect, context)).toEqual(inspect);
    expect(receipts.inspect({ ...coreRequest, method: "inspect" })).toMatchObject([{ operationId, status: "accepted" }]);
    const expiredId = operationId + ":unseen";
    expect(validateControlRequest({ ...request, params: { ...request.params, operationId: expiredId } }, context)).toBeDefined();
    expect(() => receipts.accept({ ...coreRequest, operationId: expiredId })).toThrow("expired");
  } finally { clock.mockRestore(); db.close(); await rm(root, { recursive: true, force: true }); }
});

it("deduplicates exact inputs, rejects conflicting retries and preserves uncertainty across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-receipts-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const request = { method: "send" as const, sessionId: "session", targetId: (await db.getSession("session"))!.executionTarget!.targetId, operationId: createControlOperationId(), text: "hello" };
    const receipts = new ControlReceipts(db.db, "default", "first");
    expect(receipts.accept(request).inserted).toBe(true);
    expect(receipts.accept(request).inserted).toBe(false);
    expect(() => receipts.accept({ ...request, text: "different" })).toThrow("different input");
    receipts.transition(request, "dispatched");
    const restarted = new ControlReceipts(db.db, "default", "second");
    restarted.recover();
    expect(restarted.accept(request)).toMatchObject({ inserted: false, receipt: { status: "uncertain" } });
    expect(() => receipts.transition(request, "completed")).toThrow("fenced");
    expect(new ControlReceipts(db.db, "other", "second").inspect(request)).toEqual([]);
    expect(() => restarted.accept({ ...request, operationId: "1:expired" })).toThrow("expired");
    expect(db.db.query<{ event_json: string }>("select event_json from session_events where event_json like '%private-control-input%'").all()).toHaveLength(1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it("returns a durable acceptance before completion and never redispatches a lost-response retry", async () => {
  const { SharedSessionHost } = await import("./shared-session-host.js");
  const root = await mkdtemp(join(tmpdir(), "control-acceptance-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  let finish!: () => void, calls = 0;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const request = { method: "send" as const, sessionId: "session", targetId: (await db.getSession("session"))!.executionTarget!.targetId, operationId: createControlOperationId(), text: "work" };
    const receipts = new ControlReceipts(db.db, "default", "host");
    const host = new SharedSessionHost({ profileId: "default", sessionDb: db, receipts,
      channelApproval: async () => undefined, acquire: async () => ({ sessionId: "session", dispose: async () => undefined,
        handle: async () => { calls++; await completed; return { text: "done" }; } }) as unknown as import("../runtime/create-runtime.js").Runtime });
    await expect(host.handle(request)).resolves.toMatchObject({ status: "accepted" });
    await expect(host.handle(request)).resolves.toMatchObject({ status: "dispatched" });
    finish();
    while (host.hasPendingWork()) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(host.handle(request)).resolves.toMatchObject({ status: "completed" });
    expect(calls).toBe(1);
    await host.close();
  } finally { finish(); db.close(); await rm(root, { recursive: true, force: true }); }
});

it("records control revisions once and rejects another live process before acceptance", async () => {
  const { SessionExecutionOwnership } = await import("../session/execution-ownership.js");
  const root = await mkdtemp(join(tmpdir(), "control-owner-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
    const targetId = (await db.getSession("session"))!.executionTarget!.targetId;
    const store = new SessionExecutionOwnership(db.db);
    const claim = store.claim({ sessionId: "session", profileId: "default", targetId });
    const receipts = new ControlReceipts(db.db, "default", "host");
    const request = { method: "cancel" as const, sessionId: "session", targetId, operationId: createControlOperationId() };
    receipts.accept(request); receipts.accept(request);
    expect(db.db.query<{ control_revision: number }>("select control_revision from session_execution_owners").get()!.control_revision).toBe(1);
    db.db.query("update session_execution_owners set owner_pid=?").run(process.ppid);
    expect(() => receipts.accept({ ...request, operationId: createControlOperationId() })).toThrow("another process");
    db.db.query("update session_execution_owners set owner_pid=?").run(process.pid);
    store.release(claim);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
