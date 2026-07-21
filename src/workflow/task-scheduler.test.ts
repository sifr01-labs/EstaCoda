import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Task,
  TaskAttempt,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskHostDispatchGrant,
  TaskHostKind,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { GatewayApprovalQueue } from "../gateway/approval-queue.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { FakeTaskStepExecutor } from "./fake-task-step-executor.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskResultService } from "./task-result-service.js";
import { TaskApprovalService } from "./task-approval-service.js";
import { TaskOperatorService } from "./task-operator-service.js";
import {
  TaskScheduler,
  classifyTaskRetry,
  taskHostDispatchGrant,
  taskDispatchKey,
  type TaskSchedulerLimits
} from "./task-scheduler.js";

describe("TaskScheduler", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let resultService: TaskResultService;
  let nowMs: number;
  let ids: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-scheduler-"));
    nowMs = Date.parse(NOW);
    ids = 0;
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite"), now });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    await sessionDb.appendMessage({
      id: "visible-turn-alpha",
      sessionId: "creator-alpha",
      role: "user",
      content: "Run the Task"
    });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "profiles", "alpha", "tasks", "results"),
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

  it("runs dependencies in order and settles the Task only after durable result acceptance", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("research", 0),
      makeStep("synthesis", 1, { dependsOn: ["step-research"] })
    ]));
    const executor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: `${step.key} result` }]
    }));
    const scheduler = makeScheduler(executor);

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(store.getStep("step-research")?.status).toBe("completed");
    expect(store.getStep("step-synthesis")?.status).toBe("pending");
    expect(store.getTask("task-alpha")?.status).toBe("running");

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(executor.executions.map((execution) => execution.step.key)).toEqual(["research", "synthesis"]);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(store.listResults("task-alpha").map((result) => result.summary ?? result.kind)).toEqual(["text", "text"]);
    const attempts = store.listAttempts("task-alpha");
    expect(attempts.map((attempt) => attempt.dispatchKey)).toEqual([
      taskDispatchKey("task-alpha", "revision-alpha", "step-research", 1),
      taskDispatchKey("task-alpha", "revision-alpha", "step-synthesis", 1)
    ]);
    expect(new Set(attempts.map((attempt) => attempt.dispatchKey)).size).toBe(2);
  });

  it("confirms durable dispatch before Attempt execution settles", async () => {
    store.createTaskGraph(makeGraph([makeStep("long", 0)]));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const executor = new FakeTaskStepExecutor(async () => {
      await gate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "done" }] };
    });
    const scheduler = makeScheduler(executor);

    const dispatch = await scheduler.dispatchOnce({
      dispatchGrants: dispatchGrantsFor("scheduler-alpha", ["task-alpha"])
    });

    expect(dispatch).toMatchObject({ dispatched: 1, completed: 0, failed: 0 });
    expect(executor.executions).toHaveLength(1);
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({ status: "running" });
    expect(scheduler.hasPendingWork()).toBe(true);

    finish!();
    await expect(dispatch.completion).resolves.toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(scheduler.hasPendingWork()).toBe(false);
  });

  it("dispatches and reconciles only Tasks selected by the owning host", async () => {
    const excluded = makeGraph([makeStep("excluded", 0)]);
    excluded.task.status = "running";
    excluded.task.startedAt = NOW;
    excluded.steps[0]!.status = "running";
    store.createTaskGraph(excluded);
    store.createAttempt(makeRunningAttempt(
      excluded.steps[0]!,
      "attempt-excluded",
      "2029-12-31T23:59:00.000Z"
    ));
    store.createTaskGraph(makeGraphFor("task-selected", "selected"));
    const executor = new FakeTaskStepExecutor(({ task }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: task.id }]
    }));
    const scheduler = makeScheduler(executor);

    const dispatch = await scheduler.dispatchOnce({
      dispatchGrants: dispatchGrantsFor("scheduler-alpha", ["task-selected"])
    });
    await expect(dispatch.completion).resolves.toMatchObject({ dispatched: 1, completed: 1 });

    expect(executor.executions.map(({ task }) => task.id)).toEqual(["task-selected"]);
    expect(store.listAttempts("task-alpha")).toEqual([
      expect.objectContaining({ id: "attempt-excluded", status: "leased" })
    ]);
    expect(store.getTask("task-alpha")?.status).toBe("running");
    expect(store.listEvents("task-alpha", { kinds: ["attempt-expired"] })).toHaveLength(0);
    expect(store.getTask("task-selected")?.status).toBe("completed");
  });

  it("denies expired and superseded host dispatch grants without creating Attempts", async () => {
    store.createTaskGraph(makeGraph([makeStep("fenced", 0)]));
    const executor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const scheduler = makeScheduler(executor, undefined, undefined, "host-owner");
    const [currentGrant] = dispatchGrantsFor("host-owner", ["task-alpha"]);

    expect((await scheduler.runOnce({
      dispatchGrants: [{ ...currentGrant!, expiresAt: NOW }]
    })).dispatched).toBe(0);
    expect(store.listAttempts("task-alpha")).toHaveLength(0);

    nowMs += 60_001;
    expect((await scheduler.runOnce({
      dispatchGrants: [{ ...currentGrant!, expiresAt: new Date(nowMs + 60_000).toISOString() }]
    })).dispatched).toBe(0);
    expect(store.listAttempts("task-alpha")).toHaveLength(0);

    const [replacementGrant] = acquireDispatchGrants("host-owner", ["task-alpha"]);
    expect(replacementGrant?.fencingToken).toBe(currentGrant!.fencingToken + 1);
    expect((await scheduler.runOnce({ dispatchGrants: [currentGrant!] })).dispatched).toBe(0);
    expect(store.listAttempts("task-alpha")).toHaveLength(0);
  });

  it("revalidates host fencing inside Attempt dispatch after an ownership race", async () => {
    store.createTaskGraph(makeGraph([makeStep("fenced", 0)]));
    const [staleGrant] = acquireDispatchGrants("host-owner", ["task-alpha"]);
    const approvals = new TaskApprovalService({ store, now });
    vi.spyOn(approvals, "reconcile").mockImplementation(async () => {
      releaseHostLease("task-alpha", "host-owner");
      acquireDispatchGrants("host-owner", ["task-alpha"]);
    });
    const executor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "host-owner",
      resolveExecutor: () => executor,
      approvalService: approvals,
      now
    });

    expect((await scheduler.runOnce({ dispatchGrants: [staleGrant!] })).dispatched).toBe(0);
    expect(store.getTaskHostLease("task-alpha")?.fencingToken).toBe(staleGrant!.fencingToken + 1);
    expect(store.listAttempts("task-alpha")).toHaveLength(0);
    expect(executor.executions).toHaveLength(0);
  });

  it.each([
    ["owner", (grant: TaskHostDispatchGrant) => ({ ...grant, ownerId: "wrong-owner" })],
    ["kind", (grant: TaskHostDispatchGrant) => ({ ...grant, kind: "foreground" as const })],
    ["workspace", (grant: TaskHostDispatchGrant) => ({ ...grant, workspaceIdentityHash: "wrong-workspace" })]
  ])("denies a host dispatch grant with the wrong %s", async (_field, mutate) => {
    store.createTaskGraph(makeGraph([makeStep("fenced", 0)]));
    const executor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const scheduler = makeScheduler(executor, undefined, undefined, "host-owner");
    const [grant] = dispatchGrantsFor("host-owner", ["task-alpha"]);

    expect((await scheduler.runOnce({ dispatchGrants: [mutate(grant!)] })).dispatched).toBe(0);
    expect(store.listAttempts("task-alpha")).toHaveLength(0);
    expect(executor.executions).toHaveLength(0);
  });

  it("allows only one competing scheduler to dispatch with the same current host grant", async () => {
    store.createTaskGraph(makeGraph([makeStep("contended", 0)]));
    const [grant] = acquireDispatchGrants("shared-host", ["task-alpha"]);
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const firstExecutor = new FakeTaskStepExecutor(async () => {
      await gate;
      return { outcome: "succeeded" };
    });
    const secondExecutor = new FakeTaskStepExecutor(() => ({ outcome: "succeeded" }));
    const first = new TaskScheduler({
      store,
      resultService,
      ownerId: "shared-host",
      resolveExecutor: () => firstExecutor,
      now
    });
    const second = new TaskScheduler({
      store,
      resultService,
      ownerId: "shared-host",
      resolveExecutor: () => secondExecutor,
      now
    });

    const firstDispatch = await first.dispatchOnce({ dispatchGrants: [grant!] });
    const secondDispatch = await second.dispatchOnce({ dispatchGrants: [grant!] });
    expect(firstDispatch.dispatched + secondDispatch.dispatched).toBe(1);
    expect(store.listAttempts("task-alpha")).toHaveLength(1);
    expect(secondExecutor.executions).toHaveLength(0);

    finish!();
    await Promise.all([firstDispatch.completion, secondDispatch.completion]);
  });

  it("stops admitting new work and drains the final durable settlement on shutdown", async () => {
    store.createTaskGraph(makeGraph([makeStep("active", 0)]));
    store.createTaskGraph(makeGraphFor("task-waiting", "waiting"));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const executor = new FakeTaskStepExecutor(async ({ task }) => {
      if (task.id === "task-alpha") await gate;
      return { outcome: "succeeded", results: [{ kind: "text", content: task.id }] };
    });
    const scheduler = makeScheduler(executor);
    const active = await scheduler.dispatchOnce({
      dispatchGrants: dispatchGrantsFor("scheduler-alpha", ["task-alpha"])
    });

    let shutdownFinished = false;
    const shutdown = scheduler.shutdown().then(() => { shutdownFinished = true; });
    expect(scheduler.isAcceptingDispatch()).toBe(false);
    expect((await scheduler.dispatchOnce({
      dispatchGrants: dispatchGrantsFor("scheduler-alpha", ["task-waiting"])
    })).dispatched).toBe(0);
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finish!();
    await active.completion;
    await shutdown;

    expect(shutdownFinished).toBe(true);
    expect(scheduler.hasPendingWork()).toBe(false);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(store.getTask("task-waiting")?.status).toBe("queued");
    expect(store.listAttempts("task-waiting")).toHaveLength(0);
  });

  it("fences and requeues an unfinished Attempt for immediate host handoff", async () => {
    store.createTaskGraph(makeGraph([makeStep("handoff", 0, {
      retryPolicy: {
        maxAttempts: 1,
        initialBackoffMs: 0,
        backoffMultiplier: 1,
        maxBackoffMs: 0,
        retryableFailureClasses: [],
        nonRetryableFailureClasses: [],
        requireIdempotent: true
      }
    })]));
    let finishOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
    const foregroundExecutor = new FakeTaskStepExecutor(async () => {
      await oldGate;
      return { outcome: "succeeded", results: [{ kind: "text", content: "stale foreground result" }] };
    });
    const foreground = makeScheduler(foregroundExecutor, undefined, undefined, "foreground-owner");
    const dispatch = await foreground.dispatchOnce({
      dispatchGrants: dispatchGrantsFor("foreground-owner", ["task-alpha"])
    });
    const attemptId = store.listAttempts("task-alpha")[0]!.id;

    await expect(foreground.handoff({
      eligibleTaskIds: ["task-alpha"],
      settleGraceMs: 0,
      abortGraceMs: 0
    })).resolves.toEqual({
      settled: false,
      interrupted: 1,
      stillStopping: 1,
      taskIds: ["task-alpha"]
    });
    expect(store.getTask("task-alpha")?.status).toBe("waiting_for_host");
    expect(store.getStep("step-handoff")?.status).toBe("ready");
    expect(store.getAttempt(attemptId)).toMatchObject({ status: "queued", attemptNumber: 1 });
    expect(store.getAttempt(attemptId)?.lease).toBeUndefined();

    const backgroundExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "background result" }]
    }));
    const background = makeScheduler(backgroundExecutor, undefined, undefined, "background-owner");
    releaseHostLease("task-alpha", "foreground-owner");
    acquireDispatchGrants("background-owner", ["task-alpha"]);
    await expect(background.runOnce()).resolves.toMatchObject({
      dispatched: 1,
      completed: 1
    });
    expect(backgroundExecutor.executions[0]?.attempt.id).toBe(attemptId);
    expect(backgroundExecutor.executions[0]?.attempt.lease?.fencingToken).toBe(2);

    finishOld!();
    await dispatch.completion;
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(store.listResults("task-alpha").map((result) => result.summary ?? result.kind)).toEqual(["text"]);
    expect(store.listEvents("task-alpha", { kinds: ["attempt-interrupted"] })).toHaveLength(1);
  });

  it.each(["unknown", "non_idempotent"] as const)(
    "pauses started %s work for operator review during host handoff",
    async (idempotency) => {
      store.createTaskGraph(makeGraph([makeStep("unsafe-handoff", 0, {
        idempotency,
        retryPolicy: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
          retryableFailureClasses: ["lease-expired", "lease-missing"],
          nonRetryableFailureClasses: [],
          requireIdempotent: false
        }
      })]));
      let finishOld: (() => void) | undefined;
      const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
      const foregroundExecutor = new FakeTaskStepExecutor(async () => {
        await oldGate;
        return { outcome: "succeeded", results: [{ kind: "text", content: "stale foreground result" }] };
      });
      const foreground = makeScheduler(foregroundExecutor, undefined, undefined, "foreground-owner");
      const dispatch = await foreground.dispatchOnce({
        dispatchGrants: dispatchGrantsFor("foreground-owner", ["task-alpha"])
      });
      const attemptId = store.listAttempts("task-alpha")[0]!.id;

      await expect(foreground.handoff({
        eligibleTaskIds: ["task-alpha"],
        settleGraceMs: 0,
        abortGraceMs: 0
      })).resolves.toMatchObject({ settled: false, interrupted: 1, stillStopping: 1 });
      expect(store.getTask("task-alpha")).toMatchObject({
        status: "waiting_for_input",
        waitReason: { kind: "operator" }
      });
      expect(store.getStep("step-unsafe-handoff")?.status).toBe("waiting_for_input");
      expect(store.getAttempt(attemptId)).toMatchObject({
        status: "interrupted",
        failure: { class: "host-handoff-uncertain", uncertainSideEffects: true }
      });
      expect(store.getAttempt(attemptId)?.lease).toBeUndefined();

      const backgroundExecutor = new FakeTaskStepExecutor(() => ({
        outcome: "succeeded",
        results: [{ kind: "text", content: "reviewed background result" }]
      }));
      const background = makeScheduler(backgroundExecutor, undefined, undefined, "background-owner");
      releaseHostLease("task-alpha", "foreground-owner");
      acquireDispatchGrants("background-owner", ["task-alpha"]);
      expect((await background.runOnce()).dispatched).toBe(0);

      new TaskOperatorService({ store, now }).retry("task-alpha", undefined, "creator-alpha");
      await expect(background.runOnce({
        dispatchGrants: dispatchGrantsFor("background-owner", ["task-alpha"])
      })).resolves.toMatchObject({
        dispatched: 1,
        completed: 1
      });
      expect(store.listAttempts("task-alpha").map((attempt) => attempt.status)).toEqual(["interrupted", "completed"]);

      finishOld!();
      await dispatch.completion;
      expect(store.getTask("task-alpha")?.status).toBe("completed");
      expect(store.listResults("task-alpha").map((result) => result.summary ?? result.kind)).toEqual(["text"]);
    }
  );

  it("enforces profile and Task concurrency without duplicate dispatch", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("one", 0),
      makeStep("two", 1),
      makeStep("three", 2)
    ], { maxConcurrentAttempts: 2 }));
    const executor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: step.key }]
    }));
    const scheduler = makeScheduler(executor, { maxProfileConcurrentAttempts: 2 });

    expect((await scheduler.runOnce()).dispatched).toBe(2);
    expect(store.listAttempts("task-alpha")).toHaveLength(2);
    expect((await scheduler.runOnce()).dispatched).toBe(1);
    expect(store.listAttempts("task-alpha")).toHaveLength(3);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
  });

  it("enforces the durable concurrency boundary across scheduler owners", async () => {
    store.createTaskGraph(makeGraph([makeStep("one", 0), makeStep("two", 1)]));
    let finishFirst: ((value: { outcome: "succeeded"; results: [{ kind: "text"; content: string }] }) => void) | undefined;
    const firstExecutor = new FakeTaskStepExecutor(({ step }) => new Promise((resolve) => {
      finishFirst = resolve;
      expect(step.key).toBe("one");
    }));
    const firstScheduler = makeScheduler(firstExecutor, { maxProfileConcurrentAttempts: 1 }, undefined, "scheduler-one");
    const firstRun = firstScheduler.runOnce();
    await vi.waitFor(() => expect(firstExecutor.executions).toHaveLength(1));

    const secondExecutor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: step.key }]
    }));
    const secondScheduler = makeScheduler(secondExecutor, { maxProfileConcurrentAttempts: 1 }, undefined, "scheduler-two");
    expect((await secondScheduler.runOnce()).dispatched).toBe(0);
    expect(secondExecutor.executions).toHaveLength(0);

    finishFirst!({ outcome: "succeeded", results: [{ kind: "text", content: "one" }] });
    await firstRun;
    releaseHostLease("task-alpha", "scheduler-one");
    acquireDispatchGrants("scheduler-two", ["task-alpha"]);
    expect((await secondScheduler.runOnce()).dispatched).toBe(1);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
  });

  it("enforces executor and provider concurrency independently of the Task limit", async () => {
    const executorRoute = { kind: "agent", role: "worker", model: { provider: "openai", id: "test-model" } } as const;
    store.createTaskGraph(makeGraph([
      makeStep("one", 0, { executor: executorRoute }),
      makeStep("two", 1, { executor: executorRoute })
    ], { maxConcurrentAttempts: 2 }));
    const executor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: step.key }]
    }));
    const scheduler = makeScheduler(executor, {
      maxProfileConcurrentAttempts: 2,
      maxConcurrentByExecutor: { agent: 1 },
      maxConcurrentByProvider: { openai: 1 }
    });

    expect((await scheduler.runOnce()).dispatched).toBe(1);
    expect((await scheduler.runOnce()).dispatched).toBe(1);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
  });

  it("applies deterministic retry backoff and reuses no logical dispatch", async () => {
    store.createTaskGraph(makeGraph([makeStep("retry", 0, {
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 100,
        backoffMultiplier: 2,
        maxBackoffMs: 1_000,
        retryableFailureClasses: ["transient"],
        nonRetryableFailureClasses: ["security-deny"],
        requireIdempotent: true
      }
    })]));
    const executor = new FakeTaskStepExecutor((_input, executionNumber) => executionNumber === 1
      ? {
          outcome: "failed",
          failure: { class: "transient", message: "Temporary failure.", retryable: true, uncertainSideEffects: false }
        }
      : { outcome: "succeeded", results: [{ kind: "text", content: "recovered" }] });
    const scheduler = makeScheduler(executor);

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, failed: 1 });
    expect(store.getStep("step-retry")?.status).toBe("ready");
    nowMs += 99;
    expect((await scheduler.runOnce()).dispatched).toBe(0);
    nowMs += 1;
    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1 });
    expect(store.listAttempts("task-alpha").map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
  });

  it("pauses uncertain non-idempotent work for operator review", async () => {
    const step = makeStep("unsafe", 0, {
      idempotency: "non_idempotent",
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 0,
        backoffMultiplier: 1,
        maxBackoffMs: 0,
        retryableFailureClasses: ["transient"],
        nonRetryableFailureClasses: ["security-deny"],
        requireIdempotent: false
      }
    });
    store.createTaskGraph(makeGraph([step]));
    const executor = new FakeTaskStepExecutor(() => ({
      outcome: "failed",
      failure: { class: "transient", message: "Outcome is ambiguous.", retryable: true, uncertainSideEffects: true }
    }));

    expect(await makeScheduler(executor).runOnce()).toMatchObject({ dispatched: 1, failed: 1 });
    expect(store.listAttempts("task-alpha")).toHaveLength(1);
    expect(store.getStep(step.id)?.status).toBe("waiting_for_input");
    expect(store.getTask("task-alpha")).toMatchObject({
      status: "waiting_for_input",
      waitReason: { kind: "operator" }
    });
    expect(classifyTaskRetry(step, store.listAttempts("task-alpha")[0]!)).toMatchObject({
      retry: false,
      reason: "uncertain-side-effects"
    });
  });

  it("fails acceptance when a required result is absent", async () => {
    store.createTaskGraph(makeGraph([makeStep("required", 0)]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => ({ outcome: "succeeded" })));

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, failed: 1 });
    expect(store.getTask("task-alpha")?.status).toBe("failed");
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({
      status: "failed",
      failure: { class: "required-result-missing" }
    });
    expect(store.listResults("task-alpha")).toEqual([]);
  });

  it("fails deterministic acceptance when a required durable result is empty", async () => {
    store.createTaskGraph(makeGraph([makeStep("required", 0)]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "" }]
    })));

    await scheduler.runOnce();

    expect(store.getTask("task-alpha")).toMatchObject({
      status: "failed",
      failure: { class: "empty-result" }
    });
    expect(store.listResults("task-alpha")).toHaveLength(0);
  });

  it("retries a failed atomic publication without exposing stale or duplicate Results", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("publish", 0),
      makeStep("consume", 1, { dependsOn: ["step-publish"] })
    ]));
    const resultEventIds = [
      "duplicate-result-event",
      "duplicate-result-event",
      "retry-result-event",
      "consumer-result-event"
    ];
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "profiles", "alpha", "tasks", "results"),
      sessionDb,
      now,
      id: () => nextId("result"),
      handleId: () => nextId("handle"),
      eventId: () => resultEventIds.shift()!
    });
    let downstreamResults: string[] | undefined;
    const executor = new FakeTaskStepExecutor(({ step }, executionNumber) => {
      if (step.key === "consume") {
        downstreamResults = store.listResults("task-alpha")
          .filter((result) => result.stepId === "step-publish")
          .map((result) => result.id);
        return { outcome: "succeeded", results: [{ kind: "text", content: "consumed result" }] };
      }
      return executionNumber === 1 ? {
          outcome: "succeeded",
          results: [
            { kind: "text", content: "first prepared result" },
            { kind: "text", content: "later prepared result" }
          ]
        }
        : { outcome: "succeeded", results: [{ kind: "text", content: "retry result" }] };
    });
    const scheduler = makeScheduler(executor);

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 0, failed: 1 });
    expect(store.listResults("task-alpha")).toEqual([]);
    expect(store.listEvents("task-alpha", { kinds: ["result-recorded"] })).toEqual([]);
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({
      status: "failed",
      failure: { class: "result-persistence-failed", retryable: true }
    });
    expect(store.getStep("step-publish")?.status).toBe("ready");

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(store.getTask("task-alpha")?.status).toBe("running");
    const published = store.listResults("task-alpha");
    expect(published).toEqual([
      expect.objectContaining({ attemptId: store.listAttempts("task-alpha")[1]!.id, byteLength: 12 })
    ]);

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(downstreamResults).toEqual([published[0]!.id]);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(store.listResults("task-alpha")).toHaveLength(2);
    expect(store.listEvents("task-alpha", { kinds: ["result-recorded"] })).toHaveLength(2);
  });

  it("rolls prepared Results back when a later settlement write is invalid", async () => {
    store.createTaskGraph(makeGraph([makeStep("atomic", 0)]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(({ attempt }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "must roll back" }],
      usage: usage(1, 10, 0.1),
      usageEntries: [{ ...usageEntry(attempt, "wrong-owner", 10, 0.1), attemptId: "another-attempt" }]
    })));

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 0, failed: 1 });
    expect(store.listResults("task-alpha")).toEqual([]);
    expect(store.listProviderUsageEntries({ taskId: "task-alpha" })).toEqual([]);
    expect(store.listEvents("task-alpha", { kinds: ["result-recorded", "attempt-completed"] })).toEqual([]);
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({
      status: "failed",
      failure: { class: "invalid-settlement" }
    });
    expect(store.getTask("task-alpha")?.status).toBe("failed");
  });

  it("persists operator-wait Step and Task transitions in the event journal", async () => {
    store.createTaskGraph(makeGraph([makeStep("review", 0, {
      retryPolicy: { ...makeStep("review-policy", 0).retryPolicy, maxAttempts: 1 },
      failurePolicy: { onAttemptsExhausted: "wait_for_operator", optional: false }
    })]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => ({
      outcome: "failed",
      failure: { class: "blocked", message: "Operator decision required.", retryable: false, uncertainSideEffects: false }
    })));

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, failed: 1 });
    expect(store.getStep("step-review")?.status).toBe("waiting_for_input");
    expect(store.getTask("task-alpha")).toMatchObject({ status: "waiting_for_input", waitReason: { kind: "operator" } });
    const transitions = store.listEvents("task-alpha", { kinds: ["step-state-changed", "task-state-changed"] });
    expect(transitions.some((event) => event.data.to === "waiting_for_input" && event.stepId === "step-review"))
      .toBe(true);
    expect(transitions.some((event) => event.data.to === "waiting_for_input" && event.stepId === undefined))
      .toBe(true);
  });

  it("settles a Task as partial after an independent Step exhausts mark-partial policy", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("fails", 0, {
        retryPolicy: { ...makeStep("policy", 0).retryPolicy, maxAttempts: 1 },
        failurePolicy: { onAttemptsExhausted: "mark_partial", optional: false }
      }),
      makeStep("succeeds", 1)
    ]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(({ step }) => step.key === "fails"
      ? {
          outcome: "failed",
          failure: { class: "transient", message: "No more attempts.", retryable: true, uncertainSideEffects: false }
        }
      : { outcome: "succeeded", results: [{ kind: "text", content: "complete" }] }));

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 2, completed: 1, failed: 1 });
    expect(store.getStep("step-fails")?.status).toBe("failed");
    expect(store.getStep("step-succeeds")?.status).toBe("completed");
    expect(store.getTask("task-alpha")?.status).toBe("partial");
  });

  it("persists cancellation, aborts local execution, and rejects late success", async () => {
    store.createTaskGraph(makeGraph([makeStep("long", 0)]));
    const executor = new FakeTaskStepExecutor(({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true });
    }));
    const scheduler = makeScheduler(executor);

    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(executor.executions).toHaveLength(1));
    expect(scheduler.cancelTask("task-alpha")).toMatchObject({ status: "cancelled" });
    expect(await running).toMatchObject({ dispatched: 1, cancelled: 1 });
    expect(store.getTask("task-alpha")?.status).toBe("cancelled");
    expect(store.getStep("step-long")?.status).toBe("cancelled");
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({ status: "cancelled" });
    expect(store.listAttempts("task-alpha")[0]?.lease).toBeUndefined();
    expect(store.listResults("task-alpha")).toEqual([]);
    expect(store.listEvents("task-alpha", { kinds: ["step-state-changed"] })
      .some((event) => event.data.to === "cancelled" && event.stepId === "step-long"))
      .toBe(true);
  });

  it("renews leases from executor heartbeat", async () => {
    store.createTaskGraph(makeGraph([makeStep("heartbeat", 0)]));
    let renewedExpiry: string | undefined;
    const scheduler = makeScheduler(new FakeTaskStepExecutor((input) => {
      nowMs += 10_000;
      renewedExpiry = input.heartbeat().expiresAt;
      return { outcome: "succeeded", results: [{ kind: "text", content: "alive" }] };
    }), undefined, 30_000);

    expect(await scheduler.runOnce()).toMatchObject({ completed: 1, leaseLost: 0 });
    expect(renewedExpiry).toBe("2030-01-01T00:00:40.000Z");
  });

  it("checkpoints and links durable worker progress under the Attempt fence", async () => {
    store.createTaskGraph(makeGraph([makeStep("checkpoint", 0)]));
    await sessionDb.createSession({
      id: "worker-alpha",
      profileId: "alpha",
      parentSessionId: "creator-alpha",
      metadata: { kind: "task-step-worker" }
    });
    await sessionDb.saveTrajectory({
      id: "trajectory-alpha",
      profileId: "alpha",
      sessionId: "worker-alpha",
      modelId: "test-model",
      events: []
    });
    const scheduler = makeScheduler(new FakeTaskStepExecutor((input) => {
      input.checkpoint({
        workerSessionId: "worker-alpha",
        trajectoryId: "trajectory-alpha",
        activity: { kind: "tool", label: "Using browser.navigate", toolCategory: "browser" }
      });
      return { outcome: "succeeded", results: [{ kind: "text", content: "checkpointed" }] };
    }));

    const run = await scheduler.runOnce();
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({
      status: "completed",
      workerSessionId: "worker-alpha",
      trajectoryId: "trajectory-alpha"
    });
    expect(run).toMatchObject({ dispatched: 1, completed: 1, leaseLost: 0 });
    expect(store.listSessionLinks("task-alpha")).toContainEqual(expect.objectContaining({
      sessionId: "worker-alpha",
      relationship: "worker",
      stepId: "step-checkpoint",
      attemptId: store.listAttempts("task-alpha")[0]?.id
    }));
    expect(store.listEvents("task-alpha", { kinds: ["attempt-progressed"] })).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          activity: { kind: "tool", label: "Using browser.navigate", toolCategory: "browser" }
        })
      })
    ]);
  });

  it("reconciles an expired retry-safe Attempt after restart and retries only through policy", async () => {
    const graph = makeGraph([makeStep("recover", 0, { idempotency: "retry_safe" })]);
    graph.task.status = "running";
    graph.task.startedAt = NOW;
    graph.steps[0]!.status = "running";
    store.createTaskGraph(graph);
    store.createAttempt(makeRunningAttempt(graph.steps[0]!, "attempt-before-restart", "2029-12-31T23:59:00.000Z"));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "recovered after restart" }]
    })));

    expect(await scheduler.runOnce()).toMatchObject({ reconciled: 1, dispatched: 1, completed: 1 });
    expect(store.listAttempts("task-alpha").map((attempt) => attempt.status)).toEqual(["expired", "completed"]);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
    expect(store.listEvents("task-alpha", { kinds: ["attempt-expired"] })).toHaveLength(1);
  });

  it.each(["unknown", "non_idempotent"] as const)(
    "pauses an expired started %s Attempt until an operator retries it",
    async (idempotency) => {
      const graph = makeGraph([makeStep("unsafe-recover", 0, {
        idempotency,
        retryPolicy: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
          retryableFailureClasses: ["lease-expired", "lease-missing"],
          nonRetryableFailureClasses: [],
          requireIdempotent: false
        }
      })]);
      graph.task.status = "running";
      graph.task.startedAt = NOW;
      graph.steps[0]!.status = "running";
      store.createTaskGraph(graph);
      store.createAttempt(makeRunningAttempt(
        graph.steps[0]!,
        "attempt-before-restart",
        "2029-12-31T23:59:00.000Z"
      ));
      const leased = store.getAttempt("attempt-before-restart")!;
      store.updateAttempt({ ...leased, status: "running", startedAt: leased.startedAt ?? leased.updatedAt });
      const executor = new FakeTaskStepExecutor(() => ({
        outcome: "succeeded",
        results: [{ kind: "text", content: "operator-approved recovery" }]
      }));
      const scheduler = makeScheduler(executor);

      expect(await scheduler.runOnce()).toMatchObject({ reconciled: 1, dispatched: 0 });
      expect(store.listAttempts("task-alpha")[0]).toMatchObject({
        status: "expired",
        failure: { class: "lease-expired", uncertainSideEffects: true }
      });
      expect(store.getStep("step-unsafe-recover")?.status).toBe("waiting_for_input");
      expect(store.getTask("task-alpha")).toMatchObject({
        status: "waiting_for_input",
        waitReason: { kind: "operator" }
      });

      new TaskOperatorService({ store, now }).retry("task-alpha", undefined, "creator-alpha");
      expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1 });
      expect(store.listAttempts("task-alpha").map((attempt) => attempt.status)).toEqual(["expired", "completed"]);
      expect(store.getTask("task-alpha")?.status).toBe("completed");
    }
  );

  it("reuses a queued crash-boundary Attempt instead of creating a duplicate dispatch", async () => {
    const graph = makeGraph([makeStep("queued", 0)]);
    graph.task.status = "running";
    graph.task.startedAt = NOW;
    graph.steps[0]!.status = "ready";
    store.createTaskGraph(graph);
    const queued = makeRunningAttempt(graph.steps[0]!, "attempt-before-start", "2030-01-01T00:01:00.000Z");
    store.createAttempt({ ...queued, status: "queued", lease: undefined, startedAt: undefined });
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "reused" }]
    })));

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1 });
    expect(store.listAttempts("task-alpha")).toHaveLength(1);
    expect(store.listAttempts("task-alpha")[0]).toMatchObject({ id: "attempt-before-start", status: "completed" });
  });

  it("refuses result settlement after lease expiry and reconciles it on the next pass", async () => {
    store.createTaskGraph(makeGraph([makeStep("stale", 0)]));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(() => {
      nowMs += 31_000;
      return { outcome: "succeeded", results: [{ kind: "text", content: "too late" }] };
    }), undefined, 30_000);

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, leaseLost: 1, completed: 0 });
    expect(store.listResults("task-alpha")).toEqual([]);
    expect((await scheduler.runOnce()).reconciled).toBe(1);
    expect(store.listAttempts("task-alpha")[0]?.status).toBe("expired");
  });

  it("waits for an eligible host and pauses before exceeding a zero provider-call execution limit", async () => {
    store.createTaskGraph(makeGraph([makeStep("host", 0, {
      executionLimits: { maxProviderCalls: 0, maxTotalTokens: 50_000, maxWallClockMs: 300_000 }
    })], { maxProviderCalls: 0 }));
    acquireDispatchGrants("scheduler-alpha");
    const unavailable = new TaskScheduler({
      store,
      resultService,
      ownerId: "scheduler-alpha",
      resolveExecutor: () => undefined,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });
    expect((await unavailable.runOnce()).dispatched).toBe(0);
    expect(store.getTask("task-alpha")?.status).toBe("waiting_for_host");

    const task = store.getTask("task-alpha")!;
    store.updateTask({ ...task, status: "queued", waitReason: undefined, updatedAt: now().toISOString() });
    expect((await makeScheduler(new FakeTaskStepExecutor()).runOnce()).dispatched).toBe(0);
    expect(store.getTask("task-alpha")).toMatchObject({ status: "paused", waitReason: { kind: "execution_limit" } });
  });

  it("continues eligible independent work before waiting for a missing executor", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("unsupported", 0),
      makeStep("supported", 1)
    ]));
    const executor = new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: step.key }]
    }));
    acquireDispatchGrants("scheduler-alpha");
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "scheduler-alpha",
      resolveExecutor: (_task, step) => step.key === "supported" ? executor : undefined,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 1 });
    expect(store.getStep("step-supported")?.status).toBe("completed");
    expect(store.getStep("step-unsupported")?.status).toBe("ready");
    expect(store.getTask("task-alpha")?.status).toBe("running");

    expect((await scheduler.runOnce()).dispatched).toBe(0);
    expect(store.getTask("task-alpha")).toMatchObject({
      status: "waiting_for_host",
      waitReason: { kind: "eligible_host" }
    });
  });

  it("does not pause active work while a provider-call reservation is still settling", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("one", 0, { executionLimits: { ...makeStep("one-budget", 0).executionLimits, maxProviderCalls: 1 } }),
      makeStep("two", 1, { executionLimits: { ...makeStep("two-budget", 1).executionLimits, maxProviderCalls: 1 } })
    ], { maxConcurrentAttempts: 2, maxProviderCalls: 1 }));
    const scheduler = makeScheduler(new FakeTaskStepExecutor(({ step }) => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: step.key }]
    })));

    expect((await scheduler.runOnce()).dispatched).toBe(1);
    expect(store.getTask("task-alpha")?.status).toBe("running");
    expect(store.getStep("step-one")?.status).toBe("completed");
    expect(store.getStep("step-two")?.status).toBe("ready");
    expect((await scheduler.runOnce()).dispatched).toBe(0);
    expect(store.getTask("task-alpha")).toMatchObject({ status: "paused", waitReason: { kind: "execution_limit" } });
  });

  it("durably pauses for approval, resumes the same Attempt with a higher fence, and preserves usage", async () => {
    store.createTaskGraph(makeGraph([makeStep("approval", 0)]));
    const queue = new GatewayApprovalQueue({
      db: sessionDb.db,
      controller: new WorkspaceApprovalController(),
      now,
      idFactory: () => nextId("pending-approval")
    });
    const approvals = new TaskApprovalService({
      store,
      queue,
      now,
      id: () => nextId("task-approval")
    });
    const executor = new FakeTaskStepExecutor(({ attempt }, executionNumber) => executionNumber === 1
      ? {
          outcome: "waiting_for_approval",
          approval: {
            toolName: "file.write",
            riskClass: "workspace-write",
            targetFingerprint: `sha256:${"a".repeat(64)}`,
            targetPreview: "write workspace file"
          },
          usage: usage(1, 10, 0.1),
          usageEntries: [usageEntry(attempt, "request-one", 10, 0.1)]
        }
      : {
          outcome: "succeeded",
          results: [{ kind: "text", content: "approved result" }],
          usage: usage(1, 20, 0.2),
          usageEntries: [usageEntry(attempt, "request-two", 20, 0.2)]
        });
    acquireDispatchGrants("scheduler-alpha");
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "scheduler-alpha",
      resolveExecutor: () => executor,
      approvalService: approvals,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });

    expect(await scheduler.runOnce()).toMatchObject({ dispatched: 1, completed: 0, failed: 0 });
    const attemptId = store.listAttempts("task-alpha")[0]!.id;
    expect(store.getAttempt(attemptId)).toMatchObject({ status: "waiting_for_approval", usage: { providerCalls: 1 } });
    expect(store.getTask("task-alpha")).toMatchObject({
      status: "waiting_for_approval",
      waitReason: { kind: "approval" }
    });

    await scheduler.runOnce();
    const link = store.listApprovalLinks({ taskId: "task-alpha" })[0]!;
    expect(link).toMatchObject({ status: "pending", authorizedSessionId: "creator-alpha" });
    await queue.resolveApproval(link.pendingApprovalId!, "approved", "operator", {
      profileId: "alpha",
      sessionId: "creator-alpha"
    });
    await approvals.reconcile();
    expect(store.getApprovalLink(link.id)?.status).toBe("approved");

    const resumed = await scheduler.runOnce();
    expect(resumed).toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(executor.executions).toHaveLength(2);
    expect(executor.executions.map((execution) => execution.attempt.id)).toEqual([attemptId, attemptId]);
    expect(executor.executions.map((execution) => execution.attempt.lease?.fencingToken)).toEqual([1, 2]);
    expect(store.getAttempt(attemptId)).toMatchObject({
      status: "completed",
      usage: { providerCalls: 2, totalTokens: 30 }
    });
    expect(store.getAttempt(attemptId)!.usage.estimatedCostUsd).toBeCloseTo(0.3, 12);
    expect(store.listProviderUsageEntries({ taskId: "task-alpha", attemptId }).map((entry) => entry.requestKey)).toEqual([
      "request-one",
      "request-two"
    ]);
    expect(store.getTask("task-alpha")?.status).toBe("completed");
  });

  it("pauses on an exact spending denial while preserving completed Results", async () => {
    store.createTaskGraph(makeGraph([
      makeStep("research-before-limit", 0),
      makeStep("synthesis-after-limit", 1, {
        dependsOn: ["step-research-before-limit"],
        executor: { kind: "agent", role: "synthesis" }
      })
    ]));
    const executor = new FakeTaskStepExecutor(({ step }) => step.executor.role === "synthesis"
      ? {
          outcome: "spending_denied",
          reason: "TASK_LIMIT_EXHAUSTED",
          usage: usage(0, 0, 0)
        }
      : {
          outcome: "succeeded",
          results: [{ kind: "text", content: "preserved research" }]
        });
    const scheduler = makeScheduler(executor);

    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    const preservedResultId = store.listResults("task-alpha")[0]?.id;
    expect(preservedResultId).toBeDefined();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ dispatched: 1, completed: 0, failed: 0 });

    const deniedAttempt = store.listAttempts("task-alpha", "step-synthesis-after-limit")[0];
    expect(deniedAttempt).toMatchObject({
      status: "interrupted",
      failure: { class: "provider-spend-task-limit-exhausted", retryable: false }
    });
    expect(store.getStep("step-synthesis-after-limit")?.status).toBe("ready");
    expect(store.getTask("task-alpha")).toMatchObject({
      status: "paused",
      waitReason: {
        kind: "execution_limit",
        summary: expect.stringContaining("Task tree has reached")
      }
    });
    expect(store.listResults("task-alpha").map((result) => result.id)).toEqual([preservedResultId]);
    expect(store.listEvents("task-alpha")).toContainEqual(expect.objectContaining({
      kind: "task-state-changed",
      data: expect.objectContaining({ reasonCode: "TASK_LIMIT_EXHAUSTED" })
    }));
  });

  function now(): Date {
    return new Date(nowMs);
  }

  function nextId(prefix: string): string {
    return `${prefix}-${++ids}`;
  }

  function acquireDispatchGrants(
    ownerId: string,
    taskIds = store.listTasks().map((task) => task.id),
    kind: TaskHostKind = "background"
  ): TaskHostDispatchGrant[] {
    return taskIds.flatMap((taskId) => {
      const task = store.getTask(taskId);
      if (task === null) return [];
      const existing = store.getTaskHostLease(taskId);
      if (existing !== null && existing.ownerId === ownerId && existing.kind === kind &&
          Date.parse(existing.expiresAt) > nowMs) {
        return [taskHostDispatchGrant(existing)];
      }
      const lease = store.acquireTaskHostLease({
        taskId,
        workspaceIdentityHash: task.workspace.identityHash,
        ownerId,
        kind,
        acquiredAt: now().toISOString(),
        expiresAt: new Date(nowMs + 60_000).toISOString()
      });
      return lease === null ? [] : [taskHostDispatchGrant(lease)];
    });
  }

  function dispatchGrantsFor(ownerId: string, taskIds: readonly string[]): TaskHostDispatchGrant[] {
    return acquireDispatchGrants(ownerId, [...taskIds]);
  }

  function releaseHostLease(taskId: string, ownerId: string): void {
    const lease = store.getTaskHostLease(taskId);
    if (lease === null || lease.ownerId !== ownerId) return;
    store.releaseTaskHostLease({
      taskId,
      workspaceIdentityHash: lease.workspaceIdentityHash,
      ownerId,
      kind: lease.kind,
      fencingToken: lease.fencingToken
    });
  }

  function makeScheduler(
    executor: FakeTaskStepExecutor,
    limits?: TaskSchedulerLimits,
    leaseMs?: number,
    ownerId = "scheduler-alpha"
  ): TaskScheduler {
    acquireDispatchGrants(ownerId);
    return new TaskScheduler({
      store,
      resultService,
      ownerId,
      resolveExecutor: () => executor,
      limits,
      leaseMs,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });
  }
});

