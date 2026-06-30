import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { SetupPanelState, SetupPanelStatusLine } from "./operatorConsoleState.js";

export type SetupSelectRuntimeOption = {
  readonly id?: string;
  readonly label: string;
  readonly description?: string;
  readonly group?: "main" | "navigation";
  readonly cells?: Readonly<Record<string, string>>;
  readonly badges?: readonly string[];
  readonly current?: boolean;
};

export type SetupSelectRuntimeColumn = {
  readonly key: string;
  readonly header: string;
  readonly align?: "left" | "right";
};

export type SetupSelectRuntimeMapperInput = {
  readonly title: string;
  readonly body?: string;
  readonly hint?: string;
  readonly statusLines?: readonly SetupPanelStatusLine[];
  readonly locale?: OperatorConsoleLocale;
  readonly columns?: readonly SetupSelectRuntimeColumn[];
  readonly options: readonly SetupSelectRuntimeOption[];
  readonly selectedIndex: number;
};

export function mapSetupSelectToSetupPanelState(
  input: SetupSelectRuntimeMapperInput
): SetupPanelState | undefined {
  if (input.options.length === 0) return undefined;
  const selectedIndex = clampIndex(input.selectedIndex, input.options.length);
  return {
    kind: "table",
    layout: isChoiceMenu(input.columns, input.options) ? "choiceMenu" : "routeTable",
    title: input.title,
    description: bodyDescription(input.body),
    ...(input.statusLines === undefined ? {} : { statusLines: input.statusLines }),
    locale: input.locale,
    rows: input.options.map((option, index) => mapOptionToRow(option, index)),
    selectedRowId: optionId(input.options[selectedIndex], selectedIndex),
    footer: defaultFooter(),
  };
}

function mapOptionToRow(option: SetupSelectRuntimeOption, index: number): SetupPanelState["rows"][number] {
  const cells = option.cells ?? {};
  return {
    id: optionId(option, index),
    provider: firstNonEmpty(cells.provider, cells.name, option.label),
    model: firstNonEmpty(cells.model, cells.route, cells.value),
    status: firstNonEmpty(cells.status, cells.state, option.description, cells.details),
    notes: firstNonEmpty(cells.notes, cells.description, badgesText(option), option.current === true ? "current" : ""),
    ...(option.group === undefined ? {} : { group: option.group }),
  };
}

function isChoiceMenu(
  columns: readonly SetupSelectRuntimeColumn[] | undefined,
  options: readonly SetupSelectRuntimeOption[]
): boolean {
  if (columns === undefined) return !options.some(hasRouteTableCells);
  if (columns.length !== 2) return false;
  const keys = new Set(columns.map((column) => column.key));
  return keys.has("name") && (keys.has("description") || keys.has("details"));
}

function hasRouteTableCells(option: SetupSelectRuntimeOption): boolean {
  const cells = option.cells;
  if (cells === undefined) return false;
  return cells.provider !== undefined ||
    cells.model !== undefined ||
    cells.route !== undefined ||
    cells.value !== undefined ||
    cells.status !== undefined ||
    cells.state !== undefined ||
    cells.notes !== undefined;
}

function optionId(option: SetupSelectRuntimeOption | undefined, index: number): string {
  return option?.id ?? String(index);
}

function badgesText(option: SetupSelectRuntimeOption): string {
  return option.badges?.join(", ") ?? "";
}

function bodyDescription(body: string | undefined): string | undefined {
  const lines = body?.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) ?? [];
  return lines.length === 0 ? undefined : lines.join("\n");
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim().length > 0) ?? "";
}

function defaultFooter(): string {
  return "↑↓ navigate   ENTER select   CTRL+C exit";
}

function clampIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.floor(index), 0), optionCount - 1);
}
