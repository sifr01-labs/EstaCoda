import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import {
  resolveActiveWorkCopy,
  type OperatorConsoleLocale,
} from "./activeWorkCopy.js";
import type {
  ActiveWorkItem,
  ActiveWorkItemStatus,
  ToolActivityState,
} from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type ActiveWorkSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: OperatorConsoleLocale;
  readonly style?: OperatorConsoleStyle;
};

export type ActiveWorkSummaryOptions = {
  readonly locale?: OperatorConsoleLocale;
  readonly includeActive?: boolean;
};

export const ACTIVE_WORK_STATUS_SYMBOLS: Readonly<Record<ActiveWorkItemStatus, string>> = {
  queued: "·",
  running: "◷",
  succeeded: "✓",
  failed: "✗",
  cancelled: "×",
  awaitingApproval: "!",
};

const LTR_ISOLATE_START = "\u2068";
const LTR_ISOLATE_END = "\u2069";
const TOOL_DETAIL_GAP_CELLS = 3;
const DURATION_DETAIL_GAP_CELLS = 3;
const ARABIC_DURATION_DETAIL_GAP_CELLS = 7;

export function hasActiveWork(state: ToolActivityState): boolean {
  return state.items.length > 0;
}

export function hasRunningDelegationWork(state: ToolActivityState): boolean {
  return state.items.some((item) =>
    item.source !== "subagent" &&
    item.toolName === "delegate_task" &&
    item.status === "running"
  );
}

export function sortActiveWorkItems(state: ToolActivityState): readonly ActiveWorkItem[] {
  return state.items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const priority = statusPriority(left.item.status) - statusPriority(right.item.status);
      return priority === 0 ? left.index - right.index : priority;
    })
    .map(({ item }) => item);
}

export function getActiveWorkSurfaceDesiredHeight(state: ToolActivityState): number {
  if (!hasActiveWork(state)) return 0;
  return Math.max(3, activeWorkItemsForLiveSurface(state).length + 2);
}

export function getCompletedActiveWorkSurfaceDesiredHeight(state: ToolActivityState): number {
  const durableItems = activeWorkItemsForCompletedSurface(state);
  if (durableItems.length === 0) return 0;
  return durableItems.length + 4;
}

export function renderActiveWorkSurface(
  state: ToolActivityState,
  options: ActiveWorkSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || !hasActiveWork(state)) return [];

  const height = normalizeDimension(options.height ?? getActiveWorkSurfaceDesiredHeight(state));
  if (height <= 0) return [];
  const copy = resolveActiveWorkCopy(options.locale);
  const liveItems = activeWorkItemsForLiveSurface(state);
  const liveTitle = hasRunningDelegationWork(state) ? copy.delegatedWork : copy.runningTools;
  if (height < 3) return [truncateVisibleCells(`${liveTitle}: ${liveItems.length}`, width)];

  const contentWidth = Math.max(0, width - 4);
  const contentRows = Math.max(1, height - 2);
  const visibleState = {
    ...state,
    items: liveItems,
  };
  const sorted = sortActiveWorkItems(visibleState);
  const title = formatActiveWorkTitle(
    liveTitle,
    state.startedAtMs === undefined ? undefined : formatClockDuration(resolveActiveWorkElapsedMs(state)),
    options.locale
  );

  return [
    renderTopBorder(title, width),
    ...renderActiveWorkContentRows(visibleState, sorted, contentRows, contentWidth, options.locale, options.style)
      .map((row) => renderContentRow(row, contentWidth, width)),
    renderBottomBorder(width),
  ];
}

export function renderCompletedActiveWorkSurface(
  state: ToolActivityState,
  options: ActiveWorkSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  const visibleState = {
    ...state,
    items: activeWorkItemsForCompletedSurface(state),
  };
  if (width <= 0 || !hasActiveWork(visibleState)) return [];

  const height = normalizeDimension(options.height ?? getCompletedActiveWorkSurfaceDesiredHeight(visibleState));
  if (height <= 0) return [];
  const copy = resolveActiveWorkCopy(options.locale);
  if (height < 3) return [truncateVisibleCells(formatActiveWorkSummary(visibleState, { locale: options.locale }), width)];

  const contentWidth = Math.max(0, width - 4);
  const contentRows = Math.max(1, height - 2);
  const visibleRows = renderCompletedActiveWorkContentRows(visibleState, contentRows, contentWidth, options.locale, options.style);

  return [
    renderTopBorder(copy.toolsCompleted, width),
    ...visibleRows.map((row) => renderContentRow(row, contentWidth, width)),
    renderBottomBorder(width),
  ];
}

