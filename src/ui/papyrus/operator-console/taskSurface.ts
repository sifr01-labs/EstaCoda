import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { padVisibleEnd, truncateVisible } from "../../renderers/layout.js";
import { semanticMotionFrame } from "../../semantic-motion.js";
import { navigateActivityTrace, type TraceNavigationAction } from "./activityTraceSurface.js";
import { setFocus } from "./focusModel.js";
import type {
  OperatorConsoleLocale,
} from "./activeWorkCopy.js";
import type {
  OperatorConsoleState,
  TaskCardActivityState,
  TaskCardState,
  TaskCardSubagentState,
  TaskSurfaceState,
} from "./operatorConsoleState.js";
import { formatUsageCost } from "../../usage-cost-format.js";
import {
  styleBackgroundRow,
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";
import { renderTaskOverviewSurface, taskOverviewContentLines } from "./taskOverviewSurface.js";

const SUBAGENT_CARD_HEIGHT = 7;
const SUBAGENT_ACTIVITY_ROWS = 3;
const SUBAGENT_ROWS_PER_COLUMN = 3;
const SUBAGENT_COLUMN_GAP = 2;
const SUBAGENT_ROW_GAP = 1;
const MIN_SUBAGENT_CARD_WIDTH = 44;
const LTR_START = "\u2068";
const LTR_END = "\u2069";

type TaskCopy = {
  tasks: string;
  task: string;
  inspectHint: string;
  stepsSettled: string;
  earlierActivities: string;
  noEarlierActivity: string;
  waitingForActivity: string;
  tokens: string;
  moreSubagents: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, TaskCopy>> = {
  en: {
    tasks: "Tasks",
    task: "Task",
    inspectHint: "Ctrl+T or Tab focus · Enter inspect",
    stepsSettled: "Steps settled",
    earlierActivities: "earlier activities",
    noEarlierActivity: "no earlier activity",
    waitingForActivity: "Waiting for safe activity",
    tokens: "tokens",
    moreSubagents: "more Subagents",
  },
  ar: {
    tasks: "المهام",
    task: "المهمة",
    inspectHint: "Ctrl+T أو Tab للتركيز · Enter للفحص",
    stepsSettled: "خطوات مستقرة",
    earlierActivities: "أنشطة سابقة",
    noEarlierActivity: "لا يوجد نشاط سابق",
    waitingForActivity: "بانتظار نشاط آمن",
    tokens: "رمز",
    moreSubagents: "وكلاء فرعيون إضافيون",
  },
};

export type TaskSurfaceKeyResult = {
  readonly state: OperatorConsoleState;
  readonly handled: boolean;
};

export function hasTaskCards(state: TaskSurfaceState): boolean {
  return state.cards.length > 0;
}

export function getTaskCardSurfaceDesiredHeight(state: TaskSurfaceState, width = 80): number {
  const card = selectedTask(state);
  if (card === undefined) return 0;
  if (card.subagents.length === 0) return 2;
  const grid = resolveSubagentGrid(card.subagents.length, dimension(width));
  return 1 +
    grid.rows * SUBAGENT_CARD_HEIGHT +
    Math.max(0, grid.rows - 1) * SUBAGENT_ROW_GAP +
    (grid.hiddenCount > 0 ? 1 : 0);
}

export function renderTaskCardSurface(
  state: TaskSurfaceState,
  options: {
    readonly width: number;
    readonly height?: number;
    readonly locale?: OperatorConsoleLocale;
    readonly isTty?: boolean;
    readonly focusedTaskId?: string;
    readonly style?: OperatorConsoleStyle;
    readonly motionElapsedMs?: number;
  }
): readonly string[] {
  const width = dimension(options.width);
  const height = dimension(options.height ?? getTaskCardSurfaceDesiredHeight(state, width));
  const card = selectedTask(state);
  if (width === 0 || height === 0 || card === undefined) return [];
  const copy = COPY[options.locale ?? "en"];
  const isFocused = options.focusedTaskId === card.taskId;
  const header = formatTaskHeader(card, state, copy, isFocused, options.style);
  if (card.subagents.length === 0) {
    const summary = `${formatStatus(card.status)} · ${isolateIfArabic(formatExecution(card), options.locale)} · ${formatDuration(card.elapsedMs)} · ${formatCardUsage(card.usage, options.locale ?? "en")} · ${copy.inspectHint}`;
    return padSurfaceRows([header, summary], height, width);
  }

  const grid = resolveSubagentGrid(card.subagents.length, width);
  const fitted = fitSubagentGridToHeight(grid, card.subagents.length, height);
  if (fitted.rows === 0) {
    return renderCompactSubagentFallback(card, header, copy, options, width, height);
  }

  const visibleCount = Math.min(card.subagents.length, fitted.rows * grid.columns);
  const visibleSubagents = card.subagents.slice(0, visibleCount);
  const hiddenCount = card.subagents.length - visibleSubagents.length;
  const columnWidth = resolveEqualColumnWidth(width, grid.columns);
  const rows: string[] = [padVisibleEnd(truncateVisible(header, width, "…"), width)];
  for (let rowIndex = 0; rowIndex < fitted.rows; rowIndex += 1) {
    if (rowIndex > 0) rows.push("".padEnd(width));
    const cards = Array.from({ length: grid.columns }, (_, columnIndex) => {
      const subagent = visibleSubagents[columnIndex * fitted.rows + rowIndex];
      return subagent === undefined
        ? Array.from({ length: SUBAGENT_CARD_HEIGHT }, () => "".padEnd(columnWidth))
        : renderSubagentCard(subagent, columnWidth, copy, options);
    });
    for (let lineIndex = 0; lineIndex < SUBAGENT_CARD_HEIGHT; lineIndex += 1) {
      const joined = cards.map((lines) => lines[lineIndex] ?? "".padEnd(columnWidth))
        .join(" ".repeat(SUBAGENT_COLUMN_GAP));
      rows.push(padVisibleEnd(truncateVisible(joined, width, "…"), width));
    }
  }
  if (hiddenCount > 0) rows.push(`+${hiddenCount} ${copy.moreSubagents}`);
  return padSurfaceRows(rows, height, width);
}

export function getTaskInspectionSurfaceDesiredHeight(terminalHeight: number): number {
  return dimension(terminalHeight);
}

export function renderTaskInspectionSurface(
  state: TaskSurfaceState,
  options: {
    readonly width: number;
    readonly height: number;
    readonly locale?: OperatorConsoleLocale;
    readonly isTty?: boolean;
    readonly style?: OperatorConsoleStyle;
  }
): readonly string[] {
  return renderTaskOverviewSurface(state, options);
}

export function taskInspectionContentLines(
  card: TaskCardState,
  width: number,
  locale: OperatorConsoleLocale = "en"
): readonly string[] {
  return taskOverviewContentLines(card, width, { locale });
}

export function routeTaskSurfaceKey(
  state: OperatorConsoleState,
  keypress: ParsedKeypress,
  viewportHeight: number = state.terminal.height
): TaskSurfaceKeyResult {
  if (keypress.type !== "key" || state.tasks.cards.length === 0) return { state, handled: false };
  if (state.tasks.inspectedTaskId !== undefined) {
    const card = inspectedTask(state.tasks);
    if (card === undefined) return { state: closeInspection(state), handled: true };
    const contentHeight = Math.max(1, dimension(viewportHeight) - 2);
    const maxOffset = Math.max(0, taskOverviewContentLines(card, state.terminal.width, {
      locale: state.locale,
      style: state.style,
      inspection: state.tasks.inspection,
    }).length - contentHeight);
    switch (keypress.key) {
      case "escape": return { state: closeInspection(state), handled: true };
      case "tab": return { state: closeInspection(state, true), handled: true };
      case "up": return { state: setTaskScroll(state, state.tasks.scrollOffset - 1, maxOffset), handled: true };
      case "down": return { state: setTaskScroll(state, state.tasks.scrollOffset + 1, maxOffset), handled: true };
      case "pageup": return { state: setTaskScroll(state, state.tasks.scrollOffset - contentHeight, maxOffset), handled: true };
      case "pagedown": return { state: setTaskScroll(state, state.tasks.scrollOffset + contentHeight, maxOffset), handled: true };
      case "left": return { state: setTaskTraceSelection(state, card, "left"), handled: true };
      case "right": return { state: setTaskTraceSelection(state, card, "right"), handled: true };
      case "home": return { state: setTaskTraceSelection(state, card, "home"), handled: true };
      case "end": return { state: setTaskTraceSelection(state, card, "end"), handled: true };
      default: return { state, handled: true };
    }
  }

  const focused = state.focus.target.kind === "taskCard";
  if (!focused) {
    const shortcut = keypress.ctrl === true && keypress.key === "t";
    if (!shortcut && keypress.key !== "tab") return { state, handled: false };
    const taskId = selectedTask(state.tasks)?.taskId;
    if (taskId === undefined) return { state, handled: false };
    return {
      state: {
        ...state,
        tasks: { ...state.tasks, selectedTaskId: taskId },
        focus: setFocus(state.focus, { kind: "taskCard", taskId }),
      },
      handled: true,
    };
  }

  switch (keypress.key) {
    case "up": return { state: selectRelativeTask(state, -1), handled: true };
    case "down": return { state: selectRelativeTask(state, 1), handled: true };
    case "home": return { state: selectTaskAt(state, 0), handled: true };
    case "end": return { state: selectTaskAt(state, state.tasks.cards.length - 1), handled: true };
    case "enter": {
      const taskId = selectedTask(state.tasks)?.taskId;
      return taskId === undefined
        ? { state, handled: true }
        : {
            state: {
              ...state,
              tasks: {
                ...state.tasks,
                inspectedTaskId: taskId,
                inspection: { followLive: true },
                scrollOffset: 0,
              }
            },
            handled: true
          };
    }
    case "escape":
    case "tab": return {
      state: { ...state, focus: setFocus(state.focus, { kind: "prompt" }) },
      handled: true,
    };
    default: return { state, handled: true };
  }
}

function selectedTask(state: TaskSurfaceState): TaskCardState | undefined {
  return state.cards.find((card) => card.taskId === state.selectedTaskId) ?? state.cards[0];
}

function inspectedTask(state: TaskSurfaceState): TaskCardState | undefined {
  return state.cards.find((card) => card.taskId === state.inspectedTaskId);
}

function closeInspection(state: OperatorConsoleState, focusPrompt = false): OperatorConsoleState {
  const taskId = state.tasks.inspectedTaskId ?? selectedTask(state.tasks)?.taskId;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspectedTaskId: undefined,
      inspection: { followLive: true },
      scrollOffset: 0,
    },
    focus: focusPrompt || taskId === undefined
      ? setFocus(state.focus, { kind: "prompt" })
      : setFocus(state.focus, { kind: "taskCard", taskId }),
  };
}

