import { describe, expect, it } from "vitest";
import {
  formatToolDisplayCall,
  TOOL_DISPLAY_LABELS,
  toolDisplayIcon,
  toolDisplayLabel,
  type ToolDisplayLabelSet
} from "./tool-display.js";

const expectedLabels: Record<string, ToolDisplayLabelSet> = {
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

describe("tool display labels", () => {
  it("matches the approved native English and Arabic label table", () => {
    expect(TOOL_DISPLAY_LABELS).toEqual(expectedLabels);
    for (const [tool, label] of Object.entries(expectedLabels)) {
      expect(toolDisplayLabel(tool, "en")).toBe(label.en);
      expect(toolDisplayLabel(tool, "ar")).toBe(label.ar);
    }
  });

  it("keeps technical identifiers inside Arabic labels when approved", () => {
    expect(toolDisplayLabel("python.probe", "ar")).toBe("فحص Python");
    expect(toolDisplayLabel("browser.cdp", "ar")).toBe("Browser CDP");
    expect(toolDisplayLabel("config.mcp.setup", "ar")).toBe("إعداد MCP");
    expect(toolDisplayLabel("config.telegram.status", "ar")).toBe("حالة Telegram");
  });

  it("formats dynamic MCP labels without translating server or tool tokens", () => {
    expect(toolDisplayLabel("mcp.sheets.read", "en")).toBe("Sheets Read");
    expect(toolDisplayLabel("mcp.sheets.read", "ar")).toBe("أداة Sheets Read");
    expect(toolDisplayLabel("mcp.github.issues", "en")).toBe("GitHub Issues");
    expect(toolDisplayLabel("mcp.github.issues", "ar")).toBe("أداة GitHub Issues");
    expect(toolDisplayLabel("mcp.filesystem.read", "en")).toBe("Filesystem Read");
    expect(toolDisplayLabel("mcp.filesystem.read", "ar")).toBe("أداة Filesystem Read");
  });

  it("uses a stable title-case fallback for unknown non-MCP tools", () => {
    expect(toolDisplayLabel("web_search", "en")).toBe("Web Search");
    expect(toolDisplayLabel("custom.api_fetch", "en")).toBe("Custom API Fetch");
    expect(toolDisplayLabel("custom.api_fetch", "ar")).toBe("أداة Custom API Fetch");
  });

  it("suppresses icons on plain and ACP surfaces", () => {
    expect(toolDisplayIcon("web.search", "channel")).toBe("🔎");
    expect(toolDisplayIcon("task.result.read", "papyrus")).toBe("📖");
    expect(toolDisplayIcon("terminal.run", "cli")).toBe("🖥️");
    expect(toolDisplayIcon("terminal.run", "plain-log")).toBe("");
    expect(toolDisplayIcon("terminal.run", "acp")).toBe("");
  });

  it("formats display calls with compact previews", () => {
    expect(formatToolDisplayCall({ tool: "file.read", preview: "src/main.ts", locale: "en" })).toBe("Read File(\"src/main.ts\")");
    expect(formatToolDisplayCall({ tool: "terminal.run", preview: "pnpm run test", locale: "ar" })).toBe("تشغيل أمر(\"pnpm run test\")");
    expect(formatToolDisplayCall({ tool: "web.search", preview: "  OpenAI\nResponses API  ", locale: "ar" })).toBe("بحث الويب(\"OpenAI Responses API\")");
    expect(formatToolDisplayCall({ tool: "delegate_task", locale: "en" })).toBe("Delegate Task");
  });
});
