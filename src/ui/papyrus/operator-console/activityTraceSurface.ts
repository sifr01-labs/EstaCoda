import { measureVisibleWidth, truncateVisible } from "../../renderers/layout.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type {
  ActivityTraceInspectionState,
  TaskCardActivityState,
  TaskCardActivitySpanState,
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
  readonly activity: string;
  readonly activities: string;
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
  readonly synthesis: string;
  readonly subagents: string;
  readonly delivery: string;
  readonly complete: string;
  readonly waiting: string;
  readonly noLogicalActivity: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, TraceCopy>> = {
  en: {
    activityTrace: "Activity trace",
    activity: "activity",
    activities: "activities",
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
    synthesis: "Synthesis",
    subagents: "Subagents",
    delivery: "Delivery",
    complete: "COMPLETE",
    waiting: "WAITING",
    noLogicalActivity: "No logical activity yet",
  },
  ar: {
    activityTrace: "مسار النشاط",
    activity: "نشاط",
    activities: "أنشطة",
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
    synthesis: "التجميع",
    subagents: "الوكلاء الفرعيون",
    delivery: "التسليم",
    complete: "مكتمل",
    waiting: "انتظار",
    noLogicalActivity: "لا يوجد نشاط منطقي بعد",
  },
};

export type ActivityRibbonScope = "auto" | "task" | "subagents" | "synthesis" | "delivery" | "all";

export type ActivityRibbonSegment = {
  readonly span: TaskCardActivitySpanState;
  readonly width: number;
  readonly running: boolean;
};

export function activityRibbonHeight(width: number): number {
  return width < 60 ? 2 : 4;
}

/** Render logical activity spans as execution history, never as completion progress. */
export function renderActivityRibbonSurface(
  card: TaskCardState,
  options: {
    readonly width: number;
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
    readonly scope?: ActivityRibbonScope;
  }
): readonly string[] {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const style = options.style;
  const tokens = style?.tokens.contract;
  const scope = resolveRibbonScope(card, options.scope ?? "auto");
  const spans = filterSpans(card.trace.spans, scope);
  const selected = [...spans].reverse().find((span) => span.status === "running") ?? spans.at(-1);
  const activityLabel = spans.length === 1 ? copy.activity : copy.activities;
  const title = `${copy.activityTrace} · ${spans.length} ${activityLabel}`;
  const styledTitle = tokens === undefined
    ? title
    : styleColor(style, styleBold(style, title), tokens.palette.accent);
  const live = isTaskLive(card);
  const waiting = card.phase.name === "waiting_for_input" || card.phase.name === "waiting_for_approval";
  const stateLabel = waiting ? copy.waiting : live ? copy.live.toLocaleUpperCase() : copy.complete;
  const stateColor = waiting ? tokens?.severity.warn : live ? tokens?.palette.action : tokens?.severity.ok;
  const styledState = stateColor === undefined ? stateLabel : styleColor(style, styleBold(style, stateLabel), stateColor);
  const scopeLabel = formatRibbonScope(scope, copy);
  const scopeRow = alignStatus(scopeLabel, styledState, width);

  if (width < 60) {
    const compactRibbon = spans.length === 0
      ? copy.noLogicalActivity
      : `${renderRibbon(spans, Math.max(1, width - 22), style)} ${renderLiveMarker(live, copy, style)}`;
    const compactCategory = selected === undefined ? "" : ` · ${formatSpanCategory(selected.category, locale)}`;
    return [
      fit(scopeRow, width),
      fit(`${spans.length} ${activityLabel}${compactCategory} · ${compactRibbon}`, width),
    ];
  }
  if (selected === undefined) {
    return [
      fit(scopeRow, width),
      fit(styledTitle, width),
      fit(`  ${copy.noLogicalActivity}`, width),
      "".padEnd(width),
    ];
  }
  const ribbonCapacity = Math.max(1, width - 13);
  const ribbon = renderRibbon(spans, ribbonCapacity, style);
  const ribbonLine = locale === "ar"
    ? `  \u2066${ribbon} ${renderLiveMarker(live, copy, style)}\u2069`
    : `  ${ribbon} ${renderLiveMarker(live, copy, style)}`;
  const category = formatSpanCategory(selected.category, locale);
  const categoryColor = spanColor(selected.category, style);
  const styledCategory = categoryColor === undefined
    ? category
    : styleColor(style, styleBold(style, category), categoryColor);
  const callout = `  └ ${styledCategory} · ${formatSpanScope(selected.scope, locale)} · ${isolateIfArabic(formatSpanDuration(selected.durationMs), locale)} · ${isolateIfArabic(selected.label, locale)}`;
  return [
    fit(scopeRow, width),
    fit(styledTitle, width),
    fit(ribbonLine, width),
    fit(callout, width),
  ];
}

