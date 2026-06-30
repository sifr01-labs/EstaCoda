import { stringWidth } from "../screen/stringWidth.js";
import { closeOpenBidiIsolates, isolateLtr, isolateRtl } from "../../../ui/bidi.js";
import type {
  SecretEntryPanelState,
  SetupPanelState,
  SetupPanelStatusLine,
  SetupSurfaceState,
  TextEntryPanelState,
} from "./operatorConsoleState.js";
import { styleBold, styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type SetupPanelRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly style?: OperatorConsoleStyle;
};

const WIDE_TABLE_MIN_WIDTH = 72;

export function getSetupPanelSurfaceDesiredHeight(state: SetupSurfaceState, width: number): number {
  if (state.kind === "secret") return state.optional === true ? 8 : 10;
  if (state.kind === "textInput") return Math.max(8, textEntryDescriptionLineCount(state.description, width) + 6);
  const statusLineCount = state.statusLines?.length ?? 0;
  const navigationSeparatorCount = state.rows.some((row) => row.group === "navigation") ? 1 : 0;
  const descriptionLineCount = panelDescriptionLineCount(state, width);
  if (state.locale === "ar") {
    return Math.max(8, state.rows.length * 2 + navigationSeparatorCount + 5 + descriptionLineCount + statusLineCount);
  }
  const renderedRows = state.layout === "choiceMenu"
    ? choiceMenuRenderedRowCount(state, Math.max(1, width - 4))
    : state.rows.length;
  const baseRows = renderedRows + navigationSeparatorCount + 6 + descriptionLineCount + statusLineCount;
  return normalizeDimension(width) >= WIDE_TABLE_MIN_WIDTH
    ? Math.max(8, baseRows)
    : Math.max(8, renderedRows * 4 + 3 + descriptionLineCount + statusLineCount);
}

export function renderSetupPanelSurface(
  state: SetupSurfaceState,
  options: SetupPanelRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];
  const rows = state.kind === "secret"
    ? renderSecretEntryPanel(state, width, options.style)
    : state.kind === "textInput"
    ? renderTextEntryPanel(state, width, options.style)
    : renderSetupTablePanel(state, width, options.style);
  return options.height === undefined ? rows : rows.slice(0, normalizeDimension(options.height));
}

function renderSetupTablePanel(
  state: SetupPanelState,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const contentWidth = Math.max(0, width - 4);
  const copy = resolveSetupCopy(state.locale);
  const description = state.description ?? copy.modelDescription;
  const footer = state.footer ?? copy.footer;
  const rows = [
    renderSetupPanelTopBorder(state.title, state.locale, width, style),
    ...renderPanelDescriptionRows(description, state.locale, contentWidth, width),
    ...renderStatusLines(state.statusLines, contentWidth, width, style),
    renderContentRow("", contentWidth, width),
    ...(state.locale === "ar"
      ? renderArabicStackedRows(state, contentWidth, width, style)
      : width >= WIDE_TABLE_MIN_WIDTH
      ? state.layout === "choiceMenu"
        ? renderChoiceMenuRows(state, contentWidth, width, style)
        : renderWideTableRows(state, copy, contentWidth, width, style)
      : renderNarrowTableRows(state, contentWidth, width, style)
    ),
    renderContentRow("", contentWidth, width),
    renderFooterRow(footer, state.locale, contentWidth, width, style),
    renderBottomBorder(width),
  ];
  return rows;
}

function renderArabicStackedRows(
  state: SetupPanelState,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const rows: string[] = [];
  let renderedNavigationSeparator = false;

  for (const row of state.rows) {
    if (row.group === "navigation" && !renderedNavigationSeparator && rows.length > 0) {
      rows.push(renderContentRow("", contentWidth, width));
      renderedNavigationSeparator = true;
    }

    const selected = row.id === state.selectedRowId;
    rows.push(renderPrimaryRightContentRow(
      formatArabicOptionLabel(row.provider, selected),
      selected,
      style,
      contentWidth,
      width
    ));

    for (const detailLine of wrapVisibleCells(arabicRowDetail(row, state.layout), contentWidth)) {
      rows.push(renderSecondaryRightContentRow(
        localizeChoiceCell(detailLine),
        style,
        contentWidth,
        width
      ));
    }
  }

  return rows;
}