function setTaskScroll(state: OperatorConsoleState, offset: number, maxOffset: number): OperatorConsoleState {
  return { ...state, tasks: { ...state.tasks, scrollOffset: Math.max(0, Math.min(maxOffset, offset)) } };
}

function setTaskTraceSelection(
  state: OperatorConsoleState,
  card: TaskCardState,
  action: TraceNavigationAction
): OperatorConsoleState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: navigateActivityTrace(card.trace.events, state.tasks.inspection, action, state.terminal.width),
      scrollOffset: 0,
    }
  };
}

function selectRelativeTask(state: OperatorConsoleState, delta: number): OperatorConsoleState {
  const selected = selectedTask(state.tasks);
  const index = selected === undefined ? 0 : state.tasks.cards.indexOf(selected);
  return selectTaskAt(state, Math.max(0, Math.min(state.tasks.cards.length - 1, index + delta)));
}

function selectTaskAt(state: OperatorConsoleState, index: number): OperatorConsoleState {
  const task = state.tasks.cards[index];
  if (task === undefined) return state;
  return {
    ...state,
    tasks: { ...state.tasks, selectedTaskId: task.taskId },
    focus: setFocus(state.focus, { kind: "taskCard", taskId: task.taskId }),
  };
}

type SubagentGrid = {
  readonly columns: number;
  readonly rows: number;
  readonly hiddenCount: number;
};

