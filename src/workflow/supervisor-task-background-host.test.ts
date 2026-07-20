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
});
