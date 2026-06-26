import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { redactSensitiveText } from "../../../utils/redaction.js";
import { stringWidth } from "../screen/stringWidth.js";
import { setFocus } from "./focusModel.js";
import type {
  AttachmentCardState,
  OperatorConsoleState,
} from "./operatorConsoleState.js";

export type AttachmentSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly maxCardRows?: number;
};

export type AttachmentIntent =
  | { readonly type: "openPreview"; readonly attachmentId: string }
  | { readonly type: "remove"; readonly attachmentId: string }
  | { readonly type: "submitPrompt" }
  | { readonly type: "none" };

export type AttachmentKeyResult = {
  readonly state: OperatorConsoleState;
  readonly intent: AttachmentIntent;
};

const CARD_GAP = 1;
const CARD_HEIGHT = 4;
const DEFAULT_MAX_CARD_ROWS = 2;
const MIN_CARD_WIDTH = 24;

export function createPastedTextAttachment(input: {
  readonly id: string;
  readonly content: string;
  readonly title?: string;
  readonly preview?: string;
}): AttachmentCardState {
  return {
    id: input.id,
    kind: "pastedText",
    title: input.title ?? "pasted text",
    preview: createAttachmentPreview(input.preview ?? input.content),
    content: input.content,
    metadata: {
      chars: input.content.length,
    },
  };
}

export function createFileExcerptAttachment(input: {
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly title?: string;
  readonly preview?: string;
}): AttachmentCardState {
  return {
    id: input.id,
    kind: "fileExcerpt",
    title: input.title ?? "file excerpt",
    preview: createAttachmentPreview(input.preview ?? input.path),
    content: input.content,
    metadata: {
      path: input.path,
      lines: countLines(input.content),
    },
  };
}

export function getAttachmentSurfaceDesiredHeight(
  attachments: readonly AttachmentCardState[],
  width: number
): number {
  if (attachments.length === 0) return 0;
  const columns = getAttachmentColumns(width, attachments.length);
  const cardRows = Math.ceil(attachments.length / columns);
  const visibleRows = Math.min(DEFAULT_MAX_CARD_ROWS, cardRows);
  const overflowRows = cardRows > visibleRows ? 1 : 0;
  return 1 + visibleRows * CARD_HEIGHT + overflowRows;
}

export function renderAttachmentSurface(
  attachments: readonly AttachmentCardState[],
  options: AttachmentSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || attachments.length === 0) return [];

  const columns = getAttachmentColumns(width, attachments.length);
  const cardWidth = getAttachmentCardWidth(width, columns);
  const maxCardRows = getMaxVisibleCardRows(options, attachments.length, columns);
  const visibleCount = Math.min(attachments.length, maxCardRows * columns);
  const visibleAttachments = attachments.slice(0, visibleCount);
  const rows: string[] = [truncateVisibleCells("Attachments", width)];

  for (let index = 0; index < visibleAttachments.length; index += columns) {
    const rowAttachments = visibleAttachments.slice(index, index + columns);
    const renderedCards = rowAttachments.map((attachment) => renderAttachmentCard(attachment, cardWidth, columns === 1));
    for (let lineIndex = 0; lineIndex < CARD_HEIGHT; lineIndex += 1) {
      rows.push(truncateVisibleCells(renderedCards.map((card) => card[lineIndex] ?? "").join(" ".repeat(CARD_GAP)), width));
    }
  }

  const remaining = attachments.length - visibleCount;
  if (remaining > 0) {
    rows.push(truncateVisibleCells(`+${remaining} more attachments · Enter open attachment tray`, width));
  }

  return options.height === undefined ? rows : rows.slice(0, normalizeDimension(options.height));
}

export function getFocusedAttachment(
  state: Pick<OperatorConsoleState, "attachments" | "focus">
): AttachmentCardState | undefined {
  const target = state.focus.target;
  if (target.kind !== "attachment") return undefined;
  return state.attachments.find((attachment) => attachment.id === target.attachmentId);
}

export function focusNextAttachment(state: OperatorConsoleState): OperatorConsoleState {
  return moveAttachmentFocus(state, 1);
}

export function focusPreviousAttachment(state: OperatorConsoleState): OperatorConsoleState {
  return moveAttachmentFocus(state, -1);
}

export function routeAttachmentKey(
  state: OperatorConsoleState,
  key: ParsedKeypress
): AttachmentKeyResult {
  if (key.type !== "key") return { state, intent: { type: "none" } };

  if (key.key === "tab") {
    return {
      state: key.shift === true ? focusPreviousAttachment(state) : focusNextAttachment(state),
      intent: { type: "none" },
    };
  }

  const focused = getFocusedAttachment(state);
  if (key.key === "enter") {
    if (state.focus.target.kind !== "prompt" && focused === undefined) {
      return {
        state,
        intent: { type: "none" },
      };
    }
    return {
      state,
      intent: focused === undefined
        ? { type: "submitPrompt" }
        : { type: "openPreview", attachmentId: focused.id },
    };
  }

  if (key.key === "escape" && focused !== undefined) {
    return {
      state,
      intent: { type: "remove", attachmentId: focused.id },
    };
  }

  return { state, intent: { type: "none" } };
}