type SubagentActivityRow = {
  readonly label: string;
  readonly category: TaskCardActivityState["category"];
  readonly live: boolean;
};

type TaskCardRenderOptions = {
  readonly locale?: OperatorConsoleLocale;
  readonly isTty?: boolean;
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
};

function formatTaskHeader(
  card: TaskCardState,
  state: TaskSurfaceState,
  copy: TaskCopy,
  focused: boolean,
  style: OperatorConsoleStyle | undefined
): string {
  const taskPosition = `${state.cards.indexOf(card) + 1}/${state.cards.length}`;
  const title = `${copy.task} ${taskPosition}`;
  const tokens = style?.tokens.contract;
  const titleColor = focused ? tokens?.palette.action : tokens?.palette.brand;
  const styledTitle = titleColor === undefined
    ? title
    : styleColor(style, styleBold(style, title), titleColor);
  const rail = focused ? tokens?.glyph.progress.thumb ?? ">" : " ";
  const styledRail = focused && tokens !== undefined
    ? styleColor(style, rail, tokens.palette.action)
    : rail;
  const settled = card.progress.completed + card.progress.skipped;
  return `${styledRail} ${styledTitle} · ${isolate(card.taskId)} · ${card.objective} · ${settled} of ${card.progress.total} ${copy.stepsSettled}`;
}