const NOW = "2030-01-01T00:00:00.000Z";

function makeGraph(
  steps: TaskStep[],
  budgetOverrides: Partial<Task["executionLimits"]> = {}
): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const task: Task = {
    id: "task-alpha",
    profileId: "alpha",
    creatorSessionId: "creator-alpha",
    rootTaskId: "task-alpha",
    originSessionId: "creator-alpha",
    source: "cli",
    executionPreference: "auto",
    creationKey: "create-alpha",
    objective: "Execute a deterministic durable Task.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: authorityPolicy(),
    executionLimits: {
      maxConcurrentAttempts: 2,
      maxProviderCalls: 10,
      maxTotalTokens: 100_000,
      maxWallClockMs: 600_000,
      ...budgetOverrides
    },
    activePlanRevisionId: "revision-alpha",
    createdBy: { kind: "user", sessionId: "creator-alpha" },
    createdAt: NOW,
    updatedAt: NOW
  };
  const revision: TaskPlanRevision = {
    id: "revision-alpha",
    profileId: "alpha",
    taskId: task.id,
    revision: 1,
    status: "active",
    reason: "Scheduler test plan.",
    createdBy: task.createdBy,
    createdAt: NOW,
    validatedAt: NOW,
    activatedAt: NOW
  };
  return { task, revision, steps };
}

