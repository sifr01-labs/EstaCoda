import { chromeCopy } from "../../cli-ui-copy.js";
import { closeOpenBidiIsolates } from "../../bidi.js";
import { truncateVisible } from "../../renderers/layout.js";
import { semanticMotionForPhase, semanticMotionFrame } from "../../semantic-motion.js";
import { stringWidth, stripAnsi } from "../screen/stringWidth.js";
import { formatLiveActiveWorkStatus } from "./activeWorkSurface.js";
import { resolveActiveWorkCopy } from "./activeWorkCopy.js";
import type { ToolActivityState, TurnActivityState } from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type TurnActivitySurfaceRenderOptions = {
  readonly width: number;
  readonly locale?: "en" | "ar";
  readonly activeWork?: ToolActivityState;
  readonly style?: OperatorConsoleStyle;
  readonly motionElapsedMs?: number;
};

export function getTurnActivitySurfaceDesiredHeight(state: TurnActivityState | undefined): number {
  return state === undefined ? 0 : 1;
}

export function renderTurnActivitySurface(
  state: TurnActivityState | undefined,
  options: TurnActivitySurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || state === undefined) return [];
  const spinner = turnActivitySpinner(state, options.style, options.motionElapsedMs);
  const label = turnActivityLabel(state, options.locale);
  const activeWorkStatus = formatLiveActiveWorkStatus(options.activeWork ?? { items: [], scrollOffset: 0, expanded: false }, {
    locale: options.locale,
  });
  const activityLabel = resolveActiveWorkCopy(options.locale).activity;
  const fullLabel = activeWorkStatus === undefined ? label : `${label} · ${activityLabel}: ${activeWorkStatus}`;
  const spinnerWidth = stringWidth(spinner);
  if (spinnerWidth >= width) return [truncateVisible(stripAnsi(spinner), width, "")];
  const fittedLabel = closeOpenBidiIsolates(truncateVisible(fullLabel, width - spinnerWidth - 1, ""));
  const styledFullLabel = styleColor(options.style, fittedLabel, options.style?.tokens.contract.text.secondary ?? "");
  return [`${spinner} ${styledFullLabel}`];
}

function turnActivitySpinner(
  state: TurnActivityState,
  style: OperatorConsoleStyle | undefined,
  motionElapsedMs: number | undefined
): string {
  const tokenName = semanticMotionForPhase(state.phase);
  const definition = style?.tokens.contract.motion[tokenName];
  if (definition === undefined) return fallbackMotion(state.phase);
  const elapsed = style?.tokens.contract.behavior.allowAnimation === false ? 0 : motionElapsedMs;
  return styleColor(style, semanticMotionFrame(definition, elapsed), definition.color);
}

function turnActivityLabel(state: TurnActivityState, locale: "en" | "ar" | undefined): string {
  if (state.label !== undefined && state.label.trim().length > 0) return state.label;
  const copy = chromeCopy(locale ?? "en");
  if (state.phase === "background") {
    const key = state.backgroundKind ?? "syncingSessionState";
    return copy[key];
  }
  return copy[state.phase];
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function fallbackMotion(phase: TurnActivityState["phase"]): string {
  switch (phase) {
    case "routing": return ">";
    case "provider": return "|";
    case "finalizing": return "o";
    case "background": return ".";
    case "thinking": return "*";
  }
}