export function formatActiveWorkSummary(
  state: ToolActivityState,
  options: ActiveWorkSummaryOptions = {}
): string {
  const copy = resolveActiveWorkCopy(options.locale);
  const activeCount = state.items.filter(isActiveStatusItem).length;
  const failedCount = state.items.filter((item) => item.status === "failed").length;
  const completedCount = state.items.filter((item) =>
    item.status === "succeeded" || item.status === "cancelled"
  ).length;
  const durationValue = formatClockDuration(resolveActiveWorkElapsedMs(state));
  const duration = options.locale === "ar"
    ? `${copy.duration} ${isolateIfNeeded(durationValue, options.locale)}`
    : `${copy.workedFor} ${durationValue}`;
  const parts = [
    `${formatNumber(completedCount)} ${copy.completed}`,
    `${formatNumber(failedCount)} ${copy.failed}`,
    duration,
  ];
  if (options.includeActive !== false || activeCount > 0) {
    parts.splice(1, 0, `${formatNumber(activeCount)} ${copy.active}`);
  }
  return parts.join(" · ");
}

export function formatLiveActiveWorkStatus(
  state: ToolActivityState,
  options: ActiveWorkSummaryOptions = {}
): string | undefined {
  if (!hasActiveWork(state) || state.completedAtMs !== undefined) return undefined;
  const visibleState = {
    ...state,
    items: activeWorkItemsForLiveSurface(state),
  };
  const copy = resolveActiveWorkCopy(options.locale);
  const activeCount = visibleState.items.filter(isActiveStatusItem).length;
  const doneCount = visibleState.items.filter((item) =>
    item.status === "succeeded" || item.status === "cancelled"
  ).length;
  const failedCount = visibleState.items.filter((item) => item.status === "failed").length;
  const durationValue = formatClockDuration(resolveActiveWorkElapsedMs(state));
  const parts = [
    `${formatNumber(activeCount)} ${copy.active}`,
    `${formatNumber(doneCount)} ${options.locale === "ar" ? copy.completed : "done"}`,
  ];
  if (failedCount > 0) {
    parts.push(`${formatNumber(failedCount)} ${copy.failed}`);
  }
  parts.push(isolateIfNeeded(durationValue, options.locale));
  return parts.join(" · ");
}

function activeWorkItemsForLiveSurface(state: ToolActivityState): readonly ActiveWorkItem[] {
  if (!hasRunningDelegationWork(state)) return state.items;
  const childItems = state.items.filter((item) => item.source === "subagent");
  if (childItems.length > 0) return childItems;
  return state.items.filter((item) =>
    item.source !== "subagent" && item.toolName === "delegate_task" && item.status === "running"
  );
}

function activeWorkItemsForCompletedSurface(state: ToolActivityState): readonly ActiveWorkItem[] {
  return state.items.filter((item) => item.source !== "subagent");
}

function renderCompletedActiveWorkContentRows(
  state: ToolActivityState,
  contentRows: number,
  contentWidth: number,
  locale: OperatorConsoleLocale | undefined,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const footer = formatCompletionFooterRows(state, contentWidth, locale);
  if (contentRows <= footer.length) return footer.slice(0, contentRows);

  const itemRows = Math.max(0, contentRows - footer.length);
  const visibleItems = state.items.slice(0, itemRows);
  const rows = visibleItems.map((item) => formatActiveWorkRow(item, state, contentWidth, locale, style));

  return [
    ...padRows(rows, itemRows),
    ...footer,
  ];
}

function formatCompletionFooterRows(
  state: ToolActivityState,
  contentWidth: number,
  locale: OperatorConsoleLocale | undefined
): readonly string[] {
  const summary = formatActiveWorkSummary(state, { locale, includeActive: false });
  return [truncateVisibleCells(summary, contentWidth)];
}

function renderActiveWorkContentRows(
  state: ToolActivityState,
  sortedItems: readonly ActiveWorkItem[],
  contentRows: number,
  contentWidth: number,
  locale: OperatorConsoleLocale | undefined,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const visibleItems = sortedItems.slice(0, contentRows);
  const rows = visibleItems.map((item) => formatActiveWorkRow(item, state, contentWidth, locale, style));
  return padRows(rows, contentRows);
}