function makeGraphFor(
  taskId: string,
  stepKey: string
): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const revisionId = `revision-${taskId}`;
  const step = makeStep(stepKey, 0, {
    id: `step-${taskId}-${stepKey}`,
    taskId,
    planRevisionId: revisionId
  });
  const graph = makeGraph([step]);
  return {
    task: {
      ...graph.task,
      id: taskId,
      rootTaskId: taskId,
      creationKey: `create-${taskId}`,
      activePlanRevisionId: revisionId
    },
    revision: { ...graph.revision, id: revisionId, taskId },
    steps: [step]
  };
}

function makeStep(
  key: string,
  position: number,
  overrides: Partial<TaskStep> = {}
): TaskStep {
  return {
    id: `step-${key}`,
    profileId: "alpha",
    taskId: "task-alpha",
    planRevisionId: "revision-alpha",
    key,
    position,
    status: "pending",
    title: `Execute ${key}`,
    objective: `Complete ${key}.`,
    dependsOn: [],
    executor: { kind: "agent", role: "worker" },
    childTaskPolicy: "forbid",
    authorityPolicy: authorityPolicy(),
    executionLimits: {
      maxProviderCalls: 5,
      maxTotalTokens: 50_000,
      maxWallClockMs: 300_000
    },
    retryPolicy: {
      maxAttempts: 2,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: ["transient", "lease-expired", "lease-missing", "result-persistence-failed"],
      nonRetryableFailureClasses: ["security-deny"],
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

function makeRunningAttempt(step: TaskStep, id: string, expiresAt: string): TaskAttempt {
  return {
    id,
    profileId: "alpha",
    taskId: step.taskId,
    planRevisionId: step.planRevisionId,
    stepId: step.id,
    attemptNumber: 1,
    status: "running",
    dispatchKey: taskDispatchKey(step.taskId, step.planRevisionId, step.id, 1),
    lease: {
      attemptId: id,
      profileId: "alpha",
      taskId: step.taskId,
      ownerId: "scheduler-before-restart",
      fencingToken: 1,
      acquiredAt: "2029-12-31T23:58:00.000Z",
      heartbeatAt: "2029-12-31T23:58:30.000Z",
      expiresAt
    },
    usage: {
      providerCalls: 1,
      inputTokens: 10,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 10,
      estimatedCostUsd: 0.01,
      usageComplete: false,
      pricingComplete: true,
      incompleteReasons: ["restart"]
    },
    resultIds: [],
    createdAt: "2029-12-31T23:58:00.000Z",
    updatedAt: "2029-12-31T23:58:30.000Z",
    startedAt: "2029-12-31T23:58:00.000Z"
  };
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["core"],
    allowedTools: ["task.result.read"],
    blockedTools: [],
    riskClassPolicy: riskPolicy({ "read-only-local": "runtime_policy" }),
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function usage(providerCalls: number, totalTokens: number, estimatedCostUsd: number) {
  return {
    providerCalls,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: []
  };
}

function usageEntry(attempt: TaskAttempt, requestKey: string, totalTokens: number, estimatedCostUsd: number) {
  return {
    id: `usage-${requestKey}`,
    profileId: attempt.profileId,
    sessionId: "creator-alpha",
    visibleTurnId: "visible-turn-alpha",
    taskId: attempt.taskId,
    rootTaskId: attempt.taskId,
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
    dispatchedAt: NOW
  };
}

function riskPolicy(
  overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>
): Record<ToolRiskClass, TaskAuthorityDisposition> {
  return Object.fromEntries(
    TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])
  ) as Record<ToolRiskClass, TaskAuthorityDisposition>;
}
