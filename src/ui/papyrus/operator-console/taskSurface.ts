import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { padVisibleEnd, truncateVisible, wrapText } from "../../renderers/layout.js";
import { semanticMotionFrame } from "../../semantic-motion.js";
import {
  navigateActivityTrace,
  renderActivityTraceSurface,
  type TraceNavigationAction,
} from "./activityTraceSurface.js";
import { setFocus } from "./focusModel.js";
import type {
  OperatorConsoleLocale,
} from "./activeWorkCopy.js";
import type {
  OperatorConsoleState,
  TaskCardActivityState,
  TaskCardState,
  TaskCardStepState,
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
import {
  renderSubagentInspectionSurface,
  subagentInspectionContentLines,
} from "./subagentInspectionSurface.js";
import { deriveTaskResultSummary } from "../../../utils/task-result-summary.js";

const SUBAGENT_CARD_HEIGHT = 7;
const SUBAGENT_ACTIVITY_ROWS = 3;
const SUBAGENT_ROWS_PER_COLUMN = 3;
const SUBAGENT_COLUMN_GAP = 2;
const SUBAGENT_ROW_GAP = 1;
const COLLAPSED_SUBAGENT_CARD_HEIGHT = 1;
const COLLAPSED_SUBAGENT_ROW_GAP = 1;
const PARENT_SYNTHESIS_STAGE_HEIGHT = 7;
const PARENT_SYNTHESIS_STAGE_GAP = 1;
const MIN_SUBAGENT_CARD_WIDTH = 44;
const MAX_SUBAGENT_TITLE_WORDS = 8;
const MAX_SUBAGENT_TITLE_WIDTH = 64;
const LTR_START = "\u2068";
const LTR_END = "\u2069";

type TaskCopy = {
  tasks: string;
  task: string;
  delegatedTask: string;
  inspectHint: string;
  mouseToggleHint: string;
  mouseActiveHint: string;
  stepsSettled: string;
  delegatedStepsCompleted: (completed: number, total: number) => string;
  delegatedStepsSettled: (settled: number, total: number) => string;
  delegatedProgressCompact: (completed: number, settled: number, total: number) => string;
  phaseLabel: (phase: TaskCardState["phase"]["name"]) => string;
  earlierActivities: string;
  waitingForActivity: string;
  resultReady: string;
  resultUnavailable: string;
  noResultSummary: string;
  parentSynthesis: string;
  preparingSynthesis: (count: number) => string;
  synthesizingResults: (count: number) => string;
  synthesisWaitingForInput: string;
  synthesisWaitingForApproval: string;
  tokens: string;
  moreSubagents: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, TaskCopy>> = {
  en: {
    tasks: "Tasks",
    task: "Task",
    delegatedTask: "Delegated Task",
    inspectHint: "Ctrl+T or Tab focus · Enter inspect",
    mouseToggleHint: "Ctrl+G mouse",
    mouseActiveHint: "[Mouse Mode] Esc release",
    stepsSettled: "Steps settled",
    delegatedStepsCompleted: (completed, total) => `${completed} of ${total} delegated Steps completed`,
    delegatedStepsSettled: (settled, total) => `${settled} of ${total} delegated Steps settled`,
    delegatedProgressCompact: (completed, settled, total) => completed === total
      ? `${completed}/${total} completed`
      : `${settled}/${total} settled`,
    phaseLabel: (phase) => phase.replaceAll("_", " "),
    earlierActivities: "earlier activities",
    waitingForActivity: "Waiting for safe activity",
    resultReady: "Summary",
    resultUnavailable: "Result unavailable",
    noResultSummary: "Open to inspect the full result",
    parentSynthesis: "Parent synthesis",
    preparingSynthesis: (count) => `Preparing to synthesize ${count} Subagent ${count === 1 ? "result" : "results"}`,
    synthesizingResults: (count) => `Synthesizing ${count} Subagent ${count === 1 ? "result" : "results"}`,
    synthesisWaitingForInput: "Synthesis waiting for input",
    synthesisWaitingForApproval: "Synthesis waiting for approval",
    tokens: "tokens",
    moreSubagents: "more Subagents",
  },
  ar: {
    tasks: "المهام",
    task: "المهمة",
    delegatedTask: "المهمة",
    inspectHint: "Ctrl+T أو Tab للتركيز · Enter للفحص",
    mouseToggleHint: "Ctrl+G للماوس",
    mouseActiveHint: "[وضع الماوس] Esc للتحرير",
    stepsSettled: "خطوات مستقرة",
    delegatedStepsCompleted: (completed, total) => `اكتملت ${completed} من ${total} خطوات مفوضة`,
    delegatedStepsSettled: (settled, total) => `استقرت ${settled} من ${total} خطوات مفوضة`,
    delegatedProgressCompact: (completed, settled, total) => completed === total
      ? `${completed}/${total} مكتملة`
      : `${settled}/${total} مستقرة`,
    phaseLabel: localizedArabicTaskPhase,
    earlierActivities: "أنشطة سابقة",
    waitingForActivity: "بانتظار نشاط آمن",
    resultReady: "الملخص",
    resultUnavailable: "النتيجة غير متاحة",
    noResultSummary: "افتح لفحص النتيجة الكاملة",
    parentSynthesis: "تجميع الوكيل الرئيسي",
    preparingSynthesis: (count) => `يتم التحضير لتجميع ${count} من نتائج الوكلاء الفرعيين`,
    synthesizingResults: (count) => `يتم تجميع ${count} من نتائج الوكلاء الفرعيين`,
    synthesisWaitingForInput: "التجميع بانتظار إدخال",
    synthesisWaitingForApproval: "التجميع بانتظار الموافقة",
    tokens: "رمز",
    moreSubagents: "وكلاء فرعيون إضافيون",
  },
};

export type TaskSurfaceKeyResult = {
  readonly state: OperatorConsoleState;
  readonly handled: boolean;
};

export type TaskCardHitTarget = {
  readonly kind: "taskHeader" | "subagentCard";
  readonly taskId: string;
  readonly stepId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type TaskSurfacePointerAction =
  | { readonly type: "openTask"; readonly taskId: string }
  | { readonly type: "openSubagent"; readonly taskId: string; readonly stepId: string }
  | { readonly type: "selectTraceEvent"; readonly scope: "task" | "subagent"; readonly eventId: string }
  | { readonly type: "returnToLive"; readonly scope: "task" | "subagent" }
  | { readonly type: "back" }
  | { readonly type: "scroll"; readonly delta: number };

export function hasTaskCards(state: TaskSurfaceState): boolean {
  return state.cards.length > 0;
}

/** Refresh Task projections without moving established cards or resetting inspection state. */
export function reconcileTaskSurfaceState(
  current: TaskSurfaceState,
  incomingCards: readonly TaskCardState[]
): TaskSurfaceState {
  const incomingById = new Map(incomingCards.map((card) => [card.taskId, card]));
  const retainedIds = new Set<string>();
  const cards = current.cards.flatMap((card) => {
    const refreshed = incomingById.get(card.taskId);
    if (refreshed === undefined) return [];
    retainedIds.add(card.taskId);
    return [refreshed];
  });
  for (const card of incomingCards) {
    if (retainedIds.has(card.taskId)) continue;
    retainedIds.add(card.taskId);
    cards.push(card);
  }

  const selectedTaskId = cards.some((card) => card.taskId === current.selectedTaskId)
    ? current.selectedTaskId
    : cards[0]?.taskId;
  const inspectedTaskId = cards.some((card) => card.taskId === current.inspectedTaskId)
    ? current.inspectedTaskId
    : undefined;
  const inspectedCard = cards.find((card) => card.taskId === inspectedTaskId);
  const retainedInspection = current.inspection ?? { followLive: true };
  const selectedSubagent = inspectedCard?.subagents.find((subagent) =>
    subagent.stepId === retainedInspection.selectedSubagentStepId
  ) ?? inspectedCard?.subagents[0];
  const inspectedSubagent = inspectedCard?.subagents.find((subagent) =>
    subagent.stepId === retainedInspection.inspectedSubagentStepId
  );
  const {
    selectedSubagentStepId: _selectedSubagentStepId,
    inspectedSubagentStepId: _inspectedSubagentStepId,
    subagentTrace: _subagentTrace,
    ...baseInspection
  } = retainedInspection;
  const inspection = inspectedTaskId === undefined
    ? { followLive: true }
    : {
        ...baseInspection,
        ...(selectedSubagent === undefined ? {} : { selectedSubagentStepId: selectedSubagent.stepId }),
        ...(inspectedSubagent === undefined
          ? {}
          : {
              inspectedSubagentStepId: inspectedSubagent.stepId,
              subagentTrace: retainedInspection.subagentTrace ?? { followLive: true },
            }),
      };
  return {
    cards,
    ...(selectedTaskId === undefined ? {} : { selectedTaskId }),
    ...(inspectedTaskId === undefined ? {} : { inspectedTaskId }),
    inspection,
    ...(cards.length > 0 && current.mouseModeActive === true ? { mouseModeActive: true } : {}),
    scrollOffset: inspectedTaskId === undefined ? 0 : current.scrollOffset,
  };
}

export function getTaskCardSurfaceDesiredHeight(state: TaskSurfaceState, width = 80): number {
  const card = selectedTask(state);
  if (card === undefined) return 0;
  const synthesis = activeParentSynthesisStep(card);
  if (synthesis !== undefined) {
    const grid = resolveSubagentGrid(card.subagents.length, dimension(width));
    return 1 +
      PARENT_SYNTHESIS_STAGE_HEIGHT +
      PARENT_SYNTHESIS_STAGE_GAP +
      collapsedSubagentGridHeight(grid);
  }
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
    readonly focusedSubagentStepId?: string;
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
  const synthesis = activeParentSynthesisStep(card);
  if (synthesis !== undefined) {
    return renderParentSynthesisTaskSurface(card, synthesis, header, copy, options, width, height);
  }
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
        : renderSubagentCard(
            subagent,
            columnWidth,
            copy,
            options,
            options.focusedSubagentStepId === subagent.stepId
          );
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

export function getTaskCardHitTargets(
  state: TaskSurfaceState,
  width: number,
  height = getTaskCardSurfaceDesiredHeight(state, width)
): readonly TaskCardHitTarget[] {
  const card = selectedTask(state);
  const normalizedWidth = dimension(width);
  const normalizedHeight = dimension(height);
  if (card === undefined || normalizedWidth === 0 || normalizedHeight === 0) return [];
  const synthesis = activeParentSynthesisStep(card);
  const taskTargetHeight = synthesis === undefined
    ? 1
    : Math.min(normalizedHeight, 1 + PARENT_SYNTHESIS_STAGE_HEIGHT);
  const targets: TaskCardHitTarget[] = [{
    kind: "taskHeader",
    taskId: card.taskId,
    x: 0,
    y: 0,
    width: normalizedWidth,
    height: taskTargetHeight,
  }];
  if (card.subagents.length === 0) return targets;
  if (synthesis !== undefined) {
    const layout = resolveCollapsedSynthesisLayout(card, normalizedWidth, normalizedHeight);
    const columnWidth = resolveEqualColumnWidth(normalizedWidth, layout.grid.columns);
    for (let columnIndex = 0; columnIndex < layout.grid.columns; columnIndex += 1) {
      for (let rowIndex = 0; rowIndex < layout.grid.rows; rowIndex += 1) {
        const subagentIndex = columnIndex * layout.grid.rows + rowIndex;
        const subagent = card.subagents[subagentIndex];
        if (subagent === undefined || subagentIndex >= layout.visibleCount) continue;
        targets.push({
          kind: "subagentCard",
          taskId: card.taskId,
          stepId: subagent.stepId,
          x: columnIndex * (columnWidth + SUBAGENT_COLUMN_GAP),
          y: layout.workerTop + rowIndex * (COLLAPSED_SUBAGENT_CARD_HEIGHT + COLLAPSED_SUBAGENT_ROW_GAP),
          width: columnWidth,
          height: COLLAPSED_SUBAGENT_CARD_HEIGHT,
        });
      }
    }
    return targets;
  }
  const grid = resolveSubagentGrid(card.subagents.length, normalizedWidth);
  const fitted = fitSubagentGridToHeight(grid, card.subagents.length, normalizedHeight);
  if (fitted.rows === 0) {
    const visible = card.subagents.slice(0, Math.max(0, normalizedHeight - 1));
    return [
      ...targets,
      ...visible.map((subagent, index) => ({
        kind: "subagentCard" as const,
        taskId: card.taskId,
        stepId: subagent.stepId,
        x: 0,
        y: index + 1,
        width: normalizedWidth,
        height: 1,
      })),
    ];
  }
  const visibleCount = Math.min(card.subagents.length, fitted.rows * grid.columns);
  const columnWidth = resolveEqualColumnWidth(normalizedWidth, grid.columns);
  for (let columnIndex = 0; columnIndex < grid.columns; columnIndex += 1) {
    for (let rowIndex = 0; rowIndex < fitted.rows; rowIndex += 1) {
      const subagentIndex = columnIndex * fitted.rows + rowIndex;
      const subagent = card.subagents[subagentIndex];
      if (subagent === undefined || subagentIndex >= visibleCount) continue;
      targets.push({
        kind: "subagentCard",
        taskId: card.taskId,
        stepId: subagent.stepId,
        x: columnIndex * (columnWidth + SUBAGENT_COLUMN_GAP),
        y: 1 + rowIndex * (SUBAGENT_CARD_HEIGHT + SUBAGENT_ROW_GAP),
        width: columnWidth,
        height: SUBAGENT_CARD_HEIGHT,
      });
    }
  }
  return targets;
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
  const inspectedCard = state.cards.find((card) => card.taskId === state.inspectedTaskId);
  const inspectedSubagent = inspectedCard?.subagents.find((subagent) =>
    subagent.stepId === state.inspection?.inspectedSubagentStepId
  );
  return inspectedSubagent === undefined
    ? renderTaskOverviewSurface(state, options)
    : renderSubagentInspectionSurface(state, options);
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
    const inspectedSubagent = card.subagents.find((candidate) =>
      candidate.stepId === state.tasks.inspection?.inspectedSubagentStepId
    );
    const contentHeight = Math.max(1, dimension(viewportHeight) - 2);
    const contentLines = inspectedSubagent === undefined
      ? taskOverviewContentLines(card, state.terminal.width, {
          locale: state.locale,
          style: state.style,
          inspection: state.tasks.inspection,
        })
      : subagentInspectionContentLines(card, inspectedSubagent, state.terminal.width, {
          locale: state.locale,
          style: state.style,
          inspection: state.tasks.inspection,
        });
    const maxOffset = Math.max(0, contentLines.length - contentHeight);
    if (inspectedSubagent !== undefined) {
      switch (keypress.key) {
        case "escape":
        case "tab": return { state: closeSubagentInspection(state, card), handled: true };
        case "up": return { state: setTaskScroll(state, state.tasks.scrollOffset - 1, maxOffset), handled: true };
        case "down": return { state: setTaskScroll(state, state.tasks.scrollOffset + 1, maxOffset), handled: true };
        case "pageup": return { state: setTaskScroll(state, state.tasks.scrollOffset - contentHeight, maxOffset), handled: true };
        case "pagedown": return { state: setTaskScroll(state, state.tasks.scrollOffset + contentHeight, maxOffset), handled: true };
        case "left": return { state: setSubagentTraceSelection(state, inspectedSubagent, "left"), handled: true };
        case "right": return { state: setSubagentTraceSelection(state, inspectedSubagent, "right"), handled: true };
        case "home": return { state: setSubagentTraceSelection(state, inspectedSubagent, "home"), handled: true };
        case "end": return { state: setSubagentTraceSelection(state, inspectedSubagent, "end"), handled: true };
        default: return { state, handled: true };
      }
    }
    switch (keypress.key) {
      case "escape": return { state: closeInspection(state), handled: true };
      case "tab": return { state: closeInspection(state, true), handled: true };
      case "up": return { state: selectRelativeSubagent(state, card, -1, viewportHeight), handled: true };
      case "down": return { state: selectRelativeSubagent(state, card, 1, viewportHeight), handled: true };
      case "pageup": return { state: setTaskScroll(state, state.tasks.scrollOffset - contentHeight, maxOffset), handled: true };
      case "pagedown": return { state: setTaskScroll(state, state.tasks.scrollOffset + contentHeight, maxOffset), handled: true };
      case "left": return { state: setTaskTraceSelection(state, card, "left"), handled: true };
      case "right": return { state: setTaskTraceSelection(state, card, "right"), handled: true };
      case "home": return { state: setTaskTraceSelection(state, card, "home"), handled: true };
      case "end": return { state: setTaskTraceSelection(state, card, "end"), handled: true };
      case "enter": return { state: openSelectedSubagent(state, card), handled: true };
      default: return { state, handled: true };
    }
  }

  const mainSubagentFocus = state.focus.target.kind === "taskSubagent";
  const taskFocus = state.focus.target.kind === "taskCard";
  if (!taskFocus && !mainSubagentFocus) {
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

  if (mainSubagentFocus) {
    const focusTarget = state.focus.target;
    const card = state.tasks.cards.find((candidate) => candidate.taskId === focusTarget.taskId)
      ?? selectedTask(state.tasks);
    if (card === undefined) return { state, handled: false };
    const visible = visibleSubagents(card, state.terminal.width, viewportHeight);
    const currentIndex = visible.findIndex((subagent) => subagent.stepId === focusTarget.stepId);
    if (currentIndex < 0) {
      return {
        state: {
          ...state,
          focus: setFocus(state.focus, { kind: "taskCard", taskId: card.taskId }),
        },
        handled: true,
      };
    }
    const grid = visibleSubagentGrid(card, state.terminal.width, viewportHeight);
    switch (keypress.key) {
      case "up": {
        const next = currentIndex - 1;
        return next < 0 || Math.floor(next / grid.rows) !== Math.floor(currentIndex / grid.rows)
          ? { state: focusTaskHeader(state, card), handled: true }
          : { state: focusMainSubagent(state, card, visible[next]!), handled: true };
      }
      case "down": {
        const next = currentIndex + 1;
        return next >= visible.length || Math.floor(next / grid.rows) !== Math.floor(currentIndex / grid.rows)
          ? { state, handled: true }
          : { state: focusMainSubagent(state, card, visible[next]!), handled: true };
      }
      case "left": {
        const next = currentIndex - grid.rows;
        return next < 0
          ? { state: focusTaskHeader(state, card), handled: true }
          : { state: focusMainSubagent(state, card, visible[next]!), handled: true };
      }
      case "right": {
        const next = currentIndex + grid.rows;
        return next >= visible.length
          ? { state, handled: true }
          : { state: focusMainSubagent(state, card, visible[next]!), handled: true };
      }
      case "home": return { state: focusMainSubagent(state, card, visible[0]!), handled: true };
      case "end": return { state: focusMainSubagent(state, card, visible.at(-1)!), handled: true };
      case "enter": return { state: openMainSubagent(state, card, visible[currentIndex]!), handled: true };
      case "escape":
      case "tab": return {
        state: { ...state, focus: setFocus(state.focus, { kind: "prompt" }) },
        handled: true,
      };
      default: return { state, handled: false };
    }
  }

  switch (keypress.key) {
    case "up": return { state: selectRelativeTask(state, -1), handled: true };
    case "down": return { state: selectRelativeTask(state, 1), handled: true };
    case "right": {
      const task = selectedTask(state.tasks);
      const subagent = task === undefined
        ? undefined
        : visibleSubagents(task, state.terminal.width, viewportHeight)[0];
      return task === undefined || subagent === undefined
        ? { state, handled: true }
        : { state: focusMainSubagent(state, task, subagent), handled: true };
    }
    case "home": return { state: selectTaskAt(state, 0), handled: true };
    case "end": return { state: selectTaskAt(state, state.tasks.cards.length - 1), handled: true };
    case "enter": {
      const task = selectedTask(state.tasks);
      return task === undefined
        ? { state, handled: true }
        : {
            state: {
              ...state,
              tasks: {
                ...state.tasks,
                inspectedTaskId: task.taskId,
                inspection: {
                  followLive: true,
                  ...(task.subagents[0] === undefined
                    ? {}
                    : { selectedSubagentStepId: task.subagents[0].stepId }),
                },
                scrollOffset: 0,
              },
              ...(task.subagents[0] === undefined
                ? {}
                : { focus: setFocus(state.focus, {
                    kind: "taskSubagent",
                    taskId: task.taskId,
                    stepId: task.subagents[0].stepId,
                  }) }),
            },
            handled: true
          };
    }
    case "escape":
    case "tab": return {
      state: { ...state, focus: setFocus(state.focus, { kind: "prompt" }) },
      handled: true,
    };
    default: return { state, handled: false };
  }
}

export function routeTaskSurfacePointer(
  state: OperatorConsoleState,
  action: TaskSurfacePointerAction,
  viewportHeight: number = state.terminal.height
): OperatorConsoleState {
  if (action.type === "back") {
    const card = inspectedTask(state.tasks);
    return state.tasks.inspection?.inspectedSubagentStepId !== undefined && card !== undefined
      ? closeSubagentInspection(state, card)
      : closeInspection(state);
  }
  if (action.type === "openTask") {
    const card = state.tasks.cards.find((candidate) => candidate.taskId === action.taskId);
    if (card === undefined) return state;
    return {
      ...state,
      tasks: {
        ...state.tasks,
        selectedTaskId: card.taskId,
        inspectedTaskId: card.taskId,
        inspection: {
          followLive: true,
          ...(card.subagents[0] === undefined ? {} : { selectedSubagentStepId: card.subagents[0].stepId }),
        },
        scrollOffset: 0,
      },
      focus: card.subagents[0] === undefined
        ? setFocus(state.focus, { kind: "taskCard", taskId: card.taskId })
        : setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId: card.subagents[0].stepId }),
    };
  }
  if (action.type === "openSubagent") {
    const card = state.tasks.cards.find((candidate) => candidate.taskId === action.taskId);
    const subagent = card?.subagents.find((candidate) => candidate.stepId === action.stepId);
    if (card === undefined || subagent === undefined) return state;
    return {
      ...state,
      tasks: {
        ...state.tasks,
        selectedTaskId: card.taskId,
        inspectedTaskId: card.taskId,
        inspection: {
          followLive: true,
          selectedSubagentStepId: subagent.stepId,
          inspectedSubagentStepId: subagent.stepId,
          subagentTrace: { followLive: true },
        },
        scrollOffset: 0,
      },
      focus: setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId: subagent.stepId }),
    };
  }
  const card = inspectedTask(state.tasks);
  if (card === undefined) return state;
  if (action.type === "scroll") {
    const contentHeight = Math.max(1, dimension(viewportHeight) - 2);
    const subagent = card.subagents.find((candidate) =>
      candidate.stepId === state.tasks.inspection?.inspectedSubagentStepId
    );
    const content = subagent === undefined
      ? taskOverviewContentLines(card, state.terminal.width, {
          locale: state.locale,
          style: state.style,
          inspection: state.tasks.inspection,
        })
      : subagentInspectionContentLines(card, subagent, state.terminal.width, {
          locale: state.locale,
          style: state.style,
          inspection: state.tasks.inspection,
        });
    return setTaskScroll(
      state,
      state.tasks.scrollOffset + action.delta,
      Math.max(0, content.length - contentHeight)
    );
  }
  if (action.type === "returnToLive") {
    if (action.scope === "task") return setTaskTraceSelection(state, card, "end");
    const subagent = card.subagents.find((candidate) =>
      candidate.stepId === state.tasks.inspection?.inspectedSubagentStepId
    );
    return subagent === undefined ? state : setSubagentTraceSelection(state, subagent, "end");
  }
  if (action.scope === "task") {
    if (!card.trace.events.some((event) => event.eventId === action.eventId)) return state;
    const { selectedTraceEventId: _selectedTraceEventId, ...inspection } = state.tasks.inspection ?? { followLive: true };
    return {
      ...state,
      tasks: {
        ...state.tasks,
        inspection: { ...inspection, followLive: false, selectedTraceEventId: action.eventId },
      },
    };
  }
  const subagent = card.subagents.find((candidate) =>
    candidate.stepId === state.tasks.inspection?.inspectedSubagentStepId
  );
  if (subagent === undefined || !subagent.trace.some((event) => event.eventId === action.eventId)) return state;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: {
        ...(state.tasks.inspection ?? { followLive: true }),
        subagentTrace: { followLive: false, selectedTraceEventId: action.eventId },
      },
    },
  };
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
  const scrollOffset = Math.max(0, Math.min(maxOffset, offset));
  if (scrollOffset === state.tasks.scrollOffset) return state;
  return { ...state, tasks: { ...state.tasks, scrollOffset } };
}

