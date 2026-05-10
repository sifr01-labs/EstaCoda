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

  // Slash menu (Pass 13+)
  readonly commands: string;
  readonly typeToFilter: string;
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

  commands: "Commands",
  typeToFilter: "Type / then a command. Keep typing to filter.",
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

  commands: "الأوامر",
  typeToFilter: "اكتب / ثم أمر. استمر في الكتابة للتصفية.",
};

export const cliUiChromeCopy: Record<UiLocale, CliUiChromeCopy> = {
  en,
  ar,
};

export function chromeCopy(locale: UiLocale): CliUiChromeCopy {
  return cliUiChromeCopy[locale] ?? en;
}
