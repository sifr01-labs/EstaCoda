import { describe, expect, it } from "vitest";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import { listResumableSessions, resolveSessionForResume } from "./session-resume.js";

describe("session resume boundary", () => {
  it("lists only active user-facing sessions in the selected profile and workspace", async () => {
    const db = new InMemorySessionDB();
    await seed(db, "eligible", { profileId: "default", workspaceRoot: "/workspace" });
    await seed(db, "other-profile", { profileId: "work", workspaceRoot: "/workspace" });
    await seed(db, "other-workspace", { profileId: "default", workspaceRoot: "/other" });
    await seed(db, "internal", { profileId: "default", workspaceRoot: "/workspace", kind: "task-step-worker" });
    await seed(db, "child", { profileId: "default", workspaceRoot: "/workspace", parentSessionId: "eligible" });
    await seed(db, "ended", { profileId: "default", workspaceRoot: "/workspace" });
    await db.endSession("ended", "done");

    const sessions = await listResumableSessions({
      sessionDb: db,
      profileId: "default",
      workspaceRoot: "/workspace",
      limit: 20,
    });
    expect(sessions.map((session) => session.id)).toEqual(["eligible"]);
  });

  it("rejects cross-profile, cross-workspace, ended, child, and internal direct resumes", async () => {
    const db = new InMemorySessionDB();
    await seed(db, "eligible", { profileId: "default", workspaceRoot: "/workspace" });
    await seed(db, "other-profile", { profileId: "work", workspaceRoot: "/workspace" });
    await seed(db, "other-workspace", { profileId: "default", workspaceRoot: "/other" });
    await seed(db, "internal", { profileId: "default", workspaceRoot: "/workspace", kind: "task-step-worker" });
    await seed(db, "child", { profileId: "default", workspaceRoot: "/workspace", parentSessionId: "eligible" });
    await seed(db, "ended", { profileId: "default", workspaceRoot: "/workspace" });
    await db.endSession("ended", "done");

    await expect(resolveSessionForResume({
      sessionDb: db, profileId: "default", workspaceRoot: "/workspace", sessionId: "eligible",
    })).resolves.toEqual({ ok: true, sessionId: "eligible" });
    for (const sessionId of ["other-profile", "other-workspace", "internal", "child", "ended", "missing"]) {
      await expect(resolveSessionForResume({
        sessionDb: db, profileId: "default", workspaceRoot: "/workspace", sessionId,
      })).resolves.toMatchObject({ ok: false });
    }
  });

  it("rejects an explicitly continued empty session and keeps it out of the picker", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "empty", profileId: "default", metadata: { workspaceRoot: "/workspace" } });

    await expect(resolveSessionForResume({
      sessionDb: db, profileId: "default", workspaceRoot: "/workspace", sessionId: "empty",
    })).resolves.toEqual({ ok: false, reason: "not-resumable" });
    await expect(listResumableSessions({
      sessionDb: db, profileId: "default", workspaceRoot: "/workspace", limit: 20,
    })).resolves.toEqual([]);
  });
});

async function seed(
  db: InMemorySessionDB,
  id: string,
  input: { profileId: string; workspaceRoot: string; kind?: string; parentSessionId?: string }
): Promise<void> {
  await db.createSession({
    id,
    profileId: input.profileId,
    parentSessionId: input.parentSessionId,
    metadata: { workspaceRoot: input.workspaceRoot, ...(input.kind === undefined ? {} : { kind: input.kind }) },
  });
  await db.appendMessage({ sessionId: id, role: "user", content: id, channel: "cli" });
}