function setTaskTraceSelection(
  state: OperatorConsoleState,
  card: TaskCardState,
  action: TraceNavigationAction
): OperatorConsoleState {
  const { selectedTraceEventId: _selectedTraceEventId, ...inspection } = state.tasks.inspection ?? { followLive: true };
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: {
        ...inspection,
        ...navigateActivityTrace(card.trace.events, state.tasks.inspection, action, state.terminal.width),
      },
      scrollOffset: 0,
    }
  };
}

function setSubagentTraceSelection(
  state: OperatorConsoleState,
  subagent: TaskCardSubagentState,
  action: TraceNavigationAction
): OperatorConsoleState {
  const trace = navigateActivityTrace(
    subagent.trace,
    state.tasks.inspection?.subagentTrace,
    action,
    state.terminal.width
  );
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: {
        ...(state.tasks.inspection ?? { followLive: true }),
        subagentTrace: trace,
      },
      scrollOffset: 0,
    },
  };
}

function selectRelativeSubagent(
  state: OperatorConsoleState,
  card: TaskCardState,
  delta: number,
  viewportHeight: number
): OperatorConsoleState {
  if (card.subagents.length === 0) return state;
  const selectedStepId = state.tasks.inspection?.selectedSubagentStepId;
  const currentIndex = Math.max(0, card.subagents.findIndex((subagent) => subagent.stepId === selectedStepId));
  const index = Math.max(0, Math.min(card.subagents.length - 1, currentIndex + delta));
  const subagent = card.subagents[index]!;
  const next = {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: {
        ...(state.tasks.inspection ?? { followLive: true }),
        selectedSubagentStepId: subagent.stepId,
      },
    },
    focus: setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId: subagent.stepId }),
  };
  return ensureOverviewSubagentVisible(next, card, subagent, viewportHeight);
}

