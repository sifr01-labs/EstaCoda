import type { UsageCostSummary } from "../contracts/usage-cost.js";
import { isolateLtr, isolateRtl } from "./bidi.js";

export type UsageCostFormatOptions = {
  readonly locale?: "en" | "ar";
  readonly compact?: boolean;
};

/** Renders complete, partial, and unavailable estimates without presenting unknown cost as zero. */
export function formatUsageCost(
  usage: Pick<UsageCostSummary, "estimatedCostUsd" | "costComplete">,
  options: UsageCostFormatOptions = {}
): string {
  const locale = options.locale ?? "en";
  if (
    usage.estimatedCostUsd === undefined ||
    !Number.isFinite(usage.estimatedCostUsd) ||
    usage.estimatedCostUsd < 0 ||
    (!usage.costComplete && usage.estimatedCostUsd === 0)
  ) {
    return locale === "ar" ? isolateRtl("غير متاح") : "unavailable";
  }
  const estimate = `≈ $${formatUsd(usage.estimatedCostUsd)}`;
  if (usage.costComplete) return locale === "ar" ? isolateLtr(estimate) : estimate;
  if (options.compact === true) {
    const compact = `≥ $${formatUsd(usage.estimatedCostUsd)}`;
    return locale === "ar" ? isolateLtr(compact) : compact;
  }
  return locale === "ar"
    ? `${isolateRtl("على الأقل")} ${isolateLtr(estimate)}`
    : `at least ${estimate}`;
}

export function formatUsdAmount(value: number, locale: "en" | "ar" = "en"): string {
  const amount = `$${formatUsd(Number.isFinite(value) && value >= 0 ? value : 0)}`;
  return locale === "ar" ? isolateLtr(amount) : amount;
}

function formatUsd(value: number): string {
  if (value === 0 || value >= 0.01) return value.toFixed(2);
  return value.toFixed(4);
}
