// v0.95 Channel-Safe Progress Labels
// No-emoji, ANSI-free activity labels for CI/log-safe and email channels.

import type { RuntimeEvent } from "../../contracts/runtime-event.js";

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

const PLAIN_ACTIVITY_LABELS: Record<ActivityLabelLocale, Record<ActivityLabelKey, string>> = {
  en: {
    thinking: "Thinking",
    inspect: "Inspecting",
    read_files: "Reading files",
    write_files: "Writing files",
    patch_files: "Patching files",
    run_command: "Running command",
    run_checks: "Running checks",
    install_build: "Installing/building",
    load_skill: "Loading skill",
    route_task: "Routing task",
    process_attachment: "Processing attachment",
    inspect_media: "Inspecting media",
    web_action: "Web action",
    approval_required: "Approval required",
    done: "Done",
    warning: "Warning",
    failed: "Failed",
  },
  ar: {
    thinking: "جارٍ التفكير",
    inspect: "جارٍ الفحص",
    read_files: "قراءة الملفات",
    write_files: "كتابة الملفات",
    patch_files: "تعديل الملفات",
    run_command: "تشغيل أمر",
    run_checks: "تشغيل الفحوصات",
    install_build: "تثبيت/بناء",
    load_skill: "تحميل مهارة",
    route_task: "توجيه المهمة",
    process_attachment: "معالجة مرفق",
    inspect_media: "فحص الوسائط",
    web_action: "إجراء ويب",
    approval_required: "يتطلب موافقة",
    done: "اكتمل",
    warning: "تنبيه",
    failed: "فشل",
  },
};

export function plainActivityLabel(locale: ActivityLabelLocale, key: ActivityLabelKey): string {
  return PLAIN_ACTIVITY_LABELS[locale][key];
}

export function renderPlainProgressLabel(
  event: RuntimeEvent,
  locale: ActivityLabelLocale = "en"
): string {
  switch (event.kind) {
    case "agent-start":
      return plainActivityLabel(locale, "thinking");
    case "skill":
      return `${plainActivityLabel(locale, "load_skill")}${event.name.length > 0 ? ` · ${event.name}` : ""}`;
    case "tool-start":
      return plainActivityLabel(locale, plainActivityKeyForTool(event.tool));
    case "provider-attempt":
      return plainActivityLabel(locale, "route_task");
    case "agent-final":
    case "provider-token":
      return "";
    default:
      return "";
  }
}

export function plainActivityKeyForTool(tool: string): ActivityLabelKey {
  if (tool === "file.read") return "read_files";
  if (tool === "file.write") return "write_files";
  if (tool === "file.replace") return "patch_files";
  if (tool === "terminal.run" || tool === "process.start" || tool === "process.stop") return "run_command";
  if (
    tool === "execute_code" ||
    tool === "python.probe" ||
    tool === "process.logs" ||
    tool === "process.list"
  ) {
    return "run_checks";
  }
  if (tool === "skill.view" || tool === "workflow.plan" || tool === "skill.inspect") return "load_skill";
  if (tool === "media.inspect" || tool === "media.extract-frame") return "inspect_media";
  if (tool === "vision.analyze") return "inspect_media";
  if (tool === "document.probe") return "process_attachment";
  if (tool === "web.extract" || tool === "browser.navigate" || tool === "browser.status")
    return "web_action";
  if (tool === "delegate_task") return "route_task";
  if (tool.includes("install") || tool.includes("build")) return "install_build";
  if (tool.includes("read")) return "inspect";
  if (tool.includes("write")) return "write_files";
  if (tool.includes("media")) return "inspect_media";
  if (tool.includes("web") || tool.includes("browser")) return "web_action";
  if (tool.includes("skill") || tool.includes("workflow")) return "load_skill";
  return "inspect";
}
