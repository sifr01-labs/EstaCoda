import type { RuntimeEvent } from "../contracts/runtime-event.js";

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
      return summary === undefined || summary.length === 0
        ? `${toolEmoji(event.tool)} ${event.tool}`
        : `${toolEmoji(event.tool)} ${event.tool}: "${summary}"`;
    }
    case "provider-attempt":
      return event.fallback
        ? `${providerRoutingLabel(locale, true)} · ${event.model}`
        : `${providerRoutingLabel(locale, false)} · ${event.model}`;
    case "agent-final":
    case "provider-token":
      return "";
    default:
      return "";
  }
}

function providerRoutingLabel(locale: ActivityLabelLocale, fallback: boolean): string {
  if (locale === "ar") {
    return fallback ? "✦ توجيه احتياطي" : "✦ توجيه النموذج";
  }
  return fallback ? "✦ Routing fallback" : "✦ Routing provider";
}

export function toolEmoji(tool: string): string {
  return CHANNEL_TOOL_EMOJI[tool] ?? fallbackToolEmoji(tool);
}

const CHANNEL_TOOL_EMOJI: Record<string, string> = {
  "playbook.plan": "🜁",
  "trajectory.record": "🜃",
  "python.probe": "𓆙",
  "document.probe": "📄",
  "web.search": "🔎",
  "web.extract": "🌐",
  "web.crawl": "🕷️",
  "browser.status": "🧿",
  "browser.snapshot": "📸",
  "browser.click": "🖱️",
  "browser.type": "⌨️",
  "browser.scroll": "📜",
  "browser.press": "⌨️",
  "browser.back": "↩️",
  "browser.get_images": "🖼️",
  "browser.console": "🖥️",
  "browser.cdp": "🔌",
  "browser.screenshot": "📸",
  "browser.vision": "👁️",
  "browser.dialog": "💬",
  "browser.navigate": "🧭",
  "file.read": "📖",
  "file.write": "✍️",
  "file.replace": "🔧",
  "file.search": "🔎",
  "terminal.run": "🖥️",
  "media.probe-ffmpeg": "🎬",
  "media.inspect": "🖼️",
  "media.extract-frame": "🎞️",
  "artifact.record": "◆",
  "voice.speak": "🔊",
  "voice.transcribe": "🎙️",
  "image.generate": "🎨",
  "vision.analyze": "👁️",
  "process.start": "▶️",
  "process.list": "📋",
  "process.logs": "📜",
  "process.stop": "⏹️",
  "workspace.trust.status": "🔐",
  "workspace.trust.grant": "✅",
  "workspace.trust.revoke": "❌",
  "config.provider.status": "⚙️",
  "config.security.status": "🔐",
  "config.compression.status": "🗜️",
  "config.security.setup": "🔐",
  "config.web.setup": "🌐",
  "config.browser.setup": "🧭",
  "config.mcp.status": "🔌",
  "config.mcp.setup": "🔌",
  "config.telegram.setup": "💬",
  "config.telegram.status": "💬",
  "config.image.status": "🎨",
  "config.provider.setup": "⚙️",
  "config.image.setup": "🎨",
  cronjob: "◷",
  "memory.curate": "🜂",
  "memory.file_compact": "🗜️",
  "memory.file_compaction_restore": "↩️",
  "skill.list": "📜",
  "skill.view": "☥",
  "skill.inspect": "𓂀",
  "skill.eval": "⚖️",
  "skill.usage": "📈",
  "skill.observe": "𓂀",
  "skill.propose_patch": "🜏",
  "skill.list_proposals": "📋",
  "skill.review_proposals": "⚖️",
  "skill.review_proposal": "⚖️",
  "skill.approve_patch": "✅",
  "skill.reject_patch": "❌",
  "skill.promote_patch": "⬆️",
  "skill.create": "✦",
  "skill.patch": "🜏",
  "skill.edit": "✍️",
  "skill.delete": "🗑️",
  "skill.rollback": "↩️",
  "skill.reset": "🔄",
  "skill.write_file": "✍️",
  "skill.remove_file": "🗑️",
  "skill.import": "📥",
  "skill.export": "📤",
  "knowledge.memory.inspect": "𓂀",
  "knowledge.memory.deactivate": "⊘",
  "knowledge.code.query": "𓂀",
  delegate_task: "⚔️",
  execute_code: "𓆙"
};

function fallbackToolEmoji(tool: string): string {
  if (tool.startsWith("browser.") || tool.includes("browser")) return "🧿";
  if (tool.startsWith("web.") || tool.includes("web")) return "🌐";
  if (tool.startsWith("file.")) return "📄";
  if (tool.startsWith("terminal.")) return "🖥️";
  if (tool.startsWith("process.")) return "▶️";
  if (tool.startsWith("skill.")) return "☥";
  if (tool.startsWith("memory.")) return "🜂";
  if (tool.startsWith("knowledge.")) return "𓂀";
  if (tool.startsWith("config.")) return "⚙️";
  return "⚙️";
}

export function activityKeyForTool(tool: string): ActivityLabelKey {
  if (tool === "file.read") return "read_files";
  if (tool === "file.write") return "write_files";
  if (tool === "file.replace") return "patch_files";
  if (tool === "terminal.run" || tool === "process.start" || tool === "process.stop") return "run_command";
  if (tool === "execute_code" || tool === "python.probe" || tool === "process.logs" || tool === "process.list") {
    return "run_checks";
  }
  if (tool === "skill.view" || tool === "playbook.plan" || tool === "skill.inspect") return "load_skill";
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