function formatActiveWorkRow(
  item: ActiveWorkItem,
  state: ToolActivityState,
  contentWidth: number,
  locale: OperatorConsoleLocale | undefined,
  style: OperatorConsoleStyle | undefined
): string {
  const width = normalizeDimension(contentWidth);
  if (width <= 0) return "";

  const symbol = activeWorkStatusSymbol(item.status, state.frameIndex, style);
  const renderedTool = item.displayLabel ?? item.toolName;
  const rawTool = renderedTool.trim().length === 0 ? "tool" : renderedTool.trim();
  const rawDetail = (item.target ?? item.summary).trim();
  const duration = formatActiveWorkDuration(resolveDurationMs(item));

  if (locale === "ar") {
    return formatArabicActiveWorkRow({ symbol, rawTool, rawDetail, duration, width });
  }

  if (width <= 8) return truncateVisibleCells(`${symbol} ${rawTool}`, width);

  const prefixCells = stringWidth(symbol) + 1;
  const durationPartCells = width >= 16 ? stringWidth(duration) + DURATION_DETAIL_GAP_CELLS : 0;
  const availableMainCells = Math.max(0, width - prefixCells - durationPartCells);
  if (availableMainCells <= 0) return truncateVisibleCells(`${symbol} ${rawTool}`, width);

  const toolCells = Math.min(16, Math.max(1, Math.min(availableMainCells, Math.floor(availableMainCells * 0.35))));
  const detailGapCells = availableMainCells > toolCells ? Math.min(TOOL_DETAIL_GAP_CELLS, availableMainCells - toolCells) : 0;
  const detailCells = Math.max(0, availableMainCells - toolCells - detailGapCells);
  const tool = isolateIfNeeded(truncateVisibleCells(rawTool, toolCells), locale);
  const detail = isolateIfNeeded(truncateVisibleCells(rawDetail, detailCells), locale);
  const detailGap = " ".repeat(detailGapCells);
  const left = `${symbol} ${padVisibleEnd(tool, toolCells)}${detailGapCells > 0 ? `${detailGap}${padVisibleEnd(detail, detailCells)}` : ""}`;

  if (durationPartCells === 0) return truncateVisibleCells(left, width);
  const row = `${left}${" ".repeat(DURATION_DETAIL_GAP_CELLS)}${isolateIfNeeded(duration, locale)}`;
  return truncateVisibleCells(row, width);
}

function formatArabicActiveWorkRow(input: {
  readonly symbol: string;
  readonly rawTool: string;
  readonly rawDetail: string;
  readonly duration: string;
  readonly width: number;
}): string {
  const { symbol, rawTool, rawDetail, duration, width } = input;
  if (width <= 8) return truncateVisibleCells(`${rawTool} ${symbol}`, width);

  const durationPartCells = width >= 16 ? stringWidth(duration) + ARABIC_DURATION_DETAIL_GAP_CELLS : 0;
  const availableMainCells = Math.max(0, width - durationPartCells);
  if (availableMainCells <= 0) return truncateVisibleCells(`${rawTool} ${symbol}`, width);

  const actionCells = Math.min(18, Math.max(1, Math.min(availableMainCells, Math.floor(availableMainCells * 0.35))));
  const symbolCells = stringWidth(symbol);
  const actionGapCells = actionCells > symbolCells ? 1 : 0;
  const toolCells = Math.max(0, actionCells - symbolCells - actionGapCells);
  const detailGapCells = availableMainCells > actionCells ? Math.min(TOOL_DETAIL_GAP_CELLS, availableMainCells - actionCells) : 0;
  const detailCells = Math.max(0, availableMainCells - actionCells - detailGapCells);
  const durationPart = durationPartCells === 0
    ? ""
    : `${isolateIfNeeded(duration, "ar")}${" ".repeat(ARABIC_DURATION_DETAIL_GAP_CELLS)}`;
  const detail = detailCells <= 0
    ? ""
    : padVisibleEnd(isolateIfNeeded(truncateVisibleCells(rawDetail, detailCells), "ar"), detailCells);
  const tool = toolCells <= 0 ? "" : isolateIfNeeded(truncateVisibleCells(rawTool, toolCells), "ar");
  const action = padVisibleStart(
    `${tool}${actionGapCells > 0 && tool.length > 0 ? " " : ""}${symbol}`,
    actionCells
  );
  const detailGap = " ".repeat(detailGapCells);
  const row = `${durationPart}${detailGapCells > 0 ? `${detail}${detailGap}` : detail}${action}`;
  return truncateVisibleCells(row, width);
}

