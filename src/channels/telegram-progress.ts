import { toolDisplayLabel } from "../ui/tool-display.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { activityKeyForTool, activityLabel, renderChannelProgressLabel, type ActivityLabelLocale } from "./activity-labels.js";

/** Notices requiring operator attention are never hidden by progress verbosity or cleanup. */
export function isPersistentTelegramNotice(event: RuntimeEvent): boolean {
  return event.kind === "provider-spending-warning"
    || event.kind === "provider-serving-transition"
    || (event.kind === "delegation-progress" && event.childEvent.kind === "provider-spending-warning")
    || (event.kind === "tool-result" && (event.ok === false || (event.decision !== undefined && event.decision !== "allow")))
    || (event.kind === "routing-status" && event.configuredMode === "jev-assisted" && (event.actualEngine === "standard" || event.partialFallback === true));
}

export function renderTelegramProgressLabel(event: RuntimeEvent, locale: ActivityLabelLocale): string {
  if (event.kind === "tool-result" && isPersistentTelegramNotice(event)) {
    return `${activityLabel(locale, event.decision !== undefined && event.decision !== "allow" ? "warning" : "failed")} · ${toolDisplayLabel(event.tool, locale)}`;
  }
  if (isPersistentTelegramNotice(event)) return renderChannelProgressLabel(event, locale);
  if (event.kind === "routing-status") return "";
  if (event.kind === "skill") return activityLabel(locale, "load_skill");
  if (event.kind === "tool-start") {
    if (/^(web\.|browser\.)/u.test(event.tool)) {
      return locale === "ar" ? "🔎 جارٍ التحقق من مصادر الويب" : "🔎 Checking web sources";
    }
    if (event.tool.startsWith("capability.")) {
      return locale === "ar" ? "🔎 جارٍ تحديد الأدوات المناسبة" : "🔎 Finding the right tools";
    }
    return activityLabel(locale, activityKeyForTool(event.tool));
  }
  return renderChannelProgressLabel(event, locale);
}
