import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { StatusRailState } from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { formatUsageCost } from "../../usage-cost-format.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";

export type StatusRailRenderOptions = {
  readonly width: number;
  readonly style?: OperatorConsoleStyle;
  readonly locale?: OperatorConsoleLocale;
};

const CONTEXT_BAR_CELLS = 10;

export function renderStatusRailSurface(
  state: StatusRailState,
  options: StatusRailRenderOptions
): string {
  const width = normalizeWidth(options.width);
  if (width <= 0) return "";

  const model = formatModel(state, options.style);
  const narrowModel = shortenModelLabel(state.model.label, 10);
  const minimalModel = shortenModelLabel(state.model.label, 4);
  const contextPercent = resolveContextPercent(state);
  const percent = state.context.usedTokens === undefined ? "--%" : formatPercent(contextPercent);
  const timer = formatSessionTimer(state.sessionTimer.elapsedMs);
  const sessionIcon = options.style?.tokens.contract.toolIcon.cronjob ?? "◷";
  const bar = state.context.usedTokens === undefined
    ? `[${"·".repeat(CONTEXT_BAR_CELLS)}]`
    : renderContextBar(contextPercent);
  const numbers = formatContextNumbers(state);
  const symbol = modelStateSymbol(state.model.state, state.model.route, options.style);
  const securityBadge = formatSecurityBadge(state, options.style);
  const securitySegment = securityBadge === undefined ? "" : ` │ ${securityBadge}`;
  const cost = state.sessionCost === undefined
    ? undefined
    : formatUsageCost(state.sessionCost, { locale: options.locale, compact: true });
  const costLabel = options.locale === "ar" ? "الجلسة" : "session";
  const costSegment = cost === undefined ? "" : ` │ ${costLabel} ${cost}`;

  const full = `${model}${securitySegment} │ ctx ${bar} ${numbers} ${percent}${costSegment} │ ${sessionIcon} ${timer}`;
  if (stringWidth(full) <= width) return full;

  const compact = `${model}${securitySegment} │ ctx ${bar} ${percent}${costSegment} │ ${sessionIcon} ${timer}`;
  if (stringWidth(compact) <= width) return compact;

  const compactWithoutSecurity = `${model} │ ctx ${bar} ${percent}${costSegment} │ ${sessionIcon} ${timer}`;
  if (stringWidth(compactWithoutSecurity) <= width) return compactWithoutSecurity;

  const narrow = cost === undefined
    ? `${narrowModel} ${symbol} │ ctx ${percent} │ ${timer}`
    : `${narrowModel} ${symbol} │ ${cost} │ ${timer}`;
  if (stringWidth(narrow) <= width) return narrow;

  const minimal = cost === undefined
    ? `${minimalModel} ${symbol} ${percent} ${timer}`
    : `${cost} ${timer}`;
  return truncateVisibleCells(minimal, width);
}

export function renderContextBar(percent: number, cells = CONTEXT_BAR_CELLS): string {
  const normalizedCells = Math.max(0, Math.floor(cells));
  const clampedPercent = clampPercent(percent);
  const fullCells = clampedPercent <= 0 ? 0 : Math.ceil((clampedPercent / 100) * normalizedCells);
  return `[${"▰".repeat(fullCells)}${"▱".repeat(Math.max(0, normalizedCells - fullCells))}]`;
}

export function resolveContextPercent(state: StatusRailState): number {
  if (state.context.usedTokens === undefined) return 0;
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

function formatModel(state: StatusRailState, style: OperatorConsoleStyle | undefined): string {
  return `${modelLabelOrFallback(state.model.label)} ${modelStateSymbol(state.model.state, state.model.route, style)}`;
}

function modelLabelOrFallback(label: string): string {
  return label.trim().length === 0 ? "model pending" : label.trim();
}

function modelStateSymbol(
  state: StatusRailState["model"]["state"],
  route: StatusRailState["model"]["route"],
  style: OperatorConsoleStyle | undefined
): string {
  const symbol = rawModelStateSymbol(state);
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return symbol;
  if (route === "fallback") return styleColor(style, symbol, tokens.palette.caution);
  if (route === "failed") return styleColor(style, symbol, tokens.severity.warn);
  return styleColor(style, symbol, tokens.severity.ok);
}

function rawModelStateSymbol(state: StatusRailState["model"]["state"]): string {
  switch (state) {
    case "working":
      return "●";
    case "degraded":
      return "◐";
    case "idle":
      return "●";
  }
}

function formatSecurityBadge(
  state: StatusRailState,
  style: OperatorConsoleStyle | undefined
): string | undefined {
  if (state.security?.yolo !== true) return undefined;
  const badge = "↯ YOLO";
  const tokens = style?.tokens.contract;
  return tokens === undefined ? badge : styleColor(style, badge, tokens.palette.caution);
}

function formatPercent(percent: number): string {
  return `${Math.round(clampPercent(percent))}%`;
}

function formatContextNumbers(state: StatusRailState): string {
  const used = state.context.usedTokens === undefined ? "--" : formatTokenCount(state.context.usedTokens);
  if (state.context.totalTokens === undefined) return used;
  return `${used}/${formatTokenCount(state.context.totalTokens)}`;
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
  return truncateVisible(value, width, "");
}

function normalizeWidth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