function renderChoiceMenuRows(
  state: SetupPanelState,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const markerWidth = 2;
  const gap = 2;
  const labelNaturalWidth = Math.max(
    10,
    ...state.rows.map((row) => stringWidth(row.provider))
  );
  const labelWidth = Math.min(Math.max(12, labelNaturalWidth), Math.max(12, Math.floor(contentWidth * 0.34)));
  const detailWidth = Math.max(1, contentWidth - labelWidth - markerWidth - gap * 2);
  const selectedMarker = state.locale === "ar" ? "◂" : "❯";
  const rows: string[] = [];
  let renderedNavigationSeparator = false;

  for (const row of state.rows) {
    if (row.group === "navigation" && !renderedNavigationSeparator && rows.length > 0) {
      rows.push(renderContentRow("", contentWidth, width));
      renderedNavigationSeparator = true;
    }

    const selected = row.id === state.selectedRowId;
    if (isFullWidthOutputRow(row)) {
      for (const line of wrapVisibleCells(row.status, contentWidth)) {
        rows.push(renderContentRow(line, contentWidth, width));
      }
      continue;
    }

    const marker = selected ? selectedMarker : "";
    const detail = choiceMenuDetail(row);
    const line = state.locale === "ar"
      ? [
        physicalChoiceCell(detail, detailWidth, "left", state.locale),
        " ".repeat(gap),
        physicalChoiceCell(row.provider, labelWidth, "right", state.locale),
        " ".repeat(gap),
        physicalChoiceCell(marker, markerWidth, "left", state.locale),
      ].join("")
      : [
        padVisibleEnd(marker, markerWidth),
        " ".repeat(gap),
        padVisibleEnd(row.provider, labelWidth),
        " ".repeat(gap),
        padVisibleEnd(detail, detailWidth),
      ].join("");
    rows.push(renderSelectedContentRow(line, selected, style, contentWidth, width));
  }

  return rows;
}

function styleSelectedChoiceRow(
  line: string,
  selected: boolean,
  style: OperatorConsoleStyle | undefined
): string {
  return selected && style !== undefined
    ? styleColor(style, line, style.tokens.contract.palette.action)
    : line;
}

function renderSelectedContentRow(
  row: string,
  selected: boolean,
  style: OperatorConsoleStyle | undefined,
  contentWidth: number,
  width: number
): string {
  if (!selected || style === undefined || width <= 3) {
    return renderContentRow(row, contentWidth, width);
  }
  const content = padVisibleEnd(truncateVisibleCells(row, contentWidth), contentWidth);
  return renderContentRow(styleSelectedChoiceRow(content, selected, style), contentWidth, width);
}

function renderPrimaryRightContentRow(
  row: string,
  selected: boolean,
  style: OperatorConsoleStyle | undefined,
  contentWidth: number,
  width: number
): string {
  const content = padVisibleStart(truncateVisibleCells(row, contentWidth), contentWidth);
  return renderContentRow(stylePrimaryChoiceRow(content, selected, style), contentWidth, width);
}

function renderSecondaryRightContentRow(
  row: string,
  style: OperatorConsoleStyle | undefined,
  contentWidth: number,
  width: number
): string {
  const content = padVisibleStart(truncateVisibleCells(row, contentWidth), contentWidth);
  return renderContentRow(styleSecondary(content, style), contentWidth, width);
}

function physicalChoiceCell(
  value: string,
  width: number,
  align: "left" | "right",
  locale: SetupPanelState["locale"]
): string {
  const truncated = closeOpenBidiIsolates(truncateVisibleCells(value, width));
  const localized = locale === "ar" ? localizeChoiceCell(truncated) : truncated;
  const padded = align === "right"
    ? padVisibleStart(localized, width)
    : padVisibleEnd(localized, width);
  return locale === "ar" ? isolateLtr(padded) : padded;
}

function localizeChoiceCell(value: string): string {
  if (value.length === 0) return value;
  if (containsArabicScript(value)) {
    return isolateRtl(closeOpenBidiIsolates(value));
  }
  return /[A-Za-z0-9]/u.test(value)
    ? isolateLtr(value)
    : isolateRtl(closeOpenBidiIsolates(value));
}

function containsArabicScript(value: string): boolean {
  return /\p{Script=Arabic}/u.test(value);
}

function choiceMenuDetail(row: SetupPanelState["rows"][number]): string {
  if (row.notes.length === 0 || row.notes === row.status) return row.status;
  if (row.status.length === 0) return row.notes;
  return `${row.status} · ${row.notes}`;
}

