import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSpendRequest, ProviderSpendReservationResult } from "../contracts/provider-spend.js";
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

const PROFILE_ID = "cross-process";
const SESSION_LIMIT = { maxEstimatedCostUsd: 10, warningThresholdPercent: 80 };
const TEST_TIMEOUT_MS = 30_000;

type ChildOperation =
  | { kind: "reserve"; request: ProviderSpendRequest }
  | { kind: "dispatch"; requestKey: string }
  | { kind: "recover"; recoveredAt?: string };

type ChildAction = {
  ownerId: string;
  operations: readonly ChildOperation[];
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  hold?: boolean;
};

type ChildOperationResult =
  | { kind: "reserve"; result: ProviderSpendReservationResult }
  | { kind: "dispatch"; result: { state: string; executionExpiresAt: string } }
  | { kind: "recover"; result: { releasedRequestKeys: string[]; uncertainRequestKeys: string[] } };

type ChildResult = {
  ok: boolean;
  operationResults?: ChildOperationResult[];
  error?: string;
};

type SpendChild = {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<ChildResult>;
  exit: Promise<number | null>;
  start(): void;
  stop(): void;
};

describe("provider spending safety across processes", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionDb: SQLiteSessionDB;
  const children = new Set<SpendChild>();

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-provider-spend-process-"));
    dbPath = join(tempDir, "sessions.sqlite");
    sessionDb = new SQLiteSessionDB({ path: dbPath });
    await createBudgetSession(sessionDb, "origin");
  });

  afterEach(async () => {
    for (const harness of children) {
      if (harness.child.exitCode === null) harness.child.kill("SIGKILL");
    }
    await Promise.allSettled([...children].map((harness) => harness.exit));
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("admits only one CLI/gateway contender for the last available capacity", async () => {
    const contenders = await runTogether([
      childAction("cli-runtime", [{ kind: "reserve", request: mainRequest("cli-last-dollar", 10) }]),
      childAction("gateway-runtime", [{ kind: "reserve", request: mainRequest("gateway-last-dollar", 10) }])
    ]);

    const reservations = contenders.map(singleReservation);
    expect(reservations.filter((result) => result.ok)).toHaveLength(1);
    expect(reservations.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        reason: "SESSION_CAPACITY_RESERVED",
        availableCostUsd: 0
      })
    ]);
    expect(scopeRow("origin")).toMatchObject({ reserved_cost_usd: 10, spent_cost_usd: 0 });
    expect(countRows("provider_spend_attempts")).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("does not recover a dispatch owned by a live heartbeating process", async () => {
    const owner = createChild({
      ownerId: "cli-live-owner",
      operations: [
        { kind: "reserve", request: mainRequest("live-dispatch", 3) },
        { kind: "dispatch", requestKey: "live-dispatch" }
      ],
      leaseMs: 500,
      heartbeatIntervalMs: 100,
      hold: true
    });
    await owner.ready;
    owner.start();
    const ownerResult = await owner.result;
    expect(ownerResult.ok).toBe(true);
    const initialExpiry = dispatchResult(ownerResult).executionExpiresAt;

    await delay(800);
    const recoveredAt = new Date().toISOString();
    const [observerResult] = await runTogether([
      childAction("gateway-observer", [{ kind: "recover", recoveredAt }], {
        leaseMs: 500,
        heartbeatIntervalMs: 100
      })
    ]);

    expect(recoveryResult(observerResult!)).toEqual({ releasedRequestKeys: [], uncertainRequestKeys: [] });
    const attempt = attemptRow("live-dispatch");
    expect(attempt).toMatchObject({ state: "dispatching", execution_owner_id: "cli-live-owner" });
    expect(Date.parse(attempt!.execution_expires_at)).toBeGreaterThan(Date.parse(initialExpiry));
    expect(Date.parse(attempt!.execution_expires_at)).toBeGreaterThan(Date.parse(recoveredAt));

    owner.stop();
    expect(await owner.exit).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("recovers reserved and dispatching capacity conservatively after a process crash", async () => {
    const owner = createChild({
      ownerId: "cli-crashing-owner",
      operations: [
        { kind: "reserve", request: mainRequest("crashed-reservation", 2) },
        { kind: "reserve", request: mainRequest("crashed-dispatch", 3, 1) },
        { kind: "dispatch", requestKey: "crashed-dispatch" }
      ],
      leaseMs: 500,
      heartbeatIntervalMs: 100,
      hold: true
    });
    await owner.ready;
    owner.start();
    const ownerResult = await owner.result;
    expect(ownerResult.ok).toBe(true);
    expect(dispatchResult(ownerResult).state).toBe("dispatching");

    owner.child.kill("SIGKILL");
    expect(await owner.exit).not.toBe(0);
    const persistedExpiry = attemptRow("crashed-dispatch")?.execution_expires_at;
    expect(persistedExpiry).toBeDefined();
    const recoveredAt = new Date(Date.parse(persistedExpiry!) + 1).toISOString();
    const [observerResult] = await runTogether([
      childAction("gateway-recovery", [{ kind: "recover", recoveredAt }], {
        leaseMs: 500,
        heartbeatIntervalMs: 100
      })
    ]);

    expect(recoveryResult(observerResult!)).toEqual({
      releasedRequestKeys: ["crashed-reservation"],
      uncertainRequestKeys: ["crashed-dispatch"]
    });
    expect(attemptRow("crashed-reservation")?.state).toBe("released");
    expect(attemptRow("crashed-dispatch")).toMatchObject({
      state: "uncertain",
      uncertainty_reason: "dispatch-outcome-unknown-after-recovery"
    });
    expect(scopeRow("origin")?.reserved_cost_usd).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("records one warning when concurrent processes cross a threshold", async () => {
    const results = await runTogether([
      childAction("cli-warning", [{ kind: "reserve", request: mainRequest("warning-cli", 4) }]),
      childAction("gateway-warning", [{ kind: "reserve", request: mainRequest("warning-gateway", 4, 1) }])
    ]);

    const reservations = results.map(singleReservation);
    expect(reservations.every((result) => result.ok)).toBe(true);
    expect(reservations.flatMap((result) => result.warnings ?? [])).toEqual([
      expect.objectContaining({
        scopeKind: "session",
        scopeOwnerId: "origin",
        committedCostUsd: 8
      })
    ]);
    expect(countRows("provider_spending_warnings")).toBe(1);
    expect(countRows(
      "session_events",
      "session_id = 'origin' and json_extract(event_json, '$.kind') = 'provider-spending-warning'"
    )).toBe(1);
    expect(scopeRow("origin")).toMatchObject({ state: "warning", reserved_cost_usd: 8 });
  }, TEST_TIMEOUT_MS);

  it("keeps session capacity available for synthesis across worker processes", async () => {
    await createBudgetSession(sessionDb, "synthesis-origin");
    const fixture = createSynthesisFixture();
    const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    store.createTaskGraph({ task: fixture.task, revision: fixture.revision, steps: fixture.steps });
    store.atomicWrite((transaction) => {
      for (const attempt of fixture.attempts) transaction.createAttempt(attempt);
    });

    const workerResults = await runTogether(fixture.steps.slice(0, 2).map((step, index) =>
      childAction(index === 0 ? "cli-worker" : "gateway-worker", [{
        kind: "reserve",
        request: taskRequest({
          fixture,
          step: step!,
          attempt: fixture.attempts[index]!,
          requestKey: `worker-${index + 1}`,
          cost: 4,
          providerAttemptIndex: index
        })
      }])
    ));
    expect(workerResults.map(singleReservation).every((result) => result.ok)).toBe(true);

    const [overflowResult] = await runTogether([childAction("extra-worker", [{
      kind: "reserve",
      request: taskRequest({
        fixture,
        step: fixture.steps[0]!,
        attempt: fixture.attempts[0]!,
        requestKey: "worker-overflow",
        cost: 0.01,
        providerAttemptIndex: 2
      })
    }])]);
    expect(singleReservation(overflowResult!)).toMatchObject({
      ok: false,
      reason: "SESSION_CAPACITY_RESERVED",
      availableCostUsd: 0
    });

    const synthesisIndex = 2;
    const [synthesisResult] = await runTogether([childAction("gateway-synthesis", [{
      kind: "reserve",
      request: taskRequest({
        fixture,
        step: fixture.steps[synthesisIndex]!,
        attempt: fixture.attempts[synthesisIndex]!,
        requestKey: "synthesis",
        cost: 2,
        providerAttemptIndex: 3
      })
    }])]);
    expect(singleReservation(synthesisResult!)).toMatchObject({ ok: true });
    expect(scopeRow("synthesis-origin")).toMatchObject({
      state: "exhausted",
      reserved_cost_usd: 10
    });
  }, TEST_TIMEOUT_MS);

  function createChild(action: ChildAction): SpendChild {
    const harness = spawnSpendChild(dbPath, action);
    children.add(harness);
    return harness;
  }

  async function runTogether(actions: readonly ChildAction[]): Promise<ChildResult[]> {
    const harnesses = actions.map(createChild);
    await Promise.all(harnesses.map((harness) => harness.ready));
    for (const harness of harnesses) harness.start();
    const results = await Promise.all(harnesses.map((harness) => harness.result));
    const exitCodes = await Promise.all(harnesses.map((harness) => harness.exit));
    expect(exitCodes).toEqual(actions.map(() => 0));
    return results;
  }

  function scopeRow(ownerId: string): SpendingScopeRow | null {
    return sessionDb.db.query<SpendingScopeRow>(
      "select * from provider_spending_scopes where profile_id = ? and kind = 'session' and owner_id = ?"
    ).get(PROFILE_ID, ownerId);
  }

  function attemptRow(requestKey: string): SpendAttemptRow | null {
    return sessionDb.db.query<SpendAttemptRow>(
      "select * from provider_spend_attempts where profile_id = ? and request_key = ?"
    ).get(PROFILE_ID, requestKey);
  }

  function countRows(table: string, where?: string): number {
    if (!ALLOWED_COUNT_TABLES.has(table)) throw new Error(`Unsupported test table: ${table}`);
    const suffix = where === undefined ? "" : ` where ${where}`;
    return sessionDb.db.query<{ count: number }>(`select count(*) as count from ${table}${suffix}`).get()?.count ?? 0;
  }
});

function spawnSpendChild(dbPath: string, action: ChildAction): SpendChild {
  const sessionDbUrl = new URL("../session/sqlite-session-db.ts", import.meta.url).href;
  const controllerUrl = new URL("./sqlite-provider-spend.ts", import.meta.url).href;
  const code = `
    import { SQLiteSessionDB } from ${JSON.stringify(sessionDbUrl)};
    import { SQLiteProviderSpendController } from ${JSON.stringify(controllerUrl)};
    const action = ${JSON.stringify(action)};
    const db = new SQLiteSessionDB({ path: ${JSON.stringify(dbPath)} });
    const controller = new SQLiteProviderSpendController({
      db: db.db,
      profileId: ${JSON.stringify(PROFILE_ID)},
      ownerId: action.ownerId,
      ...(action.leaseMs === undefined ? {} : { leaseMs: action.leaseMs }),
      ...(action.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: action.heartbeatIntervalMs })
    });
    const send = (message) => process.send?.(message);
    let started = false;
    process.on("message", (message) => {
      if (message?.kind === "stop") {
        db.close();
        process.disconnect?.();
        return;
      }
      if (message?.kind !== "start" || started) return;
      started = true;
      try {
        const operationResults = [];
        for (const operation of action.operations) {
          if (operation.kind === "reserve") {
            operationResults.push({
              kind: "reserve",
              result: controller.reserve(operation.request, new Date().toISOString())
            });
          } else if (operation.kind === "dispatch") {
            const result = controller.markDispatching(operation.requestKey, new Date().toISOString());
            operationResults.push({
              kind: "dispatch",
              result: { state: result.state, executionExpiresAt: result.executionExpiresAt }
            });
          } else {
            operationResults.push({
              kind: "recover",
              result: controller.recoverExpired(operation.recoveredAt ?? new Date().toISOString())
            });
          }
        }
        send({ kind: "result", value: { ok: true, operationResults } });
        if (!action.hold) {
          db.close();
          process.disconnect?.();
        }
      } catch (error) {
        send({
          kind: "result",
          value: { ok: false, error: error instanceof Error ? error.message : String(error) }
        });
        db.close();
        process.disconnect?.();
      }
    });
    send({ kind: "ready" });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let resultResolve!: (result: ChildResult) => void;
  let resultReject!: (error: Error) => void;
  let becameReady = false;
  let receivedResult = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<ChildResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const readyTimer = setTimeout(() => {
    readyReject(new Error(`Spend child did not become ready. stderr=${stderr}`));
  }, 10_000);
  const resultTimer = setTimeout(() => {
    resultReject(new Error(`Spend child did not return a result. stderr=${stderr}`));
  }, 20_000);
  child.on("message", (message: unknown) => {
    if (!isChildMessage(message)) return;
    if (message.kind === "ready") {
      becameReady = true;
      clearTimeout(readyTimer);
      readyResolve();
    } else {
      receivedResult = true;
      clearTimeout(resultTimer);
      resultResolve(message.value);
    }
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (exitCode) => {
      clearTimeout(readyTimer);
      clearTimeout(resultTimer);
      if (!becameReady) readyReject(new Error(`Spend child exited ${exitCode} before ready. stderr=${stderr}`));
      if (!receivedResult) resultReject(new Error(`Spend child exited ${exitCode} before result. stderr=${stderr}`));
      resolve(exitCode);
    });
  });

  return {
    child,
    ready,
    result,
    exit,
    start: () => child.send?.({ kind: "start" }),
    stop: () => child.send?.({ kind: "stop" })
  };
}

function isChildMessage(message: unknown): message is { kind: "ready" } | { kind: "result"; value: ChildResult } {
  if (typeof message !== "object" || message === null || !("kind" in message)) return false;
  return message.kind === "ready" || message.kind === "result";
}

function childAction(
  ownerId: string,
  operations: readonly ChildOperation[],
  options: Pick<ChildAction, "leaseMs" | "heartbeatIntervalMs"> = {}
): ChildAction {
  return { ownerId, operations, ...options };
}

function singleReservation(result: ChildResult): ProviderSpendReservationResult {
  if (!result.ok) throw new Error(result.error ?? "Spend child failed without an error.");
  const reservation = result.operationResults?.find((entry) => entry.kind === "reserve");
  if (reservation?.kind !== "reserve") throw new Error("Spend child did not return a reservation.");
  return reservation.result;
}

function dispatchResult(result: ChildResult): { state: string; executionExpiresAt: string } {
  if (!result.ok) throw new Error(result.error ?? "Spend child failed without an error.");
  const dispatch = result.operationResults?.find((entry) => entry.kind === "dispatch");
  if (dispatch?.kind !== "dispatch") throw new Error("Spend child did not return a dispatch.");
  return dispatch.result;
}

function recoveryResult(result: ChildResult): { releasedRequestKeys: string[]; uncertainRequestKeys: string[] } {
  if (!result.ok) throw new Error(result.error ?? "Spend child failed without an error.");
  const recovery = result.operationResults?.find((entry) => entry.kind === "recover");
  if (recovery?.kind !== "recover") throw new Error("Spend child did not return a recovery result.");
  return recovery.result;
}

function mainRequest(requestKey: string, cost: number, providerAttemptIndex = 0): ProviderSpendRequest {
  return {
    requestKey,
    profileId: PROFILE_ID,
    executionSessionId: "origin",
    sessionBudgetScopeId: "origin",
    visibleTurnId: "origin-turn",
    sourceKind: "main",
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex,
    pricing: {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      fingerprint: "pricing-v1"
    },
    estimatedInputTokens: 100,
    boundedMaximumOutputTokens: 200,
    maximumEstimatedCostUsd: cost
  };
}

async function createBudgetSession(db: SQLiteSessionDB, id: string): Promise<void> {
  await db.createSession({ id, profileId: PROFILE_ID, spendingLimit: SESSION_LIMIT });
  await db.appendMessage({
    id: `${id}-turn`,
    sessionId: id,
    role: "user",
    content: "Run the budgeted work."
  });
  if (id !== "origin") {
    await db.createSession({
      id: `${id}-worker`,
      profileId: PROFILE_ID,
      parentSessionId: id,
      spendingScopeSessionId: id,
      spendingLimit: SESSION_LIMIT
    });
  }
}

function createSynthesisFixture(): {
  task: Task;
  revision: TaskPlanRevision;
  steps: TaskStep[];
  attempts: TaskAttempt[];
} {
  const createdAt = new Date().toISOString();
  const taskId = "cross-process-synthesis";
  const revisionId = "cross-process-synthesis-r1";
  const policy = authorityPolicy();
  const step = (index: number, role: "worker" | "synthesis", tokens: number): TaskStep => ({
    id: `${taskId}-${role}-${index + 1}`,
    profileId: PROFILE_ID,
    taskId,
    planRevisionId: revisionId,
    key: `${role}-${index + 1}`,
    position: index,
    status: "pending",
    title: role === "synthesis" ? "Synthesize" : `Worker ${index + 1}`,
    objective: role === "synthesis" ? "Synthesize the worker results." : "Complete delegated work.",
    dependsOn: role === "synthesis" ? [`${taskId}-worker-1`, `${taskId}-worker-2`] : [],
    executor: { kind: "agent", role },
    childTaskPolicy: "forbid",
    authorityPolicy: policy,
    executionLimits: { maxProviderCalls: 10, maxTotalTokens: tokens, maxWallClockMs: 60_000 },
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
    createdAt,
    updatedAt: createdAt
  });
  const steps = [step(0, "worker", 4_000), step(1, "worker", 4_000), step(2, "synthesis", 2_000)];
  const task: Task = {
    id: taskId,
    profileId: PROFILE_ID,
    creatorSessionId: "synthesis-origin",
    rootTaskId: taskId,
    originSessionId: "synthesis-origin",
    originTurnId: "synthesis-origin-turn",
    source: "cli",
    executionPreference: "auto",
    objective: "Run workers and synthesize their results.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "cross-process-workspace" },
    authorityPolicy: policy,
    executionLimits: {
      maxConcurrentAttempts: 3,
      maxProviderCalls: 30,
      maxTotalTokens: 10_000,
      maxWallClockMs: 60_000
    },
    activePlanRevisionId: revisionId,
    createdBy: { kind: "user", sessionId: "synthesis-origin" },
    createdAt,
    updatedAt: createdAt
  };
  const revision: TaskPlanRevision = {
    id: revisionId,
    profileId: PROFILE_ID,
    taskId,
    revision: 1,
    status: "active",
    reason: "Initial plan.",
    createdBy: { kind: "user", sessionId: "synthesis-origin" },
    createdAt,
    validatedAt: createdAt,
    activatedAt: createdAt
  };
  const attempts = steps.map((taskStep, index): TaskAttempt => ({
    id: `${taskId}-attempt-${index + 1}`,
    profileId: PROFILE_ID,
    taskId,
    planRevisionId: revisionId,
    stepId: taskStep.id,
    attemptNumber: 1,
    status: "queued",
    dispatchKey: `${taskId}-dispatch-${index + 1}`,
    workerSessionId: "synthesis-origin-worker",
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
    createdAt,
    updatedAt: createdAt
  }));
  return { task, revision, steps, attempts };
}

function taskRequest(input: {
  fixture: ReturnType<typeof createSynthesisFixture>;
  step: TaskStep;
  attempt: TaskAttempt;
  requestKey: string;
  cost: number;
  providerAttemptIndex: number;
}): ProviderSpendRequest {
  return {
    ...mainRequest(input.requestKey, input.cost, input.providerAttemptIndex),
    executionSessionId: "synthesis-origin-worker",
    sessionBudgetScopeId: "synthesis-origin",
    visibleTurnId: "synthesis-origin-turn",
    taskId: input.fixture.task.id,
    rootTaskId: input.fixture.task.id,
    planRevisionId: input.fixture.revision.id,
    stepId: input.step.id,
    attemptId: input.attempt.id,
    sourceKind: "task"
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALLOWED_COUNT_TABLES = new Set([
  "provider_spend_attempts",
  "provider_spending_warnings",
  "session_events"
]);

type SpendingScopeRow = {
  state: string;
  spent_cost_usd: number;
  reserved_cost_usd: number;
};

type SpendAttemptRow = {
  state: string;
  execution_owner_id: string;
  execution_expires_at: string;
  uncertainty_reason: string | null;
};
