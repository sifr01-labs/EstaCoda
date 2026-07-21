import { describe, expect, it } from "vitest";
import type { UsageCostSummary } from "../contracts/usage-cost.js";
import { LRI, PDI, RLI } from "./bidi.js";
import { formatUsageCost, formatUsageCostNotice, usageCostPresentationState } from "./usage-cost-format.js";

describe("formatUsageCost", () => {
  it("renders complete, partial, and unavailable estimates honestly", () => {
    expect(formatUsageCost(summary({ estimatedCostUsd: 1.27, costComplete: true }))).toBe("$1.27");
    expect(formatUsageCost(summary({ estimatedCostUsd: 0.84, costComplete: false }))).toBe("at least $0.84");
    expect(formatUsageCost(summary({ estimatedCostUsd: undefined, costComplete: false }))).toBe("unavailable");
    expect(formatUsageCost(summary({ estimatedCostUsd: 0, costComplete: false }))).toBe("unavailable");
    expect(formatUsageCost(summary({ estimatedCostUsd: undefined, costComplete: false }), { compact: true })).toBe("unavailable");
    expect(formatUsageCostNotice(summary({ estimatedCostUsd: 0.84, costComplete: false })))
      .toBe("Some provider pricing was unavailable");
    expect(formatUsageCostNotice(summary({ estimatedCostUsd: 0, costComplete: true }))).toBeUndefined();
  });

  it("isolates Arabic labels and LTR currency fragments", () => {
    expect(formatUsageCost(summary({ estimatedCostUsd: 0.84, costComplete: false }), { locale: "ar" }))
      .toBe(`${RLI}على الأقل${PDI} ${LRI}$0.84${PDI}`);
    expect(formatUsageCost(summary({ estimatedCostUsd: undefined, costComplete: false }), { locale: "ar" }))
      .toBe(`${RLI}غير متاح${PDI}`);
    expect(formatUsageCostNotice(summary({ estimatedCostUsd: 0.84, costComplete: false }), { locale: "ar" }))
      .toBe(`${RLI}تعذر الحصول على بعض أسعار موفر النموذج${PDI}`);
  });

  it("preserves meaningful sub-cent estimates without noisy complete-zero output", () => {
    expect(formatUsageCost(summary({ estimatedCostUsd: 0.0004, costComplete: true }))).toBe("$0.0004");
    expect(formatUsageCost(summary({ estimatedCostUsd: 0, costComplete: true }))).toBe("$0.00");
    expect(usageCostPresentationState(summary({ estimatedCostUsd: 0, costComplete: true }))).toBe("exact");
    expect(usageCostPresentationState(summary({ estimatedCostUsd: 0, costComplete: false }))).toBe("unavailable");
  });
});

function summary(overrides: Partial<UsageCostSummary>): UsageCostSummary {
  return {
    providerCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    usageComplete: true,
    costComplete: true,
    incompleteReasons: [],
    ...overrides,
  };
}
