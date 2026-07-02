import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

export type ContextCompactionSurfaceState = {
  readonly didCompress: boolean;
  readonly tone?: "brand" | "warning";
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly savedTokens: number;
  readonly savingsPercent: number;
  readonly omittedToolResults: number;
  readonly warningCount?: number;
  readonly skippedReason?: string;
  readonly focusTopic?: string;
  readonly activeSessionId?: string;
};

export type ContextCompactionStatusSurfaceState = {
  readonly kind: "cancelled" | "failed" | "unavailable";
  readonly detail?: string;
};

export type ContextCompactionSurfaceRenderOptions = {
  readonly width: number;
  readonly style?: OperatorConsoleStyle;
};

const TITLE_PREFIX = "𓂀  ";
const TITLE_COMPACTED = `${TITLE_PREFIX}Context Compacted`;
const TITLE_UNCHANGED = `${TITLE_PREFIX}Context Unchanged`;
const TITLE_CANCELLED = `${TITLE_PREFIX}Context Compaction Cancelled`;
const TITLE_FAILED = `${TITLE_PREFIX}Context Compaction Failed`;
const TITLE_UNAVAILABLE = `${TITLE_PREFIX}Context Compaction Unavailable`;
const LABEL_WIDTH = 10;

export function getContextCompactionSurfaceDesiredHeight(
  state: ContextCompactionSurfaceState
): number {
  return contextCompactionRows(state).length + 2;
}

export function renderContextCompactionSurface(
  state: ContextCompactionSurfaceState,
  options: ContextCompactionSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const rows = contextCompactionRows(state);
  const title = state.didCompress ? TITLE_COMPACTED : TITLE_UNCHANGED;
  const frameWidth = compactFrameWidth(title, rows, width);
  if (frameWidth < 3) return [truncateVisibleCells(`${title}: ${rows.join(" ")}`, width)];

  const contentWidth = Math.max(0, frameWidth - 4);
  return [
    renderTopBorder(title, frameWidth, options.style, state.tone ?? "brand"),
    ...rows.map((row) => renderContentRow(row, contentWidth, frameWidth, options.style)),
    renderBottomBorder(frameWidth, options.style),
  ];
}

export function renderContextCompactionStatusSurface(
  state: ContextCompactionStatusSurfaceState,
  options: ContextCompactionSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];

  const title = statusTitle(state.kind);
  const rows = contextCompactionStatusRows(state);
  const frameWidth = compactFrameWidth(title, rows, width);
  if (frameWidth < 3) return [truncateVisibleCells(`${title}: ${rows.join(" ")}`, width)];

  const contentWidth = Math.max(0, frameWidth - 4);
  return [
    renderTopBorder(title, frameWidth, options.style, state.kind === "failed" ? "error" : "warning"),
    ...rows.map((row) => renderContentRow(row, contentWidth, frameWidth, options.style)),
    renderBottomBorder(frameWidth, options.style),
  ];
}

function contextCompactionRows(state: ContextCompactionSurfaceState): readonly string[] {
  const rows = [
    formatStatRow("Messages", `${formatNumber(state.messagesBefore)} → ${formatNumber(state.messagesAfter)}`),
    formatStatRow("Tokens", `${formatNumber(state.tokensBefore)} → ${formatNumber(state.tokensAfter)}`),
    formatStatRow("Saved", `~${formatNumber(state.savedTokens)} tokens · ${formatNumber(state.savingsPercent)}%`),
  ];

  const details: string[] = [];
  const note = compactionNote(state);
  if (note !== undefined) details.push(formatStatRow("Note", note));
  if ((state.warningCount ?? 0) > 0) {
    details.push(formatStatRow(
      "Warning",
      `${formatNumber(state.warningCount ?? 0)} compaction warning${state.warningCount === 1 ? "" : "s"} ${state.warningCount === 1 ? "was" : "were"} recorded.`
    ));
  }
  if (state.focusTopic !== undefined && state.focusTopic.trim().length > 0) {
    details.push(formatStatRow("Focus", state.focusTopic.trim()));
  }
  if (state.activeSessionId !== undefined && state.activeSessionId.trim().length > 0) {
    details.push(formatStatRow("Session", state.activeSessionId.trim()));
  }

  return details.length === 0 ? rows : [...rows, "", ...details];
}