function openSelectedSubagent(state: OperatorConsoleState, card: TaskCardState): OperatorConsoleState {
  const selectedStepId = state.tasks.inspection?.selectedSubagentStepId ?? card.subagents[0]?.stepId;
  const subagent = card.subagents.find((candidate) => candidate.stepId === selectedStepId);
  if (subagent === undefined) return state;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      inspection: {
        ...(state.tasks.inspection ?? { followLive: true }),
        selectedSubagentStepId: subagent.stepId,
        inspectedSubagentStepId: subagent.stepId,
        subagentTrace: { followLive: true },
      },
      scrollOffset: 0,
    },
    focus: setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId: subagent.stepId }),
  };
}

function closeSubagentInspection(state: OperatorConsoleState, card: TaskCardState): OperatorConsoleState {
  const stepId = state.tasks.inspection?.inspectedSubagentStepId;
  if (stepId === undefined) return state;
  const {
    inspectedSubagentStepId: _inspectedSubagentStepId,
    subagentTrace: _subagentTrace,
    ...inspection
  } = state.tasks.inspection ?? { followLive: true };
  return {
    ...state,
    tasks: { ...state.tasks, inspection, scrollOffset: 0 },
    focus: setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId }),
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
  if (
    state.tasks.selectedTaskId === task.taskId &&
    state.focus.target.kind === "taskCard" &&
    state.focus.target.taskId === task.taskId
  ) return state;
  return {
    ...state,
    tasks: { ...state.tasks, selectedTaskId: task.taskId },
    focus: setFocus(state.focus, { kind: "taskCard", taskId: task.taskId }),
  };
}