function choiceMenuRenderedRowCount(state: SetupPanelState, contentWidth: number): number {
  return state.rows.reduce((count, row) => {
    if (!isFullWidthOutputRow(row)) return count + 1;
    return count + Math.max(1, wrapVisibleCells(row.status, contentWidth).length);
  }, 0);
}

function isFullWidthOutputRow(row: SetupPanelState["rows"][number]): boolean {
  return row.provider.trim().length === 0 &&
    row.model.trim().length === 0 &&
    row.notes.trim().length === 0 &&
    row.status.trim().length > 0;
}

function formatArabicOptionLabel(label: string, selected: boolean): string {
  const localizedLabel = localizeChoiceCell(label);
  return selected ? `${localizedLabel} ◂` : localizedLabel;
}

function arabicRowDetail(
  row: SetupPanelState["rows"][number],
  layout: SetupPanelState["layout"]
): string {
  if (layout === "choiceMenu") return choiceMenuDetail(row);
  return [row.model, row.status, row.notes]
    .filter((value) => value.trim().length > 0)
    .join(" · ");
}

function renderWideTableRows(
  state: SetupPanelState,
  copy: SetupCopy,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const markerWidth = 2;
  const providerWidth = Math.max(10, Math.floor(contentWidth * 0.2));
  const modelWidth = Math.max(14, Math.floor(contentWidth * 0.32));
  const statusWidth = Math.max(10, Math.floor(contentWidth * 0.18));
  const notesWidth = Math.max(6, contentWidth - markerWidth - providerWidth - modelWidth - statusWidth - 3);
  const header = [
    padVisibleEnd("", markerWidth),
    padVisibleEnd(copy.provider, providerWidth),
    padVisibleEnd(copy.model, modelWidth),
    padVisibleEnd(copy.status, statusWidth),
    padVisibleEnd(copy.notes, notesWidth),
  ].join(" ");
  const divider = "─".repeat(contentWidth);

  return [
    renderContentRow(header, contentWidth, width),
    renderContentRow(divider, contentWidth, width),
    ...state.rows.map((row) => {
      const selected = row.id === state.selectedRowId;
      const marker = selected ? "❯" : "";
      const line = [
        padVisibleEnd(marker, markerWidth),
        padVisibleEnd(row.provider, providerWidth),
        padVisibleEnd(row.model, modelWidth),
        padVisibleEnd(row.status, statusWidth),
        padVisibleEnd(row.notes, notesWidth),
      ].join(" ");
      return renderSelectedContentRow(line, selected, style, contentWidth, width);
    }),
  ];
}

function renderNarrowTableRows(
  state: SetupPanelState,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return state.rows.flatMap((row) => {
    const selected = row.id === state.selectedRowId;
    const marker = selected ? "❯ " : "  ";
    return [
      renderSelectedContentRow(`${marker}${row.provider}`, selected, style, contentWidth, width),
      renderSelectedContentRow(`  ${row.model}`, selected, style, contentWidth, width),
      renderSelectedContentRow(`  ${row.status} · ${row.notes}`, selected, style, contentWidth, width),
      renderContentRow("", contentWidth, width),
    ];
  }).slice(0, Math.max(0, state.rows.length * 4 - 1));
}

function renderSecretEntryPanel(
  state: SecretEntryPanelState,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const contentWidth = Math.max(0, width - 4);
  const value = state.optional === true && (state.maskedValue === undefined || state.maskedValue.length === 0)
    ? state.emptyLabel ?? "[leave empty]"
    : maskSecretValue(state);
  const rows = [
    renderSetupPanelTopBorder(state.title, state.locale, width, style),
    renderContentRow(state.description, contentWidth, width),
    renderContentRow("", contentWidth, width),
    renderContentRow(value, contentWidth, width),
    renderContentRow("", contentWidth, width),
  ];

  if (state.envVar !== undefined && state.envVar.length > 0) {
    rows.push(renderContentRow(`Stored as: ${state.envVar}`, contentWidth, width));
    rows.push(renderContentRow("", contentWidth, width));
  }

  rows.push(renderFooterRow(state.footer, state.locale, contentWidth, width, style));
  rows.push(renderBottomBorder(width));
  return rows;
}

