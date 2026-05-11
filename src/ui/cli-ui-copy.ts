// v0.95 UI Chrome Copy Boundary
// Small, focused copy map for new interactive chrome labels only.
// Do not use this for legacy command output — keep those English.

import { isolateLtr } from "./bidi.js";

export type UiLocale = "en" | "ar";

export interface CliUiChromeCopy {
  // Assistant card (Pass 6+)
  readonly assistantCardTitle: string;
  readonly assistantCardTitleUnicode: string;
  readonly assistantCardTitleAscii: string;

  // Status rail labels (Pass 7+)
  readonly model: string;
  readonly readiness: string;
  readonly context: string;
  readonly idle: string;
  readonly running: string;
  readonly blocked: string;
  readonly error: string;

  // Shortcut rail (Pass 7+)
  readonly shortcuts: string;

  // Active turn spinner (Pass 9+)
  readonly thinking: string;
  readonly routing: string;
  readonly provider: string;
  readonly tool: string;
  readonly finalizing: string;

  // Permission card (Pass 10+)
  readonly permissionRequired: string;
  readonly cardTool: string;
  readonly cardRisk: string;
  readonly cardTarget: string;
  readonly allowOnce: string;
  readonly allowSession: string;
  readonly allowAlways: string;
  readonly deny: string;

  // Tool activity rail (Pass 11A+)
  readonly preparing: string;
  readonly read: string;
  readonly write: string;
  readonly run: string;
  readonly fetch: string;
  readonly review: string;
  readonly memo: string;
  readonly delegate: string;
  readonly config: string;
  readonly media: string;
  readonly plan: string;
  readonly failed: string;
  readonly gated: string;

  // File change preview (Pass 12+)
  readonly created: string;
  readonly edited: string;
  readonly deleted: string;
  readonly omittedDiffLines: (count: number) => string;

  // Startup chrome (Pass 12.5)
  readonly startupVersion: string;
  readonly startupSession: string;
  readonly startupModel: string;
  readonly startupReadiness: string;
  readonly startupWorkspaceTrust: string;
  readonly startupWorkspaceVerification: string;
  readonly startupWorkspaceDirectory: string;
  readonly startupSecurityMode: string;
  readonly startupSkillAutonomy: string;
  readonly startupVersionStatus: string;
  readonly startupInteractiveCommands: string;
  readonly startupReady: string;
  readonly startupDegraded: string;
  readonly startupMissingConfig: string;
  readonly startupModelNotConfigured: string;
  readonly startupUnknown: string;
  readonly startupTrusted: string;
  readonly startupUntrusted: string;
  readonly startupVerified: string;
  readonly startupUnverified: string;
  readonly startupCommandTools: string;
  readonly startupCommandSkills: string;
  readonly startupCommandModel: string;
  readonly startupCommandStatus: string;
  readonly startupPromptHint: string;

  // Slash menu (Pass 13+)
  readonly commands: string;
  readonly typeToFilter: string;
  readonly slashNoMatches: (query: string) => string;
  readonly slashCommandHelpDescription: string;
  readonly slashCommandStatusDescription: string;
  readonly slashCommandModelDescription: string;
  readonly slashCommandToolsDescription: string;
  readonly slashCommandSkillsDescription: string;
  readonly slashCommandExitDescription: string;
}

const en: CliUiChromeCopy = {
  assistantCardTitle: "EstaCoda",
  assistantCardTitleUnicode: "𓂀 EstaCoda",
  assistantCardTitleAscii: "* EstaCoda",

  model: "model",
  readiness: "readiness",
  context: "context",
  idle: "idle",
  running: "running",
  blocked: "blocked",
  error: "error",

  shortcuts: "/help · /tools · /model · /status · Ctrl+C exit",

  thinking: "contemplating",
  routing: "plotting",
  provider: "scribbling",
  tool: "tinkering",
  finalizing: "polishing",

  permissionRequired: "Permission required",
  cardTool: "Tool",
  cardRisk: "Risk",
  cardTarget: "Target",
  allowOnce: "Allow once",
  allowSession: "Allow session",
  allowAlways: "Always allow",
  deny: "Deny",

  preparing: "preparing",
  read: "read",
  write: "write",
  run: "run",
  fetch: "fetch",
  review: "review",
  memo: "memo",
  delegate: "delegate",
  config: "config",
  media: "media",
  plan: "plan",
  failed: "failed",
  gated: "gated",

  created: "created",
  edited: "edited",
  deleted: "deleted",
  omittedDiffLines: (count) => `omitted ${count} diff line(s).`,

  startupVersion: "version",
  startupSession: "session",
  startupModel: "model",
  startupReadiness: "readiness",
  startupWorkspaceTrust: "Workspace Trust",
  startupWorkspaceVerification: "Workspace Verification",
  startupWorkspaceDirectory: "Workspace Directory",
  startupSecurityMode: "User Security Mode",
  startupSkillAutonomy: "User Skill Autonomy",
  startupVersionStatus: "Version Status",
  startupInteractiveCommands: "Interactive Commands:",
  startupReady: "ready",
  startupDegraded: "degraded",
  startupMissingConfig: "missing config",
  startupModelNotConfigured: "model not configured",
  startupUnknown: "unknown",
  startupTrusted: "trusted",
  startupUntrusted: "untrusted",
  startupVerified: "verified",
  startupUnverified: "unverified",
  startupCommandTools: "Browse runtime tools",
  startupCommandSkills: "Browse skills",
  startupCommandModel: "Show active model",
  startupCommandStatus: "Show session status",
  startupPromptHint: "Type a message. Use /help for commands or /exit to leave.",

  commands: "Commands",
  typeToFilter: "Type / then a command. Keep typing to filter.",
  slashNoMatches: (query) => `No slash commands match "${query}".`,
  slashCommandHelpDescription: "Show command help",
  slashCommandStatusDescription: "Show runtime, model, context, and session status",
  slashCommandModelDescription: "Show active model",
  slashCommandToolsDescription: "Browse runtime tools",
  slashCommandSkillsDescription: "Browse skills",
  slashCommandExitDescription: "Exit session",
};

