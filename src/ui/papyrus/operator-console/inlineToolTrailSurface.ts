import { truncateVisible } from "../../renderers/layout.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  activeWorkStatusSymbol,
  formatActiveWorkDuration,
} from "./activeWorkSurface.js";
import type { InlineToolTrailEntry } from "./operatorConsoleState.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

const TOOL_DETAIL_GAP_CELLS = 3;

export type InlineToolTrailRowOptions = {
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
};

export function formatInlineToolTrailRow(
  entry: InlineToolTrailEntry,
  width: number,
  options: InlineToolTrailRowOptions = {}
): string {
  const normalizedWidth = normalizeDimension(width);
  if (normalizedWidth <= 0) return "";

  const symbol = activeWorkStatusSymbol(entry.status, options.motionElapsedMs, options.style);
  const tool = normalizeText(entry.displayLabel ?? entry.toolName, "tool");
  const detail = normalizeText(entry.target ?? entry.summary, entry.status);
  const duration = formatActiveWorkDuration(resolveEntryDurationMs(entry));
  const prefix = `  ${symbol} `;
  if (normalizedWidth <= stringWidth(prefix) + 1) return truncateVisible(prefix.trimEnd(), normalizedWidth, "");

  const durationPart = normalizedWidth >= 16 ? ` ${duration}` : "";
  const available = Math.max(0, normalizedWidth - stringWidth(prefix) - stringWidth(durationPart));
  if (available <= 0) return truncateVisible(`${prefix}${tool}`, normalizedWidth, "");

  const toolCells = Math.min(18, Math.max(1, Math.min(available, Math.floor(available * 0.35))));
  const detailGapCells = available > toolCells ? Math.min(TOOL_DETAIL_GAP_CELLS, available - toolCells) : 0;
  const detailCells = Math.max(0, available - toolCells - detailGapCells);
  const renderedTool = padVisibleEnd(truncateVisible(tool, toolCells, ""), toolCells);
  const renderedDetail = detailCells <= 0 ? "" : padVisibleEnd(truncateVisible(detail, detailCells, ""), detailCells);
  const detailGap = " ".repeat(detailGapCells);
  const row = `${prefix}${renderedTool}${detailGapCells > 0 ? `${detailGap}${renderedDetail}` : ""}${durationPart}`;

  return truncateVisible(row, normalizedWidth, "");
}

function resolveEntryDurationMs(entry: InlineToolTrailEntry): number {
  if (entry.durationMs !== undefined) return entry.durationMs;
  if (entry.startedAtMs !== undefined && entry.endedAtMs !== undefined) {
    return entry.endedAtMs - entry.startedAtMs;
  }
  return 0;
}

function padVisibleEnd(value: string, width: number): string {
  const padCells = Math.max(0, width - stringWidth(value));
  return `${value}${" ".repeat(padCells)}`;
}

function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? fallback : normalized;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
