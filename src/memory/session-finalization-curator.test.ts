import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { SessionFinalizationQueue } from "../session/session-finalization-queue.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import {
  curateSessionFinalizationJob,
  resolveSessionFinalizationWorkspaceRoot,
} from "./session-finalization-curator.js";

describe("curateSessionFinalizationJob", () => {
  let tempDir: string;
  let db: SQLiteSessionDB;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-finalization-curator-"));
    db = await createSQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses an absolute session workspace and rejects malformed workspace metadata", () => {
    expect(resolveSessionFinalizationWorkspaceRoot({ workspaceRoot: "/workspace/session" }, "/workspace/gateway"))
      .toBe("/workspace/session");
    expect(resolveSessionFinalizationWorkspaceRoot({ workspaceRoot: "../outside" }, "/workspace/gateway"))
      .toBe("/workspace/gateway");
    expect(resolveSessionFinalizationWorkspaceRoot({ workspaceRoot: " /workspace/session" }, "/workspace/gateway"))
      .toBe("/workspace/gateway");
  });

  it("runs the governed checkpoint with profile-local config and the queued cutoff", async () => {
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({ id: "message-1", sessionId: "session-1", role: "user", content: "One-off request" });
    const queue = new SessionFinalizationQueue({ db: db.db, id: () => "job-1" });
    const job = queue.enqueue({ profileId: "default", sessionId: "session-1", reason: "cli-exit" });
    const config = await loadRuntimeConfig({
      homeDir: tempDir,
      profileId: "default",
      workspaceRoot: tempDir,
    });

    const result = await curateSessionFinalizationJob({
      job,
      config,
      sessionDb: db,
      homeDir: tempDir,
      workspaceRoot: tempDir,
      profileId: "default",
    });

    expect(result).toMatchObject({
      status: "skipped",
      trigger: "runtime-dispose",
      sessionId: "session-1",
      sourceMessageCount: 1,
    });
  });

  it("rejects a job outside the active profile before loading memory", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    const queue = new SessionFinalizationQueue({ db: db.db, id: () => "job-1" });
    const job = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const config = await loadRuntimeConfig({
      homeDir: tempDir,
      profileId: "profile-b",
      workspaceRoot: tempDir,
    });

    await expect(curateSessionFinalizationJob({
      job,
      config,
      sessionDb: db,
      homeDir: tempDir,
      workspaceRoot: tempDir,
      profileId: "profile-b",
    })).rejects.toThrow("does not belong to the active profile");
  });

  it("skips disabled runtime-dispose curation without initializing provider work", async () => {
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({ id: "message-1", sessionId: "session-1", role: "user", content: "request" });
    const job = new SessionFinalizationQueue({ db: db.db, id: () => "job-1" }).enqueue({
      profileId: "default",
      sessionId: "session-1",
      reason: "cli-exit",
    });
    const config = await loadRuntimeConfig({
      homeDir: tempDir,
      profileId: "default",
      workspaceRoot: tempDir,
    });
    config.memory.curation.auditOnRuntimeDispose = false;

    await expect(curateSessionFinalizationJob({
      job,
      config,
      sessionDb: db,
      homeDir: tempDir,
      workspaceRoot: tempDir,
      profileId: "default",
    })).resolves.toMatchObject({
      status: "skipped",
      sourceMessageCount: 1,
      reviewedMessageCount: 0,
    });
  });
});
