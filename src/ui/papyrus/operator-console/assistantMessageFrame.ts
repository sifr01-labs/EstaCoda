import {
  truncateVisible,
  wrapText,
} from "../../renderers/layout.js";
import { stringWidth } from "../screen/stringWidth.js";
import { formatInlineToolTrailRow } from "./inlineToolTrailSurface.js";
import type { InlineToolTrailEntry } from "./operatorConsoleState.js";
import {
  type OperatorConsoleStyle,
  styleBold,
  styleColor,
} from "./operatorConsoleStyle.js";

export type AssistantMessageFrameInput = {
  readonly title?: string;
  readonly lines: readonly string[];
  readonly cursor?: boolean;
  readonly blocks?: readonly AssistantMessageFrameBlock[];
  readonly toolTrail?: readonly InlineToolTrailEntry[];
};

export type AssistantMessageFrameBlock =
  | {
    readonly kind: "text";
    readonly lines: readonly string[];
    readonly cursor?: boolean;
  }
  | {
    readonly kind: "toolTrail";
    readonly entries: readonly InlineToolTrailEntry[];
  };

export type AssistantMessageFrameTextBlock = Extract<AssistantMessageFrameBlock, { readonly kind: "text" }>;
export type AssistantMessageFrameToolTrailBlock = Extract<AssistantMessageFrameBlock, { readonly kind: "toolTrail" }>;

export type AssistantMessageFrameRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
};

const DEFAULT_ASSISTANT_NAME = "EstaCoda";
const ASSISTANT_TITLE_GLYPH = "𓂀";
const LIVE_CURSOR = "▍";

export function getAssistantMessageFrameDesiredHeight(
  input: AssistantMessageFrameInput,
  width: number
): number {
  const normalizedWidth = normalizeDimension(width);
  if (normalizedWidth <= 0) return 0;
  const contentRows = renderWrappedContentRows(input, contentWidthFor(normalizedWidth));
  return Math.max(3, contentRows.length + 2);
}

export function renderAssistantMessageFrame(
  input: AssistantMessageFrameInput,
  options: AssistantMessageFrameRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const desiredHeight = getAssistantMessageFrameDesiredHeight(input, width);
  const height = normalizeDimension(options.height ?? desiredHeight);
  if (height <= 0) return [];

  const title = normalizeTitle(input.title, options.style);
  const contentRows = renderWrappedContentRows(input, contentWidthFor(width), options.style, options.motionElapsedMs);
  if (height < 3) return [truncateVisible(`${title}: ${summarizeContentRows(contentRows)}`, width)];

  const visibleContentRows = Math.max(1, height - 2);
  const selectedRows = selectLatestRows(contentRows, visibleContentRows);
  const paddedRows = padRows(selectedRows, visibleContentRows);

  return [
    renderTopBorder(title, width, options.style),
    ...paddedRows.map((row) => renderContentRow(row, width)),
    renderBottomBorder(width),
  ];
}

function renderWrappedContentRows(
  input: AssistantMessageFrameInput,
  width: number,
  style?: OperatorConsoleStyle,
  motionElapsedMs?: number
): readonly string[] {
  const rows = contentBlocksForInput(input).flatMap((block, index, blocks) =>
    renderContentBlockRows(block, index, blocks, width, style, motionElapsedMs)
  );
  return rows.length === 0 ? [""] : rows;
}

function contentBlocksForInput(input: AssistantMessageFrameInput): readonly AssistantMessageFrameBlock[] {
  if (input.blocks !== undefined) return input.blocks;
  const blocks: AssistantMessageFrameBlock[] = [{
    kind: "text",
    lines: input.lines,
    cursor: input.cursor,
  }];
  if (input.toolTrail !== undefined && input.toolTrail.length > 0) {
    blocks.push({ kind: "toolTrail", entries: input.toolTrail });
  }
  return blocks;
}

