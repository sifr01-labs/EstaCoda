import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type {
  Task,
  TaskAttempt,
  TaskAuthorityDisposition,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteProviderSpendController } from "../tasks/sqlite-provider-spend.js";
import { SQLiteTaskStore } from "../tasks/sqlite-task-store.js";
import { executeAuxiliaryTask } from "./auxiliary-executor.js";
import { ProviderExecutor } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";

const PROFILE_ID = "vision-spend";
const CREATED_AT = "2030-01-01T00:00:00.000Z";

describe("vision provider spending enforcement", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let registry: ProviderRegistry;
  let controller: SQLiteProviderSpendController;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-vision-spend-"));
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    registry = new ProviderRegistry();
    controller = new SQLiteProviderSpendController({ db: sessionDb.db, profileId: PROFILE_ID });
    vi.stubEnv("ESTACODA_VISION_SPEND_TEST_KEY", "test-only-secret");
  });

  afterEach(() => {
    try { controller.dispose(); } catch { /* a test may already dispose it */ }
    vi.unstubAllEnvs();
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies a vision request that exceeds its Session limit before dispatch", async () => {
    await createOriginSession(0.001);
    const complete = vi.fn(async (request: ProviderRequest) => okResponse("openai", request));
    registry.register(adapter("openai", complete));

    const execution = await executor().complete(visionRequest("gpt-5.6"), {}, {
      primaryRoute: route("openai", "gpt-5.6"),
      usage: visionUsage("origin", "session-limit")
    });
    expect(execution).toMatchObject({
      ok: false,
      spendDenialReason: "SESSION_LIMIT_EXHAUSTED"
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("charges a Task-scoped vision call to both its root Task and logical Session", async () => {
    await createOriginSession(10);
    await createTaskWorker(0.001);
    const complete = vi.fn(async (request: ProviderRequest) => okResponse("openai", request));
    registry.register(adapter("openai", complete));

    const execution = await executor().complete(visionRequest("gpt-5.6"), {}, {
      primaryRoute: route("openai", "gpt-5.6"),
      usage: visionUsage("worker", "task-limit", {
        sessionBudgetScopeId: "origin",
        taskId: "task-root",
        rootTaskId: "task-root",
        planRevisionId: "revision-root",
        stepId: "step-root",
        attemptId: "attempt-root"
      })
    });

    expect(execution).toMatchObject({ ok: false, spendDenialReason: "TASK_LIMIT_EXHAUSTED" });
    expect(complete).not.toHaveBeenCalled();
    expect(controller.getScope("session", "origin")).toMatchObject({ reservedCostUsd: 0 });
    expect(controller.getScope("root_task", "task-root")).toMatchObject({ reservedCostUsd: 0 });
  });

  it("reserves both primary and fallback vision attempts before their dispatch", async () => {
    await createOriginSession(10);
    const dispatchStates: Array<{ provider: string; state: string }> = [];
    registry.register(adapter("openai", async (request) => {
      dispatchStates.push(latestDispatchState());
      return {
        ok: false,
        provider: "openai",
        model: request.model,
        content: "temporary failure",
        errorClass: "network",
        usage: { inputTokens: 100, outputTokens: 0 }
      };
    }));
    registry.register(adapter("google", async (request) => {
      dispatchStates.push(latestDispatchState());
      return okResponse("google", request, { inputTokens: 200, outputTokens: 1 });
    }));

    const execution = await executeAuxiliaryTask({
      route: {
        task: "vision",
        route: route("openai", "gpt-5.6"),
        source: "explicit",
        fallbackToMain: true,
        diagnostics: []
      },
      mainRoute: route("google", "gemini-3-pro"),
      providerExecutor: executor(),
      request: visionRequest("gpt-5.6"),
      usage: {
        executionSessionId: "origin",
        visibleTurnId: "origin-turn",
        imageInputs: [{ width: 1_024, height: 1_024, detail: "auto" }]
      }
    });

    expect(execution).toMatchObject({ ok: true, fallbackUsed: true });
    expect(dispatchStates).toEqual([
      { provider: "openai", state: "dispatching" },
      { provider: "google", state: "dispatching" }
    ]);
    const attempts = sessionDb.db.query<{ state: string; route_role: string }>(
      `select state, json_extract(attribution_json, '$.routeRole') as route_role
       from provider_spend_attempts where profile_id = ? order by reserved_at, request_key`
    ).all(PROFILE_ID);
    expect(attempts).toEqual([
      { state: "settled", route_role: "primary" },
      { state: "settled", route_role: "fallback" }
    ]);
    const entries = await sessionDb.listProviderUsageEntries(PROFILE_ID, { sessionId: "origin" });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", routeRole: "primary", auxiliaryKind: "vision" }),
      expect.objectContaining({ provider: "google", routeRole: "fallback", auxiliaryKind: "vision" })
    ]));
  });

  it("releases a reservation when a configured budget cannot price the image provider", async () => {
    await createOriginSession(10);
    const complete = vi.fn(async (request: ProviderRequest) => okResponse("custom-provider", request));
    registry.register(adapter("custom-provider", complete));

    const execution = await executor().complete(visionRequest("vision-model"), {}, {
      primaryRoute: route("custom-provider", "vision-model"),
      usage: visionUsage("origin", "unpriceable")
    });

    expect(execution).toMatchObject({
      ok: false,
      spendDenialReason: "REQUEST_CANNOT_BE_SAFELY_BOUNDED"
    });
    expect(complete).not.toHaveBeenCalled();
    expect(sessionDb.db.query<{ state: string }>(
      "select state from provider_spend_attempts where profile_id = ?"
    ).get(PROFILE_ID)).toEqual({ state: "released" });
    expect(controller.getScope("session", "origin")).toMatchObject({ reservedCostUsd: 0 });
  });

  it("settles actual provider usage and releases the larger vision reservation", async () => {
    await createOriginSession(10);
    registry.register(adapter("openai", async (request) =>
      okResponse("openai", request, { inputTokens: 1_000, outputTokens: 10 })
    ));

    const execution = await executor().complete(visionRequest("gpt-5.6"), {}, {
      primaryRoute: route("openai", "gpt-5.6"),
      usage: visionUsage("origin", "actual-settlement")
    });

    expect(execution.ok).toBe(true);
    const scope = controller.getScope("session", "origin");
    expect(scope?.spentCostUsd).toBeCloseTo(0.102, 12);
    expect(scope?.reservedCostUsd).toBe(0);
    const row = sessionDb.db.query<{
      state: string;
      actual: number;
      image_tokens: number;
      estimator: string;
    }>(
      `select state, actual_estimated_cost_usd as actual,
              json_extract(attribution_json, '$.estimatedImageInputTokens') as image_tokens,
              json_extract(attribution_json, '$.imageTokenEstimator') as estimator
       from provider_spend_attempts where profile_id = ?`
    ).get(PROFILE_ID);
    expect(row).toMatchObject({
      state: "settled",
      image_tokens: 1_024,
      estimator: "openai-patch-32-gpt-5.6-auto-v1"
    });
    expect(row?.actual).toBeCloseTo(0.102, 12);
  });

  function executor(): ProviderExecutor {
    return new ProviderExecutor({
      registry,
      profileId: PROFILE_ID,
      spendController: controller
    });
  }

  async function createOriginSession(maxEstimatedCostUsd: number): Promise<void> {
    await sessionDb.createSession({
      id: "origin",
      profileId: PROFILE_ID,
      spendingLimit: { maxEstimatedCostUsd, warningThresholdPercent: 80 }
    });
    await sessionDb.appendMessage({
      id: "origin-turn",
      sessionId: "origin",
      role: "user",
      content: "Analyze the image."
    });
  }

  async function createTaskWorker(maxEstimatedCostUsd: number): Promise<void> {
    await sessionDb.createSession({
      id: "worker",
      profileId: PROFILE_ID,
      parentSessionId: "origin",
      spendingScopeSessionId: "origin",
      spendingLimit: { maxEstimatedCostUsd: 10, warningThresholdPercent: 80 }
    });
    const taskStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: PROFILE_ID });
    taskStore.createTaskGraph(taskGraph(maxEstimatedCostUsd));
    taskStore.atomicWrite((store) => store.createAttempt(taskAttempt()));
  }

  function latestDispatchState(): { provider: string; state: string } {
    return sessionDb.db.query<{ provider: string; state: string }>(
      `select json_extract(attribution_json, '$.provider') as provider, state
       from provider_spend_attempts where profile_id = ? order by rowid desc limit 1`
    ).get(PROFILE_ID)!;
  }
});

