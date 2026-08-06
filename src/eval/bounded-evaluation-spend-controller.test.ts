import { describe, expect, it } from "vitest";
import type { ProviderSpendRequest } from "../contracts/provider-spend.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import { BoundedEvaluationSpendController } from "./bounded-evaluation-spend-controller.js";

describe("BoundedEvaluationSpendController", () => {
  it("denies exposure above the explicit run cap before dispatch", () => {
    const controller = new BoundedEvaluationSpendController({ profileId: "default", maximumCostUsd: 0.1 });
    const result = controller.reserve(request("one", 0.11), "2030-01-01T00:00:00.000Z");

    expect(result).toMatchObject({
      ok: false,
      reason: "SESSION_LIMIT_EXHAUSTED",
      requestedCostUsd: 0.11,
      availableCostUsd: 0.1,
    });
  });

  it("settles actual estimated cost and releases unused exposure for later cases", () => {
    const controller = new BoundedEvaluationSpendController({ profileId: "default", maximumCostUsd: 0.1 });
    const reserved = controller.reserve(request("one", 0.08), "2030-01-01T00:00:00.000Z");
    expect(reserved.ok).toBe(true);
    controller.markDispatching("one", "2030-01-01T00:00:01.000Z");
    controller.settle("one", usage("one", 0.02), "2030-01-01T00:00:02.000Z");

    expect(controller.snapshot()).toEqual({ maximumCostUsd: 0.1, spentCostUsd: 0.02, reservedCostUsd: 0 });
    expect(controller.reserve(request("two", 0.08), "2030-01-01T00:00:03.000Z").ok).toBe(true);
  });

  it("keeps uncertain dispatched exposure reserved", () => {
    const controller = new BoundedEvaluationSpendController({ profileId: "default", maximumCostUsd: 0.1 });
    controller.reserve(request("one", 0.08), "2030-01-01T00:00:00.000Z");
    controller.markDispatching("one", "2030-01-01T00:00:01.000Z");
    controller.markUncertain("one", "2030-01-01T00:00:02.000Z", "provider outcome unknown");

    expect(controller.snapshot().reservedCostUsd).toBe(0.08);
    expect(controller.reserve(request("two", 0.03), "2030-01-01T00:00:03.000Z")).toMatchObject({
      ok: false,
      reason: "SESSION_LIMIT_EXHAUSTED",
    });
  });
});

function request(requestKey: string, maximumEstimatedCostUsd: number): ProviderSpendRequest {
  return {
    requestKey,
    profileId: "default",
    sourceKind: "auxiliary",
    auxiliaryKind: "vision",
    provider: "openai",
    model: "gpt-4o",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    pricing: {
      currency: "USD",
      inputPerMillionTokens: 5,
      outputPerMillionTokens: 15,
      fingerprint: "pricing-test",
    },
    estimatedInputTokens: 1_000,
    boundedMaximumOutputTokens: 2_048,
    maximumEstimatedCostUsd,
  };
}

function usage(requestKey: string, estimatedCostUsd: number): ProviderUsageEntry {
  return {
    id: `usage:${requestKey}`,
    profileId: "default",
    requestKey,
    provider: "openai",
    model: "gpt-4o",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind: "auxiliary",
    auxiliaryKind: "vision",
    pricing: request(requestKey, 0).pricing,
    pricingFingerprint: "pricing-test",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    dispatchedAt: "2030-01-01T00:00:01.000Z",
  };
}