function visibleSubagentGrid(card: TaskCardState, width: number, height: number): SubagentGrid {
  if (activeParentSynthesisStep(card) !== undefined) {
    return resolveCollapsedSynthesisLayout(card, dimension(width), dimension(height)).grid;
  }
  const grid = resolveSubagentGrid(card.subagents.length, dimension(width));
  const fitted = fitSubagentGridToHeight(grid, card.subagents.length, dimension(height));
  if (fitted.rows > 0) return fitted;
  const visibleCount = Math.min(card.subagents.length, Math.max(0, dimension(height) - 1));
  return { columns: 1, rows: Math.max(1, visibleCount), hiddenCount: card.subagents.length - visibleCount };
}

function visibleSubagents(card: TaskCardState, width: number, height: number): readonly TaskCardSubagentState[] {
  const normalizedHeight = dimension(height);
  if (activeParentSynthesisStep(card) !== undefined) {
    const layout = resolveCollapsedSynthesisLayout(card, dimension(width), normalizedHeight);
    return card.subagents.slice(0, layout.visibleCount);
  }
  const grid = resolveSubagentGrid(card.subagents.length, dimension(width));
  const fitted = fitSubagentGridToHeight(grid, card.subagents.length, normalizedHeight);
  const visibleCount = fitted.rows > 0
    ? Math.min(card.subagents.length, fitted.columns * fitted.rows)
    : Math.min(card.subagents.length, Math.max(0, normalizedHeight - 1));
  return card.subagents.slice(0, visibleCount);
}