function resolveSubagentGrid(count: number, width: number): SubagentGrid {
  const normalizedCount = Math.max(0, Math.floor(count));
  if (normalizedCount === 0) return { columns: 1, rows: 0, hiddenCount: 0 };
  const requestedColumns = normalizedCount <= SUBAGENT_ROWS_PER_COLUMN
    ? 1
    : Math.ceil(normalizedCount / SUBAGENT_ROWS_PER_COLUMN);
  const readableColumns = Math.max(
    1,
    Math.floor((Math.max(0, width) + SUBAGENT_COLUMN_GAP) / (MIN_SUBAGENT_CARD_WIDTH + SUBAGENT_COLUMN_GAP))
  );
  const columns = Math.max(1, Math.min(requestedColumns, readableColumns));
  const rows = Math.min(SUBAGENT_ROWS_PER_COLUMN, normalizedCount);
  return {
    columns,
    rows,
    hiddenCount: Math.max(0, normalizedCount - columns * rows),
  };
}

function fitSubagentGridToHeight(grid: SubagentGrid, count: number, height: number): SubagentGrid {
  for (let rows = grid.rows; rows > 0; rows -= 1) {
    const hiddenCount = Math.max(0, count - rows * grid.columns);
    const requiredHeight = 1 +
      rows * SUBAGENT_CARD_HEIGHT +
      Math.max(0, rows - 1) * SUBAGENT_ROW_GAP +
      (hiddenCount > 0 ? 1 : 0);
    if (requiredHeight <= height) return { columns: grid.columns, rows, hiddenCount };
  }
  return { columns: grid.columns, rows: 0, hiddenCount: count };
}

function resolveEqualColumnWidth(width: number, columns: number): number {
  const gutters = Math.max(0, columns - 1) * SUBAGENT_COLUMN_GAP;
  return Math.max(1, Math.floor(Math.max(0, width - gutters) / Math.max(1, columns)));
}

function renderSubagentCard(
  subagent: TaskCardSubagentState,
  width: number,
  copy: TaskCopy,
  options: TaskCardRenderOptions
): readonly string[] {
  const activity = subagentActivityRows(subagent);
  const visibleActivity = activity.rows.slice(0, SUBAGENT_ACTIVITY_ROWS);
  const title = formatSubagentTitle(subagent, options);
  const history = formatSubagentHistoryCount(activity.hiddenCount, copy, options.style);
  const activityRows = Array.from({ length: SUBAGENT_ACTIVITY_ROWS }, (_, index) => {
    const row = visibleActivity[index];
    if (row !== undefined) return formatSubagentActivity(row, options.style);
    if (index === 0) return styleMuted(options.style, copy.waitingForActivity);
    return "";
  });
  const summary = formatSubagentPreviewOrSummary(subagent, options.style);
  const footer = formatSubagentFooter(subagent, copy, options);
  const background = options.style?.tokens.contract.surface.bgElevated ?? "";
  return [title, history, ...activityRows, summary, footer]
    .map((row) => styleBackgroundRow(options.style, ` ${row}`, width, background));
}

