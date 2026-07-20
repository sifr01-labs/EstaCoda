import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { TaskAuthorityPolicy, TaskUsageTotals } from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { FixedTaskCreationConflictError, FixedTaskService } from "../workflow/fixed-task-service.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskOperatorService } from "../workflow/task-operator-service.js";
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
