import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { TaskAuthorityPolicy, TaskUsageTotals } from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { FixedTaskCreationConflictError, FixedTaskService } from "../workflow/fixed-task-service.js";
import { FakeTaskStepExecutor } from "../workflow/fake-task-step-executor.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskOperatorService } from "../workflow/task-operator-service.js";
import { TaskResultService } from "../workflow/task-result-service.js";
import { TaskScheduler } from "../workflow/task-scheduler.js";
import { DurableDelegationService } from "./durable-delegation-service.js";

describe("DurableDelegationService", () => {
  let root: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "estacoda-durable-delegation-"));
    sessionDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    await sessionDb.createSession({ id: "parent", profileId: "alpha" });
    await sessionDb.createSession({ id: "worker", profileId: "alpha", parentSessionId: "parent" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists a batch as one queued Task and replays a provider call idempotently", () => {
    const service = rootService(store);
    const first = service.create({
      toolCallId: "call-1",
      trustedWorkspace: true,
      tasks: [{ task: "Read A" }, { task: "Read B", role: "orchestrator" }]
    });
    const replay = service.create({
      toolCallId: "call-1",
      trustedWorkspace: true,
      tasks: [{ task: "Read A" }, { task: "Read B", role: "orchestrator" }]
    });
    const task = store.getTask(first.taskId)!;
    const steps = store.listSteps(task.id, task.activePlanRevisionId!);

    expect(replay).toMatchObject({ taskId: first.taskId, idempotentReplay: true });
    expect(task).toMatchObject({ status: "queued", source: "delegation" });
    expect(task).toMatchObject({
      rootTaskId: task.id,
      originSessionId: "parent",
      originTurnId: "call-1"
    });
    expect(task.parentTaskId).toBeUndefined();
    expect(task.budgetPolicy.maxConcurrentAttempts).toBe(2);
    expect(steps.map((step) => step.executor.role)).toEqual(["worker", "orchestrator"]);
    expect(steps.map((step) => step.childTaskPolicy)).toEqual(["forbid", "fire_and_forget"]);
    expect(steps[1]?.authorityPolicy.maxChildDepth).toBe(1);
    expect(store.listSessionLinks(task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, sessionId: "parent", relationship: "creator" })
    ]);
  });

  it("creates one immutable fan-out graph with a terminal synthesis primary Result Step", () => {
    const service = rootService(store);
    const request = {
      toolCallId: "call-synthesis",
      trustedWorkspace: true as const,
      tasks: [{ task: "Research A" }, { task: "Research B" }, { task: "Research C" }],
      synthesis: { objective: "Compare the three findings and return one supported conclusion." }
    };
    const handle = service.create(request);
    const task = store.getTask(handle.taskId)!;
    const revisions = store.listPlanRevisions(task.id);
    const steps = store.listSteps(task.id, task.activePlanRevisionId!);
    const workers = steps.filter((step) => step.executor.role === "worker");
    const synthesis = steps.find((step) => step.executor.role === "synthesis")!;

    expect(handle).toMatchObject({
      stepCount: 4,
      workerStepIds: workers.map((step) => step.id),
      synthesisStepId: synthesis.id,
      primaryResultStepId: synthesis.id
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.status).toBe("active");
    expect(new Set(synthesis.dependsOn)).toEqual(new Set(workers.map((step) => step.id)));
    expect(synthesis.childTaskPolicy).toBe("forbid");
    expect(synthesis.authorityPolicy).toMatchObject({
      allowedToolsets: ["core"],
      allowedTools: ["task.result.read"],
      mayCreateChildTasks: false,
      maxChildDepth: 0
    });
    expect(workers.every((step) => step.failurePolicy.onAttemptsExhausted === "mark_partial")).toBe(true);
    expect(service.create(request)).toMatchObject({ taskId: handle.taskId, idempotentReplay: true });
  });

  it("runs workers before synthesis and preserves the graph and primary Result across restart", async () => {
    const handle = rootService(store).create({
      toolCallId: "call-restart-synthesis",
      trustedWorkspace: true,
      tasks: [{ task: "Research A" }, { task: "Research B" }],
      synthesis: { objective: "Return one answer grounded in both worker Results." }
    });
    const workerExecutor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: `${step.key} evidence` }]
    }));
    const firstScheduler = scheduler(store, sessionDb, workerExecutor, "before-restart", join(root, "task-results"));

    expect(await firstScheduler.runOnce()).toMatchObject({ dispatched: 2, completed: 2 });
    expect(workerExecutor.executions.map(({ step }) => step.executor.role)).toEqual(["worker", "worker"]);
    expect(store.getTask(handle.taskId)?.status).toBe("running");
    expect(store.getStep(handle.synthesisStepId!)?.status).toBe("pending");
    expect(store.listResults(handle.taskId)).toHaveLength(2);

    sessionDb.close();
    sessionDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    const synthesisExecutor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: `${step.key} final answer` }]
    }));
    const secondScheduler = scheduler(store, sessionDb, synthesisExecutor, "after-restart", join(root, "task-results"));

    expect(await secondScheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1 });
    expect(synthesisExecutor.executions.map(({ step }) => step.executor.role)).toEqual(["synthesis"]);
    expect(store.getTask(handle.taskId)?.status).toBe("completed");
    const projection = new TaskOperatorService({ store }).status(handle.taskId, "parent");
    expect(projection.results).toHaveLength(3);
    expect(projection.results[0]).toMatchObject({ primary: true });
    expect(store.getStep(handle.synthesisStepId!)?.status).toBe("completed");
  });

  it("marks the graph partial and durably blocks synthesis after a worker failure", async () => {
    const handle = rootService(store).create({
      toolCallId: "call-partial-synthesis",
      trustedWorkspace: true,
      tasks: [{ task: "Research A" }, { task: "Research B" }],
      synthesis: { objective: "Synthesize only after every worker succeeds." }
    });
    const executor = new FakeTaskStepExecutor(({ step }) => step.key === "delegated-1"
      ? {
          outcome: "failed",
          failure: { class: "worker-failed", message: "Worker failed.", retryable: false, uncertainSideEffects: false }
        }
      : { outcome: "succeeded", results: [{ kind: "text", content: "worker evidence" }] });
    const taskScheduler = scheduler(store, sessionDb, executor, "partial", join(root, "task-results"));

    expect(await taskScheduler.runOnce()).toMatchObject({ dispatched: 2, completed: 1, failed: 1 });
    expect(await taskScheduler.runOnce()).toMatchObject({ dispatched: 0 });
    expect(store.getTask(handle.taskId)?.status).toBe("partial");
    expect(store.getStep(handle.synthesisStepId!)?.status).toBe("skipped");
    expect(executor.executions.every(({ step }) => step.executor.role === "worker")).toBe(true);
    expect(new TaskOperatorService({ store }).status(handle.taskId, "parent").results.every((result) => !result.primary)).toBe(true);
  });

  it("cancels running workers and the pending synthesis Step together", async () => {
    const handle = rootService(store).create({
      toolCallId: "call-cancel-synthesis",
      trustedWorkspace: true,
      tasks: [{ task: "Research A" }, { task: "Research B" }, { task: "Research C" }],
      synthesis: { objective: "Synthesize the completed research." }
    });
    const executor = new FakeTaskStepExecutor(({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true });
    }));
    const taskScheduler = scheduler(store, sessionDb, executor, "cancel", join(root, "task-results"));
    const running = taskScheduler.runOnce();
    await vi.waitFor(() => expect(executor.executions).toHaveLength(2));

    expect(taskScheduler.cancelTask(handle.taskId).status).toBe("cancelled");
    await running;
    expect(store.getTask(handle.taskId)?.status).toBe("cancelled");
    expect(store.getStep(handle.synthesisStepId!)?.status).toBe("cancelled");
    expect(store.listResults(handle.taskId)).toEqual([]);
  });

  it("rejects a provider call replay whose immutable definition changed", () => {
    const service = rootService(store);
    service.create({ toolCallId: "call-1", trustedWorkspace: true, tasks: [{ task: "Read A" }] });
    expect(() => service.create({
      toolCallId: "call-1",
      trustedWorkspace: true,
      tasks: [{ task: "Different work" }]
    })).toThrow(FixedTaskCreationConflictError);
  });

  it("creates a linked child Task under the active Attempt with narrower authority and budget", () => {
    const parent = createParentAttempt(store);
    const service = new DurableDelegationService({
      store,
      creatorSessionId: () => "worker",
      workspace: workspace(),
      config: { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 3 },
      visibleTools,
      activeTaskExecution: {
        taskId: parent.taskId,
        planRevisionId: parent.planRevisionId,
        stepId: parent.stepId,
        attemptId: parent.attemptId
      }
    });
    const handle = service.create({
      toolCallId: "nested-call",
      trustedWorkspace: true,
      tasks: [{ task: "Nested review", role: "orchestrator" }]
    });
    const child = store.getTask(handle.taskId)!;
    const parentTask = store.getTask(parent.taskId)!;

    expect(handle).toMatchObject({ childTask: true, parentTaskId: parent.taskId });
    expect(child).toMatchObject({
      parentTaskId: parent.taskId,
      parentAttemptId: parent.attemptId,
      rootTaskId: parentTask.rootTaskId,
      originSessionId: "parent",
      originTurnId: "parent-turn",
      createdBy: {
        kind: "agent",
        sessionId: "worker",
        taskId: parent.taskId,
        attemptId: parent.attemptId
      }
    });
    expect(child.authorityPolicy.maxChildDepth).toBe(1);
    expect(child.budgetPolicy.maxProviderCalls).toBeLessThanOrEqual(parent.stepBudget.maxProviderCalls);
    expect(store.listSessionLinks(child.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "worker", relationship: "creator" }),
      expect.objectContaining({ sessionId: "parent", relationship: "observer" })
    ]));
    expect(store.listChildTasks(parent.taskId).map((task) => task.id)).toEqual([child.id]);
    expect(new TaskOperatorService({ store }).status(child.id, "parent").taskId).toBe(child.id);
    expect(new TaskOperatorService({ store }).status(parent.taskId, "parent").childTasks).toEqual([
      expect.objectContaining({ taskId: child.id, status: "queued", parentAttemptId: parent.attemptId })
    ]);

    const runningParent = { ...parentTask, status: "running" as const, startedAt: "2026-01-01T00:00:30.000Z", updatedAt: "2026-01-01T00:00:30.000Z" };
    store.updateTask(runningParent);
    const parentStep = store.getStep(parent.stepId)!;
    const readyStep = { ...parentStep, status: "ready" as const, updatedAt: "2026-01-01T00:00:30.000Z" };
    store.updateStep(readyStep);
    const runningStep = { ...readyStep, status: "running" as const, updatedAt: "2026-01-01T00:00:30.000Z" };
    store.updateStep(runningStep);
    const settledParentAttempt = store.getAttempt(parent.attemptId)!;
    store.updateAttempt({
      ...settledParentAttempt,
      status: "completed",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z"
    });
    store.updateStep({ ...runningStep, status: "completed", updatedAt: "2026-01-01T00:01:00.000Z" });
    store.updateTask({
      ...runningParent,
      status: "completed",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z"
    });
    expect(store.getTask(child.id)?.status).toBe("queued");
    expect(service.create({
      toolCallId: "nested-call",
      trustedWorkspace: true,
      tasks: [{ task: "Nested review", role: "orchestrator" }]
    })).toMatchObject({ taskId: handle.taskId, idempotentReplay: true });
  });

  it("rejects runtime children when the active parent Step policy forbids them", () => {
    const parent = createParentAttempt(store, "forbid");
    const service = new DurableDelegationService({
      store,
      creatorSessionId: () => "worker",
      workspace: workspace(),
      config: { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 3 },
      visibleTools,
      activeTaskExecution: {
        taskId: parent.taskId,
        planRevisionId: parent.planRevisionId,
        stepId: parent.stepId,
        attemptId: parent.attemptId
      }
    });

    expect(() => service.create({
      toolCallId: "forbidden-child",
      trustedWorkspace: true,
      tasks: [{ task: "Must not start" }]
    })).toThrow("forbids runtime child Tasks");
    expect(store.listChildTasks(parent.taskId)).toEqual([]);
  });

  it("fails closed for untrusted workspaces and overlong objectives", () => {
    const service = rootService(store);
    expect(() => service.create({
      toolCallId: "call-untrusted",
      trustedWorkspace: false,
      tasks: [{ task: "Read A" }]
    })).toThrow("trusted workspace");
    expect(() => service.create({
      toolCallId: "call-long",
      trustedWorkspace: true,
      tasks: [{ task: "x".repeat(4_001) }]
    })).toThrow("1-4000");

    const noResultReader = new DurableDelegationService({
      store,
      creatorSessionId: () => "parent",
      workspace: workspace(),
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools: () => [tool("file.read", "read-only-local", ["files"])]
    });
    expect(() => noResultReader.create({
      toolCallId: "call-no-result-reader",
      trustedWorkspace: true,
      tasks: [{ task: "Research A" }],
      synthesis: { objective: "Synthesize the worker Result." }
    })).toThrow("requires the task.result.read tool");
  });
});

