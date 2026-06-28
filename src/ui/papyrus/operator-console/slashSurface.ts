import { stringWidth } from "../screen/stringWidth.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { SlashMenuState } from "./operatorConsoleState.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type SlashSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly style?: OperatorConsoleStyle;
};

const MAX_SLASH_MENU_HEIGHT = 14;

export function getSlashSurfaceDesiredHeight(state: SlashMenuState | undefined): number {
  if (state === undefined) return 0;
  return Math.max(3, Math.min(MAX_SLASH_MENU_HEIGHT, state.items.length + 2));
}

export function renderSlashSurface(
  state: SlashMenuState | undefined,
  options: SlashSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || state === undefined) return [];

  const desiredHeight = getSlashSurfaceDesiredHeight(state);
  const height = normalizeDimension(options.height ?? desiredHeight);
  if (height <= 0) return [];
  if (height < 3) return [truncateVisibleCells(renderFallbackLine(state), width)];

  const contentWidth = Math.max(0, width - 4);
  const itemRows = Math.max(1, height - 2);
  const startIndex = slashViewportStartIndex(state, itemRows);
  const visibleItems = state.items.slice(startIndex, startIndex + itemRows);
  const commandColumnCells = slashCommandColumnCells(visibleItems, contentWidth);
  const rows = [
    renderTopBorder(titleForSlashMenu(state), width),
    ...visibleItems.map((item) => renderContentRow(
      formatSlashItemRow(state, item, commandColumnCells, options.style),
      contentWidth,
      width
    )),
    renderBottomBorder(width),
  ];

  return rows.slice(0, height);
}

function slashViewportStartIndex(state: SlashMenuState, itemRows: number): number {
  if (state.items.length <= itemRows) return 0;
  const activeIndex = state.activeItemId === undefined
    ? 0
    : state.items.findIndex((item) => item.id === state.activeItemId);
  if (activeIndex < 0) return 0;
  if (activeIndex < itemRows) return 0;
  return Math.min(activeIndex - itemRows + 1, state.items.length - itemRows);
}

function titleForSlashMenu(state: SlashMenuState): string {
  return state.query.length <= 2 ? "Command palette" : "Commands";
}

function formatSlashItemRow(
  state: SlashMenuState,
  item: SlashMenuState["items"][number],
  commandColumnCells: number,
  style: OperatorConsoleStyle | undefined
): string {
  const selected = item.id === state.activeItemId;
  const marker = selected ? "❯" : " ";
  const label = padVisibleEnd(truncateVisibleCells(item.label, commandColumnCells), commandColumnCells);
  const detail = item.detail === undefined || item.detail.length === 0 ? "" : `  ${item.detail}`;
  const row = `${marker} ${label}${detail}`;
  return selected && style !== undefined
    ? styleColor(style, row, style.tokens.contract.palette.action)
    : row;
}

function slashCommandColumnCells(items: readonly SlashMenuState["items"][number][], contentWidth: number): number {
  if (items.length === 0) return 1;
  const markerCells = 2;
  const detailGapCells = 2;
  const preferredDetailCells = 16;
  const maxLabelCells = Math.max(...items.map((item) => stringWidth(item.label)));
  const availableAfterMarker = Math.max(1, contentWidth - markerCells);
  if (maxLabelCells + detailGapCells + preferredDetailCells <= availableAfterMarker) {
    return maxLabelCells;
  }
  return Math.max(1, Math.min(maxLabelCells, availableAfterMarker - detailGapCells));
}

function renderFallbackLine(state: SlashMenuState): string {
  const active = state.items.find((item) => item.id === state.activeItemId) ?? state.items[0];
  if (active === undefined) return `Commands: ${state.query}`;
  return `Commands: ${active.label}${active.detail === undefined ? "" : ` ${active.detail}`}`;
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
  return truncateVisible(value, width, "");
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
