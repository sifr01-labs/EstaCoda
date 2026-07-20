import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { padVisibleEnd, truncateVisible, wrapText } from "../../renderers/layout.js";
import { setFocus } from "./focusModel.js";
import type {
  OperatorConsoleLocale,
} from "./activeWorkCopy.js";
import type {
  OperatorConsoleState,
  TaskCardState,
  TaskCardStepState,
  TaskSurfaceState,
} from "./operatorConsoleState.js";

const MAX_CARD_STEPS = 4;
const LTR_START = "\u2068";
const LTR_END = "\u2069";

type TaskCopy = {
  tasks: string;
  inspectHint: string;
  objective: string;
  status: string;
  planRevision: string;
  dependencies: string;
  activeAttempt: string;
  elapsed: string;
  recentActivity: string;
  toolCategory: string;
  usageCost: string;
  results: string;
  waitingReason: string;
  failureReason: string;
  none: string;
  closeHint: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, TaskCopy>> = {
  en: {
    tasks: "Tasks",
    inspectHint: "Ctrl+T or Tab focus · Enter inspect",
    objective: "Objective",
    status: "Status",
    planRevision: "Plan revision",
    dependencies: "Dependencies",
    activeAttempt: "Active Attempt",
    elapsed: "Elapsed",
    recentActivity: "Recent safe activity",
    toolCategory: "Current tool category",
    usageCost: "Usage and cost",
    results: "Results and artifacts",
    waitingReason: "Waiting reason",
    failureReason: "Failure reason",
    none: "none",
    closeHint: "Esc return · Up/Down scroll · PgUp/PgDn page · Home/End jump",
  },
  ar: {
    tasks: "المهام",
    inspectHint: "Ctrl+T أو Tab للتركيز · Enter للفحص",
    objective: "الهدف",
    status: "الحالة",
    planRevision: "مراجعة الخطة",
    dependencies: "الاعتماديات",
    activeAttempt: "المحاولة النشطة",
    elapsed: "المدة",
    recentActivity: "النشاط الآمن الأخير",
    toolCategory: "فئة الأداة الحالية",
    usageCost: "الاستخدام والتكلفة",
    results: "النتائج والملفات",
    waitingReason: "سبب الانتظار",
    failureReason: "سبب الفشل",
    none: "لا يوجد",
    closeHint: "Esc للعودة · ↑/↓ للتمرير · PgUp/PgDn للصفحة · Home/End للانتقال",
  },
};

export type TaskSurfaceKeyResult = {
  readonly state: OperatorConsoleState;
  readonly handled: boolean;
};

export function hasTaskCards(state: TaskSurfaceState): boolean {
  return state.cards.length > 0;
}

export function getTaskCardSurfaceDesiredHeight(state: TaskSurfaceState): number {
  const card = selectedTask(state);
  if (card === undefined) return 0;
  return Math.min(8, 3 + Math.min(MAX_CARD_STEPS, card.steps.length));
}

export function renderTaskCardSurface(
  state: TaskSurfaceState,
  options: { readonly width: number; readonly height?: number; readonly locale?: OperatorConsoleLocale; readonly isTty?: boolean; readonly focusedTaskId?: string }
): readonly string[] {
  const width = dimension(options.width);
  const height = dimension(options.height ?? getTaskCardSurfaceDesiredHeight(state));
  const card = selectedTask(state);
  if (width === 0 || height === 0 || card === undefined) return [];
  const copy = COPY[options.locale ?? "en"];
  const isFocused = options.focusedTaskId === card.taskId;
  const progress = progressPercent(card);
  const title = `${copy.tasks} ${state.cards.indexOf(card) + 1}/${state.cards.length}`;
  const header = `${isFocused ? ">" : " "} ${isolate(card.taskId)}  ${card.objective}  ${progress}%`;
  const rows = [title, header];
  for (const step of card.steps.slice(0, MAX_CARD_STEPS)) {
    rows.push(formatStepRow(step, options.isTty !== false, options.locale));
  }
  const hidden = Math.max(0, card.steps.length - MAX_CARD_STEPS);
  if (hidden > 0) rows.push(`  +${hidden} more steps`);
  rows.push(`${formatStatus(card.status)} · ${formatDuration(card.elapsedMs)} · ${copy.inspectHint}`);
  return rows.slice(0, height).map((row) => padVisibleEnd(truncateVisible(row, width, "…"), width));
}

export function getTaskInspectionSurfaceDesiredHeight(terminalHeight: number): number {
  return dimension(terminalHeight);
}

export function renderTaskInspectionSurface(
  state: TaskSurfaceState,
  options: { readonly width: number; readonly height: number; readonly locale?: OperatorConsoleLocale; readonly isTty?: boolean }
): readonly string[] {
  const width = dimension(options.width);
  const height = dimension(options.height);
  const card = inspectedTask(state);
  if (width === 0 || height === 0 || card === undefined) return [];
  const copy = COPY[options.locale ?? "en"];
  const header = `${copy.tasks} · ${isolate(card.taskId)} · ${formatStatus(card.status)}`;
  if (height === 1) return [padVisibleEnd(truncateVisible(header, width, "…"), width)];
  const footer = copy.closeHint;
  const contentHeight = Math.max(0, height - 2);
  const content = taskInspectionContentLines(card, width, options.locale);
  const maxOffset = Math.max(0, content.length - contentHeight);
  const offset = Math.min(maxOffset, Math.max(0, state.scrollOffset));
  const visible = content.slice(offset, offset + contentHeight);
  const rows = [header, ...visible, ...Array.from({ length: Math.max(0, contentHeight - visible.length) }, () => ""), footer];
  return rows.slice(0, height).map((row) => padVisibleEnd(truncateVisible(row, width, "…"), width));
}

export function taskInspectionContentLines(
  card: TaskCardState,
  width: number,
  locale: OperatorConsoleLocale = "en"
): readonly string[] {
  const copy = COPY[locale];
  const contentWidth = Math.max(1, dimension(width) - 2);
  const lines: string[] = [];
  addSection(lines, copy.objective, wrapText(card.objective, contentWidth));
  addSection(lines, copy.status, [`${formatStatus(card.status)} · ${progressPercent(card)}%`]);
  addSection(lines, copy.planRevision, [card.planRevision === undefined
    ? copy.none
    : `${card.planRevision.revision} · ${card.planRevision.status}`]);
  addSection(lines, copy.elapsed, [formatDuration(card.elapsedMs)]);
  addSection(lines, copy.dependencies, dependencyLines(card, copy.none));
  addSection(lines, copy.activeAttempt, activeAttemptLines(card, copy.none));
  addSection(lines, copy.toolCategory, [card.currentToolCategory === undefined ? copy.none : isolate(card.currentToolCategory)]);
  addSection(lines, copy.usageCost, [
    `${card.usage.providerCalls} calls · ${card.usage.totalTokens} tokens · $${card.usage.estimatedCostUsd.toFixed(4)}` +
      `${card.usage.usageComplete && card.usage.pricingComplete ? "" : " · incomplete"}`,
  ]);
  addSection(lines, copy.results, card.results.length === 0
    ? [copy.none]
    : card.results.map((result) => `${isolate(result.handle)} · ${result.kind} · ${formatBytes(result.byteLength)}${result.summary === undefined ? "" : ` · ${result.summary}`}`));
  addSection(lines, copy.recentActivity, card.recentActivity.length === 0
    ? [copy.none]
    : card.recentActivity.map((activity) => `${formatTimestamp(activity.timestamp)} · ${activity.label}`));
  if (card.waitReason !== undefined) addSection(lines, copy.waitingReason, wrapText(card.waitReason, contentWidth));
  if (card.failure !== undefined) {
    addSection(lines, copy.failureReason, [
      `${isolate(card.failure.class)} · retryable=${String(card.failure.retryable)} · uncertain-side-effects=${String(card.failure.uncertainSideEffects)}`,
    ]);
  }
  return lines;
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
    const maxOffset = Math.max(0, taskInspectionContentLines(card, state.terminal.width, state.locale).length - contentHeight);
    switch (keypress.key) {
      case "escape": return { state: closeInspection(state), handled: true };
      case "tab": return { state: closeInspection(state, true), handled: true };
      case "up": return { state: setTaskScroll(state, state.tasks.scrollOffset - 1, maxOffset), handled: true };
      case "down": return { state: setTaskScroll(state, state.tasks.scrollOffset + 1, maxOffset), handled: true };
      case "pageup": return { state: setTaskScroll(state, state.tasks.scrollOffset - contentHeight, maxOffset), handled: true };
      case "pagedown": return { state: setTaskScroll(state, state.tasks.scrollOffset + contentHeight, maxOffset), handled: true };
      case "home": return { state: setTaskScroll(state, 0, maxOffset), handled: true };
      case "end": return { state: setTaskScroll(state, maxOffset, maxOffset), handled: true };
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
        : { state: { ...state, tasks: { ...state.tasks, inspectedTaskId: taskId, scrollOffset: 0 } }, handled: true };
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
    tasks: { ...state.tasks, inspectedTaskId: undefined, scrollOffset: 0 },
    focus: focusPrompt || taskId === undefined
      ? setFocus(state.focus, { kind: "prompt" })
      : setFocus(state.focus, { kind: "taskCard", taskId }),
  };
}

function setTaskScroll(state: OperatorConsoleState, offset: number, maxOffset: number): OperatorConsoleState {
  return { ...state, tasks: { ...state.tasks, scrollOffset: Math.max(0, Math.min(maxOffset, offset)) } };
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

function addSection(lines: string[], title: string, values: readonly string[]): void {
  if (lines.length > 0) lines.push("");
  lines.push(title);
  lines.push(...values.map((value) => `  ${value}`));
}

function dependencyLines(card: TaskCardState, none: string): readonly string[] {
  const titles = new Map(card.steps.map((step) => [step.stepId, step.title]));
  const withDependencies = card.steps.filter((step) => step.dependsOn.length > 0);
  if (withDependencies.length === 0) return [none];
  return withDependencies.map((step) => `${step.title}: ${step.dependsOn.map((id) => titles.get(id) ?? isolate(id)).join(", ")}`);
}

function activeAttemptLines(card: TaskCardState, none: string): readonly string[] {
  const active = card.steps.filter((step) => step.activeAttempt !== undefined);
  if (active.length === 0) return [none];
  return active.map((step) => `${step.title} · #${step.activeAttempt!.attemptNumber} · ${step.activeAttempt!.status} · ${formatDuration(step.activeAttempt!.elapsedMs)}`);
}

function formatStepRow(step: TaskCardStepState, unicode: boolean, locale: OperatorConsoleLocale | undefined): string {
  const symbol = stepStatusSymbol(step.status, unicode);
  const activity = step.activeAttempt?.currentActivity ??
    step.activeAttempt?.currentToolCategory ??
    step.activeAttempt?.status ??
    step.status;
  const duration = step.activeAttempt === undefined ? "" : `  ${formatDuration(step.activeAttempt.elapsedMs)}`;
  return `  ${symbol} ${step.title}  ${isolateIfArabic(activity, locale)}${duration}`;
}

function stepStatusSymbol(status: TaskCardStepState["status"], unicode: boolean): string {
  if (!unicode) {
    if (status === "completed") return "[x]";
    if (status === "failed") return "[!]";
    if (status === "cancelled") return "[-]";
    return "[ ]";
  }
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "cancelled") return "×";
  if (status === "running") return "●";
  if (status === "waiting_for_input" || status === "waiting_for_approval") return "!";
  return "·";
}

function progressPercent(card: TaskCardState): number {
  if (card.progress.total <= 0) return 0;
  return Math.round(((card.progress.completed + card.progress.skipped) / card.progress.total) * 100);
}

function formatStatus(status: TaskCardState["status"]): string {
  return status.replaceAll("_", " ");
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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 19) : "--:--:--";
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
