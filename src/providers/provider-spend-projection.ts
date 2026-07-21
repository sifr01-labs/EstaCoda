import type { SpendingLimit } from "../contracts/budget.js";
import type { ProviderSpendingScope } from "../contracts/provider-spend.js";
import type { SpendingBudgetSummary } from "../contracts/usage-cost.js";

/** Pure display projection; no additional accounting rows or mutable balances are created. */
export function spendingBudgetSummary(
  limit: SpendingLimit,
  scope: ProviderSpendingScope | null | undefined,
  fallbackSpentCostUsd = 0
): SpendingBudgetSummary {
  const spentCostUsd = scope?.spentCostUsd ?? nonNegative(fallbackSpentCostUsd);
  const reservedCostUsd = scope?.reservedCostUsd ?? 0;
  const maxEstimatedCostUsd = limit.maxEstimatedCostUsd;
  const remainingCostUsd = stableAmount(
    Math.max(0, maxEstimatedCostUsd - spentCostUsd - reservedCostUsd)
  );
  const usedPercent = maxEstimatedCostUsd === 0
    ? 100
    : (spentCostUsd + reservedCostUsd) / maxEstimatedCostUsd * 100;
  return {
    spentCostUsd,
    reservedCostUsd,
    remainingCostUsd,
    maxEstimatedCostUsd,
    warningThresholdPercent: limit.warningThresholdPercent,
    state: scope?.state ?? (remainingCostUsd <= 0
      ? "exhausted"
      : usedPercent >= limit.warningThresholdPercent ? "warning" : "available")
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function stableAmount(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
