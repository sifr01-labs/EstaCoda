export type ToolDisplayLocale = "en" | "ar";

export type ToolDisplaySurface =
  | "papyrus"
  | "cli"
  | "channel"
  | "plain-log"
  | "acp";

export type ToolDisplayLabelSet = {
  readonly en: string;
  readonly ar: string;
};

export const TOOL_DISPLAY_LABELS: Readonly<Record<string, ToolDisplayLabelSet>> = {
  "playbook.plan": { en: "Plan", ar: "تخطيط" },
  "trajectory.record": { en: "Record Trajectory", ar: "تسجيل المسار" },
  "file.read": { en: "Read File", ar: "قراءة ملف" },
  "file.write": { en: "Write File", ar: "كتابة ملف" },
  "file.patch": { en: "Patch File", ar: "تعديل ملف" },
  "file.search": { en: "Search Files", ar: "بحث الملفات" },
  "file.glob": { en: "Glob Files", ar: "مطابقة الملفات" },
  "file.grep": { en: "Grep Files", ar: "بحث نصي" },
  "terminal.inspect": { en: "Inspect Terminal", ar: "فحص الطرفية" },
  "terminal.run": { en: "Run Command", ar: "تشغيل أمر" },
  "notebook.edit": { en: "Edit Notebook", ar: "تعديل دفتر ملاحظات" },
  execute_code: { en: "Execute Code", ar: "تنفيذ كود" },
  "python.probe": { en: "Probe Python", ar: "فحص Python" },
  "document.probe": { en: "Probe Document", ar: "فحص مستند" },
  "web.search": { en: "Web Search", ar: "بحث الويب" },
  "web.extract": { en: "Web Extract", ar: "استخراج الويب" },
  "web.crawl": { en: "Web Crawl", ar: "زحف الويب" },
  "browser.status": { en: "Browser Status", ar: "حالة المتصفح" },
  "browser.snapshot": { en: "Browser Snapshot", ar: "لقطة الصفحة" },
  "browser.navigate": { en: "Browser Navigate", ar: "فتح صفحة" },
  "browser.click": { en: "Browser Click", ar: "نقر" },
  "browser.type": { en: "Browser Type", ar: "كتابة" },
  "browser.scroll": { en: "Browser Scroll", ar: "تمرير" },
  "browser.press": { en: "Browser Press", ar: "ضغط مفتاح" },
  "browser.back": { en: "Browser Back", ar: "رجوع" },
  "browser.get_images": { en: "Get Images", ar: "جلب الصور" },
  "browser.console": { en: "Browser Console", ar: "وحدة تحكم المتصفح" },
  "browser.cdp": { en: "Browser CDP", ar: "Browser CDP" },
  "browser.screenshot": { en: "Screenshot", ar: "لقطة شاشة" },
  "browser.vision": { en: "Browser Vision", ar: "تحليل بصري للمتصفح" },
  "browser.dialog": { en: "Browser Dialog", ar: "حوار المتصفح" },
  "media.probe-ffmpeg": { en: "Probe Media", ar: "فحص الوسائط" },
  "media.inspect": { en: "Inspect Media", ar: "معاينة الوسائط" },
  "media.extract-frame": { en: "Extract Frame", ar: "استخراج إطار" },
  "artifact.record": { en: "Record Artifact", ar: "تسجيل ناتج" },
  "voice.speak": { en: "Speak", ar: "نطق" },
  "voice.transcribe": { en: "Transcribe", ar: "تفريغ صوتي" },
  "image.generate": { en: "Generate Image", ar: "توليد صورة" },
  "image.edit": { en: "Edit Image", ar: "تعديل صورة" },
  "vision.analyze": { en: "Analyze Image", ar: "تحليل صورة" },
  "process.start": { en: "Start Process", ar: "بدء عملية" },
  "process.list": { en: "List Processes", ar: "عرض العمليات" },
  "process.logs": { en: "Process Logs", ar: "سجلات العملية" },
  "process.stop": { en: "Stop Process", ar: "إيقاف عملية" },
  cronjob: { en: "Cron Job", ar: "مهمة مجدولة" },
  "workspace.trust.status": { en: "Trust Status", ar: "حالة الثقة" },
  "workspace.trust.grant": { en: "Grant Trust", ar: "منح الثقة" },
  "workspace.trust.revoke": { en: "Revoke Trust", ar: "إلغاء الثقة" },
  "config.provider.status": { en: "Provider Status", ar: "حالة المزوّد" },
  "config.provider.execution_status": { en: "Execution Status", ar: "حالة تشغيل المزوّد" },
  "config.security.status": { en: "Security Status", ar: "حالة الأمان" },
  "config.compression.status": { en: "Compression Status", ar: "حالة الضغط" },
  "config.security.setup": { en: "Setup Security", ar: "إعداد الأمان" },
  "config.web.setup": { en: "Setup Web", ar: "إعداد الويب" },
  "config.browser.setup": { en: "Setup Browser", ar: "إعداد المتصفح" },
  "config.mcp.status": { en: "MCP Status", ar: "حالة MCP" },
  "config.mcp.setup": { en: "Setup MCP", ar: "إعداد MCP" },
  "config.telegram.setup": { en: "Setup Telegram", ar: "إعداد Telegram" },
  "config.telegram.status": { en: "Telegram Status", ar: "حالة Telegram" },
  "config.image.status": { en: "Image Status", ar: "حالة الصور" },
  "config.provider.setup": { en: "Setup Provider", ar: "إعداد المزوّد" },
  "config.image.setup": { en: "Setup Image", ar: "إعداد الصور" },
  "memory.curate": { en: "Curate Memory", ar: "تنقيح الذاكرة" },
  "memory.read": { en: "Read Memory", ar: "قراءة الذاكرة" },
  "memory.search": { en: "Search Memory", ar: "بحث الذاكرة" },
  "memory.file_compact": { en: "Compact Memory", ar: "ضغط ملف الذاكرة" },
  "memory.file_compaction_restore": { en: "Restore Memory", ar: "استعادة ملف الذاكرة" },
  session_search: { en: "Search Sessions", ar: "بحث الجلسات" },
  "task.result.read": { en: "Read Task Result", ar: "قراءة نتيجة مهمة" },
  "task.status": { en: "Task Status", ar: "حالة المهمة" },
  "skill.list": { en: "List Skills", ar: "عرض المهارات" },
  "skill.read": { en: "Read Skill", ar: "قراءة مهارة" },
  "skill.search": { en: "Search Skills", ar: "بحث المهارات" },
  "skill.view": { en: "View Skill", ar: "عرض مهارة" },
  "skill.inspect": { en: "Inspect Skill", ar: "فحص مهارة" },
  "skill.eval": { en: "Evaluate Skill", ar: "تقييم مهارة" },
  "skill.usage": { en: "Skill Usage", ar: "استخدام المهارة" },
  "skill.observe": { en: "Observe Skill", ar: "رصد مهارة" },
  "skill.propose_patch": { en: "Propose Patch", ar: "اقتراح تعديل" },
  "skill.list_proposals": { en: "List Proposals", ar: "عرض المقترحات" },
  "skill.review_proposals": { en: "Review Proposals", ar: "مراجعة المقترحات" },
  "skill.review_proposal": { en: "Review Proposal", ar: "مراجعة مقترح" },
  "skill.approve_patch": { en: "Approve Patch", ar: "قبول تعديل" },
  "skill.reject_patch": { en: "Reject Patch", ar: "رفض تعديل" },
  "skill.promote_patch": { en: "Promote Patch", ar: "ترقية تعديل" },
  "skill.create": { en: "Create Skill", ar: "إنشاء مهارة" },
  "skill.patch": { en: "Patch Skill", ar: "تعديل مهارة" },
  "skill.edit": { en: "Edit Skill", ar: "تحرير مهارة" },
  "skill.delete": { en: "Delete Skill", ar: "حذف مهارة" },
  "skill.rollback": { en: "Roll Back Skill", ar: "إرجاع مهارة" },
  "skill.reset": { en: "Reset Skill", ar: "إعادة ضبط مهارة" },
  "skill.write_file": { en: "Write Skill File", ar: "كتابة ملف مهارة" },
  "skill.remove_file": { en: "Remove Skill File", ar: "إزالة ملف مهارة" },
  "skill.import": { en: "Import Skill", ar: "استيراد مهارة" },
  "skill.export": { en: "Export Skill", ar: "تصدير مهارة" },
  "knowledge.memory.inspect": { en: "Inspect Memory", ar: "فحص الذاكرة" },
  "knowledge.memory.deactivate": { en: "Deactivate Memory", ar: "تعطيل ذاكرة" },
  "knowledge.code.query": { en: "Query Code", ar: "بحث الكود" },
  delegate_task: { en: "Delegate Task", ar: "إسناد مهمة" }
};

