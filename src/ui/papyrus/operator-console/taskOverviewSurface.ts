import { padVisibleEnd, truncateVisible, wrapText } from "../../renderers/layout.js";
import { formatUsageCost, formatUsageCostNotice, formatUsdAmount } from "../../usage-cost-format.js";
import { renderActivityTraceSurface } from "./activityTraceSurface.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type {
  TaskCardResultState,
  TaskCardState,
  TaskCardStepState,
  TaskSurfaceState,
} from "./operatorConsoleState.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

const LTR_START = "\u2068";
const LTR_END = "\u2069";
const WIDE_OVERVIEW_WIDTH = 100;
const COLUMN_GAP = 3;

type OverviewCopy = {
  readonly mainSession: string;
  readonly task: string;
  readonly stepsSettled: string;
  readonly tokens: string;
  readonly subagents: string;
  readonly plan: string;
  readonly settled: string;
  readonly active: string;
  readonly pending: string;
  readonly blocked: string;
  readonly dependsOn: string;
  readonly approvals: string;
  readonly blockers: string;
  readonly results: string;
  readonly recoveredOutput: string;
  readonly recoveredWarning: string;
  readonly childTasks: string;
  readonly execution: string;
  readonly taskSpending: string;
  readonly spent: string;
  readonly reserved: string;
  readonly remaining: string;
  readonly limit: string;
  readonly none: string;
  readonly noSubagents: string;
  readonly closeHint: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, OverviewCopy>> = {
  en: {
    mainSession: "Main session",
    task: "Task",
    stepsSettled: "Steps settled",
    tokens: "tokens",
    subagents: "Subagents",
    plan: "Plan Steps",
    settled: "settled",
    active: "active",
    pending: "pending",
    blocked: "blocked",
    dependsOn: "after",
    approvals: "Approvals",
    blockers: "Blockers",
    results: "Results, files, and artifacts",
    recoveredOutput: "Recovered output",
    recoveredWarning: "May be incomplete; it was not accepted as a successful result.",
    childTasks: "Child Tasks",
    execution: "Execution",
    taskSpending: "Task spending",
    spent: "Spent",
    reserved: "Reserved",
    remaining: "Remaining",
    limit: "Limit",
    none: "none",
    noSubagents: "No delegated Subagents",
    closeHint: "Esc return · ↑/↓ select Subagent · Enter inspect · ←/→ events · PgUp/PgDn scroll",
  },
  ar: {
    mainSession: "الجلسة الرئيسية",
    task: "المهمة",
    stepsSettled: "خطوات مستقرة",
    tokens: "رمز",
    subagents: "الوكلاء الفرعيون",
    plan: "خطوات الخطة",
    settled: "مستقرة",
    active: "نشطة",
    pending: "معلّقة",
    blocked: "متعذرة",
    dependsOn: "بعد",
    approvals: "الموافقات",
    blockers: "العوائق",
    results: "النتائج والملفات والمخرجات",
    recoveredOutput: "المخرجات المستردة",
    recoveredWarning: "قد تكون غير مكتملة؛ لم تُقبل كنتيجة ناجحة.",
    childTasks: "المهام الفرعية",
    execution: "التنفيذ",
    taskSpending: "إنفاق المهمة",
    spent: "المنفق",
    reserved: "المحجوز",
    remaining: "المتبقي",
    limit: "الحد",
    none: "لا يوجد",
    noSubagents: "لا يوجد وكلاء فرعيون مفوضون",
    closeHint: "Esc للعودة · ↑/↓ لاختيار وكيل فرعي · Enter للفحص · ←/→ للأحداث · PgUp/PgDn للتمرير",
  },
};

export function renderTaskOverviewSurface(
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
  if (width === 0 || height === 0 || card === undefined) return [];
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const header = `${copy.mainSession} / ${copy.task} / ${isolate(card.taskId)}`;
  if (height === 1) return [padVisibleEnd(truncateVisible(header, width, "…"), width)];
  const footer = copy.closeHint;
  const contentHeight = Math.max(0, height - 2);
  const content = taskOverviewContentLines(card, width, {
    locale,
    style: options.style,
    inspection: state.inspection,
  });
  const maxOffset = Math.max(0, content.length - contentHeight);
  const offset = Math.min(maxOffset, Math.max(0, state.scrollOffset));
  const visible = content.slice(offset, offset + contentHeight);
  const rows = [
    header,
    ...visible,
    ...Array.from({ length: Math.max(0, contentHeight - visible.length) }, () => ""),
    footer,
  ];
  return rows.slice(0, height).map((row) => padVisibleEnd(truncateVisible(row, width, "…"), width));
}

export function taskOverviewContentLines(
  card: TaskCardState,
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
  const tokens = style?.tokens.contract;
  const contentWidth = Math.max(1, dimension(width) - 2);
  const objectiveLines = wrapText(card.objective, contentWidth).map((line) =>
    tokens === undefined ? line : styleColor(style, styleBold(style, line), tokens.palette.brand)
  );
  const settled = card.progress.completed + card.progress.skipped;
  const cost = formatUsageCost({
    estimatedCostUsd: card.usage.estimatedCostUsd,
    costComplete: card.usage.pricingComplete,
  }, { locale, compact: true });
  const lifecycle = `${formatStatus(card.status)} · ${formatDuration(card.elapsedMs)} · ${formatCompactNumber(card.usage.totalTokens)} ${copy.tokens} · ${cost} · ${settled} of ${card.progress.total} ${copy.stepsSettled}`;
  const lifecycleColor = taskStatusColor(card, style);
  const lines: string[] = [
    ...objectiveLines,
    lifecycleColor === undefined ? lifecycle : styleColor(style, lifecycle, lifecycleColor),
    "",
    ...renderActivityTraceSurface(card, options.inspection, { width: contentWidth, locale, style }),
    "",
  ];

  const subagentSection = sectionLines(
    copy.subagents,
    subagentLines(card, locale, copy, style, options.inspection?.selectedSubagentStepId),
    style
  );
  const planSection = sectionLines(copy.plan, planLines(card, copy, style), style);
  if (width >= WIDE_OVERVIEW_WIDTH) {
    lines.push(...renderColumns(subagentSection, planSection, contentWidth));
  } else {
    lines.push(...subagentSection, "", ...planSection);
  }

  addSection(lines, copy.approvals, approvalLines(card, copy), style);
  addSection(lines, copy.blockers, blockerLines(card, copy), style);
  addSection(lines, copy.results, resultLines(card.results, copy), style);
  const diagnosticResults = card.results.filter((result) => result.disposition === "diagnostic");
  if (diagnosticResults.length > 0) {
    addSection(lines, copy.recoveredOutput, [
      copy.recoveredWarning,
      ...diagnosticResults.map(formatResult),
    ], style);
  }
  addSection(lines, copy.childTasks, card.childTasks.length === 0
    ? [copy.none]
    : card.childTasks.map((child) =>
        `${isolate(child.taskId)} · ${formatStatus(child.status)}` +
        `${child.parentAttemptId === undefined ? "" : ` · Attempt ${isolate(child.parentAttemptId)}`}`
      ), style);
  addSection(lines, copy.execution, [
    `${formatExecution(card)} · preference ${isolate(card.executionPreference)} · background ${isolate(card.backgroundContinuation)}`,
    ...(card.executionWaitingReason === undefined ? [] : wrapText(card.executionWaitingReason, contentWidth)),
  ], style);
  if (card.spending !== undefined) {
    addSection(lines, copy.taskSpending, [
      `${copy.spent}: ${formatUsdAmount(card.spending.spentCostUsd, locale)} · ${copy.reserved}: ${formatUsdAmount(card.spending.reservedCostUsd, locale)}`,
      `${copy.remaining}: ${formatUsdAmount(card.spending.remainingCostUsd, locale)} · ${copy.limit}: ${formatUsdAmount(card.spending.maxEstimatedCostUsd, locale)}`,
    ], style);
  }
  const pricingNotice = formatUsageCostNotice({
    estimatedCostUsd: card.usage.estimatedCostUsd,
    costComplete: card.usage.pricingComplete,
  }, { locale });
  if (pricingNotice !== undefined) lines.push("", ...wrapText(pricingNotice, contentWidth));
  return lines;
}

function subagentLines(
  card: TaskCardState,
  locale: OperatorConsoleLocale,
  copy: OverviewCopy,
  style: OperatorConsoleStyle | undefined,
  selectedStepId: string | undefined
): readonly string[] {
  if (card.subagents.length === 0) return [copy.noSubagents];
  return card.subagents.map((subagent) => {
    const usage = subagent.usage.currentAttempt ?? subagent.usage.total;
    const cost = formatUsageCost({
      estimatedCostUsd: usage.estimatedCostUsd,
      costComplete: usage.pricingComplete,
    }, { locale, compact: true });
    const selected = subagent.stepId === selectedStepId;
    const rawLabel = locale === "ar" ? isolate(subagent.displayLabel) : subagent.displayLabel;
    const label = selected && style !== undefined
      ? styleColor(style, styleBold(style, rawLabel), style.tokens.contract.palette.action)
      : rawLabel;
    const duration = locale === "ar" ? isolate(formatDuration(subagent.elapsedMs)) : formatDuration(subagent.elapsedMs);
    const rail = selected ? style?.tokens.contract.glyph.progress.thumb ?? ">" : " ";
    const styledRail = selected && style !== undefined
      ? styleColor(style, rail, style.tokens.contract.palette.action)
      : rail;
    const details = `${formatStatus(subagent.status)} · ${duration} · ${cost}`;
    const color = subagentStatusColor(subagent.status, style);
    const styledDetails = color === undefined ? details : styleColor(style, details, color);
    return `${styledRail} ${label} · ${styledDetails}`;
  });
}

function planLines(
  card: TaskCardState,
  copy: OverviewCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  if (card.steps.length === 0) return [copy.none];
  const titles = new Map(card.steps.map((step) => [step.stepId, step.title]));
  return card.steps.map((step) => {
    const state = planStepState(step, copy);
    const dependencies = step.dependsOn.length === 0
      ? ""
      : ` · ${copy.dependsOn} ${step.dependsOn.map((id) => titles.get(id) ?? isolate(id)).join(", ")}`;
    const value = `${planStepGlyph(step, style)} ${step.position + 1}. ${step.title} · ${state}${dependencies}`;
    const color = planStepColor(step, style);
    return color === undefined ? value : styleColor(style, value, color);
  });
}

function approvalLines(card: TaskCardState, copy: OverviewCopy): readonly string[] {
  const waiting = card.steps.filter((step) => step.status === "waiting_for_approval");
  if (waiting.length > 0) return waiting.map((step) => step.title);
  if (card.status === "waiting_for_approval") return [card.waitReason ?? copy.blocked];
  return [copy.none];
}

function blockerLines(card: TaskCardState, copy: OverviewCopy): readonly string[] {
  const blockers: string[] = [];
  if (card.waitReason !== undefined) blockers.push(card.waitReason);
  if (card.failure !== undefined) {
    blockers.push(`${isolate(card.failure.class)} · retryable=${String(card.failure.retryable)} · uncertain-side-effects=${String(card.failure.uncertainSideEffects)}`);
  }
  for (const step of card.steps) {
    if (step.status === "waiting_for_input" || step.status === "failed") {
      blockers.push(`${step.title} · ${formatStatus(step.status)}`);
    }
  }
  return blockers.length === 0 ? [copy.none] : blockers;
}

function resultLines(results: readonly TaskCardResultState[], copy: OverviewCopy): readonly string[] {
  const accepted = results.filter((result) => result.disposition === "accepted");
  return accepted.length === 0 ? [copy.none] : accepted.map(formatResult);
}

function formatResult(result: TaskCardResultState): string {
  return `${result.primary ? "primary · " : ""}${isolate(result.handle)} · ${result.kind} · ${formatBytes(result.byteLength)}` +
    `${result.summary === undefined ? "" : ` · ${result.summary}`}`;
}

function sectionLines(
  title: string,
  values: readonly string[],
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const color = style?.tokens.contract.palette.accent;
  const heading = color === undefined ? title : styleColor(style, styleBold(style, title), color);
  return [heading, ...values.map((value) => `  ${value}`)];
}

function addSection(
  lines: string[],
  title: string,
  values: readonly string[],
  style: OperatorConsoleStyle | undefined
): void {
  lines.push("", ...sectionLines(title, values, style));
}

function renderColumns(left: readonly string[], right: readonly string[], width: number): readonly string[] {
  const columnWidth = Math.max(1, Math.floor((width - COLUMN_GAP) / 2));
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = padVisibleEnd(truncateVisible(left[index] ?? "", columnWidth, "…"), columnWidth);
    const rightLine = truncateVisible(right[index] ?? "", columnWidth, "…");
    return `${leftLine}${" ".repeat(COLUMN_GAP)}${rightLine}`;
  });
}