function focusTaskHeader(state: OperatorConsoleState, card: TaskCardState): OperatorConsoleState {
  if (
    state.tasks.selectedTaskId === card.taskId &&
    state.focus.target.kind === "taskCard" &&
    state.focus.target.taskId === card.taskId
  ) return state;
  return {
    ...state,
    tasks: { ...state.tasks, selectedTaskId: card.taskId },
    focus: setFocus(state.focus, { kind: "taskCard", taskId: card.taskId }),
  };
}

function focusMainSubagent(
  state: OperatorConsoleState,
  card: TaskCardState,
  subagent: TaskCardSubagentState
): OperatorConsoleState {
  if (
    state.tasks.selectedTaskId === card.taskId &&
    state.focus.target.kind === "taskSubagent" &&
    state.focus.target.taskId === card.taskId &&
    state.focus.target.stepId === subagent.stepId
  ) return state;
  return {
    ...state,
    tasks: { ...state.tasks, selectedTaskId: card.taskId },
    focus: setFocus(state.focus, { kind: "taskSubagent", taskId: card.taskId, stepId: subagent.stepId }),
  };
}

function openMainSubagent(
  state: OperatorConsoleState,
  card: TaskCardState,
  subagent: TaskCardSubagentState
): OperatorConsoleState {
  return {
    ...focusMainSubagent(state, card, subagent),
    tasks: {
      ...state.tasks,
      selectedTaskId: card.taskId,
      inspectedTaskId: card.taskId,
      inspection: {
        followLive: true,
        selectedSubagentStepId: subagent.stepId,
        inspectedSubagentStepId: subagent.stepId,
        subagentTrace: { followLive: true },
      },
      scrollOffset: 0,
    },
  };
}

function ensureOverviewSubagentVisible(
  state: OperatorConsoleState,
  card: TaskCardState,
  subagent: TaskCardSubagentState,
  viewportHeight: number
): OperatorConsoleState {
  const contentHeight = Math.max(1, dimension(viewportHeight) - 2);
  const lines = taskOverviewContentLines(card, state.terminal.width, {
    locale: state.locale,
    style: state.style,
    inspection: state.tasks.inspection,
  });
  const selectedRow = lines.findIndex((line) => line.includes(subagent.displayLabel));
  if (selectedRow < 0) return state;
  const maxOffset = Math.max(0, lines.length - contentHeight);
  const currentOffset = Math.max(0, Math.min(maxOffset, state.tasks.scrollOffset));
  const nextOffset = selectedRow < currentOffset
    ? selectedRow
    : selectedRow >= currentOffset + contentHeight
      ? selectedRow - contentHeight + 1
      : currentOffset;
  return setTaskScroll(state, nextOffset, maxOffset);
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
  readonly focusedSubagentStepId?: string;
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
};

type CollapsedSynthesisLayout = {
  readonly grid: SubagentGrid;
  readonly workerTop: number;
  readonly visibleCount: number;
};

function activeParentSynthesisStep(card: TaskCardState): TaskCardStepState | undefined {
  if (card.subagents.length === 0 || !card.subagents.every((subagent) => isSettledSubagent(subagent.status))) {
    return undefined;
  }
  return card.steps.find((step) =>
    step.executorRole === "synthesis" &&
    (step.status === "ready" ||
      step.status === "running" ||
      step.status === "waiting_for_input" ||
      step.status === "waiting_for_approval")
  );
}

function collapsedSubagentGridHeight(grid: SubagentGrid): number {
  if (grid.rows === 0) return grid.hiddenCount > 0 ? 1 : 0;
  return grid.rows * COLLAPSED_SUBAGENT_CARD_HEIGHT +
    Math.max(0, grid.rows - 1) * COLLAPSED_SUBAGENT_ROW_GAP +
    (grid.hiddenCount > 0 ? 1 : 0);
}

function fitCollapsedSubagentGridToHeight(
  grid: SubagentGrid,
  count: number,
  height: number
): SubagentGrid {
  for (let rows = grid.rows; rows > 0; rows -= 1) {
    const hiddenCount = Math.max(0, count - rows * grid.columns);
    const candidate = { columns: grid.columns, rows, hiddenCount };
    if (collapsedSubagentGridHeight(candidate) <= height) return candidate;
  }
  return { columns: grid.columns, rows: 0, hiddenCount: count };
}

function resolveCollapsedSynthesisLayout(
  card: TaskCardState,
  width: number,
  height: number
): CollapsedSynthesisLayout {
  const stageHeight = Math.min(PARENT_SYNTHESIS_STAGE_HEIGHT, Math.max(0, height - 1));
  const remaining = Math.max(0, height - 1 - stageHeight);
  const hasStageGap = remaining > PARENT_SYNTHESIS_STAGE_GAP;
  const workerTop = 1 + stageHeight + (hasStageGap ? PARENT_SYNTHESIS_STAGE_GAP : 0);
  const workerHeight = hasStageGap ? remaining - PARENT_SYNTHESIS_STAGE_GAP : 0;
  const grid = fitCollapsedSubagentGridToHeight(
    resolveSubagentGrid(card.subagents.length, width),
    card.subagents.length,
    workerHeight
  );
  return {
    grid,
    workerTop,
    visibleCount: Math.min(card.subagents.length, grid.rows * grid.columns),
  };
}

