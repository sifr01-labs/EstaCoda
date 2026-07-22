import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { PromptSurfaceState, TerminalMetrics } from "./operatorConsoleState.js";
import {
  styleBackgroundRow,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

export type PromptSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly terminalHeight?: number;
  readonly style?: OperatorConsoleStyle;
};

export type PromptSurfaceMetrics = {
  readonly logicalRows: number;
  readonly visibleRows: number;
  readonly overflow: boolean;
  readonly scrollOffset: number;
  readonly contentStartRow: number;
  readonly cursorRow: number;
  readonly cursorColumn: number;
};

export const PREFERRED_PROMPT_INPUT_ROWS = 8;
export const MAX_PROMPT_HEIGHT_RATIO = 0.3;
export const PROMPT_HALF_CELL_BAND_ROWS = 2;

export function getPromptSurfaceDesiredHeight(
  state: PromptSurfaceState,
  terminal: Pick<TerminalMetrics, "height"> & Partial<Pick<TerminalMetrics, "width">>
): number {
  const logicalRows = getPromptLogicalRows(state, terminal.width).length;
  const preferredInputRows = Math.min(PREFERRED_PROMPT_INPUT_ROWS, logicalRows);
  const absoluteHeight = Math.max(3, Math.floor(terminal.height * MAX_PROMPT_HEIGHT_RATIO));
  const absoluteInputRows = Math.max(1, absoluteHeight - PROMPT_HALF_CELL_BAND_ROWS);
  return Math.max(3, Math.min(preferredInputRows, absoluteInputRows) + PROMPT_HALF_CELL_BAND_ROWS);
}

export function renderPromptSurface(
  state: PromptSurfaceState,
  options: PromptSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const height = normalizeDimension(options.height ?? getPromptSurfaceDesiredHeight(state, {
    height: options.terminalHeight ?? 24,
    width,
  }));
  if (height <= 0) return [];

  const contentWidth = width;
  const chrome = resolvePromptChrome(height);
  const inputRows = Math.max(1, height - chrome.topRows - chrome.bottomRows);
  const logicalRows = getPromptLogicalRows(state, width);
  const overflow = logicalRows.length > inputRows;
  const cursor = getPromptCursorPosition(state, logicalRows);
  const scrollOffset = getCursorVisibleScrollOffset(state, logicalRows.length, inputRows, overflow, cursor.row);
  const visibleRows = getVisiblePromptRows(logicalRows, scrollOffset, inputRows, overflow);

  const content = visibleRows.map((row, index) => renderContentRow(
    row,
    contentWidth,
    width,
    shouldStylePlaceholderRow(state, scrollOffset, index),
    options.style
  ));
  const topBand = chrome.topRows === 0
    ? []
    : [renderHalfCellBand(options.style, width, "▀")];
  const bottomBand = chrome.bottomRows === 0
    ? []
    : [chrome.halfCellBands
        ? renderHalfCellBand(options.style, width, "▄")
        : renderFullPaddingRow(options.style, width)];
  return [...topBand, ...content, ...bottomBand];
}

export function getPromptSurfaceMetrics(
  state: PromptSurfaceState,
  options: PromptSurfaceRenderOptions
): PromptSurfaceMetrics {
  const height = normalizeDimension(options.height ?? getPromptSurfaceDesiredHeight(state, {
    height: options.terminalHeight ?? 24,
    width: options.width,
  }));
  const logicalRows = getPromptLogicalRows(state, options.width);
  const chrome = resolvePromptChrome(height);
  const visibleRows = Math.max(1, height - chrome.topRows - chrome.bottomRows);
  const overflow = logicalRows.length > visibleRows;
  const cursor = getPromptCursorPosition(state, logicalRows);
  return {
    logicalRows: logicalRows.length,
    visibleRows: Math.min(logicalRows.length, visibleRows),
    overflow,
    scrollOffset: getCursorVisibleScrollOffset(state, logicalRows.length, visibleRows, overflow, cursor.row),
    contentStartRow: chrome.topRows,
    cursorRow: cursor.row,
    cursorColumn: cursor.column,
  };
}

function resolvePromptChrome(height: number): {
  readonly topRows: number;
  readonly bottomRows: number;
  readonly halfCellBands: boolean;
} {
  if (height >= 3) return { topRows: 1, bottomRows: 1, halfCellBands: true };
  if (height === 2) return { topRows: 0, bottomRows: 1, halfCellBands: false };
  return { topRows: 0, bottomRows: 0, halfCellBands: false };
}