export function formatSubmittedPromptWithAttachmentReferences(
  prompt: string,
  attachments: readonly AttachmentCardState[]
): string {
  const trimmedPrompt = prompt.trimEnd();
  if (attachments.length === 0) return trimmedPrompt;
  const promptRows = trimmedPrompt.length === 0 ? [] : [trimmedPrompt];
  return [
    ...promptRows,
    "Attachments:",
    ...attachments.map((attachment) => `- ${formatSubmittedAttachmentReference(attachment)}`),
  ].join("\n");
}

function formatSubmittedAttachmentReference(attachment: AttachmentCardState): string {
  if (attachment.kind === "fileExcerpt") {
    return [
      attachment.title,
      attachment.metadata.path,
      attachment.metadata.lines === undefined ? undefined : formatLineCount(attachment.metadata.lines),
    ].filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
  }
  return [
    attachment.title,
    attachment.metadata.chars === undefined ? undefined : formatCharCount(attachment.metadata.chars),
  ].filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}

function moveAttachmentFocus(state: OperatorConsoleState, direction: 1 | -1): OperatorConsoleState {
  const targets = [
    { kind: "prompt" as const },
    ...state.attachments.map((attachment) => ({ kind: "attachment" as const, attachmentId: attachment.id })),
  ];
  if (targets.length === 1) return state;

  const currentIndex = targets.findIndex((target) => {
    const focused = state.focus.target;
    if (focused.kind !== target.kind) return false;
    if (focused.kind === "prompt") return true;
    return target.kind === "attachment" && focused.attachmentId === target.attachmentId;
  });
  const startIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (startIndex + direction + targets.length) % targets.length;
  return {
    ...state,
    focus: setFocus(state.focus, targets[nextIndex]!),
  };
}

function renderAttachmentCard(
  attachment: AttachmentCardState,
  width: number,
  includeControls: boolean
): readonly string[] {
  const contentWidth = Math.max(0, width - 4);
  const metadata = includeControls
    ? `${formatAttachmentMetadata(attachment)} · Enter open · Esc remove`
    : formatAttachmentMetadata(attachment);
  return [
    renderTopBorder(attachment.title, width),
    renderContentRow(attachment.preview, contentWidth, width),
    renderContentRow(metadata, contentWidth, width),
    renderBottomBorder(width),
  ];
}

function getMaxVisibleCardRows(
  options: AttachmentSurfaceRenderOptions,
  attachmentCount: number,
  columns: number
): number {
  const cardRows = Math.ceil(attachmentCount / columns);
  const explicitMax = Math.max(1, Math.min(DEFAULT_MAX_CARD_ROWS, normalizeDimension(options.maxCardRows ?? DEFAULT_MAX_CARD_ROWS)));
  if (options.height === undefined) return Math.min(explicitMax, cardRows);

  const availableAfterHeader = Math.max(0, normalizeDimension(options.height) - 1);
  const rowsWithoutOverflow = Math.floor(availableAfterHeader / CARD_HEIGHT);
  const rowsWithOverflow = Math.floor(Math.max(0, availableAfterHeader - 1) / CARD_HEIGHT);
  const visibleRows = cardRows > rowsWithoutOverflow ? rowsWithOverflow : rowsWithoutOverflow;
  return Math.max(1, Math.min(explicitMax, cardRows, visibleRows));
}

function getAttachmentColumns(width: number, attachmentCount: number): number {
  const normalized = normalizeDimension(width);
  let desired = normalized >= 120 ? 3 : normalized >= 90 ? 2 : 1;
  desired = Math.min(desired, Math.max(1, attachmentCount));

  while (desired > 1 && getAttachmentCardWidth(normalized, desired) < MIN_CARD_WIDTH) {
    desired -= 1;
  }

  return Math.max(1, desired);
}

function getAttachmentCardWidth(width: number, columns: number): number {
  return Math.max(1, Math.floor((normalizeDimension(width) - CARD_GAP * Math.max(0, columns - 1)) / columns));
}

function formatAttachmentMetadata(attachment: AttachmentCardState): string {
  if (attachment.kind === "fileExcerpt") {
    return formatLineCount(attachment.metadata.lines ?? countLines(attachment.content));
  }
  return formatCharCount(attachment.metadata.chars ?? attachment.content.length);
}

function createAttachmentPreview(content: string): string {
  const collapsed = redactSensitiveText(content).replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? "(empty)" : collapsed;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\n|\r/u).length;
}

function formatCharCount(chars: number): string {
  return `${formatNumber(chars)} chars`;
}

function formatLineCount(lines: number): string {
  return `${formatNumber(lines)} lines`;
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
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
