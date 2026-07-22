// v0.95 Plain Renderer
// Deterministic, ASCII-safe plain-text output for all ViewModel types.
// No ANSI, no emoji, no color, no animation, no terminal-width detection.

import { measureTextWidth, measureVisibleWidth, padVisibleAlign, padVisibleEnd, padVisibleStart, truncateVisible, wrapText } from "./layout.js";
import type { UiLocale } from "../../ui/cli-ui-copy.js";
import { chromeCopy } from "../../ui/cli-ui-copy.js";
import { closeOpenBidiIsolates, isolateLtr, isolateRtl } from "../../ui/bidi.js";
import { formatUsageCost } from "../usage-cost-format.js";
import type {
  ActiveTurnSpinnerViewModel,
  ActivityTimelineViewModel,
  ApprovalSecurityViewModel,
  CommandResultViewModel,
  ConversationMessageViewModel,
  KeyValueBlockViewModel,
  ListViewModel,
  OnboardingPromptColumn,
  OnboardingPromptCardViewModel,
  OnboardingPromptOption,
  PlainFallbackViewModel,
  PickerViewModel,
  PromptCardStatusLine,
  ProgressContextRailViewModel,
  StartupViewModel,
  StartupDashboardViewModel,
  StatusViewModel,
  TableViewModel,
  TimelineEvent,
  WarningErrorViewModel,
  AssistantResponseViewModel,
  FileChangePreviewViewModel,
  SessionStatusRailViewModel,
  SlashMenuViewModel,
  ShortcutHintRailViewModel,
  UserPromptRailViewModel,
  ViewModel,
  ToolActivityRailViewModel,
  ToolActivityRailEvent,
} from "../../contracts/view-model.js";

// ─────────────────────────────────────────────────────────────
// Generic dispatcher
// ─────────────────────────────────────────────────────────────

