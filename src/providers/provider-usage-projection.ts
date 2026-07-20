import type { ProviderUsageEntry, ProviderUsageTotals } from "../contracts/provider-usage.js";
import type { UsageCostSummary } from "../contracts/usage-cost.js";
import { providerUsageTotals } from "./provider-usage-ledger.js";

export function usageCostSummaryFromEntries(
  entries: readonly ProviderUsageEntry[],
  options: { readonly emptyUsageIsComplete?: boolean } = {}
): UsageCostSummary {
  return usageCostSummaryFromTotals(providerUsageTotals(entries, options));
}

export function usageCostSummaryFromTotals(totals: ProviderUsageTotals): UsageCostSummary {
  const hasUsableEstimate = totals.pricingComplete || totals.estimatedCostUsd > 0;
  return {
    providerCalls: totals.providerCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens: totals.totalTokens,
    ...(hasUsableEstimate ? { estimatedCostUsd: totals.estimatedCostUsd } : {}),
    usageComplete: totals.usageComplete,
    costComplete: totals.pricingComplete,
    incompleteReasons: [...totals.incompleteReasons]
  };
}

export function mergeUsageCostSummaries(
  summaries: readonly UsageCostSummary[]
): UsageCostSummary {
  if (summaries.length === 0) return emptyUsageCostSummary();
  const reasons = new Set(summaries.flatMap((summary) => summary.incompleteReasons));
  const knownCost = summaries.reduce((sum, summary) => sum + (summary.estimatedCostUsd ?? 0), 0);
  const costComplete = summaries.every((summary) => summary.costComplete);
  return {
    providerCalls: sum(summaries, "providerCalls"),
    inputTokens: sum(summaries, "inputTokens"),
    outputTokens: sum(summaries, "outputTokens"),
    reasoningTokens: sum(summaries, "reasoningTokens"),
    cacheReadTokens: sum(summaries, "cacheReadTokens"),
    cacheWriteTokens: sum(summaries, "cacheWriteTokens"),
    totalTokens: sum(summaries, "totalTokens"),
    ...(costComplete || knownCost > 0 ? { estimatedCostUsd: knownCost } : {}),
    usageComplete: summaries.every((summary) => summary.usageComplete),
    costComplete,
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

export function emptyUsageCostSummary(): UsageCostSummary {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageComplete: true,
    costComplete: true,
    incompleteReasons: []
  };
}

export function unavailableUsageCostSummary(reason: string): UsageCostSummary {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    usageComplete: false,
    costComplete: false,
    incompleteReasons: [reason]
  };
}

function sum(
  summaries: readonly UsageCostSummary[],
  field: "providerCalls" | "inputTokens" | "outputTokens" | "reasoningTokens" |
    "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
): number {
  return summaries.reduce((total, summary) => total + summary[field], 0);
}