function planStepState(step: TaskCardStepState, copy: OverviewCopy): string {
  if (step.status === "completed" || step.status === "skipped") return copy.settled;
  if (step.status === "running") return copy.active;
  if (step.status === "failed" || step.status === "waiting_for_input" || step.status === "waiting_for_approval") return copy.blocked;
  return copy.pending;
}

function planStepGlyph(step: TaskCardStepState, style: OperatorConsoleStyle | undefined): string {
  const glyph = style?.tokens.contract.glyph;
  if (step.status === "completed" || step.status === "skipped") return glyph?.check ?? "[x]";
  if (step.status === "failed" || step.status === "cancelled") return glyph?.cross ?? "[!]";
  if (step.status === "running") return glyph?.trace.live ?? ">";
  return "[ ]";
}

function taskStatusColor(card: TaskCardState, style: OperatorConsoleStyle | undefined): string | undefined {
  const severity = style?.tokens.contract.severity;
  if (severity === undefined) return undefined;
  if (card.status === "completed") return severity.ok;
  if (card.status === "failed" || card.status === "cancelled") return severity.error;
  if (["waiting_for_host", "waiting_for_input", "waiting_for_approval", "paused", "partial"].includes(card.status)) return severity.warn;
  return severity.info;
}

function subagentStatusColor(status: TaskCardStepState["status"], style: OperatorConsoleStyle | undefined): string | undefined {
  const severity = style?.tokens.contract.severity;
  if (severity === undefined) return undefined;
  if (status === "completed" || status === "skipped") return severity.ok;
  if (status === "failed" || status === "cancelled") return severity.error;
  if (status === "waiting_for_input" || status === "waiting_for_approval") return severity.warn;
  return severity.info;
}

function planStepColor(step: TaskCardStepState, style: OperatorConsoleStyle | undefined): string | undefined {
  return subagentStatusColor(step.status, style);
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function formatExecution(card: TaskCardState): string {
  return ["completed", "partial", "failed", "cancelled"].includes(card.status)
    ? "settled"
    : card.execution;
}

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatCompactNumber(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? value : 0);
  if (count < 1_000) return String(Math.floor(count));
  if (count < 1_000_000) return `${trimDecimal(count / 1_000)}k`;
  return `${trimDecimal(count / 1_000_000)}m`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function isolate(value: string): string {
  return `${LTR_START}${value}${LTR_END}`;
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