export function renderPlain(viewModel: ViewModel, locale?: UiLocale): string {
  switch (viewModel.kind) {
    case "status":
      return renderStatus(viewModel);
    case "table":
      return renderTable(viewModel);
    case "kv":
      return renderKeyValueBlock(viewModel);
    case "list":
      return renderList(viewModel);
    case "warning":
      return renderWarningError(viewModel);
    case "approval":
      return renderApprovalSecurity(viewModel);
    case "timeline":
      return renderActivityTimeline(viewModel);
    case "progress":
      return renderProgressRail(viewModel);
    case "picker":
      return renderPicker(viewModel);
    case "onboardingPromptCard":
      return renderOnboardingPromptCard(viewModel, locale);
    case "startup":
      return renderStartup(viewModel, locale);
    case "startupDashboard":
      return renderStartupDashboard(viewModel, locale);
    case "commandResult":
      return renderCommandResult(viewModel);
    case "plainFallback":
      return renderPlainFallback(viewModel);
    case "assistantResponse":
      return renderAssistantResponse(viewModel);
    case "conversationMessage":
      return renderConversationMessage(viewModel, locale);
    case "sessionStatusRail":
      return renderSessionStatusRail(viewModel, locale);
    case "shortcutHintRail":
      return renderShortcutHintRail(viewModel, locale);
    case "userPromptRail":
      return renderUserPromptRail(viewModel);
    case "activeTurnSpinner":
      return renderActiveTurnSpinner(viewModel, locale);
    case "toolActivityRail":
      return renderToolActivityRail(viewModel, locale);
    case "fileChangePreview":
      return renderFileChangePreview(viewModel, locale);
    case "startupRuntime":
      return `[unsupported view model: ${viewModel.kind}]`;
    case "slashMenu":
      return renderSlashMenu(viewModel, locale);
    default: {
      const _exhaustive: never = viewModel;
      return String(_exhaustive);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Plain Fallback
// ─────────────────────────────────────────────────────────────

export function renderPlainFallback(vm: PlainFallbackViewModel): string {
  return vm.lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Warning / Error
// ─────────────────────────────────────────────────────────────

export function renderWarningError(vm: WarningErrorViewModel): string {
  const tag = severityTag(vm.severity);
  const lines = [`${tag} ${vm.title}: ${vm.message}`];
  if (vm.details !== undefined && vm.details.length > 0) {
    for (const detail of vm.details) {
      lines.push(`  ${detail}`);
    }
  }
  return lines.join("\n");
}

function severityTag(severity: "warn" | "error" | "info"): string {
  switch (severity) {
    case "error":
      return "[ERROR]";
    case "warn":
      return "[WARN]";
    case "info":
      return "[INFO]";
  }
}

// ─────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────

export function renderStatus(vm: StatusViewModel): string {
  const lines: string[] = [
    `${vm.agentName} is ready`,
    `model: ${vm.model.provider}/${vm.model.id}`,
    vm.profileId === undefined ? undefined : `profile: ${vm.profileId}`,
    `security: ${vm.securityMode}`,
    `skills: ${vm.skillCount}${vm.skillAutonomy !== undefined ? ` (${vm.skillAutonomy})` : ""}`,
    `tools: ${vm.toolCount}`,
    `mcp: ${vm.mcp.active}/${vm.mcp.total}`,
  ].filter((line): line is string => line !== undefined);

  for (const warning of vm.warnings) {
    lines.push(renderWarningError(warning));
  }

  if (vm.sections !== undefined && vm.sections.length > 0) {
    for (const section of vm.sections) {
      lines.push("");
      lines.push(renderPlain(section));
    }
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────

export function renderTable(vm: TableViewModel): string {
  if (vm.rows.length === 0) {
    const empty = vm.emptyMessage ?? "No data.";
    return vm.title !== undefined ? `${vm.title}\n${empty}` : empty;
  }

  const widths = computeColumnWidths(vm.columns, vm.rows);
  const lines: string[] = [];

  if (vm.title !== undefined) {
    lines.push(vm.title);
  }

  // Header row
  const headerCells = vm.columns.map((col, i) =>
    padVisibleAlign(col.header, widths[i], col.alignment ?? "left")
  );
  lines.push(headerCells.join("  "));

  // Separator
  const separatorCells = vm.columns.map((col, i) =>
    "-".repeat(Math.max(col.header.length, widths[i]))
  );
  lines.push(separatorCells.join("  "));

  // Data rows
  for (const row of vm.rows) {
    const cells = vm.columns.map((col, i) => {
      const raw = row[col.key];
      const text = raw === undefined ? "" : String(raw);
      return padVisibleAlign(text, widths[i], col.alignment ?? "left");
    });
    lines.push(cells.join("  "));
  }

  return lines.join("\n");
}

function computeColumnWidths(
  columns: readonly { readonly key: string; readonly header: string }[],
  rows: readonly Record<string, unknown>[]
): number[] {
  return columns.map((col) => {
    let width = measureTextWidth(col.header);
    for (const row of rows) {
      const raw = row[col.key];
      const text = raw === undefined ? "" : String(raw);
      width = Math.max(width, measureTextWidth(text));
    }
    return width;
  });
}

// ─────────────────────────────────────────────────────────────
// Key-Value Block
// ─────────────────────────────────────────────────────────────

export function renderKeyValueBlock(vm: KeyValueBlockViewModel): string {
  const lines: string[] = [];
  if (vm.title !== undefined) {
    lines.push(vm.title);
  }

  for (const entry of vm.entries) {
    const prefix = entry.severity !== undefined ? `[${entry.severity.toUpperCase()}] ` : "";
    lines.push(`${prefix}${entry.key}: ${entry.value}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

export function renderList(vm: ListViewModel): string {
  if (vm.items.length === 0) {
    const empty = vm.emptyMessage ?? "No items.";
    return vm.title !== undefined ? `${vm.title}\n${empty}` : empty;
  }

  const lines: string[] = [];
  if (vm.title !== undefined) {
    lines.push(vm.title);
  }

  for (let i = 0; i < vm.items.length; i++) {
    const item = vm.items[i];
    const bullet = vm.ordered ? `${i + 1}.` : "-";
    const prefix = item.severity !== undefined ? `[${item.severity.toUpperCase()}] ` : "";
    const valuePart = item.value !== undefined ? `: ${item.value}` : "";
    lines.push(`${bullet} ${prefix}${item.label}${valuePart}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Approval / Security
// ─────────────────────────────────────────────────────────────

export function renderApprovalSecurity(vm: ApprovalSecurityViewModel): string {
  const lines: string[] = [
    `[${vm.severity.toUpperCase()}] Approval required: ${vm.toolName}`,
    `Target: ${vm.targetSummary}`,
  ];

  if (vm.riskClass !== undefined) {
    lines.push(`Risk: ${vm.riskClass}`);
  }

  if (vm.details !== undefined && vm.details.length > 0) {
    for (const detail of vm.details) {
      lines.push(`  ${detail}`);
    }
  }

  lines.push("");
  lines.push("Actions:");
  for (const action of vm.actions) {
    const tag = action.severity !== undefined ? `[${action.severity.toUpperCase()}] ` : "";
    lines.push(`  ${action.id}) ${tag}${action.label}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Activity Timeline
// ─────────────────────────────────────────────────────────────

export function renderActivityTimeline(vm: ActivityTimelineViewModel): string {
  if (vm.events.length === 0) {
    return "No activity.";
  }

  const lines = vm.events.map((event) => renderTimelineEvent(event));
  return lines.join("\n");
}

function renderTimelineEvent(event: TimelineEvent): string {
  const marker = timelineStatusMarker(event.status);
  const parts: string[] = [`${marker} ${event.tool}`];

  if (event.elapsedMs !== undefined) {
    parts.push(`| ${formatDuration(event.elapsedMs)}`);
  }

  if (event.chars !== undefined && event.sentChars !== undefined) {
    parts.push(
      `| ${formatCount(event.chars)} captured / ${formatCount(event.sentChars)} sent`
    );
    if (event.truncated) {
      parts.push("/ compressed");
    }
  }

  if (event.decision !== undefined) {
    parts.push(`| decision: ${event.decision}`);
  }

  if (event.riskClass !== undefined) {
    parts.push(`| risk: ${event.riskClass}`);
  }

  return parts.join(" ");
}

function timelineStatusMarker(status: TimelineEvent["status"]): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "running":
      return "[>]";
    case "done":
      return "[x]";
    case "failed":
      return "[-]";
    case "gated":
      return "[?]";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

function formatRailDuration(ms: number, locale: UiLocale = "en"): string {
  if (locale === "ar") {
    if (ms >= 3_600_000) {
      const totalMinutes = Math.floor(ms / 60_000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return minutes === 0 ? `${hours}س` : `${hours}س ${minutes}د`;
    }

    if (ms >= 60_000) {
      const totalSeconds = Math.floor(ms / 1_000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return seconds === 0 ? `${minutes}د` : `${minutes}د ${seconds}ث`;
    }

    if (ms < 1000) {
      return `${Math.max(0, ms)}ملث`;
    }
    return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}ث`;
  }

  if (ms >= 3_600_000) {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  if (ms >= 60_000) {
    const totalSeconds = Math.floor(ms / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  return formatDuration(ms);
}

function formatCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(value);
}

function formatContextCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────
// Progress / Context Rail
// ─────────────────────────────────────────────────────────────

export function renderProgressRail(vm: ProgressContextRailViewModel): string {
  if (vm.steps.length === 0 && vm.sessionElapsedMs === undefined && vm.taskElapsedMs === undefined) {
    return vm.title !== undefined ? `${vm.title}\nNo steps.` : "No steps.";
  }

  const lines: string[] = [];
  if (vm.title !== undefined) {
    lines.push(vm.title);
  }

  for (const step of vm.steps) {
    const marker = progressStatusMarker(step.status);
    lines.push(`${marker} ${step.label}`);
  }

  const timerParts: string[] = [];
  if (vm.sessionElapsedMs !== undefined) {
    timerParts.push(`sess ${formatDuration(vm.sessionElapsedMs)}`);
  }
  if (vm.taskElapsedMs !== undefined) {
    if (vm.taskElapsedMs === "idle") {
      timerParts.push("task idle");
    } else {
      timerParts.push(`task ${formatDuration(vm.taskElapsedMs)}`);
    }
  }
  if (timerParts.length > 0) {
    lines.push(timerParts.join("  "));
  }

  return lines.join("\n");
}

function progressStatusMarker(status: ProgressContextRailViewModel["steps"][number]["status"]): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "active":
      return "[>]";
    case "done":
      return "[x]";
    case "failed":
      return "[-]";
  }
}

// ──────────────────────────────────────
// Tool Activity Rail
// ──────────────────────────────────────

export function renderToolActivityRail(vm: ToolActivityRailViewModel, locale?: UiLocale): string {
  if (vm.events.length === 0) {
    return "No activity.";
  }
  const copy = chromeCopy(locale ?? "en");
  const lines = vm.events.map((event) => {
    const marker = toolActivityStatusMarker(event.status);
    const labelKey = event.label ?? "run";
    const label = (copy as unknown as Record<string, string>)[labelKey] ?? labelKey;
    const targetRaw = event.target ?? "";
    const target = locale === "ar" && targetRaw.length > 0 ? isolateLtr(targetRaw) : targetRaw;
    const elapsed = event.elapsedMs !== undefined ? formatDuration(event.elapsedMs) : "";
    const parts: string[] = [`| ${marker} ${label}`];
    if (target.length > 0) {
      parts.push(target);
    }
    if (elapsed.length > 0) {
      parts.push(elapsed);
    }
    return truncateVisible(parts.join("  "), 120);
  });
  return lines.join("\n");
}

function toolActivityStatusMarker(status: ToolActivityRailEvent["status"]): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "running":
      return "[>]";
    case "done":
      return "[x]";
    case "failed":
      return "[-]";
    case "gated":
      return "[?]";
  }
}

// ──────────────────────────────────────
// Picker
// ──────────────────────────────────────

export function renderPicker(vm: PickerViewModel): string {
  const lines: string[] = [vm.title];

  for (let i = 0; i < vm.options.length; i++) {
    const opt = vm.options[i];
    const marker = opt.selected ? ">" : " ";
    const num = String(i + 1).padStart(2);
    lines.push(`${marker} ${num}) ${opt.label}`);
    if (opt.description !== undefined) {
      lines.push(`     ${opt.description}`);
    }
  }

  return lines.join("\n");
}

// ──────────────────────────────────────
// Onboarding Prompt Card
// ──────────────────────────────────────

const PLAIN_ONBOARDING_DESCRIPTION_WIDTH = 88;

export function renderOnboardingPromptCard(
  vm: OnboardingPromptCardViewModel,
  locale: UiLocale = "en"
): string {
  const effectiveLocale = vm.locale ?? locale;
  const effectiveDirection = vm.direction ?? (effectiveLocale === "ar" ? "rtl" : "ltr");
  const lines: string[] = [vm.title];

  for (const bodyLine of vm.bodyLines) {
    lines.push(bodyLine);
  }

  for (const technicalLine of vm.technicalLines ?? []) {
    lines.push(effectiveLocale === "ar" ? isolateLtr(technicalLine) : technicalLine);
  }

  for (const statusLine of vm.statusLines ?? []) {
    lines.push(renderPlainPromptStatusLine(statusLine, effectiveLocale, effectiveDirection));
  }

  const hasPreOptionContent = vm.bodyLines.length > 0
    || (vm.technicalLines?.length ?? 0) > 0
    || (vm.statusLines?.length ?? 0) > 0;
  if (hasPreOptionContent && vm.options.length > 0) {
    lines.push("");
  }

  if (hasStructuredPromptRows(vm)) {
    lines.push(...renderPlainStructuredOnboardingOptions(vm, effectiveLocale));
  } else {
    let renderedNavigationSeparator = false;
    for (let i = 0; i < vm.options.length; i++) {
      const option = vm.options[i];
      if (option.group === "navigation" && !renderedNavigationSeparator && i > 0) {
        lines.push("");
        renderedNavigationSeparator = true;
      }
      const marker = i === vm.selectedOptionIndex ? ">" : " ";
      const label = option.technical === true && effectiveLocale === "ar"
        ? isolateLtr(option.label)
        : effectiveLocale === "ar"
          ? isolateRtl(option.label)
        : option.label;
      lines.push(effectiveLocale === "ar" ? `${label} ${marker}` : `${marker} ${label}`);
      if (option.description !== undefined) {
        lines.push(...renderPlainOnboardingOptionDescription(option.description, effectiveLocale));
      }
    }
  }

  if (vm.hint !== undefined && vm.hint.length > 0) {
    lines.push(effectiveLocale === "ar" ? isolateLtr(vm.hint) : vm.hint);
  }

  return lines.join("\n");
}

function renderPlainPromptStatusLine(
  line: PromptCardStatusLine,
  locale: UiLocale,
  cardDirection: "ltr" | "rtl"
): string {
  const direction = line.direction ?? "auto";
  const textDirection = direction === "auto" ? cardDirection : direction;
  if (textDirection === "ltr") {
    return locale === "ar" ? isolateLtr(line.text) : line.text;
  }
  return isolateRtl(closeOpenBidiIsolates(line.text));
}

function hasStructuredPromptRows(vm: OnboardingPromptCardViewModel): boolean {
  return (vm.columns?.length ?? 0) > 0;
}

type PlainStructuredTableLayout = {
  readonly widths: readonly number[];
  readonly lineWidth: number;
};

function renderPlainStructuredOnboardingOptions(vm: OnboardingPromptCardViewModel, locale: UiLocale): string[] {
  const columns = vm.columns ?? [];
  const tableDirection = vm.tableDirection ?? "ltr";
  const layout = plainStructuredTableLayout(columns, vm.options, {
    showColumnHeaders: vm.showColumnHeaders !== false,
    tableWidth: vm.tableWidth ?? "full",
    tableMaxWidth: vm.tableMaxWidth,
    showCurrentBadge: vm.showCurrentBadge,
  });
  const lines: string[] = vm.showColumnHeaders === false
    ? []
    : [tableDirection === "rtl"
      ? plainAlignStructuredLine(
        plainStructuredRtlPhysicalLine(
          plainStructuredCells(columns, Object.fromEntries(columns.map((column) => [column.key, column.header])), [], layout.widths, locale),
          "  "
        ),
        layout.lineWidth,
        vm.tableAlign
      )
      : plainAlignStructuredLine(
        `  ${plainStructuredRow(columns, Object.fromEntries(columns.map((column) => [column.key, column.header])), [], layout.widths, locale)}`,
        layout.lineWidth,
        vm.tableAlign
      )];

  let renderedNavigationSeparator = false;
  for (let i = 0; i < vm.options.length; i++) {
    const option = vm.options[i];
    if (option.group === "navigation" && !renderedNavigationSeparator && i > 0) {
      lines.push("");
      renderedNavigationSeparator = true;
    }
    const marker = i === vm.selectedOptionIndex
      ? (tableDirection === "rtl" ? "<" : ">")
      : " ";
    const cells = plainStructuredCells(columns, plainStructuredOptionCells(option, columns), plainOptionBadges(option, vm.showCurrentBadge), layout.widths, locale);
    const row = cells.join("  ");
    const line = tableDirection === "rtl"
      ? plainStructuredRtlPhysicalLine(cells, ` ${marker}`)
      : `${marker} ${row}`;
    lines.push(plainAlignStructuredLine(line, layout.lineWidth, vm.tableAlign));
  }

  return lines;
}

function plainStructuredTableLayout(
  columns: readonly OnboardingPromptColumn[],
  options: readonly OnboardingPromptOption[],
  layoutOptions: {
    readonly showColumnHeaders: boolean;
    readonly tableWidth: NonNullable<OnboardingPromptCardViewModel["tableWidth"]>;
    readonly tableMaxWidth?: number;
    readonly showCurrentBadge?: boolean;
  }
): PlainStructuredTableLayout {
  if (columns.length === 0) return { widths: [], lineWidth: 0 };
  if (columns.length === 1) {
    const width = layoutOptions.tableWidth === "content"
      ? Math.min(PLAIN_ONBOARDING_DESCRIPTION_WIDTH, plainStructuredNaturalColumnWidth(columns[0]!, 0, columns, options, layoutOptions.showColumnHeaders, layoutOptions.showCurrentBadge))
      : PLAIN_ONBOARDING_DESCRIPTION_WIDTH;
    return { widths: [Math.max(1, width)], lineWidth: Math.max(1, width) + 2 };
  }

  const primaryIndex = plainStructuredPrimaryColumnIndex(columns);
  const primary = columns[primaryIndex]!;
  const primaryWidth = Math.min(24, Math.max(
    measureVisibleWidth(primary.header),
    ...options.map((option) => measureVisibleWidth(option.cells?.[primary.key] ?? option.label))
  ));
  const nonPrimaryIndices = columns
    .map((_, index) => index)
    .filter((index) => index !== primaryIndex);
  const remaining = Math.max(16, PLAIN_ONBOARDING_DESCRIPTION_WIDTH - primaryWidth - (2 * (columns.length - 1)));
  const widths = Array.from({ length: columns.length }, () => 1);
  widths[primaryIndex] = primaryWidth;
  for (let i = 0; i < nonPrimaryIndices.length; i++) {
    widths[nonPrimaryIndices[i]!] = i === nonPrimaryIndices.length - 1
      ? remaining
      : Math.max(8, Math.floor(remaining / nonPrimaryIndices.length));
  }
  if (layoutOptions.tableWidth !== "content") {
    return { widths, lineWidth: PLAIN_ONBOARDING_DESCRIPTION_WIDTH };
  }

  const compactWidths = columns.map((column, index) => Math.max(
    1,
    Math.min(widths[index] ?? 1, plainStructuredNaturalColumnWidth(column, index, columns, options, layoutOptions.showColumnHeaders, layoutOptions.showCurrentBadge))
  ));
  const markerSlotWidth = 2;
  const gapWidth = 2 * (columns.length - 1);
  const maxLineWidth = Math.max(
    columns.length + markerSlotWidth,
    Math.min(PLAIN_ONBOARDING_DESCRIPTION_WIDTH, layoutOptions.tableMaxWidth ?? PLAIN_ONBOARDING_DESCRIPTION_WIDTH)
  );
  plainShrinkStructuredWidthsToLineWidth(compactWidths, primaryIndex, gapWidth, markerSlotWidth, maxLineWidth);
  const compactDataWidth = compactWidths.reduce((sum, width) => sum + width, 0) + gapWidth;
  return {
    widths: compactWidths,
    lineWidth: Math.min(PLAIN_ONBOARDING_DESCRIPTION_WIDTH, compactDataWidth + markerSlotWidth),
  };
}

function plainStructuredNaturalColumnWidth(
  column: OnboardingPromptColumn,
  columnIndex: number,
  columns: readonly OnboardingPromptColumn[],
  options: readonly OnboardingPromptOption[],
  showColumnHeaders: boolean,
  showCurrentBadge?: boolean
): number {
  const values = options.map((option) => {
    const cells = plainStructuredOptionCells(option, columns);
    const value = cells[column.key] ?? "";
    const badges = columnIndex === columns.length - 1
      ? plainOptionBadges(option, showCurrentBadge)
      : [];
    if (badges.length === 0) return measureVisibleWidth(value);
    return measureVisibleWidth(value) + 2 + measureVisibleWidth(badges.join("  "));
  });
  return Math.max(
    1,
    ...(showColumnHeaders ? [measureVisibleWidth(column.header)] : []),
    ...values
  );
}

function plainShrinkStructuredWidthsToLineWidth(
  widths: number[],
  primaryIndex: number,
  gapWidth: number,
  markerSlotWidth: number,
  maxLineWidth: number
): void {
  const minWidth = 1;
  const lineWidth = () => widths.reduce((sum, width) => sum + width, 0) + gapWidth + markerSlotWidth;
  const shrinkOrder = [
    ...widths.map((_, index) => index).filter((index) => index !== primaryIndex),
    primaryIndex,
  ];
  for (const index of shrinkOrder) {
    while (lineWidth() > maxLineWidth && (widths[index] ?? 0) > minWidth) {
      widths[index] = (widths[index] ?? minWidth) - 1;
    }
  }
}

function plainAlignStructuredLine(
  line: string,
  lineWidth: number,
  align: OnboardingPromptCardViewModel["tableAlign"]
): string {
  if (lineWidth >= PLAIN_ONBOARDING_DESCRIPTION_WIDTH) return line;
  const padWidth = Math.max(0, PLAIN_ONBOARDING_DESCRIPTION_WIDTH - lineWidth);
  const padding = " ".repeat(align === "center" ? Math.floor(padWidth / 2) : align === "right" ? padWidth : 0);
  return `${padding}${line}`;
}

function plainStructuredOptionCells(
  option: OnboardingPromptOption,
  columns: readonly OnboardingPromptColumn[]
): Record<string, string> {
  const cells: Record<string, string> = { ...(option.cells ?? {}) };
  const primaryColumn = plainStructuredPrimaryColumn(columns);
  if (primaryColumn !== undefined && cells[primaryColumn.key] === undefined) {
    cells[primaryColumn.key] = option.label;
  }
  if (columns.length > 1 && option.description !== undefined) {
    const descriptionColumn = plainStructuredDescriptionColumn(columns);
    if (descriptionColumn !== undefined && cells[descriptionColumn.key] === undefined) {
      cells[descriptionColumn.key] = option.description;
    }
  }
  return cells;
}

function plainStructuredPrimaryColumnIndex(columns: readonly OnboardingPromptColumn[]): number {
  const nameIndex = columns.findIndex((column) => column.key === "name");
  return nameIndex >= 0 ? nameIndex : 0;
}

function plainStructuredPrimaryColumn(columns: readonly OnboardingPromptColumn[]): OnboardingPromptColumn | undefined {
  return columns[plainStructuredPrimaryColumnIndex(columns)];
}

function plainStructuredDescriptionColumn(columns: readonly OnboardingPromptColumn[]): OnboardingPromptColumn | undefined {
  const descriptionColumn = columns.find((column) => column.key === "description");
  if (descriptionColumn !== undefined) return descriptionColumn;
  const primaryIndex = plainStructuredPrimaryColumnIndex(columns);
  return columns.find((_, index) => index !== primaryIndex) ?? columns[columns.length - 1];
}

function plainStructuredRow(
  columns: readonly OnboardingPromptColumn[],
  cells: Readonly<Record<string, string>>,
  badges: readonly string[],
  widths: readonly number[],
  locale: UiLocale
): string {
  return plainStructuredCells(columns, cells, badges, widths, locale).join("  ");
}

function plainStructuredCells(
  columns: readonly OnboardingPromptColumn[],
  cells: Readonly<Record<string, string>>,
  badges: readonly string[],
  widths: readonly number[],
  locale: UiLocale
): string[] {
  return columns.map((column, index) => {
    const width = widths[index] ?? 1;
    const value = cells[column.key] ?? "";
    if (index === columns.length - 1 && badges.length > 0) {
      return plainStructuredCellWithBadges(value, badges, width, locale);
    }
    const localized = locale === "ar" ? plainStructuredArabicCell(value) : value;
    return plainStructuredPadCell(truncateVisible(localized, width), width, column.align);
  });
}

function plainStructuredRtlPhysicalLine(cells: readonly string[], markerCell: string): string {
  return `${cells.map((cell) => isolateLtr(cell)).join(isolateLtr("  "))}${isolateLtr(markerCell)}`;
}

function plainStructuredPadCell(text: string, width: number, align?: OnboardingPromptColumn["align"]): string {
  return align === "right" ? padVisibleStart(text, width) : padVisibleEnd(text, width);
}

function plainStructuredCellWithBadges(
  value: string,
  badges: readonly string[],
  width: number,
  locale: UiLocale
): string {
  const badgeText = badges.join("  ");
  const badgeWidth = measureVisibleWidth(badgeText);
  const localizedBadges = locale === "ar" ? plainStructuredArabicCell(badgeText) : badgeText;
  if (badgeWidth >= width) {
    return padVisibleEnd(truncateVisible(localizedBadges, width), width);
  }

  const gap = "  ";
  const gapWidth = measureVisibleWidth(gap);
  const valueWidth = Math.max(0, width - badgeWidth - gapWidth);
  if (valueWidth === 0) {
    return padVisibleEnd(localizedBadges, width);
  }

  const localizedValue = locale === "ar" ? plainStructuredArabicCell(value) : value;
  return `${padVisibleEnd(truncateVisible(localizedValue, valueWidth), valueWidth)}${gap}${localizedBadges}`;
}

function plainStructuredArabicCell(value: string): string {
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

function plainOptionBadges(option: OnboardingPromptOption, showCurrentBadge = true): readonly string[] {
  const badges = [...(option.badges ?? [])];
  if (showCurrentBadge && option.current === true && !badges.includes("Current")) {
    badges.push("Current");
  }
  return badges;
}

function renderPlainOnboardingOptionDescription(description: string, locale: UiLocale): string[] {
  if (locale !== "ar") {
    return [`  ${description}`];
  }

  return wrapText(description, PLAIN_ONBOARDING_DESCRIPTION_WIDTH).map((segment) => (
    `  ${isolateRtl(closeOpenBidiIsolates(segment))}`
  ));
}

export function renderSlashMenu(vm: SlashMenuViewModel, locale: UiLocale = "en"): string {
  const copy = chromeCopy(locale);
  const visibleOptions = vm.options;
  if (visibleOptions.length === 0) {
    return copy.slashNoMatches(technical(vm.query, locale));
  }

  const markerWidth = 2;
  const commandWidth = Math.min(
    18,
    Math.max(...visibleOptions.map((option) => measureVisibleWidth(technical(option.label, locale))))
  );
  const gap = 4;
  const descriptionWidth = Math.max(8, 80 - markerWidth - commandWidth - gap);

  return visibleOptions
    .map((option, index) => {
      const marker = index === vm.selectedIndex ? "> " : "  ";
      const command = padVisibleEnd(technical(option.label, locale), commandWidth);
      const description = truncateVisible(
        slashDescription(option.id, option.description ?? "", locale),
        descriptionWidth
      );
      return `${marker}${command}${" ".repeat(gap)}${description}`;
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────

function technical(value: string, locale: UiLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function slashDescription(commandName: string, fallback: string, locale: UiLocale): string {
  const copy = chromeCopy(locale);
  switch (commandName) {
    case "help":
      return copy.slashCommandHelpDescription;
    case "status":
      return copy.slashCommandStatusDescription;
    case "model":
      return copy.slashCommandModelDescription;
    case "tools":
      return copy.slashCommandToolsDescription;
    case "skills":
      return copy.slashCommandSkillsDescription;
    case "exit":
      return copy.slashCommandExitDescription;
    default:
      return fallback;
  }
}

function modelRoute(model: { readonly provider: string; readonly id: string }, locale: UiLocale): string {
  return `${technical(model.provider, locale)}/${technical(model.id, locale)}`;
}

function startupReadinessLabel(
  readiness: StartupViewModel["readiness"] | StartupDashboardViewModel["providerReadiness"],
  locale: UiLocale
): string {
  const copy = chromeCopy(locale);
  if (locale !== "ar") {
    return readiness === "missing-config" ? copy.startupMissingConfig : readiness;
  }
  switch (readiness) {
    case "ready":
      return copy.startupReady;
    case "degraded":
      return copy.startupDegraded;
    case "missing-config":
      return copy.startupMissingConfig;
    case "unknown":
      return copy.startupUnknown;
  }
}

function startupTrustLabel(value: StartupDashboardViewModel["workspaceTrust"], locale: UiLocale): string {
  const copy = chromeCopy(locale);
  if (locale !== "ar") return value;
  switch (value) {
    case "trusted":
      return copy.startupTrusted;
    case "untrusted":
      return copy.startupUntrusted;
    case "unknown":
      return copy.startupUnknown;
  }
}

function startupVerificationLabel(value: StartupDashboardViewModel["workspaceVerification"], locale: UiLocale): string {
  const copy = chromeCopy(locale);
  if (locale !== "ar") return value;
  switch (value) {
    case "verified":
      return copy.startupVerified;
    case "unverified":
      return copy.startupUnverified;
    case "unknown":
      return copy.startupUnknown;
  }
}

function startupVersionStatusLabel(value: StartupDashboardViewModel["versionStatus"], locale: UiLocale): string {
  const copy = chromeCopy(locale);
  if (value === undefined) return copy.startupUnknown;
  if (value === "unknown") return locale === "ar" ? copy.startupUnknown : value;
  return technical(value, locale);
}

function plainStartupLabel(locale: UiLocale, english: string, localized: string): string {
  return locale === "ar" ? localized : english;
}

function startupCommands(
  vm: StartupDashboardViewModel,
  locale: UiLocale
): readonly { readonly name: string; readonly description: string }[] {
  if (vm.availableCommands.length > 0) {
    return vm.availableCommands;
  }
  const copy = chromeCopy(locale);
  return [
    { name: "/tools", description: copy.startupCommandTools },
    { name: "/skills", description: copy.startupCommandSkills },
    { name: "/model", description: copy.startupCommandModel },
    { name: "/status", description: copy.startupCommandStatus },
  ];
}

export function renderStartup(vm: StartupViewModel, locale: UiLocale = "en"): string {
  const copy = chromeCopy(locale);
  const lines: string[] = [vm.agentName];

  for (const tagline of vm.taglines) {
    if (tagline.length > 0) {
      lines.push(tagline);
    }
  }

  lines.push(`${plainStartupLabel(locale, "model", copy.startupModel)}: ${modelRoute(vm.model, locale)}`);
  const readinessText = locale === "ar" ? startupReadinessLabel(vm.readiness, locale) : vm.readiness;
  lines.push(`${plainStartupLabel(locale, "readiness", copy.startupReadiness)}: ${readinessText}`);

  for (const warning of vm.warnings) {
    lines.push("");
    lines.push(renderWarningError(warning));
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Command Result
// ─────────────────────────────────────────────────────────────

export function renderCommandResult(vm: CommandResultViewModel): string {
  const lines: string[] = [`${vm.ok ? "[OK]" : "[FAIL]"} ${vm.title}`];

  if (vm.blocks.length > 0) {
    lines.push("");
    for (const block of vm.blocks) {
      lines.push(renderPlain(block));
      lines.push("");
    }
    lines.pop(); // remove trailing blank line
  }

  return lines.join("\n");
}

// ──────────────────────────────────────
// Startup Dashboard
// ──────────────────────────────────────

export function renderStartupDashboard(vm: StartupDashboardViewModel, locale: UiLocale = "en"): string {
  const copy = chromeCopy(locale);
  const lines: string[] = [vm.agentName];

  for (const tagline of vm.taglines) {
    if (tagline.length > 0) {
      lines.push(tagline);
    }
  }

  lines.push("");

  if (vm.version !== undefined) {
    lines.push(`${plainStartupLabel(locale, "version", copy.startupVersion)}: ${technical(vm.version, locale)}`);
  }
  if (vm.sessionId !== undefined) {
    lines.push(`${plainStartupLabel(locale, "session", copy.startupSession)}: ${technical(vm.sessionId, locale)}`);
  }

  // Model route readiness line
  const readiness = vm.providerReadiness;
  let modelLabel: string;
  let readinessText: string;

  switch (readiness) {
    case "ready":
      modelLabel = technical(vm.model.id, locale);
      readinessText = startupReadinessLabel(readiness, locale);
      break;
    case "degraded":
      modelLabel = technical(vm.model.id, locale);
      readinessText = startupReadinessLabel(readiness, locale);
      break;
    case "missing-config":
      modelLabel = copy.startupModelNotConfigured;
      readinessText = copy.startupMissingConfig;
      break;
    case "unknown":
    default:
      modelLabel = technical(vm.model.id, locale);
      readinessText = startupReadinessLabel(readiness, locale);
      break;
  }

  lines.push(`${plainStartupLabel(locale, "model", copy.startupModel)}: ${modelLabel} - ${readinessText}`);

  lines.push(`${plainStartupLabel(locale, "workspace trust", copy.startupWorkspaceTrust)}: ${startupTrustLabel(vm.workspaceTrust, locale)}`);
  lines.push(`${plainStartupLabel(locale, "workspace verification", copy.startupWorkspaceVerification)}: ${startupVerificationLabel(vm.workspaceVerification, locale)}`);

  if (vm.workspaceDirectory !== undefined) {
    lines.push(`${plainStartupLabel(locale, "workspace", copy.startupWorkspaceDirectory)}: ${technical(vm.workspaceDirectory, locale)}`);
  }
  if (vm.securityMode !== undefined) {
    lines.push(`${plainStartupLabel(locale, "security", copy.startupSecurityMode)}: ${technical(vm.securityMode, locale)}`);
  }
  if (vm.skillAutonomy !== undefined) {
    lines.push(`${plainStartupLabel(locale, "skills", copy.startupSkillAutonomy)}: ${technical(vm.skillAutonomy, locale)}`);
  }
  if (vm.versionStatus !== undefined) {
    lines.push(`${plainStartupLabel(locale, "version status", copy.startupVersionStatus)}: ${startupVersionStatusLabel(vm.versionStatus, locale)}`);
  }

  lines.push("");
  lines.push(plainStartupLabel(locale, "Interactive commands:", copy.startupInteractiveCommands));
  for (const cmd of startupCommands(vm, locale)) {
    const name = padVisibleEnd(technical(cmd.name, locale), 8);
    lines.push(`  ${name} ${cmd.description}`);
  }

  for (const warning of vm.warnings) {
    lines.push("");
    lines.push(renderWarningError(warning));
  }

  return lines.join("\n");
}

// ──────────────────────────────────────
// Command Result
// ──────────────────────────────────────

export function renderAssistantResponse(vm: AssistantResponseViewModel): string {
  const plainLabel = /^[\x00-\x7F]+$/.test(vm.label) ? vm.label : "EstaCoda";
  const lines: string[] = [
    `${plainLabel}:`,
    ...vm.text.split("\n"),
  ];

  if (vm.usageFooter !== undefined) {
    lines.push("", vm.usageFooter);
  }

  if (vm.matchedSkills !== undefined && vm.matchedSkills.length > 0) {
    lines.push("");
    lines.push(`skills: ${vm.matchedSkills.join(", ")}`);
  }

  if (vm.progress !== undefined && vm.progress.length > 0) {
    lines.push(`progress: ${vm.progress.join(" -> ")}`);
  }

  return lines.join("\n");
}

// ──────────────────────────────────────
// Conversation Message
// ──────────────────────────────────────

export function renderConversationMessage(vm: ConversationMessageViewModel, locale?: UiLocale): string {
  if (vm.role === "assistant") {
    const copy = chromeCopy(locale ?? "en");
    const plainLabel = vm.label !== undefined && /^[\x00-\x7F]+$/.test(vm.label)
      ? vm.label
      : copy.assistantCardTitle;
    const lines: string[] = [
      `${plainLabel}:`,
      ...vm.text.split("\n"),
    ];

    if (vm.matchedSkills !== undefined && vm.matchedSkills.length > 0) {
      lines.push("");
      lines.push(`skills: ${vm.matchedSkills.join(", ")}`);
    }

    if (vm.progress !== undefined && vm.progress.length > 0) {
      lines.push(`progress: ${vm.progress.join(" -> ")}`);
    }

    return lines.join("\n");
  }

  // User messages: plain text until user prompt rail is implemented
  return vm.text;
}

// ──────────────────────────────────────
// Prompt Chrome Rails
// ──────────────────────────────────────

export function renderSessionStatusRail(vm: SessionStatusRailViewModel, locale?: UiLocale): string {
  const copy = chromeCopy(locale ?? "en");
  if (locale === "ar") {
    return renderArabicSessionStatusRail(vm, copy);
  }
  const parts: string[] = [`* ${vm.modelLabel}`];

  if (vm.contextUsage !== undefined) {
    const filled = vm.contextUsage.filled === undefined ? "--" : formatContextCount(vm.contextUsage.filled);
    const total = formatContextCount(vm.contextUsage.total);
    parts.push(`${copy.context} ${filled}/${total}`);
    parts.push(vm.contextUsage.filled === undefined
      ? "--%"
      : `${vm.contextUsage.total > 0 ? Math.round((vm.contextUsage.filled / vm.contextUsage.total) * 100) : 0}%`);
  }

  if (vm.sessionCost !== undefined) {
    parts.push(`session ${formatUsageCost(vm.sessionCost, { compact: true })}`);
  }

  if (vm.sessionElapsedMs !== undefined) {
    parts.push(`session ${formatRailDuration(vm.sessionElapsedMs)}`);
  }

  if (vm.currentTurnSeconds !== undefined) {
    parts.push(`turn ${formatRailDuration(vm.currentTurnSeconds * 1000)}`);
  }

  if (vm.showTurnState !== false) {
    parts.push(turnStateLabel(vm.turnState, copy));
  }
  return parts.join(" | ");
}

function renderArabicSessionStatusRail(
  vm: SessionStatusRailViewModel,
  copy: ReturnType<typeof chromeCopy>
): string {
  const parts: string[] = [`* ${isolateLtr(vm.modelLabel)}`];

  if (vm.contextUsage !== undefined) {
    const filled = vm.contextUsage.filled === undefined ? "--" : formatContextCount(vm.contextUsage.filled);
    const total = formatContextCount(vm.contextUsage.total);
    parts.push(`${isolateRtl(copy.context)} ${isolateLtr(`${filled}/${total}`)}`);
    parts.push(vm.contextUsage.filled === undefined
      ? "--%"
      : `${vm.contextUsage.total > 0 ? Math.round((vm.contextUsage.filled / vm.contextUsage.total) * 100) : 0}%`);
  }

  if (vm.sessionCost !== undefined) {
    parts.push(`${isolateRtl("الجلسة")} ${formatUsageCost(vm.sessionCost, { locale: "ar", compact: true })}`);
  }

  if (vm.sessionElapsedMs !== undefined) {
    parts.push(isolateLtr(`الجلسة ${formatRailDuration(vm.sessionElapsedMs, "ar")}`));
  }

  if (vm.currentTurnSeconds !== undefined) {
    parts.push(isolateLtr(`الدور ${formatRailDuration(vm.currentTurnSeconds * 1000, "ar")}`));
  }

  if (vm.showTurnState !== false) {
    parts.push(isolateRtl(turnStateLabel(vm.turnState, copy)));
  }

  return isolateLtr(parts.join(" | "));
}

export function renderShortcutHintRail(vm: ShortcutHintRailViewModel, locale?: UiLocale): string {
  const copy = chromeCopy(locale ?? "en");
  const text = vm.hints.length === 0
    ? copy.shortcuts
    : vm.hints.map((hint) => hint.key.length === 0 ? hint.description : `${locale === "ar" ? isolateLtr(hint.key) : hint.key} ${hint.description}`).join(" · ");
  return `> ${locale === "ar" ? isolateRtl(text) : text}`;
}

export function renderUserPromptRail(vm: UserPromptRailViewModel): string {
  return vm.text
    .split(/\r\n|\r|\n/u)
    .map((line, index) => `${index === 0 ? ">" : " "} ${line}`)
    .join("\n");
}

export function renderActiveTurnSpinner(vm: ActiveTurnSpinnerViewModel, locale?: UiLocale): string {
  const copy = chromeCopy(locale ?? "en");
  const eye = "*";
  const label = vm.label ?? (vm.phase !== undefined ? ((copy as unknown) as Record<string, string>)[vm.phase] : undefined);
  if (label !== undefined) {
    return `${eye} ${label}`;
  }
  return eye;
}

export function renderFileChangePreview(vm: FileChangePreviewViewModel, locale?: UiLocale): string {
  const copy = chromeCopy(locale ?? "en");
  const path = locale === "ar" ? isolateLtr(vm.path) : vm.path;
  const lines: string[] = [`* ${fileChangeActionLabel(vm.changeType, copy)} ${path}`];

  for (const summary of vm.summary ?? []) {
    lines.push(`  + ${summary}`);
  }

  const preview = boundedFileChangePreviewLines(vm, 8);
  for (const line of preview.lines) {
    lines.push(`  ${line}`);
  }

  if (preview.omittedLineCount > 0) {
    lines.push(`  ${copy.omittedDiffLines(preview.omittedLineCount)}`);
  }

  return lines.join("\n");
}

function fileChangeActionLabel(
  changeType: FileChangePreviewViewModel["changeType"],
  copy: ReturnType<typeof chromeCopy>
): string {
  switch (changeType) {
    case "added":
      return copy.created;
    case "modified":
      return copy.edited;
    case "deleted":
      return copy.deleted;
  }
}

function boundedFileChangePreviewLines(
  vm: FileChangePreviewViewModel,
  maxLines: number
): { lines: string[]; omittedLineCount: number } {
  const sourceLines = fileChangePreviewLines(vm);
  const lines = sourceLines.slice(0, maxLines);
  const rendererOmitted = Math.max(0, sourceLines.length - lines.length);
  return {
    lines,
    omittedLineCount: (vm.omittedLineCount ?? 0) + rendererOmitted,
  };
}

function fileChangePreviewLines(vm: FileChangePreviewViewModel): string[] {
  if (vm.diff !== undefined && vm.diff.length > 0) {
    return vm.diff.split("\n");
  }
  if (vm.hunks === undefined || vm.hunks.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const hunk of vm.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    lines.push(...hunk.lines);
  }
  return lines;
}

function turnStateLabel(state: SessionStatusRailViewModel["turnState"], copy: ReturnType<typeof chromeCopy>): string {
  switch (state) {
    case "idle":
      return copy.idle;
    case "running":
      return copy.running;
    case "blocked":
      return copy.blocked;
    case "error":
      return copy.error;
    case "unknown":
      return "unknown";
  }
}
