import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskAuthorityPolicy, TaskPlanRevision, TaskStep } from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import { GatewayApprovalQueue } from "../gateway/approval-queue.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import { FakeTaskStepExecutor } from "./fake-task-step-executor.js";
import { ForegroundTaskHost } from "./foreground-task-host.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { SupervisorTaskBackgroundHost } from "./supervisor-task-background-host.js";
import { TaskApprovalService } from "./task-approval-service.js";
import { TaskResultService } from "./task-result-service.js";

const NOW = "2030-01-01T00:00:00.000Z";

describe("ForegroundTaskHost", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let resultService: TaskResultService;
  let ids: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-foreground-task-host-"));
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite"), now });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    ids = 0;
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "results"),
      sessionDb,
      now,
      id: () => nextId("result"),
      handleId: () => nextId("handle"),
      eventId: () => nextId("result-event")
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("claims a newly created Task and confirms dispatch before its Attempt settles", async () => {
    store.createTaskGraph(makeGraph("task-one", [step("task-one", "work", 0)]));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const executor = new FakeTaskStepExecutor(async () => {
      await gate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "done" }] };
    });
    const host = makeHost(executor, "foreground-one");

    const started = await host.startTask("task-one");

    expect(started).toMatchObject({ claimed: true, dispatch: { dispatched: 1, completed: 0 } });
    expect(store.getTaskHostLease("task-one")).toMatchObject({
      ownerId: "foreground-one",
      kind: "foreground",
      workspaceIdentityHash: "workspace-hash"
    });
    expect(store.listAttempts("task-one")[0]).toMatchObject({ status: "running" });

    finish!();
    await vi.waitFor(() => expect(store.getTask("task-one")?.status).toBe("completed"));
    await vi.waitFor(() => expect(store.getTaskHostLease("task-one")).toBeNull());
    await host.shutdown();
  });

  it("keeps the full executor runtime lazy until eligible work exists", async () => {
    const executor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "lazy" }]
    }));
    const dispose = vi.fn(async () => undefined);
    const createExecutorRuntime = vi.fn(async () => ({ executor, dispose }));
    const host = new ForegroundTaskHost({
      store,
      resultService,
      createExecutorRuntime,
      ownerId: "foreground-lazy",
      workspaceIdentityHash: "workspace-hash",
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });

    await host.start();
    expect(createExecutorRuntime).not.toHaveBeenCalled();

    store.createTaskGraph(makeGraph("task-lazy", [step("task-lazy", "lazy", 0)]));
    await host.startTask("task-lazy");
    await vi.waitFor(() => expect(store.getTask("task-lazy")?.status).toBe("completed"));
    expect(createExecutorRuntime).toHaveBeenCalledOnce();

    await host.shutdown();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("automatically dispatches synthesis after parallel workers finish", async () => {
    const workerA = step("task-synthesis", "worker-a", 0);
    const workerB = step("task-synthesis", "worker-b", 1);
    const synthesis = step("task-synthesis", "synthesis", 2, { dependsOn: [workerA.id, workerB.id] });
    store.createTaskGraph(makeGraph("task-synthesis", [workerA, workerB, synthesis]));
    const executor = new FakeTaskStepExecutor(({ step: current }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: current.key }]
    }));
    const host = makeHost(executor, "foreground-synthesis");

    expect(await host.startTask("task-synthesis")).toMatchObject({
      claimed: true,
      dispatch: { dispatched: 2 }
    });

    await vi.waitFor(() => expect(store.getTask("task-synthesis")?.status).toBe("completed"));
    expect(executor.executions.map(({ step: current }) => current.key)).toEqual([
      "worker-a",
      "worker-b",
      "synthesis"
    ]);
    await host.shutdown();
  });

  it("keeps the process host alive for Tasks registered across conversation turns", async () => {
    store.createTaskGraph(makeGraph("task-turn-one", [step("task-turn-one", "one", 0)]));
    const executor = new FakeTaskStepExecutor(({ task }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: task.id }]
    }));
    const host = makeHost(executor, "foreground-process");

    await host.startTask("task-turn-one");
    await vi.waitFor(() => expect(store.getTask("task-turn-one")?.status).toBe("completed"));

    store.createTaskGraph(makeGraph("task-turn-two", [step("task-turn-two", "two", 0)]));
    await host.startTask("task-turn-two");
    await vi.waitFor(() => expect(store.getTask("task-turn-two")?.status).toBe("completed"));

    expect(executor.executions.map(({ task }) => task.id)).toEqual(["task-turn-one", "task-turn-two"]);
    await host.shutdown();
  });

  it("recovers interrupted foreground work without claiming gateway-owned queued Tasks", async () => {
    const remoteGraph = makeGraph("task-remote", [step("task-remote", "remote", 0)]);
    remoteGraph.task.source = "gateway";
    store.createTaskGraph(remoteGraph);
    store.createTaskGraph(makeGraph("task-interrupted", [step("task-interrupted", "interrupted", 0)]));
    store.acquireTaskHostLease({
      taskId: "task-interrupted",
      workspaceIdentityHash: "workspace-hash",
      ownerId: "expired-foreground",
      kind: "foreground",
      acquiredAt: "2029-12-31T23:58:00.000Z",
      expiresAt: "2029-12-31T23:59:00.000Z"
    });
    const executor = new FakeTaskStepExecutor(({ task }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: task.id }]
    }));
    const host = makeHost(executor, "foreground-recovery");

    await host.start();
    await vi.waitFor(() => expect(store.getTask("task-interrupted")?.status).toBe("completed"));

    expect(store.getTask("task-remote")?.status).toBe("queued");
    expect(store.listAttempts("task-remote")).toHaveLength(0);
    expect(executor.executions.map(({ task }) => task.id)).toEqual(["task-interrupted"]);
    await host.shutdown();
  });

  it("does not dispatch a Task with an active lease owned by another host", async () => {
    store.createTaskGraph(makeGraph("task-owned", [step("task-owned", "owned", 0)]));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const firstExecutor = new FakeTaskStepExecutor(async () => {
      await gate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "first" }] };
    });
    const first = makeHost(firstExecutor, "foreground-first");
    const secondExecutor = new FakeTaskStepExecutor();
    const second = makeHost(secondExecutor, "foreground-second");
    await first.startTask("task-owned");

    expect(await second.startTask("task-owned")).toMatchObject({
      claimed: false,
      reason: "owned-by-other-host"
    });
    expect(secondExecutor.executions).toHaveLength(0);

    finish!();
    await first.shutdown();
    await second.shutdown();
  });

  it("stops admission, drains active work, and releases ownership on shutdown", async () => {
    store.createTaskGraph(makeGraph("task-drain", [step("task-drain", "drain", 0)]));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const host = makeHost(new FakeTaskStepExecutor(async () => {
      await gate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "drained" }] };
    }), "foreground-drain");
    await host.startTask("task-drain");

    let settled = false;
    const shutdown = host.shutdown().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await host.startTask("task-drain")).toMatchObject({ claimed: false, reason: "host-stopping" });

    finish!();
    await shutdown;
    expect(store.getTask("task-drain")?.status).toBe("completed");
    expect(store.getTaskHostLease("task-drain")).toBeNull();
  });

  it("hands unfinished foreground work to a fenced background host", async () => {
    store.createTaskGraph(makeGraph("task-handoff", [step("task-handoff", "handoff", 0)]));
    let finishOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
    const foregroundExecutor = new FakeTaskStepExecutor(async () => {
      await oldGate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "stale" }] };
    });
    const warnings = vi.fn();
    const foreground = new ForegroundTaskHost({
      store,
      resultService,
      executor: foregroundExecutor,
      ownerId: "foreground-handoff",
      workspaceIdentityHash: "workspace-hash",
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      handoffSettleGraceMs: 0,
      handoffAbortGraceMs: 0,
      now,
      logWarning: warnings
    });
    await foreground.startTask("task-handoff");
    const attemptId = store.listAttempts("task-handoff")[0]!.id;

    await foreground.shutdown();

    expect(store.getTask("task-handoff")?.status).toBe("waiting_for_host");
    expect(store.getTaskHostLease("task-handoff")).toBeNull();
    expect(store.getAttempt(attemptId)).toMatchObject({ status: "queued", attemptNumber: 1 });
    expect(warnings).toHaveBeenCalledOnce();

    const backgroundExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "resumed" }]
    }));
    const taskAgentExecutor = {
      kind: "agent" as const,
      canExecute: () => true,
      execute: backgroundExecutor.execute.bind(backgroundExecutor)
    } as unknown as AgentStepExecutor;
    const background = new SupervisorTaskBackgroundHost({
      store,
      resultService,
      router: { deliverText: async () => new Map() },
      ownerId: "background-handoff",
      resolveWorkspace: async (canonicalPath) => ({ canonicalPath, identityHash: "workspace-hash" }),
      isWorkspaceTrusted: () => true,
      createExecutorRuntime: async () => ({ taskAgentExecutor, dispose: async () => undefined }),
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });
    await expect(background.runOnce()).resolves.toMatchObject({
      skipped: false,
      scheduler: { dispatched: 1, completed: 1 }
    });
    expect(backgroundExecutor.executions[0]?.attempt.id).toBe(attemptId);
    expect(backgroundExecutor.executions[0]?.attempt.lease?.fencingToken).toBe(2);
    expect(store.getTask("task-handoff")?.status).toBe("completed");

    finishOld!();
    await vi.waitFor(() => expect(store.listResults("task-handoff")).toHaveLength(1));
    await background.dispose();
  });

  it("keeps a foreground approval durable and lets the background host resume the same Attempt", async () => {
    store.createTaskGraph(makeGraph("task-approval-handoff", [step("task-approval-handoff", "approval", 0)]));
    const queue = new GatewayApprovalQueue({
      db: sessionDb.db,
      controller: new WorkspaceApprovalController(),
      now
    });
    const foregroundApprovals = new TaskApprovalService({
      store,
      queue,
      now,
      id: () => nextId("task-approval")
    });
    const foregroundExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "waiting_for_approval",
      approval: {
        toolName: "file.write",
        riskClass: "workspace-write",
        targetFingerprint: `sha256:${"a".repeat(64)}`,
        targetPreview: "write the durable artifact"
      }
    }));
    const foreground = new ForegroundTaskHost({
      store,
      resultService,
      executor: foregroundExecutor,
      approvalService: foregroundApprovals,
      ownerId: "foreground-approval-handoff",
      workspaceIdentityHash: "workspace-hash",
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });

    await foreground.startTask("task-approval-handoff");
    await vi.waitFor(() => expect(store.getTask("task-approval-handoff")?.status).toBe("waiting_for_approval"));
    await foreground.runOnce();
    const attemptId = store.listAttempts("task-approval-handoff")[0]!.id;
    const link = store.listApprovalLinks({ taskId: "task-approval-handoff" })[0]!;
    expect(link).toMatchObject({
      status: "pending",
      authorizedSessionId: "creator-alpha",
      pendingApprovalId: expect.any(String)
    });
    expect(await queue.listPending({ profileId: "alpha", sessionId: "creator-alpha" })).toEqual([
      expect.objectContaining({ id: link.pendingApprovalId, sessionId: "creator-alpha" })
    ]);
    expect(store.getTaskHostLease("task-approval-handoff")).toMatchObject({
      ownerId: "foreground-approval-handoff",
      kind: "foreground"
    });

    await foreground.shutdown();
    expect(store.getTaskHostLease("task-approval-handoff")).toBeNull();
    expect(store.getTask("task-approval-handoff")?.status).toBe("waiting_for_approval");
    await queue.resolveApproval(link.pendingApprovalId!, "approved", "operator", {
      profileId: "alpha",
      sessionId: "creator-alpha"
    });

    const backgroundExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "approved after handoff" }]
    }));
    const backgroundApprovals = new TaskApprovalService({ store, queue, now });
    const taskAgentExecutor = {
      kind: "agent" as const,
      canExecute: () => true,
      execute: backgroundExecutor.execute.bind(backgroundExecutor)
    } as unknown as AgentStepExecutor;
    const background = new SupervisorTaskBackgroundHost({
      store,
      resultService,
      router: { deliverText: async () => new Map() },
      ownerId: "background-approval-handoff",
      resolveWorkspace: async (canonicalPath) => ({ canonicalPath, identityHash: "workspace-hash" }),
      isWorkspaceTrusted: () => true,
      createExecutorRuntime: async () => ({ taskAgentExecutor, dispose: async () => undefined }),
      approvalService: backgroundApprovals,
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });

    await expect(background.runOnce()).resolves.toMatchObject({
      skipped: false,
      scheduler: { dispatched: 1, completed: 1 }
    });
    expect(backgroundExecutor.executions[0]?.attempt.id).toBe(attemptId);
    expect(backgroundExecutor.executions[0]?.attempt.lease?.fencingToken).toBe(2);
    expect(store.getTask("task-approval-handoff")?.status).toBe("completed");
    expect(store.getApprovalLink(link.id)?.status).toBe("approved");
    await background.dispose();
  });

  function makeHost(executor: FakeTaskStepExecutor, ownerId: string): ForegroundTaskHost {
    return new ForegroundTaskHost({
      store,
      resultService,
      executor,
      ownerId,
      workspaceIdentityHash: "workspace-hash",
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now,
      logWarning: (message) => { throw new Error(message); }
    });
  }

  function nextId(prefix: string): string {
    ids++;
    return `${prefix}-${ids}`;
  }
});

