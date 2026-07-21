import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { TaskAttempt, TaskAuthorityPolicy, TaskUsageTotals } from "../contracts/task.js";
import { TASK_GRAPH_LIMITS, TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
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
    await sessionDb.appendMessage({
      id: "visible-turn-alpha",
      sessionId: "parent",
      role: "user",
      content: "Delegate the Task"
    });
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
      originTurnId: "visible-turn-alpha",
      trustedWorkspace: true,
      tasks: [{ task: "Read A" }, { task: "Read B", role: "orchestrator" }]
    });
    const replay = service.create({
      toolCallId: "call-1",
      originTurnId: "visible-turn-alpha",
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
      originTurnId: "visible-turn-alpha"
    });
    expect(task.parentTaskId).toBeUndefined();
    expect(task.executionLimits.maxConcurrentAttempts).toBe(2);
    expect(steps.map((step) => step.executor.role)).toEqual(["worker", "orchestrator"]);
    expect(steps.map((step) => step.childTaskPolicy)).toEqual(["forbid", "fire_and_forget"]);
    expect(steps.map((step) => step.idempotency)).toEqual(["retry_safe", "unknown"]);
    expect(steps.map((step) => step.retryPolicy)).toEqual([
      expect.objectContaining({
        maxAttempts: TASK_GRAPH_LIMITS.maxAttemptsPerStep,
        retryableFailureClasses: ["lease-expired", "lease-missing"],
        requireIdempotent: true
      }),
      expect.objectContaining({
        maxAttempts: TASK_GRAPH_LIMITS.maxAttemptsPerStep,
        retryableFailureClasses: ["lease-expired", "lease-missing"],
        requireIdempotent: false
      })
    ]);
    expect(steps[1]?.authorityPolicy.maxChildDepth).toBe(1);
    expect(store.listSessionLinks(task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, sessionId: "parent", relationship: "creator" })
    ]);
  });

  it("snapshots the configured root spending limit and only permits finite narrowing", () => {
    const configured = new DurableDelegationService({
      store,
      creatorSessionId: () => "parent",
      workspace: workspace(),
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools,
      defaultTaskSpendingLimit: { maxEstimatedCostUsd: 5, warningThresholdPercent: 80 }
    });
    const inherited = configured.create({
      toolCallId: "call-budget-default",
      trustedWorkspace: true,
      tasks: [{ task: "Use the configured ceiling" }]
    });
    const narrowed = configured.create({
      toolCallId: "call-budget-narrow",
      trustedWorkspace: true,
      tasks: [{ task: "Use a lower ceiling" }],
      spendingLimit: { maxEstimatedCostUsd: 2 }
    });

    expect(store.getTask(inherited.taskId)?.spendingLimit).toEqual({
      maxEstimatedCostUsd: 5,
      warningThresholdPercent: 80
    });
    expect(store.getTask(narrowed.taskId)?.spendingLimit).toEqual({
      maxEstimatedCostUsd: 2,
      warningThresholdPercent: 80
    });
    expect(() => configured.create({
      toolCallId: "call-budget-widen",
      trustedWorkspace: true,
      tasks: [{ task: "Try to widen the ceiling" }],
      spendingLimit: { maxEstimatedCostUsd: 6 }
    })).toThrow(/cannot exceed/i);

    const defaultOff = rootService(store).create({
      toolCallId: "call-budget-opt-in",
      trustedWorkspace: true,
      tasks: [{ task: "Opt in to a finite ceiling" }],
      spendingLimit: { maxEstimatedCostUsd: 1 }
    });
    expect(store.getTask(defaultOff.taskId)?.spendingLimit).toEqual({
      maxEstimatedCostUsd: 1,
      warningThresholdPercent: 80
    });
  });

  it("activates a Task only after its durable graph is visible", async () => {
    const activated = vi.fn(async (taskId: string) => {
      expect(store.getTask(taskId)).toMatchObject({ id: taskId, status: "queued" });
      expect(store.getTaskHostLease(taskId)).toMatchObject({
        ownerId: "foreground-parent",
        kind: "foreground",
        fencingToken: 1
      });
    });
    const taskHostAdmission = vi.fn(() => ({
      workspaceIdentityHash: workspace().identityHash,
      ownerId: "foreground-parent",
      kind: "foreground" as const,
      acquiredAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:01:00.000Z"
    }));
    const service = new DurableDelegationService({
      store,
      creatorSessionId: () => "parent",
      workspace: workspace(),
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools,
      taskHostAdmission,
      onTaskCreated: activated
    });

    const handle = await service.createAndActivate({
      toolCallId: "call-activate",
      trustedWorkspace: true,
      tasks: [{ task: "Start foreground work" }]
    });

    expect(activated).toHaveBeenCalledWith(handle.taskId);
    expect(taskHostAdmission).toHaveBeenCalledOnce();
  });

  it("persists direct-background preference, skips foreground activation, and replay-checks it", async () => {
    const activated = vi.fn(async () => undefined);
    const service = new DurableDelegationService({
      store,
      creatorSessionId: () => "parent",
      workspace: workspace(),
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools,
      backgroundContinuation: () => "unavailable",
      onTaskCreated: activated
    });
    const request = {
      toolCallId: "call-background-preference",
      trustedWorkspace: true as const,
      executionPreference: "background" as const,
      tasks: [{ task: "Wait for the gateway" }]
    };

    const handle = await service.createAndActivate(request);
    expect(handle).toMatchObject({
      executionPreference: "background",
      execution: "waiting",
      backgroundContinuation: "unavailable"
    });
    expect(store.getTask(handle.taskId)).toMatchObject({ executionPreference: "background" });
    expect(activated).not.toHaveBeenCalled();
    expect(() => service.create({ ...request, executionPreference: "auto" }))
      .toThrow(FixedTaskCreationConflictError);
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
    expect(synthesis.idempotency).toBe("retry_safe");
    expect(synthesis.retryPolicy).toMatchObject({
      maxAttempts: TASK_GRAPH_LIMITS.maxAttemptsPerStep,
      retryableFailureClasses: ["lease-expired", "lease-missing"],
      requireIdempotent: true
    });
    expect(workers.every((step) => step.idempotency === "retry_safe")).toBe(true);
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
    expect(child.executionLimits.maxProviderCalls).toBeLessThanOrEqual(parent.stepExecutionLimits.maxProviderCalls);
    expect(store.listChildTaskExecutionReservations(parent.taskId)).toEqual([
      expect.objectContaining({
        childTaskId: child.id,
        rootTaskId: parentTask.rootTaskId,
        parentTaskId: parent.taskId,
        parentStepId: parent.stepId,
        parentAttemptId: parent.attemptId,
        executionLimits: child.executionLimits
      })
    ]);
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

  it("atomically refuses repeated child calls that would multiply the parent Step ceiling", () => {
    const parent = createParentAttempt(store);
    const service = nestedService(store, parent);
    const first = service.create({
      toolCallId: "nested-budget-one",
      trustedWorkspace: true,
      tasks: [{ task: "First nested review" }]
    });

    expect(() => service.create({
      toolCallId: "nested-budget-two",
      trustedWorkspace: true,
      tasks: [{ task: "Second nested review" }]
    })).toThrow(/remaining execution capacity/i);
    expect(store.listChildTasks(parent.taskId).map((task) => task.id)).toEqual([first.taskId]);
    expect(store.listChildTaskExecutionReservations(parent.taskId)).toHaveLength(1);
  });

  it("prevents child Tasks from redefining the root monetary scope", () => {
    const parent = createParentAttempt(store);
    expect(() => nestedService(store, parent).create({
      toolCallId: "nested-spending-limit",
      trustedWorkspace: true,
      tasks: [{ task: "Nested review" }],
      spendingLimit: { maxEstimatedCostUsd: 1 }
    })).toThrow(/inherits the root Task spending scope/i);
  });

  it("rolls a reservation back when the child graph cannot be persisted", () => {
    const parent = createParentAttempt(store);
    const parentStep = store.getStep(parent.stepId)!;
    const childAuthority = { ...parentStep.authorityPolicy, maxChildDepth: 1 };
    expect(() => new FixedTaskService({ store }).create({
      creatorSessionId: "worker",
      source: "delegation",
      objective: "Invalid child graph",
      workspace: workspace(),
      authorityPolicy: childAuthority,
      executionLimits: { maxConcurrentAttempts: 1, ...parentStep.executionLimits },
      parent: { taskId: parent.taskId, attemptId: parent.attemptId },
      createdBy: {
        kind: "agent",
        sessionId: "worker",
        taskId: parent.taskId,
        attemptId: parent.attemptId
      },
      steps: [{
        key: "invalid-child-step",
        title: "Invalid child Step",
        objective: "This dependency does not exist.",
        dependsOn: ["missing-step"],
        executor: { kind: "agent", role: "worker" },
        childTaskPolicy: "forbid",
        authorityPolicy: childAuthority,
        executionLimits: parentStep.executionLimits,
        retryPolicy: parentStep.retryPolicy,
        failurePolicy: parentStep.failurePolicy,
        idempotency: "unknown",
        resultPolicy: parentStep.resultPolicy
      }]
    })).toThrow(/invalid/i);

    expect(store.listChildTasks(parent.taskId)).toEqual([]);
    expect(store.listChildTaskExecutionReservations(parent.taskId)).toEqual([]);
  });

  it("serializes competing child reservations so only one can consume the remaining ceiling", async () => {
    const parent = createParentAttempt(store);
    const competingDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    try {
      const competingStore = new SQLiteTaskStore({ db: competingDb.db, profileId: "alpha" });
      const results = await Promise.allSettled([
        Promise.resolve().then(() => nestedService(store, parent).create({
          toolCallId: "reservation-race-a",
          trustedWorkspace: true,
          tasks: [{ task: "Competing child A" }]
        })),
        Promise.resolve().then(() => nestedService(competingStore, parent).create({
          toolCallId: "reservation-race-b",
          trustedWorkspace: true,
          tasks: [{ task: "Competing child B" }]
        }))
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(store.listChildTasks(parent.taskId)).toHaveLength(1);
      expect(store.listChildTaskExecutionReservations(parent.taskId)).toHaveLength(1);
    } finally {
      competingDb.close();
    }
  });

  it("counts descendant usage in the parent projection and rejects child settlement above the ancestor ceiling", async () => {
    const parent = createParentAttempt(store);
    const child = nestedService(store, parent).create({
      toolCallId: "nested-aggregate-usage",
      trustedWorkspace: true,
      tasks: [{ task: "Consume the reserved child budget" }]
    });
    const parentTask = store.getTask(parent.taskId)!;
    const parentStep = store.getStep(parent.stepId)!;
    const parentAttempt = store.getAttempt(parent.attemptId)!;
    store.updateTask({
      ...parentTask,
      status: "running",
      startedAt: parentAttempt.startedAt,
      updatedAt: parentAttempt.updatedAt
    });
    store.updateStep({ ...parentStep, status: "ready", updatedAt: parentAttempt.updatedAt });
    store.updateStep({ ...parentStep, status: "running", updatedAt: parentAttempt.updatedAt });
    store.updateAttempt({
      ...parentAttempt,
      status: "completed",
      usage: usage(1, 30_000, 1),
      completedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z"
    });
    store.recordProviderUsageEntry(usageEntry(parentAttempt, parentTask.rootTaskId, "parent-usage", 30_000, 1));
    expect(store.listProviderUsageEntries({ rootTaskId: parentTask.rootTaskId })).toHaveLength(1);
    store.updateStep({ ...parentStep, status: "completed", updatedAt: "2026-01-01T00:00:10.000Z" });
    store.updateTask({
      ...parentTask,
      status: "completed",
      startedAt: parentAttempt.startedAt,
      completedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z"
    });

    const executor = new FakeTaskStepExecutor(({ attempt }) => ({
      outcome: "succeeded",
      usage: usage(1, 80_000, 1),
      usageEntries: [usageEntry(attempt, store.getTask(child.taskId)!.rootTaskId, "child-usage", 80_000, 1)],
      results: [{ kind: "text", content: "Child result" }]
    }));
    const childScheduler = scheduler(
      store,
      sessionDb,
      executor,
      "tree-budget",
      join(root, "tree-budget-results"),
      () => new Date("2026-01-01T00:00:20.000Z")
    );
    expect(await childScheduler.runOnce()).toMatchObject({ dispatched: 1, failed: 1, completed: 0 });
    expect(store.listProviderUsageEntries({ rootTaskId: parentTask.rootTaskId })).toHaveLength(2);
    expect(store.getTask(child.taskId)?.status).toBe("failed");
    expect(store.listAttempts(child.taskId)[0]).toMatchObject({
      status: "failed",
      failure: { class: "execution-limit-exceeded" }
    });
    expect(new TaskOperatorService({ store }).status(parent.taskId, "parent").usage).toMatchObject({
      providerCalls: 2,
      totalTokens: 110_000,
      estimatedCostUsd: 2,
      usageComplete: true,
      pricingComplete: true
    });
  });

  it("does not let a child Task expand the root Task's live concurrency", async () => {
    const parent = createParentAttempt(store, "fire_and_forget", true);
    const child = nestedService(store, parent).create({
      toolCallId: "nested-tree-concurrency",
      trustedWorkspace: true,
      tasks: [{ task: "Wait for the parent tree slot" }]
    });
    const parentTask = store.getTask(parent.taskId)!;
    const parentStep = store.getStep(parent.stepId)!;
    const parentAttempt = store.getAttempt(parent.attemptId)!;
    store.updateTask({
      ...parentTask,
      status: "running",
      startedAt: parentAttempt.startedAt,
      updatedAt: parentAttempt.updatedAt
    });
    store.updateStep({ ...parentStep, status: "ready", updatedAt: parentAttempt.updatedAt });
    store.updateStep({ ...parentStep, status: "running", updatedAt: parentAttempt.updatedAt });
    const executor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const taskScheduler = scheduler(
      store,
      sessionDb,
      executor,
      "tree-concurrency",
      join(root, "tree-concurrency-results"),
      () => new Date("2026-01-01T00:00:20.000Z")
    );

    expect(await taskScheduler.runOnce()).toMatchObject({ dispatched: 0 });
    expect(executor.executions).toEqual([]);
    expect(store.getTask(child.taskId)?.status).toBe("running");
  });

  it("does not dispatch a descendant after its ancestor wall-clock ceiling expires", async () => {
    const parent = createParentAttempt(store);
    const child = nestedService(store, parent).create({
      toolCallId: "nested-tree-deadline",
      trustedWorkspace: true,
      tasks: [{ task: "Must remain inside the root deadline" }]
    });
    const parentTask = store.getTask(parent.taskId)!;
    const parentStep = store.getStep(parent.stepId)!;
    const parentAttempt = store.getAttempt(parent.attemptId)!;
    store.updateTask({
      ...parentTask,
      status: "running",
      startedAt: parentAttempt.startedAt,
      updatedAt: parentAttempt.updatedAt
    });
    store.updateStep({ ...parentStep, status: "ready", updatedAt: parentAttempt.updatedAt });
    store.updateStep({ ...parentStep, status: "running", updatedAt: parentAttempt.updatedAt });
    store.updateAttempt({
      ...parentAttempt,
      status: "completed",
      completedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z"
    });
    store.updateStep({ ...parentStep, status: "completed", updatedAt: "2026-01-01T00:00:10.000Z" });
    store.updateTask({
      ...parentTask,
      status: "completed",
      startedAt: parentAttempt.startedAt,
      completedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z"
    });
    const executor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const taskScheduler = scheduler(
      store,
      sessionDb,
      executor,
      "tree-deadline",
      join(root, "tree-deadline-results"),
      () => new Date("2026-01-01T00:02:00.000Z")
    );

    const result = await taskScheduler.runOnce();
    expect(result).toMatchObject({ dispatched: 0 });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("ancestor-task-wall-clock-limit-exhausted")
    ]));
    expect(executor.executions).toEqual([]);
    expect(store.getTask(child.taskId)?.status).toBe("paused");
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

function nestedService(
  taskStore: SQLiteTaskStore,
  parent: ReturnType<typeof createParentAttempt>
): DurableDelegationService {
  return new DurableDelegationService({
    store: taskStore,
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
}

function scheduler(
  taskStore: SQLiteTaskStore,
  database: SQLiteSessionDB,
  executor: FakeTaskStepExecutor,
  ownerId: string,
  contentRoot: string,
  now?: () => Date
): TaskScheduler {
  const clock = now ?? (() => new Date());
  acquireTestHostLeases(taskStore, ownerId, clock);
  return new TaskScheduler({
    store: taskStore,
    resultService: new TaskResultService({
      store: taskStore,
      profileId: taskStore.profileId,
      contentRoot,
      sessionDb: database
    }),
    ownerId,
    resolveExecutor: () => executor,
    ...(now === undefined ? {} : { now })
  });
}

function acquireTestHostLeases(store: SQLiteTaskStore, ownerId: string, now: () => Date): void {
  for (const task of store.listTasks()) {
    const existing = store.getTaskHostLease(task.id);
    if (existing !== null && existing.ownerId !== ownerId) {
      store.releaseTaskHostLease({
        taskId: task.id,
        workspaceIdentityHash: existing.workspaceIdentityHash,
        ownerId: existing.ownerId,
        kind: existing.kind,
        fencingToken: existing.fencingToken
      });
    }
    if (store.getTaskHostLease(task.id) !== null) continue;
    store.acquireTaskHostLease({
      taskId: task.id,
      workspaceIdentityHash: task.workspace.identityHash,
      ownerId,
      kind: "background",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(now().getTime() + 60_000).toISOString()
    });
  }
}

function createParentAttempt(
  store: SQLiteTaskStore,
  childTaskPolicy: "forbid" | "fire_and_forget" = "fire_and_forget",
  withLease = false
) {
  const authority = authorityPolicy(2);
  const stepExecutionLimits = {
    maxProviderCalls: 40,
    maxTotalTokens: 100_000,
    maxWallClockMs: 60_000
  };
  const graph = new FixedTaskService({ store }).create({
    creatorSessionId: "parent",
    source: "runtime",
    originTurnId: "parent-turn",
    objective: "Parent Task",
    workspace: workspace(),
    authorityPolicy: authority,
    executionLimits: { maxConcurrentAttempts: 1, ...stepExecutionLimits },
    steps: [{
      key: "parent-step",
      title: "Parent Step",
      objective: "Parent work",
      dependsOn: [],
      executor: { kind: "agent", role: "orchestrator" },
      childTaskPolicy,
      authorityPolicy: authority,
      executionLimits: stepExecutionLimits,
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
    ...(withLease ? {
      lease: {
        attemptId,
        profileId: "alpha",
        taskId: graph.task.id,
        ownerId: "active-parent-owner",
        fencingToken: 1,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:01:00.000Z"
      }
    } : {}),
    usage: emptyUsage(),
    resultIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z"
  });
  if (withLease) {
    const leased = store.getAttempt(attemptId)!;
    store.updateAttempt({ ...leased, status: "running", startedAt: leased.startedAt ?? leased.updatedAt });
  }
  return {
    taskId: graph.task.id,
    planRevisionId: graph.revision.id,
    stepId: graph.steps[0]!.id,
    attemptId,
    stepExecutionLimits
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

function usage(providerCalls: number, totalTokens: number, estimatedCostUsd: number): TaskUsageTotals {
  return {
    ...emptyUsage(),
    providerCalls,
    inputTokens: totalTokens,
    totalTokens,
    estimatedCostUsd
  };
}

function usageEntry(
  attempt: TaskAttempt,
  rootTaskId: string,
  requestKey: string,
  totalTokens: number,
  estimatedCostUsd: number
) {
  return {
    id: `usage-${requestKey}`,
    profileId: attempt.profileId,
    sessionId: "parent",
    visibleTurnId: "visible-turn-alpha",
    taskId: attempt.taskId,
    rootTaskId,
    planRevisionId: attempt.planRevisionId,
    stepId: attempt.stepId,
    attemptId: attempt.id,
    requestKey,
    providerAttemptIndex: 0,
    sourceKind: "task" as const,
    pricing: { currency: "USD" as const, fingerprint: "test-pricing" },
    pricingFingerprint: "test-pricing",
    provider: "test",
    model: "test-model",
    routeRole: "primary" as const,
    routeIndex: 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    dispatchedAt: "2026-01-01T00:00:10.000Z"
  };
}