function renderContentBlockRows(
  block: AssistantMessageFrameBlock,
  index: number,
  blocks: readonly AssistantMessageFrameBlock[],
  width: number,
  style: OperatorConsoleStyle | undefined,
  motionElapsedMs: number | undefined
): readonly string[] {
  if (block.kind === "text") {
    const lines = withOptionalCursor(normalizeFrameLines(block.lines), block.cursor);
    return lines.flatMap((line) => wrapText(line, Math.max(1, width)));
  }

  const entries = [...block.entries].sort((left, right) => left.sequence - right.sequence);
  if (entries.length === 0) return [];
  const rows = entries.map((entry) => formatInlineToolTrailRow(entry, width, { style, motionElapsedMs }));
  return [
    ...(shouldSeparateFromPreviousBlock(index, blocks) ? [""] : []),
    ...rows,
    ...(shouldSeparateFromNextBlock(index, blocks) ? [""] : []),
  ];
}

function normalizeFrameLines(lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [""];
  return lines.flatMap((line) => normalizeLineBreaks(line));
}

function normalizeLineBreaks(text: string): readonly string[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  return lines.length === 0 ? [""] : lines;
}

function withOptionalCursor(lines: readonly string[], cursor: boolean | undefined): readonly string[] {
  if (!cursor) return lines;
  if (lines.length === 0) return [LIVE_CURSOR];
  const next = [...lines];
  next[next.length - 1] = `${next[next.length - 1] ?? ""}${LIVE_CURSOR}`;
  return next;
}

function shouldSeparateFromPreviousBlock(
  index: number,
  blocks: readonly AssistantMessageFrameBlock[]
): boolean {
  return index > 0 && hasRenderableContentBefore(index, blocks);
}

function shouldSeparateFromNextBlock(
  index: number,
  blocks: readonly AssistantMessageFrameBlock[]
): boolean {
  return hasRenderableTextAfter(index, blocks);
}

function hasRenderableContentBefore(
  index: number,
  blocks: readonly AssistantMessageFrameBlock[]
): boolean {
  return blocks.slice(0, index).some(hasRenderableBlockContent);
}

function hasRenderableTextAfter(
  index: number,
  blocks: readonly AssistantMessageFrameBlock[]
): boolean {
  return blocks.slice(index + 1).some((block) => block.kind === "text" && hasRenderableBlockContent(block));
}

function hasRenderableBlockContent(block: AssistantMessageFrameBlock): boolean {
  if (block.kind === "toolTrail") return block.entries.length > 0;
  return block.lines.some((line) => line.trim().length > 0) || block.cursor === true;
}

function selectLatestRows(rows: readonly string[], count: number): readonly string[] {
  if (rows.length <= count) return rows;
  return rows.slice(Math.max(0, rows.length - count));
}

function padRows(rows: readonly string[], count: number): readonly string[] {
  if (rows.length >= count) return rows.slice(0, count);
  return [...rows, ...Array.from({ length: count - rows.length }, () => "")];
}

function summarizeContentRows(rows: readonly string[]): string {
  return rows.join(" ").trim();
}

function normalizeTitle(title: string | undefined, style: OperatorConsoleStyle | undefined): string {
  const value = title?.trim();
  if (value && value.length > 0) return value;
  const name = style?.tokens.contract.branding.agentName.trim() || DEFAULT_ASSISTANT_NAME;
  if (style?.tokens.mode === "plain") return name;
  return `${ASSISTANT_TITLE_GLYPH}  ${name}`;
}

function renderTopBorder(
  title: string,
  width: number,
  style: OperatorConsoleStyle | undefined
): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  if (width === 2) return "╭╮";

  const innerWidth = Math.max(0, width - 2);
  const styledTitle = styleTitle(title, style);
  const framedTitle = ` ${styledTitle} `;
  const visibleTitle = truncateVisible(framedTitle, innerWidth);
  const titleWidth = stringWidth(visibleTitle);
  const fillWidth = Math.max(0, innerWidth - titleWidth);
  const leftFill = Math.floor(fillWidth / 2);
  const rightFill = fillWidth - leftFill;

  return `╭${"─".repeat(leftFill)}${visibleTitle}${"─".repeat(rightFill)}╮`;
}

function renderBottomBorder(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  if (width === 2) return "╰╯";
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderContentRow(row: string, width: number): string {
  if (row.length === 0) return "";
  if (width <= 2) return truncateVisible(row, width);
  return `  ${truncateVisible(row, Math.max(0, width - 4))}`;
}

function contentWidthFor(width: number): number {
  return Math.max(0, width - 4);
}

function styleTitle(title: string, style: OperatorConsoleStyle | undefined): string {
  return styleColor(style, styleBold(style, title), style?.tokens.contract.palette.brand ?? "");
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