function renderParentSynthesisTaskSurface(
  card: TaskCardState,
  synthesis: TaskCardStepState,
  header: string,
  copy: TaskCopy,
  options: TaskCardRenderOptions,
  width: number,
  height: number
): readonly string[] {
  const stageHeight = Math.min(PARENT_SYNTHESIS_STAGE_HEIGHT, Math.max(0, height - 1));
  const rows: string[] = [padVisibleEnd(truncateVisible(header, width, "…"), width)];
  rows.push(...renderParentSynthesisStage(card, synthesis, copy, options, width, stageHeight));
  const layout = resolveCollapsedSynthesisLayout(card, width, height);
  if (layout.workerTop > rows.length) rows.push("".padEnd(width));
  const visibleSubagents = card.subagents.slice(0, layout.visibleCount);
  const columnWidth = resolveEqualColumnWidth(width, layout.grid.columns);
  for (let rowIndex = 0; rowIndex < layout.grid.rows; rowIndex += 1) {
    if (rowIndex > 0) rows.push("".padEnd(width));
    const summaries = Array.from({ length: layout.grid.columns }, (_, columnIndex) => {
      const subagent = visibleSubagents[columnIndex * layout.grid.rows + rowIndex];
      if (subagent === undefined) return "".padEnd(columnWidth);
      const summary = `${formatSubagentTitle(
        subagent,
        options,
        options.focusedSubagentStepId === subagent.stepId
      )} · ${formatSubagentFooter(subagent, copy, options)}`;
      const background = options.style?.tokens.contract.surface.bgElevated ?? "";
      return styleBackgroundRow(options.style, ` ${summary}`, columnWidth, background);
    });
    rows.push(padVisibleEnd(truncateVisible(
      summaries.join(" ".repeat(SUBAGENT_COLUMN_GAP)),
      width,
      "…"
    ), width));
  }
  const hiddenCount = card.subagents.length - visibleSubagents.length;
  if (hiddenCount > 0 && rows.length < height) rows.push(`+${hiddenCount} ${copy.moreSubagents}`);
  return padSurfaceRows(rows, height, width);
}

function renderParentSynthesisStage(
  card: TaskCardState,
  synthesis: TaskCardStepState,
  copy: TaskCopy,
  options: TaskCardRenderOptions,
  width: number,
  height: number
): readonly string[] {
  if (height === 0) return [];
  const style = options.style;
  const tokens = style?.tokens.contract;
  const attempt = synthesis.activeAttempt ?? synthesis.latestAttempt;
  const symbol = parentSynthesisStatusSymbol(synthesis, style, options.motionElapsedMs);
  const title = tokens === undefined
    ? copy.parentSynthesis
    : styleColor(style, styleBold(style, copy.parentSynthesis), tokens.palette.brand);
  const description = styleSecondary(style, conciseSubagentTitle(synthesis.title));
  const workerProgress = card.phase.workerProgress;
  const progressText = workerProgress === undefined
    ? undefined
    : workerProgress.completed === workerProgress.total
      ? copy.delegatedStepsCompleted(workerProgress.completed, workerProgress.total)
      : copy.delegatedStepsSettled(workerProgress.settled, workerProgress.total);
  const titleRow = [`${symbol} ${title}`, description, progressText]
    .filter((value): value is string => value !== undefined)
    .join(` ${styleMuted(style, "·")} `);
  const resultCount = card.subagents.filter((subagent) => subagent.status === "completed").length;
  const headlineText = parentSynthesisHeadline(synthesis, resultCount, copy);
  const currentActivity = semanticParentSynthesisActivityLabel(
    attempt?.currentActivity,
    traceCategoryForTool(attempt?.currentToolCategory),
    synthesis
  );
  const headline = [headlineText, currentActivity]
    .filter((value): value is string => value !== undefined)
    .join(` ${styleMuted(style, "·")} `);
  const headlineColor = synthesis.status === "waiting_for_input" || synthesis.status === "waiting_for_approval"
    ? tokens?.palette.caution
    : tokens?.palette.action;
  const styledHeadline = headlineColor === undefined ? headline : styleColor(style, headline, headlineColor);
  const traceEvents = card.trace.events.flatMap((event) => {
    if (event.stepId !== synthesis.stepId || !isMainCardActivityEvent(event)) return [];
    const label = semanticParentSynthesisActivityLabel(event.label, event.category, synthesis);
    return label === undefined ? [] : [{ ...event, label }];
  });
  const traceCard: TaskCardState = {
    ...card,
    subagents: [],
    trace: { events: traceEvents, hasEarlierEvents: false },
    recentActivity: traceEvents.slice(-12).reverse(),
  };
  const traceRows = renderActivityTraceSurface(traceCard, { followLive: true }, {
    width,
    locale: options.locale,
    style,
  });
  const paddedTraceRows = Array.from({ length: 4 }, (_, index) => traceRows[index] ?? "");
  const usage = attempt?.usage ?? synthesis.usage;
  const elapsedMs = attempt?.elapsedMs ?? 0;
  const status = styleParentSynthesisStatus(formatSubagentStatus(synthesis.status), synthesis.status, style);
  const footer = `${status} ${styleMuted(style, `· ${formatDuration(elapsedMs)} · ${formatCompactTokenCount(usage.totalTokens)} ${copy.tokens} · ${formatCardUsage(usage, options.locale ?? "en")}`)}`;
  const fullRows = [titleRow, styledHeadline, ...paddedTraceRows, footer];
  if (height === 1) return [padVisibleEnd(truncateVisible(titleRow, width, "…"), width)];
  const fittedRows = height >= fullRows.length
    ? fullRows
    : [titleRow, ...fullRows.slice(1, Math.max(1, height - 1)), footer];
  return padSurfaceRows(fittedRows.slice(0, height), height, width);
}

function formatTaskHeader(
  card: TaskCardState,
  state: TaskSurfaceState,
  copy: TaskCopy,
  focused: boolean,
  style: OperatorConsoleStyle | undefined
): string {
  const taskPosition = `${state.cards.indexOf(card) + 1}/${state.cards.length}`;
  const workerProgress = card.phase.workerProgress;
  const title = `${workerProgress === undefined ? copy.task : copy.delegatedTask} ${taskPosition}`;
  const tokens = style?.tokens.contract;
  const titleColor = focused ? tokens?.palette.action : tokens?.palette.brand;
  const styledTitle = titleColor === undefined
    ? title
    : styleColor(style, styleBold(style, title), titleColor);
  const rail = focused ? tokens?.glyph.progress.thumb ?? ">" : " ";
  const styledRail = focused && tokens !== undefined
    ? styleColor(style, rail, tokens.palette.action)
    : rail;
  const mouseHint = state.mouseModeActive === true
    ? copy.mouseActiveHint
    : workerProgress === undefined
      ? copy.mouseToggleHint
      : "Ctrl+G";
  const styledMouseHint = state.mouseModeActive === true && tokens !== undefined
    ? styleColor(style, styleBold(style, mouseHint), tokens.palette.action)
    : styleMuted(style, mouseHint);
  const separator = styleMuted(style, "·");
  const taskId = styleMuted(style, isolate(formatTaskDisplayId(card.taskId)));
  const phase = styleMuted(style, copy.phaseLabel(card.phase.name));
  const progressText = workerProgress === undefined
    ? `${card.progress.completed + card.progress.skipped} of ${card.progress.total} ${copy.stepsSettled}`
    : copy.delegatedProgressCompact(workerProgress.completed, workerProgress.settled, workerProgress.total);
  const progress = styleMuted(style, progressText);
  if (workerProgress === undefined) {
    return `${styledRail} ${styledTitle} ${separator} ${taskId} ${separator} ${styledMouseHint} ${separator} ${card.objective} ${separator} ${progress}`;
  }
  return `${styledRail} ${styledTitle} ${separator} ${taskId} ${separator} ${phase} ${separator} ${progress} ${separator} ${styledMouseHint} ${separator} ${card.objective}`;
}