function renderTextEntryPanel(
  state: TextEntryPanelState,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const contentWidth = Math.max(0, width - 4);
  const value = sanitizeInlineText(state.value.length === 0
    ? state.placeholder ?? ""
    : state.value);
  const rows = [
    renderSetupPanelTopBorder(state.title, state.locale, width, style),
    ...renderPanelDescriptionRows(state.description, state.locale, contentWidth, width),
    renderContentRow("", contentWidth, width),
    renderTextInputValueRow(value, state.value.length === 0, state.locale, contentWidth, width, style),
    renderContentRow("", contentWidth, width),
    renderFooterRow(state.footer, state.locale, contentWidth, width, style),
    renderBottomBorder(width),
  ];
  return rows;
}

function renderTextInputValueRow(
  value: string,
  empty: boolean,
  locale: SetupPanelState["locale"],
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): string {
  const displayValue = empty
    ? styleSecondary(value, style)
    : value;
  if (locale !== "ar") return renderContentRow(displayValue, contentWidth, width);
  const localized = localizeChoiceCell(displayValue);
  return renderContentRow(padVisibleStart(truncateVisibleCells(localized, contentWidth), contentWidth), contentWidth, width);
}

function maskSecretValue(state: SecretEntryPanelState): string {
  if (state.maskedValue !== undefined && state.maskedValue.length > 0) return state.maskedValue;
  const rawWidth = state.rawValue === undefined ? 0 : stringWidth(state.rawValue);
  return "•".repeat(Math.max(8, Math.min(64, rawWidth)));
}

function sanitizeInlineText(value: string): string {
  return value.replace(/[\r\n\t]/gu, " ");
}

function textEntryDescriptionLineCount(description: string, width: number): number {
  const contentWidth = Math.max(1, normalizeDimension(width) - 4);
  return renderableDescriptionLines(description, contentWidth).length;
}

function panelDescriptionLineCount(state: SetupPanelState, width: number): number {
  const contentWidth = Math.max(1, normalizeDimension(width) - 4);
  const description = state.description ?? resolveSetupCopy(state.locale).modelDescription;
  return renderableDescriptionLines(description, contentWidth).length;
}

function renderPanelDescriptionRows(
  description: string,
  locale: SetupPanelState["locale"],
  contentWidth: number,
  width: number
): readonly string[] {
  return renderableDescriptionLines(description, contentWidth).map((line) =>
    renderPanelDescriptionRow(line, locale, contentWidth, width)
  );
}

function renderableDescriptionLines(description: string, contentWidth: number): readonly string[] {
  const lines = description.split(/\r?\n/u);
  const rendered = lines.flatMap((line) =>
    line.trim().length === 0 ? [""] : wrapVisibleCells(line.trimEnd(), contentWidth)
  );
  return rendered.length > 0 ? rendered : [""];
}

type SetupCopy = {
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly notes: string;
  readonly modelDescription: string;
  readonly footer: string;
};

function resolveSetupCopy(locale: SetupPanelState["locale"]): SetupCopy {
  if (locale === "ar") {
    return {
      provider: "المزود",
      model: "النموذج",
      status: "الحالة",
      notes: "ملاحظات",
      modelDescription: "اختر مزود النموذج والمسار النشط.",
      footer: "↑↓ navigate   ENTER select   CTRL+C exit",
    };
  }
  return {
    provider: "Provider",
    model: "Model",
    status: "Status",
    notes: "Notes",
    modelDescription: "Choose the active provider and model route.",
    footer: "↑↓ navigate   ENTER select   CTRL+C exit",
  };
}

function renderSetupPanelTopBorder(
  title: string,
  locale: SetupPanelState["locale"],
  width: number,
  style: OperatorConsoleStyle | undefined
): string {
  return renderTopBorder(
    styleBrand(styleBold(style, `𓂀  ${formatFrameTitle(title, locale)}`), style),
    width,
    locale === "ar" ? "right" : "left"
  );
}

function renderTopBorder(title: string, width: number, align: "left" | "right"): string {
  if (width <= 1) return "╭".slice(0, width);
  const label = align === "right" ? ` ${title} ────` : `──── ${title} `;
  const remaining = Math.max(0, width - 2 - stringWidth(label));
  const line = align === "right"
    ? `╭${"─".repeat(remaining)}${label}╮`
    : `╭${label}${"─".repeat(remaining)}╮`;
  return truncateVisibleCells(line, width);
}

