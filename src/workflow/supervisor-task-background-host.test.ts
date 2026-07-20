import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { SupervisorTaskBackgroundHost } from "./supervisor-task-background-host.js";
import { TaskOperatorService } from "./task-operator-service.js";
import { TaskResultService } from "./task-result-service.js";

describe("SupervisorTaskBackgroundHost Task ownership", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not create an executor or dispatch a Task with an active foreground lease", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-supervisor-task-owner-"));
    tempDirs.push(tempDir);
    const sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    const task = new TaskOperatorService({ store }).begin({
      objective: "Execute only after foreground ownership is released.",
      workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
      creatorSessionId: "creator-alpha"
    });
    const acquiredAt = new Date();
    const foregroundLease = store.acquireTaskHostLease({
      taskId: task.taskId,
      workspaceIdentityHash: "workspace-hash",
      ownerId: "foreground-owner",
      kind: "foreground",
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + 60_000).toISOString()
    })!;
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      results: [{ kind: "text" as const, content: "background result" }]
    }));
    const executor = {
      kind: "agent" as const,
      canExecute: () => true,
      execute
    } as unknown as AgentStepExecutor;
    const dispose = vi.fn(async () => undefined);
    const createExecutorRuntime = vi.fn(async () => ({ taskAgentExecutor: executor, dispose }));
    const host = new SupervisorTaskBackgroundHost({
      store,
      resultService: new TaskResultService({
        store,
        profileId: "alpha",
        contentRoot: join(tempDir, "results"),
        sessionDb
      }),
      router: { deliverText: async () => new Map() },
      ownerId: "background-owner",
      workspaceIdentityHash: "workspace-hash",
      createExecutorRuntime
    });

    await expect(host.runOnce()).resolves.toMatchObject({
      skipped: false,
      scheduler: { dispatched: 0 }
    });
    expect(createExecutorRuntime).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(store.listAttempts(task.taskId)).toHaveLength(0);

    const eligible = new TaskOperatorService({ store }).begin({
      objective: "Run while the earlier Task remains foreground-owned.",
      workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
      creatorSessionId: "creator-alpha"
    });
    await expect(host.runOnce()).resolves.toMatchObject({
      skipped: false,
      scheduler: { dispatched: 1, completed: 1 }
    });
    expect(store.getTask(eligible.taskId)?.status).toBe("completed");
    expect(store.listAttempts(task.taskId)).toHaveLength(0);

    expect(store.releaseTaskHostLease({
      taskId: foregroundLease.taskId,
      workspaceIdentityHash: foregroundLease.workspaceIdentityHash,
      ownerId: foregroundLease.ownerId,
      kind: foregroundLease.kind,
      fencingToken: foregroundLease.fencingToken
    })).toBe(true);
    await expect(host.runOnce()).resolves.toMatchObject({
      skipped: false,
      scheduler: { dispatched: 1, completed: 1 }
    });
    expect(createExecutorRuntime).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.getTask(task.taskId)?.status).toBe("completed");

    await host.dispose();
    sessionDb.close();
  });

  it("acquires and fences background ownership while an Attempt is running", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-supervisor-task-background-lease-"));
    tempDirs.push(tempDir);
    const sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    const task = new TaskOperatorService({ store }).begin({
      objective: "Keep the background lease alive while running.",
      workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
      creatorSessionId: "creator-alpha"
    });
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return {
        outcome: "succeeded" as const,
        results: [{ kind: "text" as const, content: "background result" }]
      };
    });
    const executor = {
      kind: "agent" as const,
      canExecute: () => true,
      execute
    } as unknown as AgentStepExecutor;
    const host = new SupervisorTaskBackgroundHost({
      store,
      resultService: new TaskResultService({
        store,
        profileId: "alpha",
        contentRoot: join(tempDir, "results"),
        sessionDb
      }),
      router: { deliverText: async () => new Map() },
      ownerId: "background-owner",
      workspaceIdentityHash: "workspace-hash",
      createExecutorRuntime: async () => ({ taskAgentExecutor: executor, dispose: async () => undefined })
    });

    const run = host.runOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(store.getTaskHostLease(task.taskId)).toMatchObject({
      ownerId: "background-owner",
      kind: "background",
      workspaceIdentityHash: "workspace-hash"
    });
    expect(store.acquireTaskHostLease({
      taskId: task.taskId,
      workspaceIdentityHash: "workspace-hash",
      ownerId: "competing-foreground",
      kind: "foreground",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).toBeNull();

    finish!();
    await expect(run).resolves.toMatchObject({ scheduler: { dispatched: 1, completed: 1 } });
    expect(store.getTaskHostLease(task.taskId)).toBeNull();
    await host.dispose();
    sessionDb.close();
  });

  it("takes over an expired foreground host generation after an ungraceful exit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-supervisor-task-expired-foreground-"));
    tempDirs.push(tempDir);
    const now = () => new Date("2030-01-01T00:02:00.000Z");
    const sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite"), now });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    const task = new TaskOperatorService({ store, now }).begin({
      objective: "Recover after the foreground process disappears.",
      workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
      creatorSessionId: "creator-alpha"
    });
    store.acquireTaskHostLease({
      taskId: task.taskId,
      workspaceIdentityHash: "workspace-hash",
      ownerId: "crashed-foreground",
      kind: "foreground",
      acquiredAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:01:00.000Z"
    });
    const executor = {
      kind: "agent" as const,
      canExecute: () => true,
      execute: async () => ({
        outcome: "succeeded" as const,
        results: [{ kind: "text" as const, content: "recovered" }]
      })
    } as unknown as AgentStepExecutor;
    const host = new SupervisorTaskBackgroundHost({
      store,
      resultService: new TaskResultService({
        store,
        profileId: "alpha",
        contentRoot: join(tempDir, "results"),
        sessionDb,
        now
      }),
      router: { deliverText: async () => new Map() },
      ownerId: "recovery-background",
      workspaceIdentityHash: "workspace-hash",
      createExecutorRuntime: async () => ({ taskAgentExecutor: executor, dispose: async () => undefined }),
      leaseMs: 60_000,
      heartbeatIntervalMs: 30_000,
      now
    });

    await expect(host.runOnce()).resolves.toMatchObject({ scheduler: { dispatched: 1, completed: 1 } });
    expect(store.getTask(task.taskId)?.status).toBe("completed");
    expect(store.getTaskHostLease(task.taskId)).toBeNull();
    await host.dispose();
    sessionDb.close();
  });
});
