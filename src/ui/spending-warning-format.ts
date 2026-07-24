import type { ProviderSpendScopeKind } from "../contracts/provider-spend.js";
import { isolateRtl } from "./bidi.js";
import { formatUsdAmount } from "./usage-cost-format.js";

export type SpendingWarningPresentation = {
  scopeKind: ProviderSpendScopeKind;
  warningThresholdPercent: number;
  maxEstimatedCostUsd: number;
  committedCostUsd: number;
};

/** Plain, explicit warning copy that never depends on color or an icon for meaning. */
export function formatSpendingThresholdWarning(
  warning: SpendingWarningPresentation,
  locale: "en" | "ar" = "en"
): string {
  const committed = formatUsdAmount(warning.committedCostUsd, locale);
  const limit = formatUsdAmount(warning.maxEstimatedCostUsd, locale);
  const threshold = `${formatPercent(warning.warningThresholdPercent)}%`;
  if (locale === "ar") {
    const scope = warning.scopeKind === "session" ? "الجلسة" : "المهمة";
    return isolateRtl(
      `تنبيه بشأن الإنفاق التقديري: بلغ الإنفاق المحجوز أو المستخدم في ${scope} ${committed} من ${limit} (حد التنبيه ${threshold}).`
    );
  }
  const scope = warning.scopeKind === "session" ? "Session" : "Task";
  return `Estimated spending warning: ${scope} has used or reserved ${committed} of ${limit} in provider spending (${threshold} warning threshold).`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}