export function getActivityRibbonSegments(
  spans: readonly TaskCardActivitySpanState[],
  maxSegmentWidth = 8
): readonly ActivityRibbonSegment[] {
  return spans.map((span) => ({
    span,
    width: Math.max(1, Math.min(maxSegmentWidth, Math.round(1 + Math.log2(1 + span.durationMs / 1_000)))),
    running: span.status === "running",
  }));
}

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
  const totalEvents = card.trace.totalEvents ?? card.trace.events.length;
  const categoryCounts = card.trace.categoryCounts ?? countTraceCategories(card.trace.events);
  const eventLabel = totalEvents === 1 ? copy.event : copy.events;
  const title = `${copy.activityTrace} · ${totalEvents} ${eventLabel}`;
  const styledTitle = tokens === undefined
    ? title
    : styleColor(style, styleBold(style, title), tokens.palette.accent);
  if (window.selectedEvent === undefined) {
    return [
      styledTitle,
      `  ${copy.noActivity}`,
      ...(card.trace.hasEarlierEvents ? [`  ${tokens?.glyph.trace.earlier ?? "<"} ${copy.earlierOmitted}`] : []),
      formatTraceCounters(categoryCounts, locale, style),
    ];
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
    formatTraceCounters(categoryCounts, locale, style),
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
  counts: Readonly<Record<TaskCardActivityState["category"], number>>,
  locale: OperatorConsoleLocale,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  const values = TRACE_CATEGORIES.flatMap((category) => {
    const count = counts[category];
    if (count === 0) return [];
    const glyph = tokens?.glyph.trace.event ?? ".";
    const color = tokens?.trace[category];
    const styledGlyph = color === undefined ? glyph : styleColor(style, glyph, color);
    return [`${styledGlyph} ${formatCategory(category, locale)} ×${count}`];
  });
  return `  ${values.join("  ")}`;
}