function localizedArabicTaskPhase(phase: TaskCardState["phase"]["name"]): string {
  switch (phase) {
    case "planning": return "قيد التخطيط";
    case "queued": return "في قائمة الانتظار";
    case "running": return "قيد التنفيذ";
    case "delegating": return "يتم تنفيذ العمل المفوض";
    case "synthesizing": return "يتم تجميع النتائج";
    case "waiting_for_host": return "بانتظار مضيف";
    case "waiting_for_input": return "بانتظار إدخال";
    case "waiting_for_approval": return "بانتظار الموافقة";
    case "paused": return "متوقفة مؤقتاً";
    case "completed": return "مكتملة";
    case "partial": return "مكتملة جزئياً";
    case "failed": return "فشلت";
    case "cancelled": return "ملغاة";
  }
}

function formatTaskDisplayId(taskId: string): string {
  const uuid = taskId.match(/^([A-Za-z][A-Za-z0-9_-]{0,15}[_-])?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  if (uuid !== null) return `${uuid[1] ?? ""}${uuid[2]}`;
  return taskId;
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
  options: TaskCardRenderOptions,
  focused: boolean
): readonly string[] {
  const activity = subagentActivityRows(subagent);
  const title = formatSubagentTitle(subagent, options, focused);
  const history = formatSubagentHistoryCount(activity.hiddenCount, copy, options.style);
  const footer = formatSubagentFooter(subagent, copy, options);
  const background = options.style?.tokens.contract.surface.bgElevated ?? "";
  const contentRows = isSettledSubagent(subagent.status)
    ? [
        formatSettledSubagentState(subagent, copy, options.style),
        ...formatSettledSubagentSummary(subagent, copy, Math.max(1, width - 3), options.style),
      ]
    : [
        ...formatRunningSubagentActivity(activity.rows, copy, options.style),
        formatSubagentPreview(subagent, options.style),
      ];
  return [title, history, ...contentRows, footer]
    .map((row) => styleBackgroundRow(options.style, ` ${row}`, width, background));
}

function formatRunningSubagentActivity(
  activity: readonly SubagentActivityRow[],
  copy: TaskCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const visibleActivity = activity.slice(0, SUBAGENT_ACTIVITY_ROWS);
  return Array.from({ length: SUBAGENT_ACTIVITY_ROWS }, (_, index) => {
    const row = visibleActivity[index];
    if (row !== undefined) return formatSubagentActivity(row, style);
    if (index === 0) return styleMuted(style, copy.waitingForActivity);
    return "";
  });
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
    const focused = options.focusedSubagentStepId === subagent.stepId;
    const tokens = options.style?.tokens.contract;
    const rail = focused ? tokens?.glyph.progress.thumb ?? ">" : " ";
    const styledRail = focused && tokens !== undefined
      ? styleColor(options.style, rail, tokens.palette.action)
      : rail;
    const titleColor = focused ? tokens?.palette.action : tokens?.palette.accent;
    const title = titleColor === undefined
      ? subagent.displayLabel
      : styleColor(options.style, styleBold(options.style, subagent.displayLabel), titleColor);
    const status = styleSubagentStatus(formatSubagentStatus(subagent.status), subagent.status, options.style);
    const metadata = styleMuted(options.style, `· ${formatDuration(subagent.elapsedMs)} · ${formatCompactTokenCount(usage.totalTokens)} ${copy.tokens} · ${formatCardUsage(usage, options.locale ?? "en")}`);
    const summary = `${styledRail} ${title} · ${status} ${metadata}`;
    rows.push(summary);
  }
  const hiddenCount = Math.max(0, card.subagents.length - visible.length);
  if (hiddenCount > 0 && rows.length > 1) rows[rows.length - 1] = `+${hiddenCount} ${copy.moreSubagents}`;
  return padSurfaceRows(rows, height, width);
}