function renderBottomBorder(width: number): string {
  if (width <= 1) return "╰".slice(0, width);
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderContentRow(row: string, contentWidth: number, width: number): string {
  if (width <= 0) return "";
  const content = padVisibleEnd(truncateVisibleCells(row, contentWidth), contentWidth);
  return truncateVisibleCells(`  ${content}`, width);
}

function renderPanelDescriptionRow(
  description: string,
  locale: SetupPanelState["locale"],
  contentWidth: number,
  width: number
): string {
  if (locale !== "ar") return renderContentRow(description, contentWidth, width);
  const content = padVisibleStart(truncateVisibleCells(localizeChoiceCell(description), contentWidth), contentWidth);
  return renderContentRow(content, contentWidth, width);
}

function renderStatusLines(
  statusLines: readonly SetupPanelStatusLine[] | undefined,
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return (statusLines ?? []).map((line) => {
    const localized = line.direction === "rtl" ? isolateRtl(line.text) : line.text;
    return renderContentRow(styleStatusLine(localized, line, style), contentWidth, width);
  });
}

function renderFooterRow(
  footer: string,
  locale: SetupPanelState["locale"],
  contentWidth: number,
  width: number,
  style: OperatorConsoleStyle | undefined
): string {
  const content = locale === "ar"
    ? footer
    : padVisibleStart(footer, contentWidth);
  return renderContentRow(styleFooter(content, style), contentWidth, width);
}

function styleStatusLine(
  text: string,
  line: SetupPanelStatusLine,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return text;
  if (line.tone === "active") return styleColor(style, text, tokens.severity.ok);
  if (line.tone === "warning") return styleColor(style, text, tokens.severity.warn);
  if (line.tone === "muted") return styleColor(style, text, tokens.text.secondary);
  return text;
}

function styleBrand(text: string, style: OperatorConsoleStyle | undefined): string {
  const brand = style?.tokens.contract.palette.brand;
  return brand === undefined ? text : styleColor(style, text, brand);
}

function styleFooter(text: string, style: OperatorConsoleStyle | undefined): string {
  const secondary = style?.tokens.contract.text.secondary;
  return secondary === undefined ? text : styleColor(style, text, secondary);
}

function styleSecondary(text: string, style: OperatorConsoleStyle | undefined): string {
  const secondary = style?.tokens.contract.text.secondary;
  return secondary === undefined ? text : styleColor(style, text, secondary);
}

function stylePrimary(text: string, style: OperatorConsoleStyle | undefined): string {
  const primary = style?.tokens.contract.text.primary;
  return primary === undefined ? text : styleColor(style, text, primary);
}

function stylePrimaryChoiceRow(
  line: string,
  selected: boolean,
  style: OperatorConsoleStyle | undefined
): string {
  return selected ? styleSelectedChoiceRow(line, selected, style) : stylePrimary(line, style);
}

function formatFrameTitle(title: string, locale: SetupPanelState["locale"]): string {
  if (locale === "ar" || containsArabicScript(title)) return title;
  return title.split(/(\s+)/u).map((part) => {
    if (/^\s+$/u.test(part) || part.length === 0) return part;
    if (/[A-Z]/u.test(part.slice(1))) return part;
    return `${part[0]?.toLocaleUpperCase("en-US") ?? ""}${part.slice(1)}`;
  }).join("");
}

function padVisibleEnd(value: string, width: number): string {
  const truncated = truncateVisibleCells(value, width);
  const padCells = Math.max(0, width - stringWidth(truncated));
  return `${truncated}${" ".repeat(padCells)}`;
}

function padVisibleStart(value: string, width: number): string {
  const truncated = truncateVisibleCells(value, width);
  const padCells = Math.max(0, width - stringWidth(truncated));
  return `${" ".repeat(padCells)}${truncated}`;
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;

  let output = "";
  for (const char of value) {
    if (stringWidth(output + char) > width) break;
    output += char;
  }
  return output;
}

function wrapVisibleCells(value: string, maxCells: number): readonly string[] {
  const width = normalizeDimension(maxCells);
  if (width <= 0 || value.length === 0) return [];
  if (stringWidth(value) <= width) return [value];

  const words = value.split(/(\s+)/u).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current.length === 0 ? word.trimStart() : `${current}${word}`;
    if (stringWidth(next) <= width) {
      current = next;
      continue;
    }
    if (current.trim().length > 0) lines.push(current.trim());
    current = word.trim();
    while (stringWidth(current) > width) {
      const chunk = truncateVisibleCells(current, width);
      lines.push(chunk);
      current = current.slice(chunk.length).trimStart();
    }
  }

  if (current.trim().length > 0) lines.push(current.trim());
  return lines.length === 0 ? [truncateVisibleCells(value, width)] : lines;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