const TOOL_DISPLAY_ICONS: Readonly<Record<string, string>> = {
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
  "file.patch": "🔧",
  "file.search": "🔎",
  "file.glob": "📄",
  "file.grep": "🔎",
  "terminal.inspect": "🖥️",
  "terminal.run": "🖥️",
  "notebook.edit": "📓",
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
  "config.provider.execution_status": "⚙️",
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
  "memory.read": "🜂",
  "memory.search": "🔎",
  "memory.file_compact": "🗜️",
  "memory.file_compaction_restore": "↩️",
  session_search: "🔎",
  "task.result.read": "📖",
  "task.status": "📋",
  "skill.list": "📜",
  "skill.read": "☥",
  "skill.search": "🔎",
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

const TITLE_CASE_OVERRIDES: Readonly<Record<string, string>> = {
  api: "API",
  cdp: "CDP",
  cli: "CLI",
  css: "CSS",
  dom: "DOM",
  ffmpeg: "FFmpeg",
  github: "GitHub",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  json: "JSON",
  mcp: "MCP",
  oauth: "OAuth",
  pdf: "PDF",
  python: "Python",
  stt: "STT",
  tts: "TTS",
  ui: "UI",
  url: "URL",
  urls: "URLs"
};

export function toolDisplayLabel(tool: string, locale: ToolDisplayLocale = "en"): string {
  const label = TOOL_DISPLAY_LABELS[tool]?.[locale];
  if (label !== undefined) {
    return label;
  }

  const fallback = dynamicToolDisplayLabel(tool);
  return locale === "ar" ? `أداة ${fallback}` : fallback;
}

export function toolDisplayIcon(tool: string, surface: ToolDisplaySurface = "cli"): string {
  if (surface === "plain-log" || surface === "acp") {
    return "";
  }
  return TOOL_DISPLAY_ICONS[tool] ?? fallbackToolDisplayIcon(tool);
}

export function formatToolDisplayCall(input: {
  readonly tool: string;
  readonly preview?: string;
  readonly locale?: ToolDisplayLocale;
}): string {
  const label = toolDisplayLabel(input.tool, input.locale);
  const preview = normalizeDisplayPreview(input.preview);
  return preview === undefined ? label : `${label}("${preview}")`;
}

function dynamicToolDisplayLabel(tool: string): string {
  const parts = tool.startsWith("mcp.")
    ? tool.slice("mcp.".length).split(".")
    : tool.split(".");

  return parts
    .flatMap((part) => part.split(/[_-]+/u))
    .map((part) => titleCaseSegment(part))
    .filter((part) => part.length > 0)
    .join(" ") || "Tool";
}

function titleCaseSegment(segment: string): string {
  const lower = segment.trim().toLowerCase();
  if (lower.length === 0) {
    return "";
  }

  const override = TITLE_CASE_OVERRIDES[lower];
  if (override !== undefined) {
    return override;
  }

  return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
}

function fallbackToolDisplayIcon(tool: string): string {
  if (tool.startsWith("browser.") || tool.includes("browser")) return "🧿";
  if (tool.startsWith("web.") || tool.includes("web")) return "🌐";
  if (tool.startsWith("file.")) return "📄";
  if (tool.startsWith("terminal.")) return "🖥️";
  if (tool.startsWith("process.")) return "▶️";
  if (tool.startsWith("skill.")) return "☥";
  if (tool.startsWith("memory.")) return "💠";
  if (tool.startsWith("knowledge.")) return "𓂀";
  if (tool.startsWith("config.")) return "⚙️";
  return "⚙️";
}

function normalizeDisplayPreview(preview: string | undefined): string | undefined {
  const normalized = preview?.replace(/\s+/gu, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