function contextCompactionStatusRows(state: ContextCompactionStatusSurfaceState): readonly string[] {
  const status = statusMessage(state.kind);
  const detail = state.detail?.trim();
  return detail === undefined || detail.length === 0
    ? [formatStatRow("Status", status)]
    : [formatStatRow("Status", status), formatStatRow("Detail", detail)];
}

function statusTitle(kind: ContextCompactionStatusSurfaceState["kind"]): string {
  if (kind === "cancelled") return TITLE_CANCELLED;
  if (kind === "failed") return TITLE_FAILED;
  return TITLE_UNAVAILABLE;
}

function statusMessage(kind: ContextCompactionStatusSurfaceState["kind"]): string {
  if (kind === "cancelled") return "Compaction was cancelled.";
  if (kind === "failed") return "Compaction failed.";
  return "Compaction is unavailable in this runtime.";
}

function compactionNote(state: ContextCompactionSurfaceState): string | undefined {
  if (!state.didCompress) {
    return `Compaction skipped: ${state.skippedReason ?? "not needed"}.`;
  }
  if (state.omittedToolResults <= 0) return undefined;
  return `${formatNumber(state.omittedToolResults)} older tool result${state.omittedToolResults === 1 ? "" : "s"} ${state.omittedToolResults === 1 ? "was" : "were"} omitted.`;
}

function formatStatRow(label: string, value: string): string {
  return `${padVisibleEnd(label, LABEL_WIDTH)} ${value}`;
}

function compactFrameWidth(title: string, rows: readonly string[], maxWidth: number): number {
  const titleWidth = stringWidth(`─ ${title} `) + 2;
  const contentWidth = rows.reduce((widest, row) => Math.max(widest, stringWidth(row) + 4), 0);
  const desired = Math.max(3, titleWidth, contentWidth);
  return Math.max(0, Math.min(maxWidth, desired));
}

function renderTopBorder(
  title: string,
  width: number,
  style: OperatorConsoleStyle | undefined,
  tone: "brand" | "warning" | "error"
): string {
  if (width <= 1) return "╭".slice(0, width);
  const styledTitle = styleColor(style, styleBold(style, title), titleColor(style, tone));
  const label = `─ ${styledTitle} `;
  const remaining = Math.max(0, width - 2 - stringWidth(label));
  return truncateVisibleCells(`╭${label}${"─".repeat(remaining)}╮`, width);
}

function renderBottomBorder(width: number, _style: OperatorConsoleStyle | undefined): string {
  if (width <= 1) return "╰".slice(0, width);
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderContentRow(
  row: string,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): string {
  if (width <= 1) return "│".slice(0, width);
  const content = padVisibleEnd(truncateVisibleCells(styleContentRow(row, style), contentWidth), contentWidth);
  return truncateVisibleCells(`│ ${content} │`, width);
}

function styleContentRow(row: string, style: OperatorConsoleStyle | undefined): string {
  if (!row.startsWith("Warning")) return row;
  const label = row.slice(0, LABEL_WIDTH);
  return `${styleColor(style, label, style?.tokens.contract.palette.caution ?? "")}${row.slice(LABEL_WIDTH)}`;
}

function titleColor(style: OperatorConsoleStyle | undefined, tone: "brand" | "warning" | "error"): string {
  if (tone === "error") return style?.tokens.contract.severity.error ?? "";
  if (tone === "warning") return style?.tokens.contract.palette.caution ?? "";
  return style?.tokens.contract.palette.brand ?? "";
}

function formatNumber(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return new Intl.NumberFormat("en-US").format(safe);
}

function padVisibleEnd(value: string, width: number): string {
  const current = stringWidth(value);
  if (current >= width) return value;
  return `${value}${" ".repeat(width - current)}`;
}

function truncateVisibleCells(value: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return truncateVisible(value, maxCells, "");
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