export function activeWorkStatusSymbol(
  status: ActiveWorkItemStatus,
  frameIndex: number | undefined,
  style: OperatorConsoleStyle | undefined
): string {
  const symbol = status === "running"
    ? style?.tokens.contract.glyph.spinner.tool[spinnerFrameIndex(frameIndex, style?.tokens.contract.glyph.spinner.tool.length ?? 0)] ?? ACTIVE_WORK_STATUS_SYMBOLS.running
    : ACTIVE_WORK_STATUS_SYMBOLS[status];
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return symbol;
  switch (status) {
    case "running":
    case "queued":
      return styleColor(style, symbol, tokens.palette.action);
    case "succeeded":
      return styleColor(style, symbol, tokens.severity.ok);
    case "failed":
    case "cancelled":
      return styleColor(style, symbol, tokens.severity.error);
    case "awaitingApproval":
      return styleColor(style, symbol, tokens.palette.caution);
  }
}

function spinnerFrameIndex(input: number | undefined, length: number): number {
  if (length <= 0) return 0;
  if (input === undefined || !Number.isFinite(input)) return 0;
  return Math.abs(Math.floor(input)) % length;
}

function isActiveStatusItem(item: ActiveWorkItem): boolean {
  return item.status === "queued" || item.status === "running" || item.status === "awaitingApproval";
}

function statusPriority(status: ActiveWorkItemStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "awaitingApproval":
      return 2;
    case "succeeded":
      return 3;
    case "failed":
      return 4;
    case "cancelled":
      return 5;
  }
}

function resolveDurationMs(item: ActiveWorkItem): number {
  if (item.durationMs !== undefined) return item.durationMs;
  if (item.startedAtMs !== undefined && item.endedAtMs !== undefined) return item.endedAtMs - item.startedAtMs;
  return 0;
}

function resolveActiveWorkElapsedMs(state: ToolActivityState): number {
  if (state.startedAtMs !== undefined) {
    const end = state.completedAtMs ?? state.updatedAtMs;
    if (end !== undefined) return Math.max(0, end - state.startedAtMs);
  }
  return Math.max(0, ...state.items.map(resolveDurationMs));
}

function formatClockDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatActiveWorkTitle(
  runningTools: string,
  duration: string | undefined,
  locale: OperatorConsoleLocale | undefined
): string {
  if (duration === undefined) return runningTools;
  const isolatedDuration = isolateIfNeeded(duration, locale);
  return locale === "ar"
    ? `${isolatedDuration} ◷ ${runningTools}`
    : `${runningTools}  ◷ ${isolatedDuration}`;
}

export function formatActiveWorkDuration(durationMs: number): string {
  const safeMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  if (safeMs < 100) return `${Math.floor(safeMs)}ms`;
  if (safeMs < 60_000) {
    const roundedTenths = Math.round(safeMs / 100);
    if (roundedTenths < 100 && roundedTenths % 10 !== 0) {
      return `${(roundedTenths / 10).toFixed(1)}s`;
    }
    return `${Math.round(safeMs / 1000)}s`;
  }

  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

function renderTopBorder(title: string, width: number, rightLabel?: string): string {
  if (width <= 1) return "╭".slice(0, width);
  const label = `─ ${title} `;
  const right = rightLabel === undefined ? "" : ` ${rightLabel} `;
  const remaining = Math.max(0, width - 2 - stringWidth(label) - stringWidth(right));
  return truncateVisibleCells(`╭${label}${"─".repeat(remaining)}${right}╮`, width);
}

function renderBottomBorder(width: number): string {
  if (width <= 1) return "╰".slice(0, width);
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderContentRow(row: string, contentWidth: number, width: number): string {
  if (width <= 1) return "│".slice(0, width);
  const content = padVisibleEnd(truncateVisibleCells(row, contentWidth), contentWidth);
  return truncateVisibleCells(`│ ${content} │`, width);
}

function padRows(rows: readonly string[], count: number): readonly string[] {
  if (rows.length >= count) return rows.slice(0, count);
  return [...rows, ...Array.from({ length: count - rows.length }, () => "")];
}

function padVisibleEnd(value: string, width: number): string {
  const padCells = Math.max(0, width - stringWidth(value));
  return `${value}${" ".repeat(padCells)}`;
}

function padVisibleStart(value: string, width: number): string {
  const padCells = Math.max(0, width - stringWidth(value));
  return `${" ".repeat(padCells)}${value}`;
}

function isolateIfNeeded(value: string, locale: OperatorConsoleLocale | undefined): string {
  if (locale !== "ar" || value.length === 0) return value;
  return `${LTR_ISOLATE_START}${value}${LTR_ISOLATE_END}`;
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  return truncateVisible(value, width, "");
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}