function rootService(store: SQLiteTaskStore) {
  return new DurableDelegationService({
    store,
    creatorSessionId: () => "parent",
    workspace: workspace(),
    config: { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 2, maxConcurrentChildren: 2 },
    visibleTools
  });
}

function scheduler(
  taskStore: SQLiteTaskStore,
  database: SQLiteSessionDB,
  executor: FakeTaskStepExecutor,
  ownerId: string,
  contentRoot: string
): TaskScheduler {
  return new TaskScheduler({
    store: taskStore,
    resultService: new TaskResultService({
      store: taskStore,
      profileId: taskStore.profileId,
      contentRoot,
      sessionDb: database
    }),
    ownerId,
    resolveExecutor: () => executor
  });
}

function createParentAttempt(store: SQLiteTaskStore, childTaskPolicy: "forbid" | "fire_and_forget" = "fire_and_forget") {
  const authority = authorityPolicy(2);
  const stepBudget = {
    maxProviderCalls: 40,
    maxTotalTokens: 100_000,
    maxEstimatedCostUsd: 10,
    maxWallClockMs: 60_000
  };
  const graph = new FixedTaskService({ store }).create({
    creatorSessionId: "parent",
    source: "runtime",
    originTurnId: "parent-turn",
    objective: "Parent Task",
    workspace: workspace(),
    authorityPolicy: authority,
    budgetPolicy: { maxConcurrentAttempts: 1, ...stepBudget },
    steps: [{
      key: "parent-step",
      title: "Parent Step",
      objective: "Parent work",
      dependsOn: [],
      executor: { kind: "agent", role: "orchestrator" },
      childTaskPolicy,
      authorityPolicy: authority,
      budget: stepBudget,
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
      idempotency: "unknown",
      resultPolicy: { kind: "text", required: true, maxBytes: 1_000 }
    }]
  });
  const attemptId = "parent-attempt";
  store.createAttempt({
    id: attemptId,
    profileId: "alpha",
    taskId: graph.task.id,
    planRevisionId: graph.revision.id,
    stepId: graph.steps[0]!.id,
    attemptNumber: 1,
    status: "running",
    dispatchKey: "parent-dispatch",
    workerSessionId: "worker",
    usage: emptyUsage(),
    resultIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z"
  });
  return {
    taskId: graph.task.id,
    planRevisionId: graph.revision.id,
    stepId: graph.steps[0]!.id,
    attemptId,
    stepBudget
  };
}

function authorityPolicy(maxChildDepth: number): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["core", "files", "research", "coding"],
    allowedTools: visibleTools().map((tool) => tool.name),
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => [
      riskClass,
      riskClass === "read-only-local" || riskClass === "shared-state-mutation" ? "runtime_policy" : "forbid"
    ])) as TaskAuthorityPolicy["riskClassPolicy"],
    mayCreateChildTasks: maxChildDepth > 0,
    maxChildDepth
  };
}

function visibleTools(): ToolDefinition[] {
  return [
    tool("file.read", "read-only-local", ["files"]),
    tool("task.result.read", "read-only-local", ["core"]),
    tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
  ];
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return { name, description: name, inputSchema: {}, riskClass, toolsets, progressLabel: name, maxResultSizeChars: 1_000 };
}

function workspace() {
  return { canonicalPath: "/workspace", identityHash: "workspace-hash" };
}

function emptyUsage(): TaskUsageTotals {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: []
  };
}