function countTraceCategories(
  events: readonly TaskCardActivityState[]
): Record<TaskCardActivityState["category"], number> {
  const result = Object.fromEntries(TRACE_CATEGORIES.map((category) => [category, 0])) as Record<
    TaskCardActivityState["category"],
    number
  >;
  for (const event of events) result[event.category] += 1;
  return result;
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

function resolveRibbonScope(card: TaskCardState, requested: ActivityRibbonScope): Exclude<ActivityRibbonScope, "auto"> {
  if (requested !== "auto") return requested;
  if (card.phase.name === "synthesizing") return "synthesis";
  if (card.phase.name === "delegating") return "subagents";
  if (card.phase.name === "completed" || card.phase.name === "partial") return "delivery";
  return "task";
}

function filterSpans(
  spans: readonly TaskCardActivitySpanState[],
  scope: Exclude<ActivityRibbonScope, "auto">
): readonly TaskCardActivitySpanState[] {
  if (scope === "all") return spans;
  if (scope === "subagents") return spans.filter((span) => span.scope.kind === "subagent");
  if (scope === "task") return spans.filter((span) => span.scope.kind === "task");
  return spans.filter((span) => span.scope.kind === scope);
}

function renderRibbon(
  spans: readonly TaskCardActivitySpanState[],
  capacity: number,
  style: OperatorConsoleStyle | undefined
): string {
  const segments = getActivityRibbonSegments(spans);
  const rendered = segments.map((segment) => renderRibbonSegment(segment, style));
  const widths = segments.map((segment) => segment.width);
  let totalWidth = widths.reduce((sum, value) => sum + value, 0);
  let start = 0;
  while (start < rendered.length - 1 && totalWidth > capacity) {
    totalWidth -= widths[start] ?? 0;
    start += 1;
  }
  const visible = rendered.slice(start).join("");
  if (visible.length === 0) return "";
  const earlier = start > 0 ? styleMutedRibbon(style, style?.tokens.contract.glyph.trace.earlier ?? "<") : "";
  return `${earlier}${truncateVisible(visible, Math.max(1, capacity - (start > 0 ? 1 : 0)), "")}`;
}

function renderRibbonSegment(
  segment: ActivityRibbonSegment,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  const fill = tokens?.glyph.progress.filled ?? "█";
  const selected = tokens?.glyph.trace.selected ?? "□";
  const failed = style?.tokens.mode === "plain" ? "x" : tokens?.glyph.cross ?? "×";
  const glyph = segment.span.status === "failed"
    ? failed.repeat(segment.width)
    : segment.running
      ? `${fill.repeat(Math.max(0, segment.width - 1))}${selected}`
      : fill.repeat(segment.width);
  const color = spanColor(segment.span.category, style);
  return color === undefined ? glyph : styleColor(style, glyph, color);
}

function renderLiveMarker(
  live: boolean,
  copy: TraceCopy,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  const glyph = live ? tokens?.glyph.trace.live ?? "◆" : tokens?.glyph.check ?? "✓";
  const label = live ? copy.live : copy.complete.toLocaleLowerCase();
  const color = live ? tokens?.palette.action : tokens?.severity.ok;
  return color === undefined ? `${glyph} ${label}` : styleColor(style, `${glyph} ${label}`, color);
}

function spanColor(
  category: TaskCardActivitySpanState["category"],
  style: OperatorConsoleStyle | undefined
): string | undefined {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return undefined;
  switch (category) {
    case "plan": return tokens.trace.plan;
    case "search": return tokens.trace.search;
    case "read": return tokens.trace.read;
    case "execute": return tokens.palette.caution;
    case "write": return tokens.trace.answer;
    case "validate": return tokens.trace.finish;
    case "wait": return tokens.text.muted;
    case "retry": return tokens.severity.warn;
    case "failure": return tokens.trace.failed;
    case "deliver": return tokens.trace.finish;
  }
}

function formatSpanCategory(
  category: TaskCardActivitySpanState["category"],
  locale: OperatorConsoleLocale
): string {
  if (locale === "en") return category[0]!.toUpperCase() + category.slice(1);
  const labels: Readonly<Record<TaskCardActivitySpanState["category"], string>> = {
    plan: "تخطيط",
    search: "بحث",
    read: "قراءة",
    execute: "تنفيذ",
    write: "كتابة",
    validate: "تحقق",
    wait: "انتظار",
    retry: "إعادة محاولة",
    failure: "فشل",
    deliver: "تسليم",
  };
  return labels[category];
}

function formatSpanScope(
  scope: TaskCardActivitySpanState["scope"],
  locale: OperatorConsoleLocale
): string {
  if (scope.kind === "task") return locale === "ar" ? "المهمة" : "Task";
  if (scope.kind === "synthesis") return locale === "ar" ? "التجميع" : "Synthesis";
  if (scope.kind === "delivery") return locale === "ar" ? "التسليم" : "Delivery";
  return isolateIfArabic(scope.label, locale);
}

function formatRibbonScope(scope: Exclude<ActivityRibbonScope, "auto">, copy: TraceCopy): string {
  if (scope === "synthesis") return copy.synthesis;
  if (scope === "subagents") return copy.subagents;
  if (scope === "delivery") return copy.delivery;
  return copy.task;
}

function formatSpanDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1_000;
  if (seconds < 1) return `${Math.round(durationMs)}ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/u, "") : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function isTaskLive(card: TaskCardState): boolean {
  return !["completed", "partial", "failed", "cancelled"].includes(card.status);
}

function alignStatus(left: string, right: string, width: number): string {
  const leftWidth = measureVisibleWidth(left);
  const rightWidth = measureVisibleWidth(right);
  return leftWidth + rightWidth + 1 >= width
    ? `${left} · ${right}`
    : `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

function fit(value: string, width: number): string {
  return truncateVisible(value, width, "…");
}

function styleMutedRibbon(style: OperatorConsoleStyle | undefined, value: string): string {
  const color = style?.tokens.contract.text.muted;
  return color === undefined ? value : styleColor(style, value, color);
}
