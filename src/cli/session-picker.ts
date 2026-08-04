import type { UiLocale } from "../contracts/ui.js";
import type { SessionPresentation } from "../session/session-presentation.js";
import { isolateLtr } from "../ui/bidi.js";
import type { SelectPromptInput } from "./interactive-select.js";

export const SESSION_PICKER_LIMIT = 20;

export function buildSessionPickerPrompt(
  sessions: readonly SessionPresentation[],
  locale: UiLocale = "en"
): SelectPromptInput<string> {
  const copy = sessionPickerCopy(locale);
  return {
    title: copy.title,
    columns: [
      { key: "number", header: "#", align: "right" },
      { key: "session", header: copy.session },
    ],
    options: sessions.map((session, index) => ({
      id: session.id,
      value: session.id,
      label: session.description,
      description: [
        `${copy.started} ${technicalValue(formatSessionTimestamp(session.createdAt), locale)}`,
        `${copy.lastActive} ${technicalValue(formatSessionTimestamp(session.updatedAt), locale)}`,
        `${copy.via} ${technicalValue(formatSessionOrigin(session.originSurface, locale), locale)}`,
      ].join("  ·  "),
      cells: {
        number: String(index + 1),
        session: session.description,
      },
    })),
    defaultIndex: 0,
    fallbackPrompt: copy.fallbackPrompt,
    selectedLabel: copy.selectedLabel,
    instruction: copy.instruction,
    descriptionVisibility: "selected",
    visibleRows: 10,
    locale,
    direction: locale === "ar" ? "rtl" : "ltr",
  };
}

function technicalValue(value: string, locale: UiLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

export function formatSessionTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return "Unknown";
  }
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatSessionOrigin(origin: string | undefined, locale: UiLocale = "en"): string {
  if (origin === undefined) return locale === "ar" ? "غير معروف" : "Unknown";
  switch (origin.toLocaleLowerCase("en")) {
    case "cli":
      return "CLI";
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "whatsapp":
      return "WhatsApp";
    case "email":
      return "Email";
    default:
      return origin;
  }
}

export function noResumableSessionsMessage(locale: UiLocale = "en"): string {
  return locale === "ar"
    ? "لا توجد جلسات قابلة للاستئناف في مساحة العمل الحالية."
    : "No resumable sessions found in the current workspace.";
}

function sessionPickerCopy(locale: UiLocale): {
  title: string;
  session: string;
  started: string;
  lastActive: string;
  via: string;
  fallbackPrompt: string;
  selectedLabel: string;
  instruction: string;
} {
  if (locale === "ar") {
    return {
      title: "اختر جلسة",
      session: "الجلسة",
      started: "بدأت",
      lastActive: "آخر نشاط",
      via: "عبر",
      fallbackPrompt: "رقم الجلسة [1]: ",
      selectedLabel: "فتح الجلسة",
      instruction: "↑↓ للتنقل  ·  ENTER للفتح  ·  CTRL+C للخروج",
    };
  }
  return {
    title: "Choose a session",
    session: "Session",
    started: "Started",
    lastActive: "Last active",
    via: "Via",
    fallbackPrompt: "Session number [1]: ",
    selectedLabel: "Opening session",
    instruction: "↑↓ navigate  ·  ENTER open  ·  CTRL+C exit",
  };
}