const ar: CliUiChromeCopy = {
  assistantCardTitle: "إستاكودا",
  assistantCardTitleUnicode: "𓂀 إستاكودا",
  assistantCardTitleAscii: "* إستاكودا",

  model: "النموذج",
  readiness: "الجاهزية",
  context: "السياق",
  idle: "خامل",
  running: "شغال",
  blocked: "محجوز",
  error: "خطأ",

  // Technical tokens inside Arabic shortcuts must stay LTR-stable
  shortcuts: `${isolateLtr("/help")} · ${isolateLtr("/tools")} · ${isolateLtr("/model")} · ${isolateLtr("/status")} · ${isolateLtr("Ctrl+C")} خروج`,

  thinking: "بفكر",
  routing: "بحدد",
  provider: "بكتب",
  tool: "شغال",
  finalizing: "بخلص",

  permissionRequired: "مطلوب إذن",
  cardTool: "الأداة",
  cardRisk: "المخاطرة",
  cardTarget: "الهدف",
  allowOnce: "السماح مرة واحدة",
  allowSession: "السماح لهذه الجلسة",
  allowAlways: "السماح دائماً",
  deny: "رفض",

  preparing: "تحضير",
  read: "قراءة",
  write: "كتابة",
  run: "تشغيل",
  fetch: "جلب",
  review: "مراجعة",
  memo: "تدوين",
  delegate: "تفويض",
  config: "إعداد",
  media: "وسائط",
  plan: "تخطيط",
  failed: "فشل",
  gated: "محجوب",

  created: "أنشأ",
  edited: "عدّل",
  deleted: "حذف",
  omittedDiffLines: (count) => `تم إخفاء ${isolateLtr(String(count))} سطر/أسطر من الفرق.`,

  startupVersion: "الإصدار",
  startupSession: "الجلسة",
  startupModel: "النموذج",
  startupReadiness: "الجاهزية",
  startupWorkspaceTrust: "ثقة مساحة العمل",
  startupWorkspaceVerification: "حالة تحقق مساحة العمل",
  startupWorkspaceDirectory: "مسار مساحة العمل",
  startupSecurityMode: "وضع الأمان",
  startupSkillAutonomy: "استقلالية المهارات",
  startupVersionStatus: "حالة الإصدار",
  startupInteractiveCommands: "الأوامر التفاعلية:",
  startupReady: "جاهز",
  startupDegraded: "جاهزية جزئية",
  startupMissingConfig: "إعداد ناقص",
  startupModelNotConfigured: "النموذج غير مهيأ",
  startupUnknown: "غير معروف",
  startupTrusted: "موثوقة",
  startupUntrusted: "غير موثوقة",
  startupVerified: "متحقق منها",
  startupUnverified: "غير متحقق منها",
  startupCommandTools: "استعرض أدوات التشغيل",
  startupCommandSkills: "استعرض المهارات",
  startupCommandModel: "اعرض النموذج النشط",
  startupCommandStatus: "اعرض حالة الجلسة",
  startupPromptHint: `اكتب رسالة. استخدم ${isolateLtr("/help")} للأوامر أو ${isolateLtr("/exit")} للمغادرة.`,

  commands: "الأوامر",
  typeToFilter: "اكتب / ثم أمر. استمر في الكتابة للتصفية.",
  slashNoMatches: (query) => `لا توجد أوامر تطابق ${isolateLtr(query)}.`,
  slashCommandHelpDescription: "اعرض مساعدة الأوامر",
  slashCommandStatusDescription: "اعرض حالة التشغيل والنموذج والسياق والجلسة",
  slashCommandModelDescription: "اعرض النموذج النشط",
  slashCommandToolsDescription: "استعرض أدوات التشغيل",
  slashCommandSkillsDescription: "استعرض المهارات",
  slashCommandExitDescription: "غادر الجلسة",
};

export const cliUiChromeCopy: Record<UiLocale, CliUiChromeCopy> = {
  en,
  ar,
};

export function chromeCopy(locale: UiLocale): CliUiChromeCopy {
  return cliUiChromeCopy[locale] ?? en;
}