function now(): Date {
  return new Date(NOW);
}

function makeGraph(taskId: string, steps: TaskStep[]): {
  task: Task;
  revision: TaskPlanRevision;
  steps: TaskStep[];
} {
  const revisionId = `revision-${taskId}`;
  return {
    task: {
      id: taskId,
      profileId: "alpha",
      creatorSessionId: "creator-alpha",
      rootTaskId: taskId,
      originSessionId: "creator-alpha",
      source: "cli",
      creationKey: `create-${taskId}`,
      objective: `Complete ${taskId}.`,
      status: "queued",
      workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
      authorityPolicy: authorityPolicy(),
      budgetPolicy: {
        maxConcurrentAttempts: 3,
        maxProviderCalls: 20,
        maxTotalTokens: 100_000,
        maxEstimatedCostUsd: 10,
        maxWallClockMs: 600_000
      },
      activePlanRevisionId: revisionId,
      createdBy: { kind: "user", sessionId: "creator-alpha" },
      createdAt: NOW,
      updatedAt: NOW
    },
    revision: {
      id: revisionId,
      profileId: "alpha",
      taskId,
      revision: 1,
      status: "active",
      reason: "Foreground host test.",
      createdBy: { kind: "user", sessionId: "creator-alpha" },
      createdAt: NOW,
      validatedAt: NOW,
      activatedAt: NOW
    },
    steps
  };
}

function step(taskId: string, key: string, position: number, overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: `step-${taskId}-${key}`,
    profileId: "alpha",
    taskId,
    planRevisionId: `revision-${taskId}`,
    key,
    position,
    status: "pending",
    title: `Execute ${key}`,
    objective: `Complete ${key}.`,
    dependsOn: [],
    executor: { kind: "agent", role: key === "synthesis" ? "synthesis" : "worker" },
    childTaskPolicy: "forbid",
    authorityPolicy: authorityPolicy(),
    budget: {
      maxProviderCalls: 5,
      maxTotalTokens: 50_000,
      maxEstimatedCostUsd: 5,
      maxWallClockMs: 300_000
    },
    retryPolicy: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: [],
      nonRetryableFailureClasses: [],
      requireIdempotent: true
    },
    failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
    idempotency: "idempotent",
    resultPolicy: { kind: "text", required: true, maxBytes: 50_000 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["core"],
    allowedTools: ["task.result.read"],
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => [
      riskClass,
      riskClass === "read-only-local" ? "runtime_policy" : "forbid"
    ])) as TaskAuthorityPolicy["riskClassPolicy"],
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}
