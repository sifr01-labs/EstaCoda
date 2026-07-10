import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { stringWidth } from "../screen/stringWidth.js";
import type {
  QueuedSteerState,
  SteerState,
  TranscriptBlock,
} from "./operatorConsoleState.js";

export type SteerSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
};

export type SteerInputSurfaceMetrics = {
  readonly logicalRows: number;
  readonly visibleRows: number;
  readonly cursorRow: number;
  readonly cursorColumn: number;
};

export type SteerIntent =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "cancelDraft" }
  | { readonly type: "cancelQueued"; readonly queuedSteerId: string }
  | { readonly type: "none" };

const STEER_INPUT_TITLE = "Steer current turn";
const QUEUED_STEER_TITLE = "Queued steer";
const QUEUED_STEER_HINT = "Will apply at next safe boundary · Esc cancel";
const USER_STEER_LABEL = "User steer";

export function isSteerInputActive(state: SteerState | undefined): boolean {
  return state?.mode === "drafting" || state?.mode === "queued";
}

export function hasQueuedSteer(state: SteerState | undefined): boolean {
  return state?.queued?.status === "queued";
}

export function getSteerInputSurfaceDesiredHeight(state: SteerState): number {
  const rows = getSteerDraftLogicalRows(state).length;
  return Math.max(3, Math.min(8, rows + 2));
}

export function getQueuedSteerSurfaceDesiredHeight(state: QueuedSteerState): number {
  return state.status === "queued" ? 4 : 0;
}

export function renderSteerInputSurface(
  state: SteerState,
  options: SteerSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const height = normalizeDimension(options.height ?? getSteerInputSurfaceDesiredHeight(state));
  if (height <= 0) return [];
  if (height < 3) return [truncateVisibleCells(renderSteerInputFallbackLine(state), width)];

  const contentWidth = Math.max(0, width - 4);
  const inputRows = Math.max(1, height - 2);
  const rows = padRows(getSteerDraftLogicalRows(state).map((row) => row.content), inputRows);

  return [
    renderTopBorder(STEER_INPUT_TITLE, width),
    ...rows.map((row) => renderContentRow(row, contentWidth, width)),
    renderBottomBorder(width),
  ];
}

export function getSteerInputSurfaceMetrics(
  state: SteerState,
  options: SteerSurfaceRenderOptions
): SteerInputSurfaceMetrics {
  const width = normalizeDimension(options.width);
  const height = normalizeDimension(options.height ?? getSteerInputSurfaceDesiredHeight(state));
  const contentWidth = Math.max(0, width - 4);
  const inputRows = height < 3 ? 1 : Math.max(1, height - 2);
  const logicalRows = getSteerDraftLogicalRows(state);
  const cursorOffset = clampInteger(state.cursorOffset, 0, state.draft.length);
  const cursorLogicalRow = findSteerCursorRow(logicalRows, cursorOffset);
  const visibleRow = Math.min(cursorLogicalRow, inputRows - 1);
  const row = logicalRows[visibleRow] ?? staticSteerRow("");
  const hiddenCursor = cursorLogicalRow !== visibleRow;
  const contentColumn = hiddenCursor
    ? contentWidth
    : stringWidth(row.prefix) + stringWidth(row.text.slice(0, Math.max(0, cursorOffset - row.startOffset)));

  return {
    logicalRows: logicalRows.length,
    visibleRows: Math.min(logicalRows.length, inputRows),
    cursorRow: visibleRow,
    cursorColumn: 2 + Math.min(contentWidth, Math.max(0, contentColumn)),
  };
}

export function renderQueuedSteerSurface(
  state: QueuedSteerState,
  options: SteerSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || state.status !== "queued") return [];

  const height = normalizeDimension(options.height ?? getQueuedSteerSurfaceDesiredHeight(state));
  if (height <= 0) return [];
  if (height < 3) return [truncateVisibleCells(`Queued steer: ${state.text}`, width)];

  const contentWidth = Math.max(0, width - 4);
  const rows = [
    renderTopBorder(QUEUED_STEER_TITLE, width),
    renderContentRow(state.text, contentWidth, width),
    renderContentRow(QUEUED_STEER_HINT, contentWidth, width),
    renderBottomBorder(width),
  ];
  return rows.slice(0, height);
}

export function routeSteerKey(state: SteerState, key: ParsedKeypress): SteerIntent {
  if (key.type !== "key") return { type: "none" };

  if (key.key === "enter") {
    const text = state.draft.trim();
    return text.length === 0 ? { type: "none" } : { type: "submit", text };
  }

  if (key.key === "escape") {
    if (state.mode === "drafting") return { type: "cancelDraft" };
    if (state.mode === "queued" && state.queued?.status === "queued") {
      return { type: "cancelQueued", queuedSteerId: state.queued.id };
    }
  }

  return { type: "none" };
}

export function createSubmittedSteerTranscriptBlock(input: {
  readonly id: string;
  readonly text: string;
  readonly createdAtMs?: number;
}): TranscriptBlock {
  return {
    id: input.id,
    role: "user",
    text: `${USER_STEER_LABEL}:\n${input.text}`,
    ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
  };
}

function renderSteerInputFallbackLine(state: SteerState): string {
  const value = state.draft.replace(/\r\n|\n|\r/gu, " ");
  return `Steer: ${value.length === 0 ? ">" : value}`;
}

type SteerDraftLogicalRow = {
  readonly content: string;
  readonly text: string;
  readonly prefix: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

function getSteerDraftLogicalRows(state: SteerState): readonly SteerDraftLogicalRow[] {
  const rows = splitSteerDraftLines(state.draft).map((line, index) => {
    const prefix = index === 0 ? "› " : "  ";
    return {
      ...line,
      prefix,
      content: `${prefix}${line.text}`,
    };
  });
  return rows.length === 0 ? [staticSteerRow("")] : rows;
}

function splitSteerDraftLines(value: string): readonly Pick<SteerDraftLogicalRow, "text" | "startOffset" | "endOffset">[] {
  const rows: Pick<SteerDraftLogicalRow, "text" | "startOffset" | "endOffset">[] = [];
  const lineBreak = /\r\n|\n|\r/gu;
  let startOffset = 0;
  for (const match of value.matchAll(lineBreak)) {
    const endOffset = match.index ?? startOffset;
    rows.push({
      text: value.slice(startOffset, endOffset),
      startOffset,
      endOffset,
    });
    startOffset = endOffset + match[0].length;
  }
  rows.push({
    text: value.slice(startOffset),
    startOffset,
    endOffset: value.length,
  });
  return rows;
}

function staticSteerRow(text: string): SteerDraftLogicalRow {
  return {
    content: text,
    text,
    prefix: "",
    startOffset: 0,
    endOffset: 0,
  };
}

function findSteerCursorRow(rows: readonly SteerDraftLogicalRow[], cursorOffset: number): number {
  const index = rows.findIndex((row) => cursorOffset >= row.startOffset && cursorOffset <= row.endOffset);
  return index < 0 ? Math.max(0, rows.length - 1) : index;
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

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
