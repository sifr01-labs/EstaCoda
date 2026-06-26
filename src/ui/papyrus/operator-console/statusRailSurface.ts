import { stringWidth } from "../screen/stringWidth.js";
import type { StatusRailState } from "./operatorConsoleState.js";

export type StatusRailRenderOptions = {
  readonly width: number;
};

const CONTEXT_BAR_CELLS = 10;

export function renderStatusRailSurface(
  state: StatusRailState,
  options: StatusRailRenderOptions
): string {
  const width = normalizeWidth(options.width);
  if (width <= 0) return "";

  const model = formatModel(state);
  const narrowModel = shortenModelLabel(state.model.label, 10);
  const minimalModel = shortenModelLabel(state.model.label, 4);
  const percent = formatPercent(resolveContextPercent(state));
  const timer = formatSessionTimer(state.sessionTimer.elapsedMs);
  const bar = renderContextBar(resolveContextPercent(state));
  const numbers = formatContextNumbers(state);

  const full = `${model} │ ctx ${bar} ${numbers} ${percent} │ session ${timer}`;
  if (stringWidth(full) <= width) return full;

  const compact = `${model} │ ctx ${bar} ${percent} │ session ${timer}`;
  if (stringWidth(compact) <= width) return compact;

  const narrow = `${narrowModel} ${modelStateSymbol(state.model.state)} │ ctx ${percent} │ ${timer}`;
  if (stringWidth(narrow) <= width) return narrow;

  const minimal = `${minimalModel} ${modelStateSymbol(state.model.state)} ${percent} ${timer}`;
  return truncateVisibleCells(minimal, width);
}

export function renderContextBar(percent: number, cells = CONTEXT_BAR_CELLS): string {
  const normalizedCells = Math.max(0, Math.floor(cells));
  const clampedPercent = clampPercent(percent);
  const fullCells = clampedPercent <= 0 ? 0 : Math.ceil((clampedPercent / 100) * normalizedCells);
  return `[${"▰".repeat(fullCells)}${"▱".repeat(Math.max(0, normalizedCells - fullCells))}]`;
}

export function resolveContextPercent(state: StatusRailState): number {
  if (state.context.percent !== undefined) return clampPercent(state.context.percent);
  if (state.context.totalTokens !== undefined && state.context.totalTokens > 0) {
    return clampPercent((state.context.usedTokens / state.context.totalTokens) * 100);
  }
  return 0;
}

export function formatSessionTimer(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatModel(state: StatusRailState): string {
  return `${modelLabelOrFallback(state.model.label)} ${modelStateSymbol(state.model.state)}`;
}

function modelLabelOrFallback(label: string): string {
  return label.trim().length === 0 ? "model pending" : label.trim();
}

function modelStateSymbol(state: StatusRailState["model"]["state"]): string {
  switch (state) {
    case "working":
      return "●";
    case "degraded":
      return "◐";
    case "idle":
      return "○";
  }
}

function formatPercent(percent: number): string {
  return `${Math.round(clampPercent(percent))}%`;
}

function formatContextNumbers(state: StatusRailState): string {
  if (state.context.totalTokens === undefined) return formatTokenCount(state.context.usedTokens);
  return `${formatTokenCount(state.context.usedTokens)}/${formatTokenCount(state.context.totalTokens)}`;
}

function formatTokenCount(value: number): string {
  const normalized = Math.max(0, Math.floor(value));
  if (normalized < 1000) return String(normalized);
  const thousands = normalized / 1000;
  if (Number.isInteger(thousands)) return `${thousands}k`;
  return `${thousands.toFixed(1).replace(/\.0$/u, "")}k`;
}

function shortenModelLabel(label: string, maxCells: number): string {
  const fallback = modelLabelOrFallback(label);
  const truncated = truncateVisibleCells(fallback, maxCells);
  if (truncated === fallback) return truncated;
  return truncated.replace(/[-._\s]+$/u, "");
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeWidth(maxCells);
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;

  let output = "";
  for (const char of value) {
    if (stringWidth(output + char) > width) break;
    output += char;
  }
  return output;
}

function normalizeWidth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
