import { measureVisibleWidth, truncateVisible } from "../../renderers/layout.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type {
  ActivityTraceInspectionState,
  TaskCardActivityState,
  TaskCardState,
} from "./operatorConsoleState.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

const TRACE_CATEGORIES: readonly TaskCardActivityState["category"][] = [
  "terminal",
  "search",
  "plan",
  "read",
  "edit",
  "answer",
  "wait",
  "finish",
  "failed",
];

type TraceCopy = {
  readonly activityTrace: string;
  readonly event: string;
  readonly events: string;
  readonly noActivity: string;
  readonly earlier: string;
  readonly earlierOmitted: string;
  readonly later: string;
  readonly live: string;
  readonly retained: string;
  readonly returnToLive: string;
  readonly task: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, TraceCopy>> = {
  en: {
    activityTrace: "Activity trace",
    event: "event",
    events: "events",
    noActivity: "No retained safe activity yet",
    earlier: "earlier",
    earlierOmitted: "earlier history omitted",
    later: "later",
    live: "live",
    retained: "retained",
    returnToLive: "Return to live → End",
    task: "Task",
  },
  ar: {
    activityTrace: "مسار النشاط",
    event: "حدث",
    events: "أحداث",
    noActivity: "لا يوجد نشاط آمن محفوظ بعد",
    earlier: "أسبق",
    earlierOmitted: "سجل أسبق غير محفوظ",
    later: "لاحق",
    live: "مباشر",
    retained: "محفوظ",
    returnToLive: "العودة للبث المباشر ← End",
    task: "المهمة",
  },
};

export type ActivityTraceWindow = {
  readonly events: readonly TaskCardActivityState[];
  readonly startIndex: number;
  readonly earlierCount: number;
  readonly laterCount: number;
  readonly selectedEvent?: TaskCardActivityState;
};

export type TraceNavigationAction = "left" | "right" | "home" | "end";

export type ActivityTraceHitLayout = {
  readonly events: readonly { readonly eventId: string; readonly column: number }[];
  readonly liveColumn: number;
};

export function renderActivityTraceSurface(
  card: TaskCardState,
  inspection: ActivityTraceInspectionState | undefined,
  options: {
    readonly width: number;
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
  }
): readonly string[] {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const style = options.style;
  const tokens = style?.tokens.contract;
  const followLive = inspection?.followLive ?? true;
  const window = getActivityTraceWindow(card.trace.events, inspection, width);
  const eventLabel = card.trace.events.length === 1 ? copy.event : copy.events;
  const title = `${copy.activityTrace} · ${card.trace.events.length} ${eventLabel}`;
  const styledTitle = tokens === undefined
    ? title
    : styleColor(style, styleBold(style, title), tokens.palette.accent);
  if (window.selectedEvent === undefined) {
    return [styledTitle, `  ${copy.noActivity}`, formatTraceCounters(card.trace.events, locale, style)];
  }

  const omitted = card.trace.hasEarlierEvents
    ? `${tokens?.glyph.trace.earlier ?? "<"} ${copy.earlierOmitted} · `
    : "";
  const earlier = window.earlierCount > 0
    ? `${tokens?.glyph.trace.earlier ?? "<"} ${window.earlierCount} ${copy.earlier} `
    : "";
  const later = window.laterCount > 0 ? ` ${window.laterCount} ${copy.later} ` : " ";
  const glyphs = window.events.map((event) => {
    const selected = event.eventId === window.selectedEvent?.eventId;
    const glyph = selected
      ? tokens?.glyph.trace.selected ?? "o"
      : tokens?.glyph.trace.event ?? ".";
    const color = tokens?.trace[event.category];
    return color === undefined ? glyph : styleColor(style, glyph, color);
  }).join("");
  const liveGlyph = tokens?.glyph.trace.live ?? ">";
  const styledLiveGlyph = tokens === undefined
    ? liveGlyph
    : styleColor(style, liveGlyph, tokens.severity.ok);
  const tracePrefix = `  ${omitted}${earlier}`;
  const traceLine = `${tracePrefix}${glyphs}${later}${styledLiveGlyph} ${copy.live}`;
  const origin = traceEventOrigin(card, window.selectedEvent, copy.task, locale);
  const category = formatCategory(window.selectedEvent.category, locale);
  const categoryColor = tokens?.trace[window.selectedEvent.category];
  const styledCategory = categoryColor === undefined
    ? category
    : styleColor(style, styleBold(style, category), categoryColor);
  const callout = `  └ ${styledCategory} · ${origin} · ${formatTimestamp(window.selectedEvent.timestamp)} · ${window.selectedEvent.label}`;
  return [
    styledTitle,
    truncateVisible(traceLine, width, "…"),
    truncateVisible(callout, width, "…"),
    formatTraceCounters(card.trace.events, locale, style, card.trace.hasEarlierEvents),
    ...(followLive ? [] : [`  ${copy.returnToLive}`]),
  ];
}

export function getActivityTraceHitLayout(
  card: TaskCardState,
  inspection: ActivityTraceInspectionState | undefined,
  options: { readonly width: number; readonly locale?: OperatorConsoleLocale }
): ActivityTraceHitLayout | undefined {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const window = getActivityTraceWindow(card.trace.events, inspection, width);
  if (window.selectedEvent === undefined) return undefined;
  const omitted = card.trace.hasEarlierEvents ? `< ${copy.earlierOmitted} · ` : "";
  const earlier = window.earlierCount > 0 ? `< ${window.earlierCount} ${copy.earlier} ` : "";
  const startColumn = measureVisibleWidth(`  ${omitted}${earlier}`);
  const later = window.laterCount > 0 ? ` ${window.laterCount} ${copy.later} ` : " ";
  return {
    events: window.events.map((event, index) => ({ eventId: event.eventId, column: startColumn + index })),
    liveColumn: startColumn + window.events.length + measureVisibleWidth(later),
  };
}

export function getActivityTraceWindow(
  events: readonly TaskCardActivityState[],
  inspection: ActivityTraceInspectionState | undefined,
  width: number
): ActivityTraceWindow {
  if (events.length === 0) {
    return { events: [], startIndex: 0, earlierCount: 0, laterCount: 0 };
  }
  const followLive = inspection?.followLive ?? true;
  const requestedIndex = followLive
    ? events.length - 1
    : events.findIndex((event) => event.eventId === inspection?.selectedTraceEventId);
  const selectedIndex = requestedIndex < 0 ? events.length - 1 : requestedIndex;
  const capacity = traceEventCapacity(width);
  const idealStart = followLive
    ? events.length - capacity
    : selectedIndex - Math.floor(capacity / 2);
  const startIndex = Math.max(0, Math.min(Math.max(0, events.length - capacity), idealStart));
  const visibleEvents = events.slice(startIndex, startIndex + capacity);
  return {
    events: visibleEvents,
    startIndex,
    earlierCount: startIndex,
    laterCount: Math.max(0, events.length - startIndex - visibleEvents.length),
    selectedEvent: events[selectedIndex],
  };
}

export function navigateActivityTrace(
  events: readonly TaskCardActivityState[],
  inspection: ActivityTraceInspectionState | undefined,
  action: TraceNavigationAction,
  width: number
): ActivityTraceInspectionState {
  if (action === "end" || events.length === 0) return { followLive: true };
  const followLive = inspection?.followLive ?? true;
  const selectedIndex = events.findIndex((event) => event.eventId === inspection?.selectedTraceEventId);
  const currentIndex = followLive || selectedIndex < 0 ? events.length - 1 : selectedIndex;
  const window = getActivityTraceWindow(events, inspection, width);
  let nextIndex = currentIndex;
  if (action === "left") nextIndex = Math.max(0, currentIndex - 1);
  if (action === "right") nextIndex = Math.min(events.length - 1, currentIndex + 1);
  if (action === "home") nextIndex = window.startIndex;
  return {
    followLive: false,
    selectedTraceEventId: events[nextIndex]?.eventId,
  };
}

function traceEventCapacity(width: number): number {
  // Keep room for indentation, overflow labels, and the independent live-tail marker.
  return Math.max(1, Math.floor(width) - 24);
}

function traceEventOrigin(
  card: TaskCardState,
  event: TaskCardActivityState,
  taskLabel: string,
  locale: OperatorConsoleLocale
): string {
  if (event.subagentIndex !== undefined) return isolateIfArabic(`Subagent ${event.subagentIndex}`, locale);
  const subagent = card.subagents.find((candidate) => candidate.stepId === event.stepId);
  return subagent === undefined ? taskLabel : isolateIfArabic(subagent.displayLabel, locale);
}

function formatTraceCounters(
  events: readonly TaskCardActivityState[],
  locale: OperatorConsoleLocale,
  style: OperatorConsoleStyle | undefined,
  retainedOnly = false
): string {
  const tokens = style?.tokens.contract;
  const counts = new Map<TaskCardActivityState["category"], number>();
  for (const event of events) counts.set(event.category, (counts.get(event.category) ?? 0) + 1);
  const values = TRACE_CATEGORIES.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    if (count === 0) return [];
    const glyph = tokens?.glyph.trace.event ?? ".";
    const color = tokens?.trace[category];
    const styledGlyph = color === undefined ? glyph : styleColor(style, glyph, color);
    return [`${styledGlyph} ${formatCategory(category, locale)} ×${count}`];
  });
  return `  ${retainedOnly ? `${COPY[locale].retained} · ` : ""}${values.join("  ")}`;
}

function formatCategory(category: TaskCardActivityState["category"], locale: OperatorConsoleLocale): string {
  if (locale === "en") return category[0]!.toUpperCase() + category.slice(1);
  const labels: Readonly<Record<TaskCardActivityState["category"], string>> = {
    terminal: "الطرفية",
    search: "بحث",
    plan: "خطة",
    read: "قراءة",
    edit: "تعديل",
    answer: "إجابة",
    wait: "انتظار",
    finish: "إنهاء",
    failed: "فشل",
  };
  return labels[category];
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 19) : "--:--:--";
}

function isolateIfArabic(value: string, locale: OperatorConsoleLocale): string {
  return locale === "ar" ? `\u2068${value}\u2069` : value;
}
