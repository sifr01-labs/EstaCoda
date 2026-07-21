import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteProviderSpendController } from "../workflow/sqlite-provider-spend.js";
import { ProviderExecutor } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";

const PROFILE_ID = "spend-enforcement";

describe("ProviderExecutor spending enforcement", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let registry: ProviderRegistry;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-provider-enforcement-"));
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("marks a durable reservation dispatching before adapter entry and settles actual usage", async () => {
    await createUsageSession("budgeted", 1);
    const controller = new SQLiteProviderSpendController({ db: sessionDb.db, profileId: PROFILE_ID });
    let observedState: string | undefined;
    registry.register(adapter(async (request) => {
      observedState = sessionDb.db.query<{ state: string }>(
        "select state from provider_spend_attempts where profile_id = ?"
      ).get(PROFILE_ID)?.state;
      return response(request, { inputTokens: 100, outputTokens: 5 });
    }));

    const execution = await executor(controller).complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute(),
      usage: usage("budgeted", "settled-request")
    });

    expect(execution.ok).toBe(true);
    expect(observedState).toBe("dispatching");
    const attempt = sessionDb.db.query<{ state: string; actual: number }>(
      `select state, actual_estimated_cost_usd as actual
       from provider_spend_attempts where profile_id = ?`
    ).get(PROFILE_ID);
    expect(attempt).toMatchObject({ state: "settled", actual: 0.0002 });
    expect(controller.getScope("session", "budgeted")).toMatchObject({
      spentCostUsd: 0.0002,
      reservedCostUsd: 0
    });
  });

  it("bounds reasoning exposure when pricing signals it despite incomplete capability metadata", async () => {
    await createUsageSession("reasoning-priced", 1);
    let reservedRequest: { boundedMaximumReasoningTokens?: number } | undefined;
    registry.register(adapter(async (request) => {
      const row = sessionDb.db.query<{ attribution_json: string }>(
        "select attribution_json from provider_spend_attempts where profile_id = ?"
      ).get(PROFILE_ID);
      reservedRequest = row == null ? undefined : JSON.parse(row.attribution_json);
      return response(request);
    }));

    const execution = await executor().complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute({
        profile: model({
          supportsReasoning: undefined,
          cost: {
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 20,
            reasoningPerMillionTokens: 30
          }
        })
      }),
      usage: usage("reasoning-priced", "reasoning-priced-request")
    });

    expect(execution.ok).toBe(true);
    expect(reservedRequest).toMatchObject({ boundedMaximumReasoningTokens: 10 });
  });

  it("blocks a zero-spend Session before the adapter and returns the exact reason", async () => {
    await createUsageSession("zero", 0);
    const complete = vi.fn(async (request: ProviderRequest) =>
      response(request, { inputTokens: 1, outputTokens: 1 })
    );
    registry.register(adapter(complete));

    const execution = await executor().complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute(),
      usage: usage("zero", "zero-request")
    });

    expect(execution).toMatchObject({ ok: false, spendDenialReason: "SESSION_LIMIT_EXHAUSTED" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed on unknown pricing only when an applicable limit exists", async () => {
    await createUsageSession("priced-policy", 1);
    await createUsageSession("unbudgeted");
    const complete = vi.fn(async (request: ProviderRequest) =>
      response(request, { inputTokens: 1, outputTokens: 1 })
    );
    registry.register(adapter(complete));
    const unpriced = pricedRoute({ profile: model({ cost: undefined }) });

    const denied = await executor().complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: unpriced,
      usage: usage("priced-policy", "unknown-priced-request")
    });
    expect(denied).toMatchObject({ ok: false, spendDenialReason: "PRICING_UNAVAILABLE" });
    expect(complete).not.toHaveBeenCalled();

    const allowed = await executor().complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: unpriced,
      usage: usage("unbudgeted", "unknown-unbudgeted-request")
    });
    expect(allowed.ok).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect((await sessionDb.listProviderUsageEntries(PROFILE_ID, { sessionId: "unbudgeted" }))[0])
      .toMatchObject({ pricingComplete: false, estimatedCostUsd: 0 });
  });

  it("denies an unbounded request under a limit before dispatch", async () => {
    await createUsageSession("bounded-policy", 1);
    const complete = vi.fn(async (request: ProviderRequest) => response(request));
    registry.register(adapter(complete));
    const route = pricedRoute({
      maxTokens: undefined,
      contextWindowTokens: undefined,
      profile: model({ contextWindowTokens: undefined })
    });

    const execution = await executor().complete({ messages: [] }, {}, {
      primaryRoute: route,
      usage: usage("bounded-policy", "unbounded-request")
    });

    expect(execution).toMatchObject({
      ok: false,
      spendDenialReason: "REQUEST_CANNOT_BE_SAFELY_BOUNDED"
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("holds parallel capacity so a second request cannot oversubscribe the Session", async () => {
    await createUsageSession("parallel", 0.0005);
    let finishFirst!: (value: ProviderResponse) => void;
    const firstResponse = new Promise<ProviderResponse>((resolve) => { finishFirst = resolve; });
    const complete = vi.fn((request: ProviderRequest) =>
      complete.mock.calls.length === 1 ? firstResponse : Promise.resolve(response(request))
    );
    registry.register(adapter(complete));
    const providerExecutor = executor();

    const first = providerExecutor.complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute(),
      usage: usage("parallel", "parallel-first")
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const second = await providerExecutor.complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute(),
      usage: usage("parallel", "parallel-second")
    });
    expect(second).toMatchObject({ ok: false, spendDenialReason: "SESSION_CAPACITY_RESERVED" });
    expect(complete).toHaveBeenCalledOnce();

    finishFirst(response({ model: "priced-model" }, { inputTokens: 1, outputTokens: 1 }));
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when attributed execution has no spend controller", async () => {
    await createUsageSession("missing-controller");
    const complete = vi.fn(async (request: ProviderRequest) => response(request));
    registry.register(adapter(complete));
    const providerExecutor = new ProviderExecutor({
      registry,
      profileId: PROFILE_ID,
      usageRecorder: async () => undefined
    });

    const execution = await providerExecutor.complete({ messages: [], maxTokens: 10 }, {}, {
      primaryRoute: pricedRoute(),
      usage: usage("missing-controller", "missing-controller-request")
    });

    expect(execution).toMatchObject({ ok: false, spendDenialReason: "SPEND_CONTROLLER_UNAVAILABLE" });
    expect(complete).not.toHaveBeenCalled();
  });

  function executor(controller = new SQLiteProviderSpendController({
    db: sessionDb.db,
    profileId: PROFILE_ID
  })): ProviderExecutor {
    return new ProviderExecutor({ registry, profileId: PROFILE_ID, spendController: controller });
  }

  async function createUsageSession(id: string, maxEstimatedCostUsd?: number): Promise<void> {
    await sessionDb.createSession({
      id,
      profileId: PROFILE_ID,
      ...(maxEstimatedCostUsd === undefined
        ? {}
        : { spendingLimit: { maxEstimatedCostUsd, warningThresholdPercent: 80 } })
    });
    await sessionDb.appendMessage({
      id: `${id}-turn`,
      sessionId: id,
      role: "user",
      content: "Run the provider request."
    });
  }
});

function adapter(complete: ProviderAdapter["complete"]): ProviderAdapter {
  return {
    id: "priced-provider",
    name: "Priced provider",
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [model()],
    complete
  };
}

function response(
  request: Pick<ProviderRequest, "model">,
  usage: ProviderResponse["usage"] = { inputTokens: 0, outputTokens: 0 }
): ProviderResponse {
  return {
    ok: true,
    provider: "priced-provider",
    model: request.model,
    content: "done",
    usage
  };
}

function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "priced-model",
    provider: "priced-provider",
    contextWindowTokens: 1_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false,
    cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 20 },
    ...overrides
  };
}

function pricedRoute(overrides: Partial<ResolvedModelRoute> = {}): ResolvedModelRoute {
  const profile = overrides.profile ?? model();
  return {
    provider: "priced-provider",
    id: profile.id,
    profile,
    maxTokens: 10,
    ...overrides
  };
}

function usage(executionSessionId: string, requestKey: string) {
  return {
    requestKey,
    sourceKind: "main" as const,
    executionSessionId,
    visibleTurnId: `${executionSessionId}-turn`
  };
}
