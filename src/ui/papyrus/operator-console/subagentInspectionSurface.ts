import { padVisibleEnd, truncateVisible, wrapText } from "../../renderers/layout.js";
import { formatUsageCost, formatUsageCostNotice } from "../../usage-cost-format.js";
import { renderActivityTraceSurface } from "./activityTraceSurface.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type {
  TaskCardAttemptState,
  TaskCardResultState,
  TaskCardState,
  TaskCardSubagentState,
  TaskSurfaceState,
} from "./operatorConsoleState.js";
import { styleBold, styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

const LTR_START = "\u2068";
const LTR_END = "\u2069";

type SubagentCopy = {
  readonly mainSession: string;
  readonly task: string;
  readonly attempt: string;
  readonly subagentTotal: string;
  readonly tokens: string;
  readonly currentActivity: string;
  readonly waitingForActivity: string;
  readonly retainedTimeline: string;
  readonly noActivity: string;
  readonly resultSummary: string;
  readonly filesAndArtifacts: string;
  readonly attempts: string;
  readonly current: string;
  readonly dependencies: string;
  readonly blockers: string;
  readonly none: string;
  readonly diagnostic: string;
  readonly waitingForApproval: string;
  readonly waitingForInput: string;
  readonly closeHint: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, SubagentCopy>> = {
  en: {
    mainSession: "Main session",
    task: "Task",
    attempt: "Attempt",
    subagentTotal: "Subagent total",
    tokens: "tokens",
    currentActivity: "Current activity",
    waitingForActivity: "Waiting for safe activity",
    retainedTimeline: "Retained safe activity",
    noActivity: "No retained safe activity yet",
    resultSummary: "Result summary",
    filesAndArtifacts: "Relevant files, artifacts, and result handles",
    attempts: "Attempts and retries",
    current: "current",
    dependencies: "Dependencies",
    blockers: "Blockers and approvals",
    none: "none",
    diagnostic: "diagnostic only",
    waitingForApproval: "waiting for approval",
    waitingForInput: "waiting for input",
    closeHint: "Esc return to Task · ←/→ inspect events · Home oldest visible · End live · ↑/↓ scroll",
  },
  ar: {
    mainSession: "الجلسة الرئيسية",
    task: "المهمة",
    attempt: "المحاولة",
    subagentTotal: "إجمالي الوكيل الفرعي",
    tokens: "رمز",
    currentActivity: "النشاط الحالي",
    waitingForActivity: "بانتظار نشاط آمن",
    retainedTimeline: "النشاط الآمن المحفوظ",
    noActivity: "لا يوجد نشاط آمن محفوظ بعد",
    resultSummary: "ملخص النتيجة",
    filesAndArtifacts: "الملفات والمخرجات ومراجع النتائج ذات الصلة",
    attempts: "المحاولات وإعادات المحاولة",
    current: "الحالية",
    dependencies: "الاعتماديات",
    blockers: "العوائق والموافقات",
    none: "لا يوجد",
    diagnostic: "للتشخيص فقط",
    waitingForApproval: "بانتظار الموافقة",
    waitingForInput: "بانتظار إدخال",
    closeHint: "Esc للعودة إلى المهمة · ←/→ لفحص الأحداث · Home للأقدم · End للمباشر · ↑/↓ للتمرير",
  },
};

export function renderSubagentInspectionSurface(
  state: TaskSurfaceState,
  options: {
    readonly width: number;
    readonly height: number;
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
  }
): readonly string[] {
  const width = dimension(options.width);
  const height = dimension(options.height);
  const card = state.cards.find((candidate) => candidate.taskId === state.inspectedTaskId);
  const subagent = card?.subagents.find((candidate) =>
    candidate.stepId === state.inspection?.inspectedSubagentStepId
  );
  if (width === 0 || height === 0 || card === undefined || subagent === undefined) return [];
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const header = `${copy.mainSession} / ${copy.task} ${isolate(card.taskId)} / ${isolateIfArabic(subagent.displayLabel, locale)}`;
  if (height === 1) return [padVisibleEnd(truncateVisible(header, width, "…"), width)];
  const contentHeight = Math.max(0, height - 2);
  const content = subagentInspectionContentLines(card, subagent, width, {
    locale,
    style: options.style,
    inspection: state.inspection,
  });
  const maxOffset = Math.max(0, content.length - contentHeight);
  const offset = Math.min(maxOffset, Math.max(0, state.scrollOffset));
  const visible = content.slice(offset, offset + contentHeight);
  return [
    header,
    ...visible,
    ...Array.from({ length: Math.max(0, contentHeight - visible.length) }, () => ""),
    copy.closeHint,
  ].slice(0, height).map((line) => padVisibleEnd(truncateVisible(line, width, "…"), width));
}

export function subagentInspectionContentLines(
  card: TaskCardState,
  subagent: TaskCardSubagentState,
  width: number,
  options: {
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
    readonly inspection?: TaskSurfaceState["inspection"];
  } = {}
): readonly string[] {
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const style = options.style;
  const contentWidth = Math.max(1, dimension(width) - 2);
  const attempt = subagent.activeAttempt ?? subagent.latestAttempt;
  const usage = attempt?.usage ?? subagent.usage.currentAttempt ?? subagent.usage.total;
  const title = `${isolateIfArabic(subagent.displayLabel, locale)} · ${subagent.objective}`;
  const titleColor = style?.tokens.contract.palette.accent;
  const styledTitle = titleColor === undefined ? title : styleColor(style, styleBold(style, title), titleColor);
  const status = attempt?.status ?? subagent.status;
  const elapsed = attempt?.elapsedMs ?? subagent.elapsedMs;
  const totalUsage = subagent.usage.total;
  const totalLifecycle = `${copy.subagentTotal} · ${formatStatus(subagent.status, locale)} · ${formatDuration(subagent.elapsedMs)} · ${formatCompactNumber(totalUsage.totalTokens)} ${copy.tokens} · ${formatCost(totalUsage, locale)}`;
  const attemptLifecycle = attempt === undefined
    ? undefined
    : `${copy.attempt} ${attempt.attemptNumber} · ${formatStatus(status, locale)} · ${formatDuration(elapsed)} · ${formatCompactNumber(usage.totalTokens)} ${copy.tokens} · ${formatCost(usage, locale)}`;
  const lines: string[] = [
    styledTitle,
    styleStatus(totalLifecycle, subagent.status, style),
    ...(attemptLifecycle === undefined ? [] : [styleStatus(attemptLifecycle, status, style)]),
  ];

  const currentActivity = normalizeText(
    subagent.currentActivity ?? attempt?.currentActivity
  ) ?? copy.waitingForActivity;
  addSection(lines, copy.currentActivity, wrapText(currentActivity, contentWidth), style);

  const traceCard: TaskCardState = {
    ...card,
    subagents: [subagent],
    trace: { events: subagent.trace, hasEarlierEvents: false },
  };
  lines.push("", ...renderActivityTraceSurface(traceCard, options.inspection?.subagentTrace, {
    width: contentWidth,
    locale,
    style,
  }));

  addSection(lines, copy.retainedTimeline, subagent.trace.length === 0
    ? [copy.noActivity]
    : subagent.trace.map((event) =>
        `${formatTimestamp(event.timestamp)} · ${formatCategory(event.category, locale)} · ${event.label}`
      ), style);

  const summaries = resultSummaryLines(subagent);
  addSection(lines, copy.resultSummary, summaries.length === 0 ? [copy.none] : summaries, style);
  addSection(lines, copy.filesAndArtifacts, subagent.results.length === 0
    ? [copy.none]
    : subagent.results.map((result) => formatResult(result, copy)), style);
  addSection(lines, copy.attempts, subagent.attempts.length === 0
    ? [copy.none]
    : [...subagent.attempts]
        .sort((left, right) => left.attemptNumber - right.attemptNumber)
        .map((candidate) => formatAttempt(candidate, attempt?.attemptId, copy, locale)), style);

  const dependencyTitles = new Map(card.steps.map((step) => [step.stepId, step.title]));
  addSection(lines, copy.dependencies, subagent.dependsOn.length === 0
    ? [copy.none]
    : subagent.dependsOn.map((stepId) => dependencyTitles.get(stepId) ?? isolate(stepId)), style);
  addSection(lines, copy.blockers, blockerLines(subagent, attempt, copy, locale), style);

  const pricingNotice = formatUsageCostNotice({
    estimatedCostUsd: totalUsage.estimatedCostUsd,
    costComplete: totalUsage.pricingComplete,
  }, { locale });
  if (pricingNotice !== undefined) lines.push("", ...wrapText(pricingNotice, contentWidth));
  return lines;
}

function resultSummaryLines(subagent: TaskCardSubagentState): readonly string[] {
  const values: string[] = [];
  const preview = normalizeText(
    subagent.assistantPreview ?? subagent.activeAttempt?.assistantPreview ?? subagent.latestAttempt?.assistantPreview
  );
  if (preview !== undefined) values.push(preview);
  for (const result of subagent.results) {
    if (result.disposition === "accepted" && normalizeText(result.summary) !== undefined) {
      values.push(result.summary!.trim());
    }
  }
  return [...new Set(values)];
}

function blockerLines(
  subagent: TaskCardSubagentState,
  attempt: TaskCardAttemptState | undefined,
  copy: SubagentCopy,
  locale: OperatorConsoleLocale
): readonly string[] {
  const status = attempt?.status ?? subagent.status;
  if (status === "waiting_for_approval") return [copy.waitingForApproval];
  if (status === "waiting_for_input") return [copy.waitingForInput];
  if (status === "failed" || status === "cancelled" || status === "interrupted" || status === "expired") {
    return [formatStatus(status, locale)];
  }
  return [copy.none];
}

function formatAttempt(
  attempt: TaskCardAttemptState,
  currentAttemptId: string | undefined,
  copy: SubagentCopy,
  locale: OperatorConsoleLocale
): string {
  const current = attempt.attemptId === currentAttemptId ? ` · ${copy.current}` : "";
  return `${copy.attempt} ${attempt.attemptNumber} · ${formatStatus(attempt.status, locale)}${current} · ${formatDuration(attempt.elapsedMs)} · ${formatCompactNumber(attempt.usage.totalTokens)} ${copy.tokens} · ${formatCost(attempt.usage, locale)}`;
}

function formatResult(result: TaskCardResultState, copy: SubagentCopy): string {
  const diagnostic = result.disposition === "diagnostic" ? ` · ${copy.diagnostic}` : "";
  const summary = normalizeText(result.summary);
  return `${result.primary ? "primary · " : ""}${isolate(result.handle)} · ${result.kind}${diagnostic}` +
    `${summary === undefined ? "" : ` · ${summary}`}`;
}

function addSection(
  lines: string[],
  title: string,
  values: readonly string[],
  style: OperatorConsoleStyle | undefined
): void {
  const color = style?.tokens.contract.palette.accent;
  const heading = color === undefined ? title : styleColor(style, styleBold(style, title), color);
  lines.push("", heading, ...values.map((value) => `  ${value}`));
}

function styleStatus(value: string, status: string, style: OperatorConsoleStyle | undefined): string {
  const severity = style?.tokens.contract.severity;
  if (severity === undefined) return value;
  if (status === "completed") return styleColor(style, value, severity.ok);
  if (["failed", "cancelled", "interrupted", "expired"].includes(status)) return styleColor(style, value, severity.error);
  if (["waiting_for_input", "waiting_for_approval"].includes(status)) return styleColor(style, value, severity.warn);
  return styleColor(style, value, severity.info);
}

function formatCost(usage: TaskCardState["usage"], locale: OperatorConsoleLocale): string {
  return formatUsageCost({
    estimatedCostUsd: usage.estimatedCostUsd,
    costComplete: usage.pricingComplete,
  }, { locale, compact: true });
}

function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatCompactNumber(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.floor(value)));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

function formatStatus(status: string, locale: OperatorConsoleLocale): string {
  if (locale === "en") return status.replaceAll("_", " ");
  const statuses: Readonly<Record<string, string>> = {
    queued: "في قائمة الانتظار",
    leased: "محجوزة",
    running: "قيد التنفيذ",
    waiting_for_input: "بانتظار إدخال",
    waiting_for_approval: "بانتظار الموافقة",
    completed: "مكتملة",
    failed: "فشلت",
    cancelled: "ملغاة",
    interrupted: "متوقفة",
    expired: "منتهية",
    pending: "معلّقة",
    ready: "جاهزة",
    skipped: "متجاوزة",
  };
  return statuses[status] ?? status.replaceAll("_", " ");
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 19) : "--:--:--";
}

function formatCategory(category: string, locale: OperatorConsoleLocale): string {
  if (locale === "en") return category.length === 0 ? category : category[0]!.toUpperCase() + category.slice(1);
  const categories: Readonly<Record<string, string>> = {
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
  return categories[category] ?? category;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isolate(value: string): string {
  return `${LTR_START}${value}${LTR_END}`;
}

function isolateIfArabic(value: string, locale: OperatorConsoleLocale): string {
  return locale === "ar" ? isolate(value) : value;
}

function dimension(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}