function renderCompactSubagentFallback(
  card: TaskCardState,
  header: string,
  copy: TaskCopy,
  options: TaskCardRenderOptions,
  width: number,
  height: number
): readonly string[] {
  const rows = [header];
  const visible = card.subagents.slice(0, Math.max(0, height - 1));
  for (const subagent of visible) {
    const usage = subagent.usage.currentAttempt ?? subagent.usage.total;
    const summary = `${subagent.displayLabel} · ${formatSubagentStatus(subagent.status)} · ${formatDuration(subagent.elapsedMs)} · ${formatCompactTokenCount(usage.totalTokens)} ${copy.tokens} · ${formatCardUsage(usage, options.locale ?? "en")}`;
    rows.push(summary);
  }
  const hiddenCount = Math.max(0, card.subagents.length - visible.length);
  if (hiddenCount > 0 && rows.length > 1) rows[rows.length - 1] = `+${hiddenCount} ${copy.moreSubagents}`;
  return padSurfaceRows(rows, height, width);
}

function formatSubagentTitle(
  subagent: TaskCardSubagentState,
  options: TaskCardRenderOptions
): string {
  const style = options.style;
  const tokens = style?.tokens.contract;
  const symbol = subagentStatusSymbol(subagent, style, options.motionElapsedMs);
  const title = `${subagent.displayLabel} · ${subagent.objective}`;
  const styledTitle = tokens === undefined
    ? title
    : styleColor(style, styleBold(style, title), tokens.palette.accent);
  return `${symbol} ${styledTitle}`;
}

function subagentStatusSymbol(
  subagent: TaskCardSubagentState,
  style: OperatorConsoleStyle | undefined,
  motionElapsedMs: number | undefined
): string {
  const tokens = style?.tokens.contract;
  if (subagent.status === "running") {
    if (tokens === undefined) return ".";
    const motion = tokens.motion.worker;
    const elapsed = tokens.behavior.allowAnimation ? motionElapsedMs : 0;
    return styleColor(style, semanticMotionFrame(motion, elapsed, subagent.displayIndex * 2), motion.color);
  }
  if (subagent.status === "completed" || subagent.status === "skipped") {
    return tokens === undefined ? "[x]" : styleColor(style, tokens.glyph.check, tokens.severity.ok);
  }
  if (subagent.status === "failed" || subagent.status === "cancelled") {
    return tokens === undefined ? "[!]" : styleColor(style, tokens.glyph.cross, tokens.severity.error);
  }
  if (subagent.status === "waiting_for_input" || subagent.status === "waiting_for_approval") {
    return tokens === undefined ? "!" : styleColor(style, "!", tokens.palette.caution);
  }
  return tokens === undefined ? "." : styleColor(style, tokens.glyph.bullet, tokens.text.muted);
}

function subagentActivityRows(subagent: TaskCardSubagentState): {
  readonly rows: readonly SubagentActivityRow[];
  readonly hiddenCount: number;
} {
  const rows: SubagentActivityRow[] = [];
  const seen = new Set<string>();
  const currentActivity = normalizeCardText(subagent.currentActivity ?? subagent.activeAttempt?.currentActivity);
  if (currentActivity !== undefined) {
    rows.push({
      label: currentActivity,
      category: traceCategoryForTool(subagent.currentToolCategory ?? subagent.activeAttempt?.currentToolCategory),
      live: true,
    });
    seen.add(currentActivity.toLocaleLowerCase());
  }
  for (const event of [...subagent.trace].reverse()) {
    const label = normalizeCardText(event.label);
    if (label === undefined || seen.has(label.toLocaleLowerCase())) continue;
    rows.push({ label, category: event.category, live: false });
    seen.add(label.toLocaleLowerCase());
  }
  return {
    rows,
    hiddenCount: Math.max(0, rows.length - SUBAGENT_ACTIVITY_ROWS),
  };
}

function formatSubagentHistoryCount(
  hiddenCount: number,
  copy: TaskCopy,
  style: OperatorConsoleStyle | undefined
): string {
  const glyph = style?.tokens.contract.glyph.continuation ?? "...";
  const text = hiddenCount > 0
    ? `${glyph} +${hiddenCount} ${copy.earlierActivities}`
    : `${glyph} ${copy.noEarlierActivity}`;
  return styleMuted(style, text);
}

function formatSubagentActivity(
  activity: SubagentActivityRow,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  const glyph = activity.live
    ? tokens?.glyph.trace.live ?? ">"
    : tokens?.glyph.trace.event ?? ".";
  const color = activity.live
    ? tokens?.palette.action
    : tokens?.trace[activity.category];
  const styledGlyph = color === undefined ? glyph : styleColor(style, glyph, color);
  return `${styledGlyph} ${activity.label}`;
}

