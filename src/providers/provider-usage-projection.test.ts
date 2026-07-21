import { describe, expect, it } from "vitest";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import {
  mergeUsageCostSummaries,
  usageCostSummaryFromEntries,
} from "./provider-usage-projection.js";

describe("provider usage cost projections", () => {
  it("distinguishes complete zero, partial known cost, and unavailable cost", () => {
    expect(usageCostSummaryFromEntries([], { emptyUsageIsComplete: true })).toMatchObject({
      estimatedCostUsd: 0,
      costComplete: true,
    });
    expect(usageCostSummaryFromEntries([entry({
      estimatedCostUsd: 0.84,
      pricingComplete: false,
      incompleteReasons: ["output-pricing-missing"],
    })])).toMatchObject({
      estimatedCostUsd: 0.84,
      costComplete: false,
    });
    expect(usageCostSummaryFromEntries([entry({
      estimatedCostUsd: 0,
      pricingComplete: false,
      incompleteReasons: ["pricing-missing"],
    })])).not.toHaveProperty("estimatedCostUsd");
  });

  it("merges steering retries without converting unknown cost into a false zero", () => {
    const known = usageCostSummaryFromEntries([entry({ estimatedCostUsd: 0.4 })]);
    const unknown = usageCostSummaryFromEntries([entry({
      requestKey: "request-2",
      estimatedCostUsd: 0,
      pricingComplete: false,
      incompleteReasons: ["pricing-missing"],
    })]);

    expect(mergeUsageCostSummaries([known, unknown])).toMatchObject({
      providerCalls: 2,
      estimatedCostUsd: 0.4,
      costComplete: false,
      incompleteReasons: ["pricing-missing"],
    });
  });
});

function entry(overrides: Partial<ProviderUsageEntry> = {}): ProviderUsageEntry {
  return {
    id: "usage-1",
    profileId: "alpha",
    sessionId: "session-1",
    visibleTurnId: "turn-1",
    requestKey: "request-1",
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind: "main",
    pricing: { currency: "USD", fingerprint: "test-pricing" },
    pricingFingerprint: "test-pricing",
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120,
    estimatedCostUsd: 1.27,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    dispatchedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}
