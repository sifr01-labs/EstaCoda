export const DEFAULT_SPENDING_WARNING_THRESHOLD_PERCENT = 80;

/** Immutable estimated provider-spend ceiling for one logical monetary scope. */
export type SpendingLimit = {
  maxEstimatedCostUsd: number;
  warningThresholdPercent: number;
};

/** Profile defaults applied prospectively to new root Tasks and logical sessions. */
export type BudgetConfig = {
  task?: SpendingLimit;
  session?: SpendingLimit;
};

export function assertSpendingLimit(value: SpendingLimit, label = "Spending limit"): void {
  if (!Number.isFinite(value.maxEstimatedCostUsd) || value.maxEstimatedCostUsd < 0) {
    throw new Error(`${label} maximum estimated cost must be a finite non-negative USD amount.`);
  }
  if (!Number.isFinite(value.warningThresholdPercent) ||
      value.warningThresholdPercent < 0 || value.warningThresholdPercent > 100) {
    throw new Error(`${label} warning threshold must be between 0 and 100 percent.`);
  }
}

export function cloneSpendingLimit(value: SpendingLimit | undefined): SpendingLimit | undefined {
  if (value === undefined) return undefined;
  assertSpendingLimit(value);
  return {
    maxEstimatedCostUsd: value.maxEstimatedCostUsd,
    warningThresholdPercent: value.warningThresholdPercent
  };
}