function formatSubagentPreviewOrSummary(
  subagent: TaskCardSubagentState,
  style: OperatorConsoleStyle | undefined
): string {
  const preview = normalizeCardText(
    subagent.assistantPreview ??
    subagent.activeAttempt?.assistantPreview ??
    subagent.latestAttempt?.assistantPreview
  );
  if (preview !== undefined) {
    const glyph = style?.tokens.contract.glyph.trace.event ?? ".";
    const color = style?.tokens.contract.trace.answer;
    return `${color === undefined ? glyph : styleColor(style, glyph, color)} ${preview}`;
  }
  if (!isSettledSubagent(subagent.status)) return "";
  const resultSummary = normalizeCardText(
    subagent.results.find((result) => result.primary && result.disposition === "accepted")?.summary ??
    subagent.results.find((result) => result.disposition === "accepted")?.summary
  );
  const summary = resultSummary ?? formatSubagentStatus(subagent.status);
  return `${subagentStatusSymbol(subagent, style, 0)} ${summary}`;
}

function formatSubagentFooter(
  subagent: TaskCardSubagentState,
  copy: TaskCopy,
  options: TaskCardRenderOptions
): string {
  const usage = subagent.usage.currentAttempt ?? subagent.usage.total;
  const status = styleSubagentStatus(formatSubagentStatus(subagent.status), subagent.status, options.style);
  return `${status} · ${formatDuration(subagent.elapsedMs)} · ${formatCompactTokenCount(usage.totalTokens)} ${copy.tokens} · ${formatCardUsage(usage, options.locale ?? "en")}`;
}

function styleSubagentStatus(
  value: string,
  status: TaskCardSubagentState["status"],
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return value;
  if (status === "completed" || status === "skipped") return styleColor(style, value, tokens.severity.ok);
  if (status === "failed" || status === "cancelled") return styleColor(style, value, tokens.severity.error);
  if (status === "waiting_for_input" || status === "waiting_for_approval") return styleColor(style, value, tokens.palette.caution);
  if (status === "running") return styleColor(style, value, tokens.palette.action);
  return styleColor(style, value, tokens.text.secondary);
}

function traceCategoryForTool(value: string | undefined): TaskCardActivityState["category"] {
  const tool = value?.toLocaleLowerCase() ?? "";
  if (/terminal|process|shell|command/u.test(tool)) return "terminal";
  if (/search|grep|rg|find/u.test(tool)) return "search";
  if (/read|fetch|browser/u.test(tool)) return "read";
  if (/edit|write|patch/u.test(tool)) return "edit";
  if (/wait|approval/u.test(tool)) return "wait";
  return "plan";
}

function normalizeCardText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function formatCompactTokenCount(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? value : 0);
  if (count < 1_000) return String(Math.floor(count));
  if (count < 1_000_000) return `${trimCompactDecimal(count / 1_000)}k`;
  return `${trimCompactDecimal(count / 1_000_000)}m`;
}

function trimCompactDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function formatSubagentStatus(status: TaskCardSubagentState["status"]): string {
  return status.replaceAll("_", " ");
}

function isSettledSubagent(status: TaskCardSubagentState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function styleMuted(style: OperatorConsoleStyle | undefined, value: string): string {
  const color = style?.tokens.contract.text.muted;
  return color === undefined ? value : styleColor(style, value, color);
}

function padSurfaceRows(rows: readonly string[], height: number, width: number): readonly string[] {
  return Array.from({ length: height }, (_, index) =>
    padVisibleEnd(truncateVisible(rows[index] ?? "", width, "…"), width)
  );
}

function formatCardUsage(usage: TaskCardState["usage"], locale: OperatorConsoleLocale): string {
  return formatUsageCost({
    estimatedCostUsd: usage.estimatedCostUsd,
    costComplete: usage.pricingComplete
  }, { locale, compact: true });
}

function formatStatus(status: TaskCardState["status"]): string {
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

function isolate(value: string): string {
  return `${LTR_START}${value}${LTR_END}`;
}

function isolateIfArabic(value: string, locale: OperatorConsoleLocale | undefined): string {
  return locale === "ar" ? isolate(value) : value;
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
