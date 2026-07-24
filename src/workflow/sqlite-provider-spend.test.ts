import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSpendRequest } from "../contracts/provider-spend.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type {
  Task,
  TaskAttempt,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import { TASK_ORIGIN_COMPLETION_DELIVERY_KEY } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { ProviderSpendIntegrityError, SQLiteProviderSpendController } from "./sqlite-provider-spend.js";

const PROFILE_ID = "alpha";
const SESSION_LIMIT = { maxEstimatedCostUsd: 10, warningThresholdPercent: 80 };
const TASK_LIMIT = { maxEstimatedCostUsd: 5, warningThresholdPercent: 80 };
const CREATED_AT = "2030-01-01T00:00:00.000Z";
const DISPATCHED_AT = "2030-01-01T00:00:01.000Z";
const SETTLED_AT = "2030-01-01T00:00:02.000Z";

describe("SQLiteProviderSpendController", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let controller: SQLiteProviderSpendController;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-provider-spend-"));
    sessionDb = new SQLiteSessionDB({
      path: join(tempDir, "sessions.sqlite"),
      now: () => new Date(CREATED_AT)
    });
    await sessionDb.createSession({ id: "origin", profileId: PROFILE_ID, spendingLimit: SESSION_LIMIT });
    await sessionDb.appendMessage({
      id: "visible-turn",
      sessionId: "origin",
      role: "user",
      content: "Do the work"
    });
    await sessionDb.createSession({
      id: "worker",
      profileId: PROFILE_ID,
      parentSessionId: "origin",
      spendingScopeSessionId: "origin",
      spendingLimit: SESSION_LIMIT
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(taskGraph());
    taskStore.atomicWrite((store) => store.createAttempt(taskAttempt()));
    controller = new SQLiteProviderSpendController({ db: sessionDb.db, profileId: PROFILE_ID });
  });

  afterEach(() => {
    try { controller.dispose("2030-01-01T01:00:00.000Z"); } catch { /* test may intentionally corrupt state */ }
    vi.useRealTimers();
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("atomically reserves every enabled scope and returns a typed capacity denial", () => {
    const first = controller.reserve(spendRequest(), CREATED_AT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.attempt.state).toBe("reserved");
    expect(first.attempt).toMatchObject({
      executionOwnerId: expect.stringMatching(/^provider-spend-/u),
      executionFencingToken: 1,
      executionHeartbeatAt: CREATED_AT,
      executionExpiresAt: "2030-01-01T00:01:00.000Z"
    });
    expect(first.attempt.allocations.map((allocation) => allocation.scopeKind))
      .toEqual(["root_task", "session"]);
    expect(controller.getScope("session", "origin")?.reservedCostUsd).toBe(4);
    expect(controller.getScope("root_task", "task-root")?.reservedCostUsd).toBe(4);

    const denied = controller.reserve(spendRequest({
      requestKey: "request-2",
      providerAttemptIndex: 1,
      maximumEstimatedCostUsd: 2
    }), CREATED_AT);
    expect(denied).toMatchObject({
      ok: false,
      reason: "TASK_CAPACITY_RESERVED",
      requestedCostUsd: 2,
      availableCostUsd: 1
    });
    expect(controller.getAttempt("request-2")).toBeNull();
    expect(controller.getScope("session", "origin")?.reservedCostUsd).toBe(4);
  });

  it("deduplicates a canonical request without re-emitting its warning", () => {
    const first = controller.reserve(spendRequest(), CREATED_AT);
    const replay = controller.reserve(spendRequest(), CREATED_AT);
    expect(first).toMatchObject({ ok: true, warnings: [{ scopeKind: "root_task" }] });
    expect(replay).toMatchObject({ ok: true, attempt: first.ok ? first.attempt : undefined });
    expect(replay).not.toHaveProperty("warnings");
    expect(controller.getScope("root_task", "task-root")?.reservedCostUsd).toBe(4);

    expect(sessionDb.db.query<{ count: number }>(
      "select count(*) as count from provider_spending_warnings where profile_id = ?"
    ).get(PROFILE_ID)).toEqual({ count: 1 });
    expect(sessionDb.db.query<{ count: number }>(
      "select count(*) as count from task_events where profile_id = ? and kind = 'provider-spending-warning'"
    ).get(PROFILE_ID)).toEqual({ count: 1 });
    expect(sessionDb.db.query<{ count: number }>(
      "select count(*) as count from session_events where session_id = ? and json_extract(event_json, '$.kind') = 'provider-spending-warning'"
    ).get("origin")).toEqual({ count: 1 });

    expect(() => controller.reserve(spendRequest({ model: "different-model" }), CREATED_AT))
      .toThrow(/conflicts with another request/i);
  });

  it("queues a threshold warning for the Task's authorized external origin", () => {
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.atomicWrite((store) => store.createDeliveryBinding({
      id: "origin-delivery",
      profileId: PROFILE_ID,
      taskId: "task-root",
      authorizedSessionId: "origin",
      deliveryKey: TASK_ORIGIN_COMPLETION_DELIVERY_KEY,
      destination: { platform: "telegram", chatId: "chat-1" },
      status: "pending",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    }));

    const result = controller.reserve(spendRequest(), CREATED_AT);

    expect(result).toMatchObject({ ok: true, warnings: [{ scopeKind: "root_task" }] });
    expect(taskStore.listProviderSpendingWarningDeliveries()).toEqual([
      expect.objectContaining({
        scopeKind: "root_task",
        scopeOwnerId: "task-root",
        deliveryBindingId: "origin-delivery",
        deliveryStatus: "pending"
      })
    ]);
  });

  it("durably marks dispatch and atomically settles immutable usage into both scopes", () => {
    controller.reserve(spendRequest(), CREATED_AT);
    expect(controller.markDispatching("request-1", DISPATCHED_AT).state).toBe("dispatching");

    const settled = controller.settle("request-1", usageEntry(3), SETTLED_AT);
    expect(settled).toMatchObject({
      state: "settled",
      actualEstimatedCostUsd: 3,
      usageEntryId: "usage-1"
    });
    expect(controller.getScope("session", "origin")).toMatchObject({
      spentCostUsd: 3,
      reservedCostUsd: 0,
      state: "available"
    });
    expect(controller.getScope("root_task", "task-root")).toMatchObject({
      spentCostUsd: 3,
      reservedCostUsd: 0,
      state: "available"
    });
    expect(sessionDb.db.query<{ id: string }>(
      "select id from provider_usage_entries where profile_id = ? and request_key = ?"
    ).get(PROFILE_ID, "request-1")).toEqual({ id: "usage-1" });
    expect(() => sessionDb.db.query(
      "update provider_usage_entries set estimated_cost_usd = 0 where id = 'usage-1'"
    ).run()).toThrow(/immutable/i);
    expect(() => sessionDb.db.query(
      "update provider_spend_attempts set actual_estimated_cost_usd = 0 where request_key = 'request-1'"
    ).run()).toThrow(/transition is invalid/i);
    expect(controller.verifyMaterializedBalances()).toEqual([]);
  });

  it("releases only pre-dispatch reservations and keeps uncertain dispatch capacity held", () => {
    controller = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "recovering-runtime",
      leaseMs: 1_500,
      heartbeatIntervalMs: 500,
      now: () => new Date(CREATED_AT)
    });
    controller.reserve(spendRequest(), CREATED_AT);
    controller.reserve(spendRequest({
      requestKey: "request-dispatched",
      providerAttemptIndex: 1,
      maximumEstimatedCostUsd: 1
    }), CREATED_AT);
    controller.markDispatching("request-dispatched", DISPATCHED_AT);

    const recovery = controller.recoverExpired(SETTLED_AT);
    expect(recovery).toEqual({
      releasedRequestKeys: ["request-1"],
      uncertainRequestKeys: ["request-dispatched"]
    });
    expect(controller.getAttempt("request-1")?.state).toBe("released");
    expect(controller.getAttempt("request-dispatched")).toMatchObject({
      state: "uncertain",
      uncertaintyReason: "dispatch-outcome-unknown-after-recovery"
    });
    expect(controller.getScope("root_task", "task-root")?.reservedCostUsd).toBe(1);
    expect(() => controller.releaseBeforeDispatch("request-dispatched", SETTLED_AT))
      .toThrow(/cannot be safely released/i);
  });

  it("fences a live reservation from another runtime and never revives it after recovery", () => {
    const owner = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "foreground-runtime",
      leaseMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => new Date(CREATED_AT)
    });
    const observer = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "gateway-runtime",
      leaseMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => new Date(CREATED_AT)
    });
    owner.reserve(spendRequest(), CREATED_AT);

    expect(observer.recoverExpired("2030-01-01T00:00:00.999Z"))
      .toEqual({ releasedRequestKeys: [], uncertainRequestKeys: [] });
    expect(() => observer.reserve(spendRequest(), "2030-01-01T00:00:00.999Z"))
      .toThrow(/another live runtime/i);

    expect(observer.recoverExpired("2030-01-01T00:00:01.000Z"))
      .toEqual({ releasedRequestKeys: ["request-1"], uncertainRequestKeys: [] });
    expect(() => owner.markDispatching("request-1", "2030-01-01T00:00:01.001Z"))
      .toThrow(/cannot dispatch from released/i);
    expect(controller.getScope("session", "origin")?.reservedCostUsd).toBe(0);
    owner.dispose("2030-01-01T00:00:02.000Z");
    observer.dispose("2030-01-01T00:00:02.000Z");
  });

  it("heartbeats an active dispatch so another runtime cannot recover it", async () => {
    vi.useFakeTimers();
    let now = Date.parse(CREATED_AT);
    const owner = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "heartbeat-runtime",
      leaseMs: 1_000,
      heartbeatIntervalMs: 100,
      now: () => new Date(now)
    });
    const observer = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "observer-runtime",
      leaseMs: 1_000,
      heartbeatIntervalMs: 100,
      now: () => new Date(now)
    });
    owner.reserve(spendRequest(), CREATED_AT);
    owner.markDispatching("request-1", CREATED_AT);

    now += 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(owner.getAttempt("request-1")?.executionExpiresAt)
      .toBe("2030-01-01T00:00:01.500Z");
    expect(observer.recoverExpired("2030-01-01T00:00:01.100Z"))
      .toEqual({ releasedRequestKeys: [], uncertainRequestKeys: [] });

    owner.dispose("2030-01-01T00:00:01.200Z");
    expect(owner.getAttempt("request-1")).toMatchObject({
      state: "uncertain",
      uncertaintyReason: "dispatch-outcome-unknown-after-owner-dispose"
    });
    observer.dispose("2030-01-01T00:00:01.200Z");
  });

  it("rejects settlement after the execution lease expires even before recovery runs", () => {
    controller = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "expired-runtime",
      leaseMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => new Date(CREATED_AT)
    });
    controller.reserve(spendRequest(), CREATED_AT);
    controller.markDispatching("request-1", CREATED_AT);

    expect(() => controller.settle(
      "request-1",
      usageEntry(3),
      "2030-01-01T00:00:01.000Z"
    )).toThrow(/lost its execution fence/i);
    expect(controller.getAttempt("request-1")?.state).toBe("dispatching");
    expect(sessionDb.db.query<{ id: string }>(
      "select id from provider_usage_entries where profile_id = ? and request_key = ?"
    ).get(PROFILE_ID, "request-1")).toBeNull();
  });

  it("allocates profile-wide monotonic fencing tokens across runtimes", () => {
    const second = new SQLiteProviderSpendController({
      db: sessionDb.db,
      profileId: PROFILE_ID,
      ownerId: "second-runtime"
    });
    const first = controller.reserve(spendRequest(), CREATED_AT);
    const other = second.reserve(spendRequest({
      requestKey: "request-2",
      providerAttemptIndex: 1,
      maximumEstimatedCostUsd: 1
    }), CREATED_AT);
    expect(first.ok && first.attempt.executionFencingToken).toBe(1);
    expect(other.ok && other.attempt.executionFencingToken).toBe(2);
    expect(() => sessionDb.db.query(
      `update provider_spend_fence_generations
       set last_fencing_token = last_fencing_token + 2 where profile_id = ?`
    ).run(PROFILE_ID)).toThrow(/generation advance is invalid/i);
    expect(() => sessionDb.db.query(
      `update provider_spend_attempts set execution_owner_id = 'forged'
       where profile_id = ? and request_key = 'request-1'`
    ).run(PROFILE_ID)).toThrow(/identity is immutable/i);
    second.dispose("2030-01-01T00:00:01.000Z");
  });

  it("verifies and rebuilds materialized balances from durable allocations and usage facts", () => {
    controller.reserve(spendRequest(), CREATED_AT);
    controller.markDispatching("request-1", DISPATCHED_AT);
    controller.settle("request-1", usageEntry(4.25), SETTLED_AT);

    sessionDb.db.query(
      `update provider_spending_scopes set spent_cost_usd = 0, state = 'available'
       where profile_id = ? and kind = 'root_task' and owner_id = 'task-root'`
    ).run(PROFILE_ID);
    expect(controller.verifyMaterializedBalances().map((issue) => issue.code))
      .toEqual(["MATERIALIZED_SPENT_MISMATCH", "MATERIALIZED_STATE_MISMATCH"]);

    const rebuilt = controller.rebuildMaterializedBalances("2030-01-01T00:00:03.000Z");
    expect(rebuilt.find((scope) => scope.kind === "root_task")).toMatchObject({
      spentCostUsd: 4.25,
      reservedCostUsd: 0,
      state: "warning"
    });
    expect(controller.verifyMaterializedBalances()).toEqual([]);
  });

  it("persists unbudgeted requests without inventing a spending scope", async () => {
    await sessionDb.createSession({ id: "unbudgeted", profileId: PROFILE_ID });
    const result = controller.reserve(spendRequest({
      requestKey: "unbudgeted-request",
      sourceKind: "auxiliary",
      auxiliaryKind: "compression",
      executionSessionId: "unbudgeted",
      sessionBudgetScopeId: undefined,
      visibleTurnId: undefined,
      taskId: undefined,
      rootTaskId: undefined,
      planRevisionId: undefined,
      stepId: undefined,
      attemptId: undefined
    }), CREATED_AT);
    expect(result).toMatchObject({ ok: true, attempt: { allocations: [] } });
  });

  it("keeps a synthesis earmark inside the root Task and Session limits", () => {
    const graph = synthesisTaskGraph();
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(graph);
    taskStore.atomicWrite((store) => {
      store.createAttempt(taskAttemptFor(graph.task.id, graph.revision.id, graph.steps[0]!.id, "attempt-earmark-worker"));
      store.createAttempt(taskAttemptFor(graph.task.id, graph.revision.id, graph.steps[1]!.id, "attempt-earmark-synthesis"));
    });

    const worker = controller.reserve(spendRequest({
      requestKey: "earmark-worker",
      taskId: graph.task.id,
      rootTaskId: graph.task.id,
      planRevisionId: graph.revision.id,
      stepId: graph.steps[0]!.id,
      attemptId: "attempt-earmark-worker",
      maximumEstimatedCostUsd: 4.5
    }), CREATED_AT);
    expect(worker).toMatchObject({
      ok: false,
      reason: "TASK_CAPACITY_RESERVED",
      availableCostUsd: 4
    });

    const synthesis = controller.reserve(spendRequest({
      requestKey: "earmark-synthesis",
      taskId: graph.task.id,
      rootTaskId: graph.task.id,
      planRevisionId: graph.revision.id,
      stepId: graph.steps[1]!.id,
      attemptId: "attempt-earmark-synthesis",
      maximumEstimatedCostUsd: 4.5
    }), CREATED_AT);
    expect(synthesis).toMatchObject({ ok: true, attempt: { reservedCostUsd: 4.5 } });
    expect(controller.getScope("root_task", graph.task.id)?.reservedCostUsd).toBe(4.5);
    expect(controller.getScope("session", "origin")?.reservedCostUsd).toBe(4.5);
  });

  it("protects synthesis under a session-only limit across concurrent workers", async () => {
    await createBudgetSession(sessionDb, "session-only");
    const graph = sessionOnlySynthesisTaskGraph({
      taskId: "task-session-only",
      originSessionId: "session-only",
      originTurnId: "session-only-turn",
      workerCount: 2
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(graph);
    const workerAttempts = graph.steps.slice(0, 2).map((step, index) =>
      taskAttemptFor(graph.task.id, graph.revision.id, step!.id, `attempt-session-worker-${index + 1}`, "session-only-worker")
    );
    const synthesisAttempt = taskAttemptFor(
      graph.task.id,
      graph.revision.id,
      graph.steps[2]!.id,
      "attempt-session-synthesis",
      "session-only-worker"
    );
    taskStore.atomicWrite((store) => {
      for (const attempt of [...workerAttempts, synthesisAttempt]) store.createAttempt(attempt);
    });

    for (const [index, attempt] of workerAttempts.entries()) {
      expect(controller.reserve(taskSpendRequest({
        graph,
        step: graph.steps[index]!,
        attempt,
        requestKey: `session-worker-${index + 1}`,
        maximumEstimatedCostUsd: 4,
        sessionId: "session-only-worker",
        sessionScopeId: "session-only",
        visibleTurnId: "session-only-turn",
        providerAttemptIndex: index
      }), CREATED_AT)).toMatchObject({ ok: true });
    }

    expect(controller.reserve(taskSpendRequest({
      graph,
      step: graph.steps[0]!,
      attempt: workerAttempts[0]!,
      requestKey: "session-worker-overflow",
      maximumEstimatedCostUsd: 0.01,
      sessionId: "session-only-worker",
      sessionScopeId: "session-only",
      visibleTurnId: "session-only-turn",
      providerAttemptIndex: 2
    }), CREATED_AT)).toMatchObject({
      ok: false,
      reason: "SESSION_CAPACITY_RESERVED",
      availableCostUsd: 0
    });

    expect(controller.reserve(taskSpendRequest({
      graph,
      step: graph.steps[2]!,
      attempt: synthesisAttempt,
      requestKey: "session-synthesis",
      maximumEstimatedCostUsd: 2,
      sessionId: "session-only-worker",
      sessionScopeId: "session-only",
      visibleTurnId: "session-only-turn",
      providerAttemptIndex: 3
    }), CREATED_AT)).toMatchObject({ ok: true });
    expect(controller.getScope("session", "session-only")?.reservedCostUsd).toBe(10);
    expect(controller.getScope("root_task", graph.task.id)).toBeNull();
  });

  it("shares a session synthesis earmark across multiple root Tasks", async () => {
    await createBudgetSession(sessionDb, "multi-root");
    const graphA = sessionOnlySynthesisTaskGraph({
      taskId: "task-multi-a",
      originSessionId: "multi-root",
      originTurnId: "multi-root-turn"
    });
    const graphB = sessionOnlySynthesisTaskGraph({
      taskId: "task-multi-b",
      originSessionId: "multi-root",
      originTurnId: "multi-root-turn"
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(graphA);
    taskStore.createTaskGraph(graphB);
    const workerA = taskAttemptFor(
      graphA.task.id, graphA.revision.id, graphA.steps[0]!.id, "attempt-multi-a-worker", "multi-root-worker"
    );
    const workerB = taskAttemptFor(
      graphB.task.id, graphB.revision.id, graphB.steps[0]!.id, "attempt-multi-b-worker", "multi-root-worker"
    );
    const synthesisA = taskAttemptFor(
      graphA.task.id, graphA.revision.id, graphA.steps[1]!.id, "attempt-multi-a-synthesis", "multi-root-worker"
    );
    taskStore.atomicWrite((store) => {
      store.createAttempt(workerA);
      store.createAttempt(workerB);
      store.createAttempt(synthesisA);
    });

    expect(controller.reserve(taskSpendRequest({
      graph: graphA,
      step: graphA.steps[0]!,
      attempt: workerA,
      requestKey: "multi-a-worker",
      maximumEstimatedCostUsd: 7.1,
      sessionId: "multi-root-worker",
      sessionScopeId: "multi-root",
      visibleTurnId: "multi-root-turn"
    }), CREATED_AT)).toMatchObject({ ok: true });
    const denied = controller.reserve(taskSpendRequest({
      graph: graphB,
      step: graphB.steps[0]!,
      attempt: workerB,
      requestKey: "multi-b-worker",
      maximumEstimatedCostUsd: 1,
      sessionId: "multi-root-worker",
      sessionScopeId: "multi-root",
      visibleTurnId: "multi-root-turn",
      providerAttemptIndex: 1
    }), CREATED_AT);
    expect(denied).toMatchObject({ ok: false, reason: "SESSION_CAPACITY_RESERVED" });
    expect(denied.ok ? undefined : denied.availableCostUsd).toBeCloseTo(0.9);

    expect(controller.reserve(taskSpendRequest({
      graph: graphA,
      step: graphA.steps[1]!,
      attempt: synthesisA,
      requestKey: "multi-a-synthesis",
      maximumEstimatedCostUsd: 1.9,
      sessionId: "multi-root-worker",
      sessionScopeId: "multi-root",
      visibleTurnId: "multi-root-turn",
      providerAttemptIndex: 2
    }), CREATED_AT)).toMatchObject({ ok: true });
    expect(controller.getScope("session", "multi-root")?.reservedCostUsd).toBe(9);
  });

  it("does not earmark synthesis capacity already committed by another root", async () => {
    await createBudgetSession(sessionDb, "committed-root");
    const graphA = sessionOnlySynthesisTaskGraph({
      taskId: "task-committed-a",
      originSessionId: "committed-root",
      originTurnId: "committed-root-turn"
    });
    const graphB = sessionOnlySynthesisTaskGraph({
      taskId: "task-committed-b",
      originSessionId: "committed-root",
      originTurnId: "committed-root-turn"
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(graphA);
    taskStore.createTaskGraph(graphB);
    const synthesisA = taskAttemptFor(
      graphA.task.id,
      graphA.revision.id,
      graphA.steps[1]!.id,
      "attempt-committed-a-synthesis",
      "committed-root-worker"
    );
    const workerB = taskAttemptFor(
      graphB.task.id,
      graphB.revision.id,
      graphB.steps[0]!.id,
      "attempt-committed-b-worker",
      "committed-root-worker"
    );
    taskStore.atomicWrite((store) => {
      store.createAttempt(synthesisA);
      store.createAttempt(workerB);
    });

    expect(controller.reserve(taskSpendRequest({
      graph: graphA,
      step: graphA.steps[1]!,
      attempt: synthesisA,
      requestKey: "committed-a-synthesis",
      maximumEstimatedCostUsd: 1,
      sessionId: "committed-root-worker",
      sessionScopeId: "committed-root",
      visibleTurnId: "committed-root-turn"
    }), CREATED_AT)).toMatchObject({ ok: true });
    expect(controller.reserve(taskSpendRequest({
      graph: graphB,
      step: graphB.steps[0]!,
      attempt: workerB,
      requestKey: "committed-b-worker",
      maximumEstimatedCostUsd: 7.5,
      sessionId: "committed-root-worker",
      sessionScopeId: "committed-root",
      visibleTurnId: "committed-root-turn",
      providerAttemptIndex: 1
    }), CREATED_AT)).toMatchObject({ ok: true });
    expect(controller.getScope("session", "committed-root")?.reservedCostUsd).toBe(8.5);
  });

  it("retains synthesis protection after partial worker failure and releases it when synthesis terminates", async () => {
    await createBudgetSession(sessionDb, "partial-root");
    const graph = sessionOnlySynthesisTaskGraph({
      taskId: "task-partial",
      originSessionId: "partial-root",
      originTurnId: "partial-root-turn",
      workerCount: 2
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(graph);
    taskStore.atomicWrite((store) => {
      for (const [index, worker] of graph.steps.slice(0, 2).entries()) {
        store.updateStep({ ...worker!, status: "ready" });
        store.updateStep({ ...worker!, status: "running" });
        store.updateStep({ ...worker!, status: index === 0 ? "completed" : "failed" });
      }
    });

    const mainRequest = spendRequest({
      requestKey: "partial-main",
      executionSessionId: "partial-root",
      sessionBudgetScopeId: "partial-root",
      visibleTurnId: "partial-root-turn",
      taskId: undefined,
      rootTaskId: undefined,
      planRevisionId: undefined,
      stepId: undefined,
      attemptId: undefined,
      sourceKind: "main",
      maximumEstimatedCostUsd: 8.01
    });
    expect(controller.reserve(mainRequest, CREATED_AT)).toMatchObject({
      ok: false,
      reason: "SESSION_CAPACITY_RESERVED",
      availableCostUsd: 8
    });

    const synthesis = graph.steps[2]!;
    taskStore.atomicWrite((store) => {
      store.updateStep({ ...synthesis, status: "ready" });
      store.updateStep({ ...synthesis, status: "running" });
      store.updateStep({ ...synthesis, status: "failed" });
    });
    expect(controller.reserve({
      ...mainRequest,
      requestKey: "partial-main-after-synthesis",
      maximumEstimatedCostUsd: 10
    }, CREATED_AT)).toMatchObject({ ok: true });
  });

  it("fails closed when materialized balances or immutable scope policy are tampered with", () => {
    controller.reserve(spendRequest(), CREATED_AT);
    sessionDb.db.query(
      `update provider_spending_scopes set reserved_cost_usd = 0
       where profile_id = ? and kind = 'session' and owner_id = 'origin'`
    ).run(PROFILE_ID);
    expect(() => controller.reserve(spendRequest({
      requestKey: "request-after-tamper",
      providerAttemptIndex: 1,
      maximumEstimatedCostUsd: 1
    }), CREATED_AT)).toThrow(ProviderSpendIntegrityError);
    expect(() => sessionDb.db.query(
      `update provider_spending_scopes set max_estimated_cost_usd = 100
       where profile_id = ? and kind = 'session' and owner_id = 'origin'`
    ).run(PROFILE_ID)).toThrow(/immutable/i);
  });
});

function spendRequest(overrides: Partial<ProviderSpendRequest> = {}): ProviderSpendRequest {
  return {
    requestKey: "request-1",
    profileId: PROFILE_ID,
    executionSessionId: "worker",
    sessionBudgetScopeId: "origin",
    visibleTurnId: "visible-turn",
    taskId: "task-root",
    rootTaskId: "task-root",
    planRevisionId: "revision-root",
    stepId: "step-root",
    attemptId: "attempt-root",
    sourceKind: "task",
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    pricing: {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      fingerprint: "pricing-v1"
    },
    estimatedInputTokens: 100,
    boundedMaximumOutputTokens: 200,
    maximumEstimatedCostUsd: 4,
    ...overrides
  };
}

function usageEntry(estimatedCostUsd: number): ProviderUsageEntry {
  return {
    id: "usage-1",
    profileId: PROFILE_ID,
    sessionId: "worker",
    sessionBudgetScopeId: "origin",
    visibleTurnId: "visible-turn",
    requestKey: "request-1",
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind: "task",
    pricing: spendRequest().pricing,
    pricingFingerprint: "pricing-v1",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    taskId: "task-root",
    rootTaskId: "task-root",
    planRevisionId: "revision-root",
    stepId: "step-root",
    attemptId: "attempt-root",
    dispatchedAt: DISPATCHED_AT
  };
}

function taskGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const task: Task = {
    id: "task-root",
    profileId: PROFILE_ID,
    creatorSessionId: "origin",
    rootTaskId: "task-root",
    originSessionId: "origin",
    originTurnId: "visible-turn",
    source: "cli",
    executionPreference: "auto",
    objective: "Do the requested work.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: authorityPolicy(),
    spendingLimit: TASK_LIMIT,
    executionLimits: {
      maxConcurrentAttempts: 1,
      maxProviderCalls: 10,
      maxTotalTokens: 10_000,
      maxWallClockMs: 60_000
    },
    activePlanRevisionId: "revision-root",
    createdBy: { kind: "user", sessionId: "origin" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
  const revision: TaskPlanRevision = {
    id: "revision-root",
    profileId: PROFILE_ID,
    taskId: task.id,
    revision: 1,
    status: "active",
    reason: "Initial plan.",
    createdBy: { kind: "user", sessionId: "origin" },
    createdAt: CREATED_AT,
    validatedAt: CREATED_AT,
    activatedAt: CREATED_AT
  };
  const step: TaskStep = {
    id: "step-root",
    profileId: PROFILE_ID,
    taskId: task.id,
    planRevisionId: revision.id,
    key: "execute",
    position: 0,
    status: "pending",
    title: "Execute",
    objective: "Execute the request.",
    dependsOn: [],
    executor: { kind: "agent", role: "worker" },
    childTaskPolicy: "forbid",
    authorityPolicy: authorityPolicy(),
    executionLimits: { maxProviderCalls: 10, maxTotalTokens: 10_000, maxWallClockMs: 60_000 },
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
    resultPolicy: { kind: "text", required: true, maxBytes: 10_000 },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
  return { task, revision, steps: [step] };
}

function taskAttempt(): TaskAttempt {
  return {
    id: "attempt-root",
    profileId: PROFILE_ID,
    taskId: "task-root",
    planRevisionId: "revision-root",
    stepId: "step-root",
    attemptNumber: 1,
    status: "queued",
    dispatchKey: "dispatch-root",
    workerSessionId: "worker",
    usage: {
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      pricingComplete: true,
      incompleteReasons: []
    },
    resultIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
}

function synthesisTaskGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const base = taskGraph();
  const taskId = "task-earmark";
  const revisionId = "revision-earmark";
  const worker: TaskStep = {
    ...base.steps[0]!,
    id: "step-earmark-worker",
    taskId,
    planRevisionId: revisionId,
    key: "worker",
    executionLimits: { ...base.steps[0]!.executionLimits, maxTotalTokens: 8_000 }
  };
  const synthesis: TaskStep = {
    ...base.steps[0]!,
    id: "step-earmark-synthesis",
    taskId,
    planRevisionId: revisionId,
    key: "synthesis",
    position: 1,
    dependsOn: [worker.id],
    executor: { kind: "agent", role: "synthesis" },
    executionLimits: { ...base.steps[0]!.executionLimits, maxTotalTokens: 2_000 }
  };
  return {
    task: {
      ...base.task,
      id: taskId,
      rootTaskId: taskId,
      creationKey: "create-earmark",
      activePlanRevisionId: revisionId
    },
    revision: { ...base.revision, id: revisionId, taskId },
    steps: [worker, synthesis]
  };
}

function taskAttemptFor(
  taskId: string,
  planRevisionId: string,
  stepId: string,
  id: string,
  workerSessionId = "worker"
): TaskAttempt {
  return {
    ...taskAttempt(),
    id,
    taskId,
    planRevisionId,
    stepId,
    dispatchKey: `dispatch-${id}`,
    workerSessionId
  };
}

async function createBudgetSession(sessionDb: SQLiteSessionDB, id: string): Promise<void> {
  await sessionDb.createSession({ id, profileId: PROFILE_ID, spendingLimit: SESSION_LIMIT });
  await sessionDb.appendMessage({
    id: `${id}-turn`,
    sessionId: id,
    role: "user",
    content: "Run the budgeted Task."
  });
  await sessionDb.createSession({
    id: `${id}-worker`,
    profileId: PROFILE_ID,
    parentSessionId: id,
    spendingScopeSessionId: id,
    spendingLimit: SESSION_LIMIT
  });
}

function sessionOnlySynthesisTaskGraph(input: {
  taskId: string;
  originSessionId: string;
  originTurnId: string;
  workerCount?: number;
}): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const base = synthesisTaskGraph();
  const revisionId = `revision-${input.taskId}`;
  const workerCount = input.workerCount ?? 1;
  const workers = Array.from({ length: workerCount }, (_, index): TaskStep => ({
    ...base.steps[0]!,
    id: `step-${input.taskId}-worker-${index + 1}`,
    taskId: input.taskId,
    planRevisionId: revisionId,
    key: `worker-${index + 1}`,
    position: index,
    executionLimits: {
      ...base.steps[0]!.executionLimits,
      maxTotalTokens: 8_000 / workerCount
    }
  }));
  const synthesis: TaskStep = {
    ...base.steps[1]!,
    id: `step-${input.taskId}-synthesis`,
    taskId: input.taskId,
    planRevisionId: revisionId,
    position: workerCount,
    dependsOn: workers.map((worker) => worker.id)
  };
  return {
    task: {
      ...base.task,
      id: input.taskId,
      creatorSessionId: input.originSessionId,
      rootTaskId: input.taskId,
      originSessionId: input.originSessionId,
      originTurnId: input.originTurnId,
      creationKey: `create-${input.taskId}`,
      spendingLimit: undefined,
      activePlanRevisionId: revisionId
    },
    revision: {
      ...base.revision,
      id: revisionId,
      taskId: input.taskId,
      createdBy: { kind: "user", sessionId: input.originSessionId }
    },
    steps: [...workers, synthesis]
  };
}

function taskSpendRequest(input: {
  graph: { task: Task; revision: TaskPlanRevision };
  step: TaskStep;
  attempt: TaskAttempt;
  requestKey: string;
  maximumEstimatedCostUsd: number;
  sessionId: string;
  sessionScopeId: string;
  visibleTurnId: string;
  providerAttemptIndex?: number;
}): ProviderSpendRequest {
  return spendRequest({
    requestKey: input.requestKey,
    executionSessionId: input.sessionId,
    sessionBudgetScopeId: input.sessionScopeId,
    visibleTurnId: input.visibleTurnId,
    taskId: input.graph.task.id,
    rootTaskId: input.graph.task.rootTaskId,
    planRevisionId: input.graph.revision.id,
    stepId: input.step.id,
    attemptId: input.attempt.id,
    providerAttemptIndex: input.providerAttemptIndex ?? 0,
    maximumEstimatedCostUsd: input.maximumEstimatedCostUsd
  });
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files"],
    allowedTools: ["file.read"],
    blockedTools: [],
    riskClassPolicy: riskPolicy({ "read-only-local": "runtime_policy" }),
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function riskPolicy(
  overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>
): Record<ToolRiskClass, TaskAuthorityDisposition> {
  return Object.fromEntries(
    TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])
  ) as Record<ToolRiskClass, TaskAuthorityDisposition>;
}
