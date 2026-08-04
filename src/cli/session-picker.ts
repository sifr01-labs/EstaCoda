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
    surface: "sessionPicker",
    columns: [
      { key: "number", header: "#", align: "right" },
      { key: "session", header: copy.session },
      { key: "started", header: copy.started },
      { key: "active", header: copy.lastActive },
      { key: "origin", header: copy.via },
    ],
    options: sessions.map((session, index) => ({
      id: session.id,
      value: session.id,
      label: session.description,
      description: [
        `${copy.started} ${formatSessionTimestamp(session.createdAt, locale)}`,
        `${copy.lastActive} ${formatSessionTimestamp(session.updatedAt, locale)}`,
        `${copy.via} ${technicalValue(formatSessionOrigin(session.originSurface, locale), locale)}`,
      ].join("  ·  "),
      cells: {
        number: String(index + 1),
        session: session.description,
        started: formatSessionTimestamp(session.createdAt, locale),
        active: formatSessionTimestamp(session.updatedAt, locale),
        origin: formatSessionOrigin(session.originSurface, locale),
      },
    })),
    defaultIndex: 0,
    fallbackPrompt: copy.fallbackPrompt,
    selectedLabel: copy.selectedLabel,
    instruction: copy.instruction,
    descriptionVisibility: "selected",
    visibleRows: 10,
    escapeCancels: true,
    locale,
    direction: locale === "ar" ? "rtl" : "ltr",
  };
}

function technicalValue(value: string, locale: UiLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

export function formatSessionTimestamp(value: string, locale: UiLocale = "en", timeZone?: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return locale === "ar" ? "غير معروف" : "Unknown";
  }
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(parsed);
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
      instruction: "↑↓ للتنقل  ·  ENTER للفتح  ·  ESC للإلغاء  ·  CTRL+C للخروج",
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
    instruction: "↑↓ navigate  ·  ENTER open  ·  ESC cancel  ·  CTRL+C exit",
  };
}
