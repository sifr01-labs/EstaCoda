import type { ApplicationResult } from "../workspaces/change-application.js";
import { isolateLtr } from "./bidi.js";

/** Safe on any display: never echo artifact paths, changed filenames or raw errors. */
export function workspaceChangeSummary(result: ApplicationResult, locale: string = "en"): string {
  const ar = locale === "ar";
  const messages = {
    applied: ar ? "طُبّقت التغييرات ضمن الموافقة السابقة." : "Changes applied within the previously approved scope.",
    review: ar ? "حُفظت التغييرات للمراجعة. لم تُعدّل ملفات المصدر." : "Changes saved for review. Source files were not modified.",
    conflict: ar ? "تعارضت التغييرات مع المصدر. راجع الأثر وابدأ بنسخة جديدة من الملفات الحالية." : "Source files conflict with this change set. Review the artifact and prepare a fresh copy from current files.",
    attention: ar ? "يتطلب التطبيق تدخلاً. افحص الموافقات وسجل الاسترداد محلياً قبل إعادة المحاولة." : "Application needs attention. Inspect current approval scope and recovery state locally before retrying."
  };
  const id = /^artifact_[a-zA-Z0-9_-]+$|^[a-f0-9-]{36}$/u.test(result.artifact.id) ? result.artifact.id : undefined;
  return `${messages[result.status]}${id ? `\n${ar ? "الأثر" : "Artifact"}: ${ar ? isolateLtr(id) : id}` : ""}`;
}