function formatSubagentTitle(
  subagent: TaskCardSubagentState,
  options: TaskCardRenderOptions,
  focused: boolean
): string {
  const style = options.style;
  const tokens = style?.tokens.contract;
  const symbol = subagentStatusSymbol(subagent, style, options.motionElapsedMs);
  const titleColor = focused ? tokens?.palette.action : tokens?.palette.accent;
  const styledLabel = titleColor === undefined
    ? subagent.displayLabel
    : styleColor(style, styleBold(style, subagent.displayLabel), titleColor);
  const separator = styleMuted(style, "·");
  const displayTitle = isGenericDelegatedTitle(subagent.title)
    ? subagent.objective
    : subagent.title;
  const description = styleSecondary(style, conciseSubagentTitle(displayTitle));
  const rail = focused ? tokens?.glyph.progress.thumb ?? ">" : " ";
  const styledRail = focused && tokens !== undefined
    ? styleColor(style, rail, tokens.palette.action)
    : rail;
  return `${styledRail} ${symbol} ${styledLabel} ${separator} ${description}`;
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

function parentSynthesisStatusSymbol(
  synthesis: TaskCardStepState,
  style: OperatorConsoleStyle | undefined,
  motionElapsedMs: number | undefined
): string {
  const tokens = style?.tokens.contract;
  if (synthesis.status === "ready" || synthesis.status === "running") {
    if (tokens === undefined) return ">";
    const motion = tokens.motion.worker;
    const elapsed = tokens.behavior.allowAnimation ? motionElapsedMs : 0;
    return styleColor(style, semanticMotionFrame(motion, elapsed, synthesis.position * 2), motion.color);
  }
  if (synthesis.status === "waiting_for_input" || synthesis.status === "waiting_for_approval") {
    return tokens === undefined ? "!" : styleColor(style, "!", tokens.palette.caution);
  }
  return tokens === undefined ? "." : styleColor(style, tokens.glyph.bullet, tokens.text.muted);
}

function parentSynthesisHeadline(
  synthesis: TaskCardStepState,
  subagentCount: number,
  copy: TaskCopy
): string {
  if (synthesis.status === "waiting_for_input") return copy.synthesisWaitingForInput;
  if (synthesis.status === "waiting_for_approval") return copy.synthesisWaitingForApproval;
  return synthesis.status === "ready"
    ? copy.preparingSynthesis(subagentCount)
    : copy.synthesizingResults(subagentCount);
}

function semanticParentSynthesisActivityLabel(
  value: string | undefined,
  category: TaskCardActivityState["category"],
  synthesis: TaskCardStepState
): string | undefined {
  let label = normalizeCardText(value);
  if (label === undefined) return undefined;
  for (const suffix of [` · ${synthesis.title}`, ` · ${synthesis.objective}`]) {
    if (label.endsWith(suffix)) label = label.slice(0, -suffix.length).trimEnd();
  }
  if (/^Attempt waiting$/iu.test(label)) return "Waiting for input";
  if (/^(?:Worker (?:started|finished)|Starting delegated work|Result ready|Step status changed|Usage recorded|Attempt (?:queued|started|completed|checkpointed|failed|cancelled|interrupted|lease expired)|Worker assigned|Result recorded)$/iu.test(label)) {
    return undefined;
  }
  if (/^(?:Tool activity|Read|Search|Edit|Terminal command) (?:started|finished)$/iu.test(label)) {
    return semanticGenericActivity(category, /finished$/iu.test(label));
  }
  return label;
}

function subagentActivityRows(subagent: TaskCardSubagentState): {
  readonly rows: readonly SubagentActivityRow[];
  readonly hiddenCount: number;
} {
  const rows: SubagentActivityRow[] = [];
  const seen = new Set<string>();
  const currentActivity = semanticSubagentActivityLabel(
    subagent.currentActivity ?? subagent.activeAttempt?.currentActivity,
    traceCategoryForTool(subagent.currentToolCategory ?? subagent.activeAttempt?.currentToolCategory),
    subagent
  );
  if (currentActivity !== undefined) {
    rows.push({
      label: currentActivity,
      category: traceCategoryForTool(subagent.currentToolCategory ?? subagent.activeAttempt?.currentToolCategory),
      live: true,
    });
    seen.add(currentActivity.toLocaleLowerCase());
  }
  for (const event of [...subagent.trace].reverse()) {
    if (!isMainCardActivityEvent(event) || event.category === "answer") continue;
    const label = semanticSubagentActivityLabel(event.label, event.category, subagent);
    if (label === undefined || seen.has(label.toLocaleLowerCase())) continue;
    rows.push({ label, category: event.category, live: false });
    seen.add(label.toLocaleLowerCase());
  }
  return {
    rows,
    hiddenCount: Math.max(0, rows.length - SUBAGENT_ACTIVITY_ROWS),
  };
}

function isMainCardActivityEvent(event: TaskCardActivityState): boolean {
  switch (event.kind) {
    case "task-created":
    case "task-state-changed":
    case "plan-revision-created":
    case "plan-revision-validated":
    case "plan-revision-activated":
    case "plan-revision-rejected":
    case "plan-revision-superseded":
    case "step-state-changed":
    case "attempt-created":
    case "attempt-leased":
    case "attempt-started":
    case "attempt-completed":
    case "attempt-failed":
    case "attempt-cancelled":
    case "attempt-interrupted":
    case "attempt-expired":
    case "usage-recorded":
    case "result-recorded":
      return false;
    default:
      return true;
  }
}

function semanticSubagentActivityLabel(
  value: string | undefined,
  category: TaskCardActivityState["category"],
  subagent: TaskCardSubagentState
): string | undefined {
  let label = normalizeCardText(value);
  if (label === undefined) return undefined;
  for (const suffix of [` · ${subagent.title}`, ` · ${subagent.objective}`]) {
    if (label.endsWith(suffix)) label = label.slice(0, -suffix.length).trimEnd();
  }
  if (/^Attempt waiting$/iu.test(label)) return "Waiting for input";
  if (/^(?:Worker (?:started|finished)|Starting delegated work|Result ready|Step status changed|Usage recorded|Attempt (?:queued|started|completed|checkpointed|failed|cancelled|interrupted|lease expired)|Worker assigned|Result recorded)$/iu.test(label)) {
    return undefined;
  }
  if (/^(?:Tool activity|Read|Search|Edit|Terminal command) (?:started|finished)$/iu.test(label)) {
    return semanticGenericActivity(category, /finished$/iu.test(label));
  }
  return label;
}

function semanticGenericActivity(category: TaskCardActivityState["category"], finished: boolean): string {
  switch (category) {
    case "terminal": return finished ? "Command completed" : "Running command";
    case "search": return finished ? "Search completed" : "Searching";
    case "read": return finished ? "Files reviewed" : "Reading files";
    case "edit": return finished ? "Changes written" : "Writing changes";
    case "wait": return "Waiting for input";
    case "failed": return "Activity failed";
    default: return finished ? "Inspection completed" : "Inspecting task context";
  }
}

function formatSubagentHistoryCount(
  hiddenCount: number,
  copy: TaskCopy,
  style: OperatorConsoleStyle | undefined
): string {
  if (hiddenCount <= 0) return "";
  const glyph = style?.tokens.contract.glyph.continuation ?? "...";
  return styleMuted(style, `${glyph} +${hiddenCount} ${copy.earlierActivities}`);
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

function formatSubagentPreview(
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
  return "";
}

function formatSettledSubagentState(
  subagent: TaskCardSubagentState,
  copy: TaskCopy,
  style: OperatorConsoleStyle | undefined
): string {
  const successful = subagent.status === "completed";
  const label = successful
    ? copy.resultReady
    : subagent.status === "skipped" ? formatSubagentStatus(subagent.status) : copy.resultUnavailable;
  const tokens = style?.tokens.contract;
  const glyph = successful
    ? tokens?.glyph.trace.event ?? ">"
    : tokens?.glyph.cross ?? "!";
  const color = successful ? tokens?.severity.ok : tokens?.severity.error;
  return `${color === undefined ? glyph : styleColor(style, glyph, color)} ${label}`;
}

function formatSettledSubagentSummary(
  subagent: TaskCardSubagentState,
  copy: TaskCopy,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const rawResultSummary =
    subagent.results.find((result) => result.primary && result.disposition === "accepted")?.summary ??
    subagent.results.find((result) => result.disposition === "accepted")?.summary ??
    subagent.results.find((result) => result.primary)?.summary ??
    subagent.results.find((result) => result.summary !== undefined)?.summary;
  const summary = deriveTaskResultSummary(
    rawResultSummary,
    Math.max(24, width * SUBAGENT_ACTIVITY_ROWS - 6)
  ) ?? copy.noResultSummary;
  const wrapped = wrapText(summary, width);
  const visible = wrapped.slice(0, SUBAGENT_ACTIVITY_ROWS);
  return Array.from({ length: SUBAGENT_ACTIVITY_ROWS }, (_, index) => {
    const line = visible[index];
    return line === undefined ? "" : `  ${styleSecondary(style, line)}`;
  });
}

function formatSubagentFooter(
  subagent: TaskCardSubagentState,
  copy: TaskCopy,
  options: TaskCardRenderOptions
): string {
  const usage = subagent.usage.currentAttempt ?? subagent.usage.total;
  const status = styleSubagentStatus(formatSubagentStatus(subagent.status), subagent.status, options.style);
  const metadata = styleMuted(options.style, `· ${formatDuration(subagent.elapsedMs)} · ${formatCompactTokenCount(usage.totalTokens)} ${copy.tokens} · ${formatCardUsage(usage, options.locale ?? "en")}`);
  return `${status} ${metadata}`;
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

function styleParentSynthesisStatus(
  value: string,
  status: TaskCardStepState["status"],
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return value;
  if (status === "waiting_for_input" || status === "waiting_for_approval") {
    return styleColor(style, value, tokens.palette.caution);
  }
  if (status === "ready" || status === "running") return styleColor(style, value, tokens.palette.action);
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

function conciseSubagentTitle(value: string): string {
  const normalized = normalizeCardText(value) ?? "Subagent task";
  const words = normalized.split(" ");
  const wordLimited = words.length > MAX_SUBAGENT_TITLE_WORDS
    ? `${words.slice(0, MAX_SUBAGENT_TITLE_WORDS).join(" ").replace(/[.,;:!?]+$/u, "")}…`
    : normalized;
  return truncateVisible(wordLimited, MAX_SUBAGENT_TITLE_WIDTH, "…");
}

function isGenericDelegatedTitle(value: string): boolean {
  return /^Delegated work(?: \d+)?$/iu.test(value.trim());
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

function styleSecondary(style: OperatorConsoleStyle | undefined, value: string): string {
  const color = style?.tokens.contract.text.secondary;
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