function renderHalfCellBand(
  style: OperatorConsoleStyle | undefined,
  width: number,
  glyph: "▄" | "▀"
): string {
  if (style === undefined || !style.supportsColor) return "".padEnd(width);
  // Inverse mode uses the terminal's real default background for the outer
  // half while making the half adjacent to the content a continuous elevated
  // background. This avoids foreground block-glyph seams at the inner edges.
  return `\x1b[7m${styleColor(style, glyph.repeat(width), style.tokens.contract.surface.bgElevated)}`;
}

function renderFullPaddingRow(style: OperatorConsoleStyle | undefined, width: number): string {
  const background = style?.tokens.contract.surface.bgElevated ?? "";
  return styleBackgroundRow(style, "", width, background);
}

type PromptLogicalRow = {
  readonly content: string;
  readonly text: string;
  readonly prefix: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

function getPromptLogicalRows(state: PromptSurfaceState, width: number | undefined): readonly PromptLogicalRow[] {
  const value = state.value.length === 0 ? state.placeholder ?? "" : state.value;
  const rows: PromptLogicalRow[] = [];
  const normalizedWidth = width === undefined ? Number.POSITIVE_INFINITY : normalizeDimension(width);
  const maxTextCells = Number.isFinite(normalizedWidth)
    ? Math.max(1, normalizedWidth - 2)
    : Number.POSITIVE_INFINITY;

  for (const explicitLine of splitExplicitLines(value)) {
    for (const segment of wrapPromptLine(explicitLine.text, explicitLine.startOffset, maxTextCells)) {
      const prefix = rows.length === 0 ? "› " : "  ";
      rows.push({
        ...segment,
        prefix,
        content: `${prefix}${segment.text}`,
      });
    }
  }

  if (rows.length === 0) {
    return [{
      content: "› ",
      text: "",
      prefix: "› ",
      startOffset: 0,
      endOffset: 0,
    }];
  }

  return rows;
}

function getVisiblePromptRows(
  logicalRows: readonly PromptLogicalRow[],
  scrollOffset: number,
  inputRows: number,
  overflow: boolean
): readonly PromptLogicalRow[] {
  if (!overflow) return padRows(logicalRows, inputRows);

  const indicatorRows = 1;
  const contentRows = Math.max(1, inputRows - indicatorRows);
  const maxOffset = Math.max(0, logicalRows.length - contentRows);
  const offset = clampInteger(scrollOffset, 0, maxOffset);
  const visible = logicalRows.slice(offset, offset + contentRows);
  return padRows([
    ...visible,
    staticPromptRow(`${logicalRows.length} lines · ↑↓ scroll within prompt`),
  ], inputRows);
}

function getCursorVisibleScrollOffset(
  state: PromptSurfaceState,
  logicalRowCount: number,
  inputRows: number,
  overflow: boolean,
  cursorRowInput?: number
): number {
  if (!overflow) return clampInteger(state.scrollOffset, 0, Math.max(0, logicalRowCount - inputRows));

  const indicatorRows = 1;
  const contentRows = Math.max(1, inputRows - indicatorRows);
  const maxOffset = Math.max(0, logicalRowCount - contentRows);
  const cursorRow = clampInteger(cursorRowInput ?? getPromptCursorPosition(state).row, 0, Math.max(0, logicalRowCount - 1));
  const scrollOffset = clampInteger(state.scrollOffset, 0, maxOffset);

  if (cursorRow < scrollOffset) return cursorRow;
  if (cursorRow >= scrollOffset + contentRows) return Math.min(maxOffset, cursorRow - contentRows + 1);
  return scrollOffset;
}

function getPromptCursorPosition(
  state: PromptSurfaceState,
  rows = getPromptLogicalRows(state, undefined)
): { readonly row: number; readonly column: number } {
  const cursor = clampInteger(state.cursorOffset, 0, state.value.length);
  const index = rows.findIndex((row) => cursor >= row.startOffset && cursor <= row.endOffset);
  const rowIndex = index < 0 ? Math.max(0, rows.length - 1) : index;
  const row = rows[rowIndex];
  if (row === undefined) return { row: 0, column: 0 };
  const cursorText = row.text.slice(0, Math.max(0, Math.min(cursor, row.endOffset) - row.startOffset));
  return {
    row: rowIndex,
    column: stringWidth(row.prefix) + stringWidth(cursorText),
  };
}

function padRows(rows: readonly PromptLogicalRow[], count: number): readonly PromptLogicalRow[] {
  if (rows.length >= count) return rows.slice(0, count);
  return [...rows, ...Array.from({ length: count - rows.length }, () => staticPromptRow(""))];
}

function renderContentRow(
  row: PromptLogicalRow,
  contentWidth: number,
  width: number,
  placeholder: boolean,
  style: OperatorConsoleStyle | undefined
): string {
  if (width <= 0) return "";
  if (style === undefined) {
    return padVisibleEnd(truncateVisibleCells(row.content, contentWidth), contentWidth);
  }
  const tokens = style.tokens.contract;
  const prefix = row.prefix.length === 0
    ? ""
    : styleColor(style, row.prefix, tokens.palette.action);
  const textColor = placeholder
    ? tokens.text.placeholder
    : row.prefix.length === 0 ? tokens.text.muted : tokens.text.primary;
  const content = `${prefix}${styleColor(style, row.text, textColor)}`;
  return styleBackgroundRow(style, content, width, tokens.surface.bgElevated);
}

function shouldStylePlaceholderRow(
  state: PromptSurfaceState,
  scrollOffset: number,
  visibleRowIndex: number
): boolean {
  return state.value.length === 0 &&
    state.placeholder !== undefined &&
    state.placeholder.length > 0 &&
    scrollOffset === 0 &&
    visibleRowIndex === 0;
}

function padVisibleEnd(value: string, width: number): string {
  const padCells = Math.max(0, width - stringWidth(value));
  return `${value}${" ".repeat(padCells)}`;
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  return truncateVisible(value, width, "");
}

function splitExplicitLines(value: string): readonly { readonly text: string; readonly startOffset: number }[] {
  const lines: { text: string; startOffset: number }[] = [];
  const newlinePattern = /\r\n|\n|\r/gu;
  let lastIndex = 0;
  for (const match of value.matchAll(newlinePattern)) {
    const index = match.index ?? lastIndex;
    lines.push({ text: value.slice(lastIndex, index), startOffset: lastIndex });
    lastIndex = index + match[0].length;
  }
  lines.push({ text: value.slice(lastIndex), startOffset: lastIndex });
  return lines;
}

function wrapPromptLine(
  text: string,
  startOffset: number,
  maxTextCells: number
): readonly Pick<PromptLogicalRow, "text" | "startOffset" | "endOffset">[] {
  if (text.length === 0) return [{ text: "", startOffset, endOffset: startOffset }];
  const rows: Pick<PromptLogicalRow, "text" | "startOffset" | "endOffset">[] = [];
  let current = "";
  let currentStartOffset = startOffset;
  let lastBreakBefore = -1;
  let lastBreakAfter = -1;
  let offset = startOffset;

  for (const char of text) {
    const next = `${current}${char}`;
    if (current.length > 0 && stringWidth(next) > maxTextCells) {
      if (lastBreakBefore > 0 && lastBreakAfter > lastBreakBefore) {
        const rowText = current.slice(0, lastBreakBefore);
        rows.push({
          text: rowText,
          startOffset: currentStartOffset,
          endOffset: currentStartOffset + rowText.length,
        });
        current = `${current.slice(lastBreakAfter)}${char}`;
        currentStartOffset += lastBreakAfter;
        const breakPoint = findLastWhitespaceBreak(current);
        lastBreakBefore = breakPoint.before;
        lastBreakAfter = breakPoint.after;
      } else {
        rows.push({ text: current, startOffset: currentStartOffset, endOffset: offset });
        current = char;
        currentStartOffset = offset;
        lastBreakBefore = -1;
        lastBreakAfter = -1;
      }
    } else {
      current = next;
      if (isWhitespace(char)) {
        lastBreakBefore = current.length - char.length;
        lastBreakAfter = current.length;
      }
    }
    offset += char.length;
  }

  rows.push({ text: current, startOffset: currentStartOffset, endOffset: offset });
  return rows;
}

function findLastWhitespaceBreak(text: string): { readonly before: number; readonly after: number } {
  let before = -1;
  let after = -1;
  let index = 0;
  for (const char of text) {
    if (isWhitespace(char)) {
      before = index;
      after = index + char.length;
    }
    index += char.length;
  }
  return { before, after };
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function staticPromptRow(content: string): PromptLogicalRow {
  return {
    content,
    text: content,
    prefix: "",
    startOffset: 0,
    endOffset: 0,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
