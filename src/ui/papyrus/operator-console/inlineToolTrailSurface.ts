import { formatToolActivityRow } from "./activeWorkSurface.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { InlineToolTrailEntry } from "./operatorConsoleState.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type InlineToolTrailRowOptions = {
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
  readonly locale?: OperatorConsoleLocale;
};

export function formatInlineToolTrailRow(
  entry: InlineToolTrailEntry,
  width: number,
  options: InlineToolTrailRowOptions = {}
): string {
  return formatToolActivityRow({
    toolName: entry.toolName,
    displayLabel: entry.displayLabel,
    status: entry.status,
    summary: entry.summary,
    target: entry.target,
    durationMs: resolveEntryDurationMs(entry),
  }, width, {
    style: options.style,
    motionElapsedMs: options.motionElapsedMs,
    locale: options.locale,
    tone: entry.status === "running" || entry.status === "queued" || entry.status === "awaitingApproval"
      ? "live"
      : "history",
    indent: 2,
  });
}

function resolveEntryDurationMs(entry: InlineToolTrailEntry): number {
  if (entry.durationMs !== undefined) return entry.durationMs;
  if (entry.startedAtMs !== undefined && entry.endedAtMs !== undefined) {
    return entry.endedAtMs - entry.startedAtMs;
  }
  return 0;
}
