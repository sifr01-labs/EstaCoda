import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { StatusRailState } from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { formatUsageCost, formatUsdAmount } from "../../usage-cost-format.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import { isolateLtr } from "../../bidi.js";

export type StatusRailRenderOptions = {
  readonly width: number;
  readonly style?: OperatorConsoleStyle;
  readonly locale?: OperatorConsoleLocale;
};

const CONTEXT_BAR_CELLS = 10;
const SEGMENT_SEPARATOR = " · ";

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
  const timer = formatSessionTimer(state.sessionTimer.elapsedMs);
  const sessionIcon = options.style?.tokens.contract.toolIcon.cronjob ?? "◷";
  const timerSegment = formatSessionValue(`${sessionIcon} ${timer}`, options.style);
  const bar = formatContextBar(state, contextPercent, options.style);
  const numbers = formatContextNumbers(state);
  const symbol = modelStateSymbol(state.model.state, state.model.route, options.style);
  const securityBadge = formatSecurityBadge(state, options.style);
  const cost = state.sessionCost === undefined
    ? undefined
    : formatUsageCost(state.sessionCost, { locale: options.locale, compact: true });
  const sessionTokens = state.sessionCost === undefined
    ? undefined
    : formatSessionTokens(
        state.sessionCost.totalTokens,
        state.sessionCost.usageComplete,
        options.locale
      );
  const budget = state.sessionCost?.budget;
  const budgetSuffix = budget === undefined
    ? ""
    : `/${formatUsdAmount(budget.maxEstimatedCostUsd, options.locale)} +${formatUsdAmount(budget.reservedCostUsd, options.locale)} ${options.locale === "ar" ? "محجوز" : "reserved"}`;
  const costWithBudget = cost === undefined ? undefined : `${cost}${budgetSuffix}`;
  const sessionFull = joinSegments([
    formatSessionValue(sessionTokens, options.style),
    formatCostValue(costWithBudget, state, options.style),
  ], options.style);
  const contextFull = formatContextSegment(bar, numbers, options.style);
  const contextCompact = formatContextNumbersSegment(numbers, options.style);
  const identityFull = formatIdentitySegments(state, securityBadge, false, options.style, options.locale);
  const identityShort = formatIdentitySegments(state, securityBadge, true, options.style, options.locale);

  const full = alignRight(
    joinSegments([model, ...identityFull, contextFull, timerSegment], options.style),
    sessionFull,
    width,
    options.style
  );
  if (full !== undefined) return full;

  const shortIdentity = alignRight(
    joinSegments([model, ...identityShort, contextFull, timerSegment], options.style),
    sessionFull,
    width,
    options.style
  );
  if (shortIdentity !== undefined) return shortIdentity;

  const compactIdentity = alignRight(
    joinSegments([model, ...identityShort, contextCompact, timerSegment], options.style),
    sessionFull,
    width,
    options.style
  );
  if (compactIdentity !== undefined) return compactIdentity;

  const fullWithoutIdentity = alignRight(
    joinSegments([model, contextFull, timerSegment], options.style),
    sessionFull,
    width,
    options.style
  );
  if (fullWithoutIdentity !== undefined) return fullWithoutIdentity;

  const compact = alignRight(
    joinSegments([model, contextCompact, timerSegment], options.style),
    sessionFull,
    width,
    options.style
  );
  if (compact !== undefined) return compact;

  const narrowCost = cost === undefined
    ? undefined
    : budget === undefined ? cost : `${cost}/${formatUsdAmount(budget.maxEstimatedCostUsd, options.locale)}`;
  const narrowSession = joinSegments([
    formatSessionValue(sessionTokens, options.style),
    formatCostValue(narrowCost, state, options.style),
  ], options.style);
  const narrow = alignRight(
    joinSegments([`${narrowModel} ${symbol}`, contextCompact, timerSegment], options.style),
    narrowSession,
    width,
    options.style
  );
  if (narrow !== undefined) return narrow;

  const essential = alignRight(
    joinSegments([contextCompact, timerSegment], options.style),
    narrowSession,
    width,
    options.style
  );
  if (essential !== undefined) return essential;

  const telemetry = joinSegments([sessionTokens, narrowCost], options.style);
  if (telemetry.length > 0 && stringWidth(telemetry) <= width) {
    return telemetry;
  }
  if (narrowCost !== undefined) {
    return truncateVisibleCells(narrowCost, width);
  }
  const minimal = joinSegments([`${minimalModel} ${symbol}`, numbers, timer], options.style);
  if (stringWidth(minimal) <= width) return minimal;
  const contextAndTimer = joinSegments([numbers, timer], options.style);
  if (stringWidth(contextAndTimer) <= width) return contextAndTimer;
  return truncateVisibleCells(numbers, width);
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
  const label = modelLabelOrFallback(state.model.label);
  const styledLabel = style === undefined
    ? label
    : styleColor(style, label, style.tokens.contract.text.primary);
  return `${styledLabel} ${modelStateSymbol(state.model.state, state.model.route, style)}`;
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

function formatContextNumbers(state: StatusRailState): string {
  const used = state.context.usedTokens === undefined ? "--" : formatTokenCount(state.context.usedTokens);
  if (state.context.totalTokens === undefined) return used;
  return `${used}/${formatTokenCount(state.context.totalTokens)}`;
}