function adapter(id: string, complete: ProviderAdapter["complete"]): ProviderAdapter {
  return {
    id,
    name: id,
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [],
    complete
  };
}

function route(provider: string, id: string): ResolvedModelRoute {
  return {
    provider,
    id,
    apiKeyEnv: "ESTACODA_VISION_SPEND_TEST_KEY",
    maxTokens: 10,
    profile: {
      provider,
      id,
      contextWindowTokens: 100_000,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: false,
      cost: { inputPerMillionTokens: 100, outputPerMillionTokens: 200 }
    }
  };
}

function visionRequest(model: string): ProviderRequest {
  return {
    model,
    maxTokens: 10,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }
      ]
    }]
  };
}

function visionUsage(
  executionSessionId: string,
  requestKey: string,
  lineage: {
    sessionBudgetScopeId?: string;
    taskId?: string;
    rootTaskId?: string;
    planRevisionId?: string;
    stepId?: string;
    attemptId?: string;
  } = {}
) {
  return {
    requestKey,
    sourceKind: "auxiliary" as const,
    auxiliaryKind: "vision",
    executionSessionId,
    visibleTurnId: "origin-turn",
    imageInputs: [{ width: 1_024, height: 1_024, detail: "auto" as const }],
    ...lineage
  };
}

function okResponse(
  provider: string,
  request: ProviderRequest,
  usage: ProviderResponse["usage"] = { inputTokens: 100, outputTokens: 1 }
): ProviderResponse {
  return {
    ok: true,
    provider,
    model: request.model,
    content: "done",
    usage
  };
}

function taskGraph(maxEstimatedCostUsd: number): {
  task: Task;
  revision: TaskPlanRevision;
  steps: TaskStep[];
} {
  const policy = authorityPolicy();
  const task: Task = {
    id: "task-root",
    profileId: PROFILE_ID,
    creatorSessionId: "origin",
    rootTaskId: "task-root",
    originSessionId: "origin",
    originTurnId: "origin-turn",
    source: "cli",
    executionPreference: "auto",
    objective: "Analyze an image.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: policy,
    spendingLimit: { maxEstimatedCostUsd, warningThresholdPercent: 80 },
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
    objective: "Analyze the image.",
    dependsOn: [],
    executor: { kind: "agent", role: "worker" },
    childTaskPolicy: "forbid",
    authorityPolicy: policy,
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

function authorityPolicy() {
  return {
    allowedToolsets: ["files"],
    allowedTools: ["file.read"],
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(
      TASK_TOOL_RISK_CLASSES.map((riskClass) => [
        riskClass,
        riskClass === "read-only-local" ? "runtime_policy" : "forbid"
      ])
    ) as Record<ToolRiskClass, TaskAuthorityDisposition>,
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}
