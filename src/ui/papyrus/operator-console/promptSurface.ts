import { stringWidth } from "../screen/stringWidth.js";
import type { PromptSurfaceState, TerminalMetrics } from "./operatorConsoleState.js";

export type PromptSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly terminalHeight?: number;
};

export type PromptSurfaceMetrics = {
  readonly logicalRows: number;
  readonly visibleRows: number;
  readonly overflow: boolean;
};

export const PREFERRED_PROMPT_INPUT_ROWS = 8;
export const MAX_PROMPT_HEIGHT_RATIO = 0.3;

export function getPromptSurfaceDesiredHeight(
  state: PromptSurfaceState,
  terminal: Pick<TerminalMetrics, "height">
): number {
  const logicalRows = getPromptLogicalRows(state).length;
  const preferredInputRows = Math.min(PREFERRED_PROMPT_INPUT_ROWS, logicalRows);
  const absoluteInputRows = Math.max(1, Math.floor(terminal.height * MAX_PROMPT_HEIGHT_RATIO) - 2);
  return Math.max(3, Math.min(preferredInputRows, Math.max(1, absoluteInputRows)) + 2);
}

export function renderPromptSurface(
  state: PromptSurfaceState,
  options: PromptSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const height = normalizeDimension(options.height ?? getPromptSurfaceDesiredHeight(state, {
    height: options.terminalHeight ?? 24,
  }));
  if (height <= 0) return [];
  if (height < 3) return [truncateVisibleCells(renderPromptFallbackLine(state), width)];

  const contentWidth = Math.max(0, width - 4);
  const inputRows = Math.max(1, height - 2);
  const logicalRows = getPromptLogicalRows(state);
  const overflow = logicalRows.length > inputRows;
  const visibleRows = getVisiblePromptRows(logicalRows, state.scrollOffset, inputRows, overflow);
  const title = state.multiline || logicalRows.length > 1 ? "Prompt · multiline" : "Prompt";

  return [
    renderTopBorder(title, width),
    ...visibleRows.map((row) => renderContentRow(row, contentWidth, width)),
    renderBottomBorder(width),
  ];
}

export function getPromptSurfaceMetrics(
  state: PromptSurfaceState,
  options: PromptSurfaceRenderOptions
): PromptSurfaceMetrics {
  const height = normalizeDimension(options.height ?? getPromptSurfaceDesiredHeight(state, {
    height: options.terminalHeight ?? 24,
  }));
  const logicalRows = getPromptLogicalRows(state).length;
  const visibleRows = Math.max(1, Math.max(0, height - 2));
  return {
    logicalRows,
    visibleRows: Math.min(logicalRows, visibleRows),
    overflow: logicalRows > visibleRows,
  };
}

function getPromptLogicalRows(state: PromptSurfaceState): readonly string[] {
  const value = state.value.length === 0 ? state.placeholder ?? "" : state.value;
  const lines = value.split(/\r\n|\n|\r/u);
  if (lines.length === 0) return [formatFirstPromptRow("")];
  return lines.map((line, index) => index === 0 ? formatFirstPromptRow(line) : formatContinuationPromptRow(line));
}

function getVisiblePromptRows(
  logicalRows: readonly string[],
  scrollOffset: number,
  inputRows: number,
  overflow: boolean
): readonly string[] {
  if (!overflow) return padRows(logicalRows, inputRows);

  const indicatorRows = 1;
  const contentRows = Math.max(1, inputRows - indicatorRows);
  const maxOffset = Math.max(0, logicalRows.length - contentRows);
  const offset = clampInteger(scrollOffset, 0, maxOffset);
  const visible = logicalRows.slice(offset, offset + contentRows);
  return padRows([
    ...visible,
    `${logicalRows.length} lines · ↑↓ scroll within prompt`,
  ], inputRows);
}

function padRows(rows: readonly string[], count: number): readonly string[] {
  if (rows.length >= count) return rows.slice(0, count);
  return [...rows, ...Array.from({ length: count - rows.length }, () => "")];
}

function renderTopBorder(title: string, width: number): string {
  if (width <= 1) return "╭".slice(0, width);
  const label = `─ ${title} `;
  const remaining = Math.max(0, width - 2 - stringWidth(label));
  return truncateVisibleCells(`╭${label}${"─".repeat(remaining)}╮`, width);
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

function renderPromptFallbackLine(state: PromptSurfaceState): string {
  const content = state.value.length === 0 ? state.placeholder ?? ">" : state.value.replace(/\r\n|\n|\r/gu, " ");
  return `Prompt: ${content.length === 0 ? ">" : content}`;
}

function formatFirstPromptRow(text: string): string {
  return `› ${text}`;
}

function formatContinuationPromptRow(text: string): string {
  return `  ${text}`;
}

function padVisibleEnd(value: string, width: number): string {
  const padCells = Math.max(0, width - stringWidth(value));
  return `${value}${" ".repeat(padCells)}`;
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;

  let output = "";
  for (const char of value) {
    if (stringWidth(output + char) > width) break;
    output += char;
  }
  return output;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