function formatContextNumbersSegment(
  value: string,
  style: OperatorConsoleStyle | undefined
): string {
  if (style === undefined) return `ctx ${value}`;
  const tokens = style.tokens.contract;
  return `${styleColor(style, "ctx", tokens.text.muted)} ${styleColor(style, value, tokens.text.secondary)}`;
}

function formatContextSegment(
  bar: string,
  value: string,
  style: OperatorConsoleStyle | undefined
): string {
  if (style === undefined) return `ctx ${bar} ${value}`;
  const tokens = style.tokens.contract;
  return `${styleColor(style, "ctx", tokens.text.muted)} ${bar} ${styleColor(style, value, tokens.text.secondary)}`;
}

function formatContextBar(
  state: StatusRailState,
  percent: number,
  style: OperatorConsoleStyle | undefined
): string {
  if (style === undefined) {
    return state.context.usedTokens === undefined
      ? `[${"·".repeat(CONTEXT_BAR_CELLS)}]`
      : renderContextBar(percent);
  }
  const tokens = style.tokens.contract;
  const muted = tokens.text.muted;
  if (state.context.usedTokens === undefined) {
    return styleColor(style, `[${"·".repeat(CONTEXT_BAR_CELLS)}]`, muted);
  }
  const fullCells = percent <= 0 ? 0 : Math.ceil((clampPercent(percent) / 100) * CONTEXT_BAR_CELLS);
  const fillColor = percent >= 90
    ? tokens.severity.error
    : percent >= 70 ? tokens.palette.caution : tokens.interactive.primary;
  return [
    styleColor(style, "[", muted),
    styleColor(style, "▰".repeat(fullCells), fillColor),
    styleColor(style, "▱".repeat(Math.max(0, CONTEXT_BAR_CELLS - fullCells)), muted),
    styleColor(style, "]", muted),
  ].join("");
}

function formatTokenCount(value: number): string {
  const normalized = Math.max(0, Math.floor(value));
  if (normalized < 1000) return String(normalized);
  const thousands = normalized / 1000;
  if (Number.isInteger(thousands)) return `${thousands}k`;
  return `${thousands.toFixed(1).replace(/\.0$/u, "")}k`;
}

function formatSessionTokens(
  value: number,
  complete: boolean,
  locale: OperatorConsoleLocale | undefined
): string {
  const count = `${formatTokenCount(value)} tok`;
  const formatted = complete ? count : `≥ ${count}`;
  return locale === "ar" ? isolateLtr(formatted) : formatted;
}

function formatIdentitySegments(
  state: StatusRailState,
  securityBadge: string | undefined,
  compact: boolean,
  style: OperatorConsoleStyle | undefined,
  locale: OperatorConsoleLocale | undefined
): readonly string[] {
  if (securityBadge !== undefined) return [securityBadge];
  const workspace = state.workspace;
  if (workspace === undefined) return [];
  const label = isolateTechnicalToken(compact ? workspace.shortLabel : workspace.label, locale);
  const branch = compact || workspace.branch === undefined
    ? undefined
    : isolateTechnicalToken(workspace.branch, locale);
  if (style === undefined) return [label, branch].filter((value): value is string => value !== undefined);
  const tokens = style.tokens.contract;
  return [
    styleColor(style, label, tokens.interactive.primary),
    ...(branch === undefined
      ? []
      : [styleColor(style, branch, tokens.text.secondary)]),
  ];
}

function isolateTechnicalToken(value: string, locale: OperatorConsoleLocale | undefined): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function formatSessionValue(
  value: string | undefined,
  style: OperatorConsoleStyle | undefined
): string | undefined {
  if (value === undefined || style === undefined) return value;
  return styleColor(style, value, style.tokens.contract.text.secondary);
}

function formatCostValue(
  value: string | undefined,
  state: StatusRailState,
  style: OperatorConsoleStyle | undefined
): string | undefined {
  if (value === undefined || style === undefined) return value;
  const tokens = style.tokens.contract;
  const color = state.sessionCost?.budget?.state === "exhausted"
    ? tokens.severity.error
    : state.sessionCost?.budget?.state === "warning"
      ? tokens.palette.caution
      : tokens.text.secondary;
  return styleColor(style, value, color);
}

function joinSegments(
  segments: readonly (string | undefined)[],
  style: OperatorConsoleStyle | undefined
): string {
  const separator = renderSeparator(style);
  return segments.filter((segment): segment is string => segment !== undefined && segment.length > 0).join(separator);
}

function alignRight(
  left: string,
  right: string,
  width: number,
  style: OperatorConsoleStyle | undefined
): string | undefined {
  if (right.length === 0) {
    const leftWidth = stringWidth(left);
    return leftWidth <= width ? `${left}${" ".repeat(width - leftWidth)}` : undefined;
  }
  const minimumWidth = stringWidth(left) + stringWidth(SEGMENT_SEPARATOR) + stringWidth(right);
  if (minimumWidth > width) return undefined;
  const flexibleSpace = width - minimumWidth;
  return `${left}${" ".repeat(flexibleSpace)}${renderSeparator(style)}${right}`;
}

function renderSeparator(style: OperatorConsoleStyle | undefined): string {
  return style === undefined
    ? SEGMENT_SEPARATOR
    : styleColor(style, SEGMENT_SEPARATOR, style.tokens.contract.text.muted);
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
