import type { TurnUsageSummary, UsageCostSummary } from "../contracts/usage-cost.js";
import { isolateLtr, isolateRtl } from "./bidi.js";

export type UsageCostFormatOptions = {
  readonly locale?: "en" | "ar";
  readonly compact?: boolean;
};

export type UsageCostPresentationState = "exact" | "partial" | "unavailable";

/** Renders complete, partial, and unavailable estimates without presenting unknown cost as zero. */
export function formatUsageCost(
  usage: Pick<UsageCostSummary, "estimatedCostUsd" | "costComplete">,
  options: UsageCostFormatOptions = {}
): string {
  const locale = options.locale ?? "en";
  const state = usageCostPresentationState(usage);
  if (state === "unavailable") {
    return locale === "ar" ? isolateRtl("غير متاح") : "unavailable";
  }
  const estimate = `$${formatUsd(usage.estimatedCostUsd!)}`;
  if (state === "exact") return locale === "ar" ? isolateLtr(estimate) : estimate;
  if (options.compact === true) {
    const compact = `≥ ${estimate}`;
    return locale === "ar" ? isolateLtr(compact) : compact;
  }
  return locale === "ar"
    ? `${isolateRtl("على الأقل")} ${isolateLtr(estimate)}`
    : `at least ${estimate}`;
}

export function usageCostPresentationState(
  usage: Pick<UsageCostSummary, "estimatedCostUsd" | "costComplete">
): UsageCostPresentationState {
  const estimate = usage.estimatedCostUsd;
  if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) return "unavailable";
  if (usage.costComplete) return "exact";
  return estimate > 0 ? "partial" : "unavailable";
}

/** Expanded surfaces use this once per aggregate; compact rails communicate partial cost with ≥. */
export function formatUsageCostNotice(
  usage: Pick<UsageCostSummary, "estimatedCostUsd" | "costComplete">,
  options: Pick<UsageCostFormatOptions, "locale"> = {}
): string | undefined {
  if (usageCostPresentationState(usage) !== "partial") return undefined;
  return options.locale === "ar"
    ? isolateRtl("تعذر الحصول على بعض أسعار موفر النموذج")
    : "Some provider pricing was unavailable";
}

export function formatUsdAmount(value: number, locale: "en" | "ar" = "en"): string {
  const amount = `$${formatUsd(Number.isFinite(value) && value >= 0 ? value : 0)}`;
  return locale === "ar" ? isolateLtr(amount) : amount;
}

/** Compact, response-level accounting. Expanded per-route costs belong in Task inspection. */
export function formatTurnUsageFooter(
  usage: Pick<TurnUsageSummary, "total" | "provisional">,
  options: Pick<UsageCostFormatOptions, "locale"> = {}
): string {
  const locale = options.locale ?? "en";
  const tokensComplete = usage.total.usageComplete && !usage.provisional;
  const tokens = `${tokensComplete ? "" : "≥ "}${formatCompactCount(usage.total.totalTokens)} tokens`;
  const costState = usageCostPresentationState(usage.total);
  const cost = costState === "unavailable"
    ? undefined
    : `${costState === "exact" && !usage.provisional ? "≈ " : "≥ "}$${formatUsd(usage.total.estimatedCostUsd!)}`;
  const footer = cost === undefined ? tokens : `${tokens} · ${cost}`;
  return locale === "ar" ? isolateLtr(footer) : footer;
}

function formatCompactCount(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${trimCompactDecimal(count / 1_000)}k`;
  return `${trimCompactDecimal(count / 1_000_000)}m`;
}

function trimCompactDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function formatUsd(value: number): string {
  if (value === 0 || value >= 0.01) return value.toFixed(2);
  return value.toFixed(4);
}
