import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { toolDisplayIcon, toolDisplayLabel } from "../ui/tool-display.js";

export type ActivityLabelLocale = "en" | "ar";

export type ActivityLabelKey =
  | "thinking"
  | "inspect"
  | "read_files"
  | "write_files"
  | "patch_files"
  | "run_command"
  | "run_checks"
  | "install_build"
  | "load_skill"
  | "route_task"
  | "process_attachment"
  | "inspect_media"
  | "web_action"
  | "approval_required"
  | "done"
  | "warning"
  | "failed";

const ACTIVITY_LABELS: Record<ActivityLabelLocale, Record<ActivityLabelKey, string>> = {
  en: {
    thinking: "◉ Thinking",
    inspect: "🕵️ Inspecting",
    read_files: "🗂️ Reading files",
    write_files: "✍️ Writing files",
    patch_files: "🪬 Patching files",
    run_command: "🖥️ Running command",
    run_checks: "👾 Running checks",
    install_build: "📦 Installing/building",
    load_skill: "⚙️ Loading skill",
    route_task: "✦ Routing task",
    process_attachment: "📎 Processing attachment",
    inspect_media: "🖼️ Inspecting media",
    web_action: "🌐 Web action",
    approval_required: "🔐 Approval required",
    done: "✅ Done",
    warning: "⚠️ Warning",
    failed: "❌ Failed"
  },
  ar: {
    thinking: "◉ جارٍ التفكير",
    inspect: "🕵️ جارٍ الفحص",
    read_files: "🗂️ قراءة الملفات",
    write_files: "✍️ كتابة الملفات",
    patch_files: "🪬 تعديل الملفات",
    run_command: "🖥️ تشغيل أمر",
    run_checks: "👾 تشغيل الفحوصات",
    install_build: "📦 تثبيت/بناء",
    load_skill: "⚙️ تحميل مهارة",
    route_task: "✦ توجيه المهمة",
    process_attachment: "📎 معالجة مرفق",
    inspect_media: "🖼️ فحص الوسائط",
    web_action: "🌐 إجراء ويب",
    approval_required: "🔐 يتطلب موافقة",
    done: "✅ اكتمل",
    warning: "⚠️ تنبيه",
    failed: "❌ فشل"
  }
};

export function activityLabel(locale: ActivityLabelLocale, key: ActivityLabelKey): string {
  return ACTIVITY_LABELS[locale][key];
}

export function renderChannelProgressLabel(
  event: RuntimeEvent,
  locale: ActivityLabelLocale = "en"
): string {
  switch (event.kind) {
    case "agent-start":
      return activityLabel(locale, "thinking");
    case "skill":
      return `${activityLabel(locale, "load_skill")}${event.name.length > 0 ? ` · ${event.name}` : ""}`;
    case "tool-start": {
      const summary = event.targetSummary?.trim();
      const label = toolDisplayLabel(event.tool, locale);
      const icon = toolDisplayIcon(event.tool, "channel");
      return summary === undefined || summary.length === 0
        ? `${icon} ${label}`
        : `${icon} ${label}: "${summary}"`;
    }
    case "provider-attempt":
      return "";
    case "provider-serving-transition":
      return `${providerServingTransitionLabel(locale, event.transition)} · ${event.model}`;
    case "agent-final":
    case "provider-token":
      return "";
    default:
      return "";
  }
}

function providerServingTransitionLabel(
  locale: ActivityLabelLocale,
  transition: Extract<RuntimeEvent, { kind: "provider-serving-transition" }>["transition"]
): string {
  if (locale === "ar") {
    return transition === "fallback-active"
      ? "✦ استخدام النموذج الاحتياطي"
      : "✦ النموذج الأساسي متاح مجددًا";
  }
  return transition === "fallback-active"
    ? "✦ Using fallback"
    : "✦ Primary model available again";
}

export function activityKeyForTool(tool: string): ActivityLabelKey {
  if (tool === "file.read") return "read_files";
  if (tool === "file.write") return "write_files";
  if (tool === "file.patch") return "patch_files";
  if (tool === "terminal.run" || tool === "process.start" || tool === "process.stop") return "run_command";
  if (tool === "execute_code" || tool === "python.probe" || tool === "process.logs" || tool === "process.list") {
    return "run_checks";
  }
  if (tool === "skill.read" || tool === "skill.search" || tool === "skill.view" || tool === "playbook.plan" || tool === "skill.inspect") return "load_skill";
  if (tool === "media.inspect" || tool === "media.extract-frame") return "inspect_media";
  if (tool === "vision.analyze") return "inspect_media";
  if (tool === "document.probe") return "process_attachment";
  if (tool === "web.extract" || tool === "browser.navigate" || tool === "browser.status") return "web_action";
  if (tool === "delegate_task") return "route_task";
  if (tool.includes("install") || tool.includes("build")) return "install_build";
  if (tool.includes("read")) return "inspect";
  if (tool.includes("write")) return "write_files";
  if (tool.includes("media")) return "inspect_media";
  if (tool.includes("web") || tool.includes("browser")) return "web_action";
  if (tool.includes("skill") || tool.includes("playbook") || tool.includes("workflow")) return "load_skill";
  return "inspect";
}
