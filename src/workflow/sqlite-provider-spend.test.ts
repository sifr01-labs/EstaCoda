import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("atomically reserves every enabled scope and returns a typed capacity denial", () => {
    const first = controller.reserve(spendRequest(), CREATED_AT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.attempt.state).toBe("reserved");
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

  it("deduplicates a canonical request and rejects conflicting reuse", () => {
    const first = controller.reserve(spendRequest(), CREATED_AT);
    const replay = controller.reserve(spendRequest(), CREATED_AT);
    expect(replay).toEqual(first);
    expect(controller.getScope("root_task", "task-root")?.reservedCostUsd).toBe(4);

    expect(() => controller.reserve(spendRequest({ model: "different-model" }), CREATED_AT))
      .toThrow(/conflicts with another request/i);
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
    controller.reserve(spendRequest(), CREATED_AT);
    controller.reserve(spendRequest({
      requestKey: "request-dispatched",
      providerAttemptIndex: 1,
      maximumEstimatedCostUsd: 1
    }), CREATED_AT);
    controller.markDispatching("request-dispatched", DISPATCHED_AT);

    const recovery = controller.recoverStale({
      reservedBefore: "2030-01-01T00:00:00.500Z",
      dispatchingBefore: "2030-01-01T00:00:01.500Z",
      recoveredAt: SETTLED_AT
    });
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
