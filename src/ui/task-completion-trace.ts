import type {
  TaskCompletionTraceCategory,
  TaskCompletionTraceOutcome,
  TaskCompletionTraceSnapshot,
} from "../contracts/task-completion-trace.js";
import { isolateLtr } from "./bidi.js";
import { measureVisibleWidth, truncateVisible } from "./renderers/layout.js";

export type TaskCompletionTraceRenderStyle = {
  readonly accent?: (text: string) => string;
  readonly muted?: (text: string) => string;
  readonly outcome?: (text: string, outcome: TaskCompletionTraceOutcome) => string;
  readonly span?: (text: string, category: TaskCompletionTraceCategory) => string;
};

export function renderTaskCompletionTrace(
  snapshot: TaskCompletionTraceSnapshot,
  options: {
    readonly width: number;
    readonly locale?: "en" | "ar";
    readonly useUnicode?: boolean;
    readonly style?: TaskCompletionTraceRenderStyle;
  }
): readonly string[] {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const unicode = options.useUnicode ?? true;
  const copy = COPY[locale];
  const style = options.style;
  const stage = copy.stage[snapshot.stage];
  const outcome = copy.outcome[snapshot.outcome];
  const heading = align(stage, style?.outcome?.(outcome, snapshot.outcome) ?? outcome, width);
  const count = `${snapshot.activityCountComplete ? "" : "≥ "}${snapshot.activityCount}`;
  const activityLabel = snapshot.activityCount === 1 ? copy.activity : copy.activities;
  const title = `${copy.title} · ${technical(count, locale)} ${activityLabel} · ${technical(formatDuration(snapshot.totalDurationMs), locale)}`;
  const styledTitle = style?.accent?.(title) ?? title;
  const status = ribbonStatus(snapshot.outcome, copy, unicode);
  const styledStatus = style?.outcome?.(status, snapshot.outcome) ?? status;
  const statusWidth = measureVisibleWidth(styledStatus);
  const ribbon = renderRibbon(snapshot, Math.max(1, width - statusWidth - 3), unicode, style);
  const ribbonText = locale === "ar" ? isolateLtr(ribbon) : ribbon;
  const ribbonLine = `  ${ribbonText}  ${styledStatus}`;
  const selected = snapshot.spans.at(-1);
  const callout = width < 60
    ? `  ${unicode ? "└" : "\\"} ${completionLabel(snapshot, copy)}`
    : selected === undefined
    ? `  ${unicode ? "└" : "\\"} ${completionLabel(snapshot, copy)}`
    : `  ${unicode ? "└" : "\\"} ${style?.span?.(copy.category[selected.category], selected.category) ?? copy.category[selected.category]} · ${scopeLabel(selected.scope.kind, selected.scope.label, copy, locale)} · ${technical(`${formatDuration(snapshot.totalDurationMs)} ${copy.total}`, locale)} · ${completionLabel(snapshot, copy)}`;
  return [
    fit(heading, width),
    fit(styledTitle, width),
    fit(ribbonLine, width),
    fit(callout, width),
  ];
}

function renderRibbon(
  snapshot: TaskCompletionTraceSnapshot,
  capacity: number,
  unicode: boolean,
  style: TaskCompletionTraceRenderStyle | undefined
): string {
  if (snapshot.spans.length === 0) return unicode ? "▱" : "-";
  const rendered = snapshot.spans.map((span) => {
    const width = Math.max(1, Math.min(8, Math.round(1 + Math.log2(1 + span.durationMs / 1_000))));
    const glyph = span.status === "failed" ? (unicode ? "×" : "x") : (unicode ? "█" : "#");
    const value = glyph.repeat(width);
    return { width, value: style?.span?.(value, span.category) ?? value };
  });
  let total = rendered.reduce((sum, segment) => sum + segment.width, 0);
  let start = 0;
  const needsEarlier = snapshot.hasEarlierActivities || total > capacity;
  const available = Math.max(1, capacity - (needsEarlier ? 1 : 0));
  while (start < rendered.length - 1 && total > available) {
    total -= rendered[start]?.width ?? 0;
    start += 1;
  }
  const visible = rendered.slice(start).map((segment) => segment.value).join("");
  const earlier = needsEarlier ? (unicode ? "‹" : "<") : "";
  return `${style?.muted?.(earlier) ?? earlier}${truncateVisible(visible, available, "")}`;
}

function completionLabel(snapshot: TaskCompletionTraceSnapshot, copy: TraceCopy): string {
  if (!snapshot.answerAvailable) return copy.answerUnavailable;
  const workers = snapshot.workerOutcomes;
  if (snapshot.outcome !== "complete_with_warnings" || workers === undefined) return copy.answerReady;
  const values = [copy.usable(workers.usable)];
  if (workers.failed > 0) values.push(copy.failed(workers.failed));
  if (workers.cancelled > 0) values.push(copy.cancelled(workers.cancelled));
  return values.join(" · ");
}

