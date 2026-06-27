import { chromeCopy } from "../../cli-ui-copy.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { TurnActivityState } from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type TurnActivitySurfaceRenderOptions = {
  readonly width: number;
  readonly locale?: "en" | "ar";
  readonly style?: OperatorConsoleStyle;
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
  const spinner = turnActivitySpinner(state, options.style);
  const label = turnActivityLabel(state, options.locale);
  const styledLabel = styleColor(options.style, label, options.style?.tokens.contract.text.secondary ?? "");
  return [truncateVisible(`${spinner} ${styledLabel}`, width, "")];
}

function turnActivitySpinner(
  state: TurnActivityState,
  style: OperatorConsoleStyle | undefined
): string {
  const frames = state.phase === "background"
    ? style?.tokens.contract.glyph.spinner.background ?? ["⡀"]
    : style?.tokens.contract.glyph.spinner.thinking ?? ["⠋"];
  const frame = frames[frameIndex(state.frameIndex, frames.length)] ?? "";
  return styleColor(style, frame, style?.tokens.contract.palette.caution ?? "");
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

function frameIndex(input: number | undefined, length: number): number {
  if (length <= 0) return 0;
  if (input === undefined || !Number.isFinite(input)) return 0;
  return Math.abs(Math.floor(input)) % length;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