function ribbonStatus(outcome: TaskCompletionTraceOutcome, copy: TraceCopy, unicode: boolean): string {
  const glyph = outcome === "complete"
    ? unicode ? "✓" : "[ok]"
    : outcome === "complete_with_warnings"
      ? unicode ? "⚠" : "[!]"
      : unicode ? "×" : "[x]";
  return `${glyph} ${copy.ribbon[outcome]}`;
}

function scopeLabel(
  kind: TaskCompletionTraceSnapshot["spans"][number]["scope"]["kind"],
  label: string,
  copy: TraceCopy,
  locale: "en" | "ar"
): string {
  if (kind === "delivery" || kind === "task") return copy.scope.task;
  if (kind === "synthesis") return copy.scope.synthesis;
  return technical(label, locale);
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1_000;
  if (seconds < 1) return `${Math.round(durationMs)}ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/u, "") : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function technical(value: string, locale: "en" | "ar"): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function align(left: string, right: string, width: number): string {
  const available = width - measureVisibleWidth(left) - measureVisibleWidth(right);
  return available > 0 ? `${left}${" ".repeat(available)}${right}` : `${left} · ${right}`;
}

function fit(value: string, width: number): string {
  return truncateVisible(value, width, "…");
}

type TraceCopy = {
  readonly title: string;
  readonly activity: string;
  readonly activities: string;
  readonly total: string;
  readonly answerReady: string;
  readonly answerUnavailable: string;
  readonly usable: (count: number) => string;
  readonly failed: (count: number) => string;
  readonly cancelled: (count: number) => string;
  readonly stage: Readonly<Record<TaskCompletionTraceSnapshot["stage"], string>>;
  readonly outcome: Readonly<Record<TaskCompletionTraceOutcome, string>>;
  readonly ribbon: Readonly<Record<TaskCompletionTraceOutcome, string>>;
  readonly category: Readonly<Record<TaskCompletionTraceCategory, string>>;
  readonly scope: { readonly task: string; readonly synthesis: string };
};

const COPY: Readonly<Record<"en" | "ar", TraceCopy>> = {
  en: {
    title: "Activity trace",
    activity: "activity",
    activities: "activities",
    total: "total",
    answerReady: "Final answer ready",
    answerUnavailable: "Task settled without an accepted answer",
    usable: (count) => `${count} usable ${count === 1 ? "report" : "reports"}`,
    failed: (count) => `${count} ${count === 1 ? "Subagent" : "Subagents"} failed`,
    cancelled: (count) => `${count} ${count === 1 ? "Subagent" : "Subagents"} cancelled`,
    stage: { task: "Task", synthesis: "Synthesis", delivery: "Delivery" },
    outcome: {
      complete: "COMPLETE",
      complete_with_warnings: "COMPLETE WITH WARNINGS",
      failed: "FAILED",
      cancelled: "CANCELLED",
    },
    ribbon: {
      complete: "complete",
      complete_with_warnings: "warnings",
      failed: "failed",
      cancelled: "cancelled",
    },
    category: {
      plan: "Plan", search: "Search", read: "Read", execute: "Execute", write: "Write",
      validate: "Validate", wait: "Wait", retry: "Retry", failure: "Failure", deliver: "Deliver",
    },
    scope: { task: "Task", synthesis: "Synthesis" },
  },
  ar: {
    title: "مسار النشاط",
    activity: "نشاط",
    activities: "أنشطة",
    total: "إجمالي",
    answerReady: "الإجابة النهائية جاهزة",
    answerUnavailable: "استقرت المهمة من دون إجابة مقبولة",
    usable: (count) => `نتائج صالحة: ${count}`,
    failed: (count) => `فشل: ${count}`,
    cancelled: (count) => `أُلغي: ${count}`,
    stage: { task: "المهمة", synthesis: "التجميع", delivery: "التسليم" },
    outcome: {
      complete: "مكتمل",
      complete_with_warnings: "مكتمل مع تحذيرات",
      failed: "فشل",
      cancelled: "أُلغي",
    },
    ribbon: {
      complete: "مكتمل",
      complete_with_warnings: "تحذيرات",
      failed: "فشل",
      cancelled: "أُلغي",
    },
    category: {
      plan: "تخطيط", search: "بحث", read: "قراءة", execute: "تنفيذ", write: "كتابة",
      validate: "تحقق", wait: "انتظار", retry: "إعادة محاولة", failure: "فشل", deliver: "تسليم",
    },
    scope: { task: "المهمة", synthesis: "التجميع" },
  },
};
