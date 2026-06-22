// v0.95 Standard Renderer
// ANSI/Unicode output for all ViewModel types.
// Falls back to plain ASCII when capabilities restrict color or Unicode.

import type { TerminalCapabilities } from "../../contracts/ui.js";
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
  ViewModel,
  ViewModelSeverity,
  WarningErrorViewModel,
  AssistantResponseViewModel,
  FileChangePreviewViewModel,
  SessionStatusRailViewModel,
  ShortcutHintRailViewModel,
  UserPromptRailViewModel,
  ToolActivityRailViewModel,
  ToolActivityRailEvent,
} from "../../contracts/view-model.js";
import type { ResolvedTokens, TokenGlyph } from "../../contracts/ui-tokens.js";
import { measureTextWidth, measureVisibleWidth, padVisibleEnd, padVisibleStart, padVisibleAlign, truncateVisible, wrapText } from "./layout.js";
import type { UiLocale } from "../../ui/cli-ui-copy.js";
import { chromeCopy } from "../../ui/cli-ui-copy.js";
import { closeOpenBidiIsolates, isolateLtr, isolateRtl } from "../../ui/bidi.js";
import type { TextDirection } from "../../contracts/ui.js";
import { formatSessionDisplayId } from "../../session/session-id.js";

const STARTUP_TITLE_SEPARATOR = "  𓂀  ";
const STARTUP_TITLE_SEPARATOR_ASCII = "  *  ";

export interface StandardRendererOptions {
  readonly tokens: ResolvedTokens;
  readonly capabilities: TerminalCapabilities;
  readonly locale?: UiLocale;
}

export class StandardRenderer {
  readonly #tokens: ResolvedTokens;
  readonly #capabilities: TerminalCapabilities;
  readonly #useColor: boolean;
  readonly #useUnicode: boolean;
  readonly #locale: UiLocale;
  readonly #copy: ReturnType<typeof chromeCopy>;

  constructor(options: StandardRendererOptions) {
    this.#tokens = options.tokens;
    this.#capabilities = options.capabilities;
    this.#useColor =
      this.#capabilities.supportsColor &&
      this.#tokens.contract.behavior.allowAnsiColor;
    this.#useUnicode = this.#capabilities.supportsUnicode;
    this.#locale = options.locale ?? "en";
    this.#copy = chromeCopy(this.#locale);
  }

  // ──────────────────────────────────────
  // Spinner / animation primitives
  // ──────────────────────────────────────

  /** Returns a time-based spinner frame when animation is supported, otherwise the first frame. */
  #spinnerFrame(frames: readonly string[]): string {
    if (frames.length === 0) return "";
    if (!this.#capabilities.supportsAnimation) {
      return frames[0] ?? "";
    }
    const index = Math.floor(Date.now() / 80) % frames.length;
    return frames[index] ?? "";
  }

  // ──────────────────────────────────────
  // ──────────────────────────────────────

  render(vm: ViewModel): string {
    switch (vm.kind) {
      case "status":
        return this.renderStatus(vm);
      case "table":
        return this.renderTable(vm);
      case "kv":
        return this.renderKeyValueBlock(vm);
      case "list":
        return this.renderList(vm);
      case "warning":
        return this.renderWarningError(vm);
      case "approval":
        return this.renderApprovalSecurity(vm);
      case "timeline":
        return this.renderActivityTimeline(vm);
      case "progress":
        return this.renderProgressRail(vm);
      case "picker":
        return this.renderPicker(vm);
      case "onboardingPromptCard":
        return this.renderOnboardingPromptCard(vm);
      case "startup":
        return this.renderStartup(vm);
      case "startupDashboard":
        return this.renderStartupDashboard(vm);
      case "commandResult":
        return this.renderCommandResult(vm);
      case "plainFallback":
        return this.renderPlainFallback(vm);
      case "assistantResponse":
        return this.renderAssistantResponse(vm);
      case "conversationMessage":
        return this.renderConversationMessage(vm);
      case "sessionStatusRail":
        return this.renderSessionStatusRail(vm);
      case "shortcutHintRail":
        return this.renderShortcutHintRail(vm);
      case "userPromptRail":
        return this.renderUserPromptRail(vm);
      case "activeTurnSpinner":
        return this.renderActiveTurnSpinner(vm);
      case "toolActivityRail":
        return this.renderToolActivityRail(vm);
      case "fileChangePreview":
        return this.renderFileChangePreview(vm);
      case "slashMenu":
        return this.renderSlashMenu(vm);
      case "startupRuntime":
        return `[unsupported view model: ${vm.kind}]`;
      default: {
        const _exhaustive: never = vm;
        return String(_exhaustive);
      }
    }
  }

  // ──────────────────────────────────────
  // ANSI helpers
  // ──────────────────────────────────────

  #color(text: string, hex: string): string {
    if (!this.#useColor) return text;
    if (this.#capabilities.supportsTrueColor) {
      const { r, g, b } = hexToRgb(hex);
      return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    const code = hexToAnsi256(hex);
    return `\x1b[38;5;${code}m${text}\x1b[0m`;
  }

  #bgColor(text: string, hex: string): string {
    if (!this.#useColor) return text;
    if (this.#capabilities.supportsTrueColor) {
      const { r, g, b } = hexToRgb(hex);
      return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    const code = hexToAnsi256(hex);
    return `\x1b[48;5;${code}m${text}\x1b[0m`;
  }

  #bold(text: string): string {
    if (!this.#useColor) return text;
    return `\x1b[1m${text}\x1b[0m`;
  }

  #dim(text: string): string {
    if (!this.#useColor) return text;
    return `\x1b[2m${text}\x1b[0m`;
  }

  #brand(text: string): string {
    return this.#color(text, this.#tokens.contract.palette.brand);
  }

  #action(text: string): string {
    return this.#color(text, this.#tokens.contract.palette.action);
  }

  #primary(text: string): string {
    return this.#color(text, this.#tokens.contract.text.primary);
  }

  #secondary(text: string): string {
    return this.#color(text, this.#tokens.contract.text.secondary);
  }

  #muted(text: string): string {
    return this.#color(text, this.#tokens.contract.text.muted);
  }

  #agentMessage(text: string): string {
    return this.#color(text, this.#tokens.contract.text.agentMessage);
  }

  #caution(text: string): string {
    return this.#color(text, this.#tokens.contract.palette.caution);
  }

  #surfaceBorder(text: string): string {
    return this.#color(text, this.#tokens.contract.surface.border);
  }

  #severity(text: string, sev: ViewModelSeverity): string {
    const hex = this.#tokens.contract.severity[sev];
    return this.#color(text, hex);
  }

  // ──────────────────────────────────────
  // Symbol helpers
  // ──────────────────────────────────────

  #glyph(key: keyof TokenGlyph): string {
    const g = this.#tokens.contract.glyph[key];
    if (typeof g === "string") {
      return this.#useUnicode ? g : this.#asciiFallback(key, g);
    }
    return "";
  }

  #asciiFallback(key: keyof TokenGlyph, _unicode: string): string {
    const map: Record<string, string> = {
      prompt: ">",
      toolPrefix: "|",
      continuation: "...",
      bullet: "-",
      check: "[OK]",
      cross: "[X]",
      arrow: ">>",
    };
    return map[key] ?? _unicode;
  }

  // ──────────────────────────────────────
  // Visual primitives
  // ──────────────────────────────────────

  /** Vertical rail for status/context lines. */
  #rail(content: string): string {
    const pipe = this.#useUnicode ? this.#glyph("toolPrefix") : "|";
    return `${pipe} ${content}`;
  }

  /** Small inline severity signal. */
  #inlineSignal(sev: ViewModelSeverity): string {
    const symbol = sev === "ok" ? this.#glyph("check") : sev === "error" ? this.#glyph("cross") : "!";
    return this.#severity(symbol, sev);
  }

  /** Framed focus panel for approvals/security prompts. */
  #framedPanel(title: string, contentLines: readonly string[]): string {
    const titleWidth = measureVisibleWidth(this.#bold(title));
    const maxContentWidth = Math.max(
      0,
      ...contentLines.map((l) => measureVisibleWidth(l))
    );
    const width = Math.min(
      this.#capabilities.terminalWidth,
      Math.max(titleWidth + 4, maxContentWidth + 4)
    );
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "┌" : "+";
    const topRight = this.#useUnicode ? "┐" : "+";
    const bottomLeft = this.#useUnicode ? "└" : "+";
    const bottomRight = this.#useUnicode ? "┘" : "+";
    const vert = this.#useUnicode ? "│" : "|";

    const top = `${topLeft}${horiz.repeat(width - 2)}${topRight}`;
    const bottom = `${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`;

    const lines = [top];
    lines.push(`${vert} ${padVisibleEnd(this.#bold(title), width - 4)} ${vert}`);
    lines.push(`${vert}${horiz.repeat(width - 2)}${vert}`);
    for (const line of contentLines) {
      lines.push(`${vert} ${padVisibleEnd(line, width - 4)} ${vert}`);
    }
    lines.push(bottom);
    return lines.join("\n");
  }

  /** Open focus panel (unbordered, indented). */
  #openPanel(contentLines: readonly string[]): string {
    return contentLines.map((l) => `  ${l}`).join("\n");
  }

  #openSideFrame(
    title: string,
    contentLines: readonly string[],
    options: {
      readonly minWidth?: number;
      readonly width?: number;
      readonly renderTitle?: (title: string) => string;
    } = {}
  ): string {
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const maxFrameWidth = Math.max(4, this.#capabilities.terminalWidth);
    const minWidth = options.minWidth ?? 40;
    const contentMaxWidth = Math.max(0, ...contentLines.map((line) => measureVisibleWidth(line)));
    const titleWidth = measureVisibleWidth(` ${title} `);
    const naturalWidth = Math.max(minWidth, contentMaxWidth + 4, titleWidth + 4);
    const width = Math.min(maxFrameWidth, Math.max(4, options.width ?? naturalWidth));
    const contentWidth = Math.max(0, width - 4);
    const boundedTitle = closeOpenBidiIsolates(truncateVisible(title, Math.max(1, width - 4)));
    const framedTitle = ` ${boundedTitle} `;
    const renderedTitle = options.renderTitle?.(framedTitle) ?? framedTitle;
    const titleAvail = Math.max(0, width - 2 - measureVisibleWidth(framedTitle));
    const titleLeft = Math.floor(titleAvail / 2);
    const titleRight = titleAvail - titleLeft;

    const lines: string[] = [
      [
        this.#surfaceBorder(`${topLeft}${horiz.repeat(titleLeft)}`),
        renderedTitle,
        this.#surfaceBorder(`${horiz.repeat(titleRight)}${topRight}`),
      ].join(""),
    ];

    for (const line of contentLines) {
      if (line.length === 0) {
        lines.push("");
      } else {
        lines.push(`  ${this.#truncateVisibleStable(line, contentWidth)}`);
      }
    }

    lines.push(this.#surfaceBorder(`${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`));
    return lines.join("\n");
  }

  #onboardingTitle(title: string, maxWidth: number, direction: TextDirection = "ltr"): string {
    const symbol = this.#useUnicode ? "𓂀" : "*";
    const rawTitle = direction === "rtl" ? `${title}  ${symbol}` : `${symbol}  ${title}`;
    const visibleTitle = truncateVisible(rawTitle, maxWidth);
    return direction === "rtl" ? isolateRtl(visibleTitle) : visibleTitle;
  }

  #assistantResponseTitle(label: string, maxWidth: number): string {
    const symbol = this.#useUnicode ? "𓂀" : "*";
    const title = label.replace(/^(?:𓂀|𓇠|\*)\s*/u, "").trim() || this.#copy.assistantCardTitle;
    return truncateVisible(`${symbol}  ${title}`, maxWidth);
  }

  #localizedTechnical(value: string, locale: UiLocale, maxWidth: number): string {
    const truncated = truncateVisible(value, maxWidth);
    return locale === "ar" ? isolateLtr(truncated) : truncated;
  }

  #isRtl(): boolean {
    return this.#locale === "ar";
  }

  #natural(value: string, maxWidth?: number): string {
    const rendered = maxWidth === undefined ? value : truncateVisible(value, maxWidth);
    return this.#isRtl() ? isolateRtl(rendered) : rendered;
  }

  #truncateVisibleStable(value: string, maxWidth: number): string {
    const truncated = closeOpenBidiIsolates(truncateVisible(value, maxWidth));
    if (this.#useColor && /\x1b\[/u.test(truncated) && !truncated.endsWith("\x1b[0m")) {
      return `${truncated}\x1b[0m`;
    }
    return truncated;
  }

  /** Hero panel for startup screen. */
  #heroPanel(agentName: string, taglines: readonly string[]): string {
    const lines: string[] = ["", this.#brand(this.#bold(agentName)), ""];
    for (const tag of taglines) {
      if (tag.length > 0) {
        lines.push(this.#dim(tag));
      }
    }
    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Plain Fallback
  // ──────────────────────────────────────

  renderPlainFallback(vm: PlainFallbackViewModel): string {
    return vm.lines.join("\n");
  }

  // ──────────────────────────────────────
  // Warning / Error
  // ──────────────────────────────────────

  renderWarningError(vm: WarningErrorViewModel): string {
    const tag = this.#severity(`[${vm.severity.toUpperCase()}]`, vm.severity);
    const title = this.#bold(vm.title);
    const lines = [`${tag} ${title}: ${vm.message}`];
    if (vm.details !== undefined && vm.details.length > 0) {
      for (const detail of vm.details) {
        lines.push(this.#dim(`  ${detail}`));
      }
    }
    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Status
  // ──────────────────────────────────────

  renderStatus(vm: StatusViewModel): string {
    const lines: string[] = [
      this.#brand(`${vm.agentName} is ready`),
      this.#rail(`model: ${this.#dim(`${vm.model.provider}/${vm.model.id}`)}`),
      vm.profileId === undefined ? undefined : this.#rail(`profile: ${this.#dim(vm.profileId)}`),
      this.#rail(`security: ${this.#severity(vm.securityMode, vm.securityMode === "open" ? "warn" : "ok")}`),
      this.#rail(`skills: ${vm.skillCount}${vm.skillAutonomy !== undefined ? ` (${vm.skillAutonomy})` : ""}`),
      this.#rail(`tools: ${vm.toolCount}`),
      this.#rail(`mcp: ${vm.mcp.active}/${vm.mcp.total}`),
      this.#rail(`workflow: ${vm.workflowAvailable ? this.#severity("available", "ok") : this.#dim("unavailable")}`),
      this.#rail(`workflow run: ${vm.workflowRunActive ? this.#severity("active", "ok") : this.#dim("inactive")}`),
    ].filter((line): line is string => line !== undefined);

    for (const warning of vm.warnings) {
      lines.push(this.renderWarningError(warning));
    }

    if (vm.sections !== undefined && vm.sections.length > 0) {
      for (const section of vm.sections) {
        lines.push("");
        lines.push(this.render(section));
      }
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Table
  // ──────────────────────────────────────

  renderTable(vm: TableViewModel): string {
    if (vm.rows.length === 0) {
      const empty = vm.emptyMessage ?? "No data.";
      return vm.title !== undefined
        ? `${this.#bold(vm.title)}\n${this.#dim(empty)}`
        : empty;
    }

    const widths = computeColumnWidths(vm.columns, vm.rows);
    const lines: string[] = [];

    if (vm.title !== undefined) {
      lines.push(this.#bold(vm.title));
    }

    // Header row with brand color
    const headerCells = vm.columns.map((col, i) =>
      this.#brand(padVisibleAlign(col.header, widths[i], col.alignment ?? "left"))
    );
    lines.push(headerCells.join("  "));

    // Separator
    const horiz = this.#useUnicode ? "─" : "-";
    const sepCells = vm.columns.map((col, i) =>
      horiz.repeat(widths[i])
    );
    lines.push(this.#dim(sepCells.join("  ")));

    // Data rows
    for (const row of vm.rows) {
      const cells = vm.columns.map((col, i) => {
        const raw = row[col.key];
        const text = raw === undefined ? "" : String(raw);
        const aligned = padVisibleAlign(text, widths[i], col.alignment ?? "left");
        return col.emphasis === "strong" ? this.#bold(aligned) : aligned;
      });
      lines.push(cells.join("  "));
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Key-Value Block
  // ──────────────────────────────────────

  renderKeyValueBlock(vm: KeyValueBlockViewModel): string {
    const lines: string[] = [];
    if (vm.title !== undefined) {
      lines.push(this.#bold(vm.title));
    }

    for (const entry of vm.entries) {
      const prefix = entry.severity !== undefined
        ? `${this.#inlineSignal(entry.severity)} `
        : "";
      lines.push(`${prefix}${entry.key}: ${entry.value}`);
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // List
  // ──────────────────────────────────────

  renderList(vm: ListViewModel): string {
    if (vm.items.length === 0) {
      const empty = vm.emptyMessage ?? "No items.";
      return vm.title !== undefined
        ? `${this.#bold(vm.title)}\n${this.#dim(empty)}`
        : empty;
    }

    const lines: string[] = [];
    if (vm.title !== undefined) {
      lines.push(this.#bold(vm.title));
    }

    for (let i = 0; i < vm.items.length; i++) {
      const item = vm.items[i];
      const bullet = vm.ordered ? `${i + 1}.` : this.#glyph("bullet");
      const prefix = item.severity !== undefined
        ? `${this.#inlineSignal(item.severity)} `
        : "";
      const valuePart = item.value !== undefined ? `: ${item.value}` : "";
      lines.push(`${bullet} ${prefix}${item.label}${valuePart}`);
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Approval / Security
  // ──────────────────────────────────────

  renderApprovalSecurity(vm: ApprovalSecurityViewModel): string {
    const copy = this.#copy;
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const vert = this.#useUnicode ? "│" : "|";
    const warningSymbol = this.#useUnicode ? "⚠" : "!";

    const titleText = `${warningSymbol} ${copy.permissionRequired}`;
    const titleLine = `${topLeft}${horiz} ${this.#caution(this.#bold(titleText))} ${horiz.repeat(Math.max(0, this.#capabilities.terminalWidth - measureVisibleWidth(titleText) - 5))}${topRight}`;

    // Key-value rows
    const kvLines: string[] = [];
    const labelWidth = Math.max(
      measureVisibleWidth(copy.cardTool),
      measureVisibleWidth(copy.cardRisk),
      measureVisibleWidth(copy.cardTarget)
    );

    kvLines.push(`  ${this.#dim(padVisibleEnd(copy.cardTool, labelWidth))}  ${this.#action(isolateLtr(vm.toolName))}`);
    if (vm.riskClass !== undefined) {
      const riskColor = vm.severity === "error" ? (text: string) => this.#severity(text, "error") : this.#caution.bind(this);
      kvLines.push(`  ${this.#dim(padVisibleEnd(copy.cardRisk, labelWidth))}  ${riskColor(isolateLtr(vm.riskClass))}`);
    }
    kvLines.push(`  ${this.#dim(padVisibleEnd(copy.cardTarget, labelWidth))}  ${isolateLtr(vm.targetSummary)}`);

    // Action row
    const actionParts: string[] = [];
    for (const action of vm.actions) {
      const style = action.severity === "error"
        ? (text: string) => this.#severity(text, "error")
        : action.id === "deny"
          ? (text: string) => this.#severity(text, "error")
          : this.#action.bind(this);
      actionParts.push(style(this.#bold(action.label)));
    }
    const actionRow = `  ${actionParts.join(`    `)}`;

    // Compute width
    const allContentLines = [
      ...kvLines,
      "",
      actionRow
    ];
    const maxContentWidth = Math.max(0, ...allContentLines.map((l) => measureVisibleWidth(l)));
    const width = Math.min(
      this.#capabilities.terminalWidth,
      Math.max(measureVisibleWidth(titleText) + 6, maxContentWidth + 4)
    );

    // Build frame
    const lines: string[] = [];
    lines.push(`${topLeft}${horiz.repeat(width - 2)}${topRight}`);
    lines.push(`${vert} ${padVisibleEnd(this.#caution(this.#bold(titleText)), width - 4)} ${vert}`);
    for (const line of allContentLines) {
      lines.push(`${vert} ${padVisibleEnd(line, width - 4)} ${vert}`);
    }
    lines.push(`${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`);

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Onboarding Prompt Card
  // ──────────────────────────────────────

  renderOnboardingPromptCard(vm: OnboardingPromptCardViewModel): string {
    const locale = vm.locale ?? this.#locale;
    const direction = vm.direction ?? (locale === "ar" ? "rtl" : "ltr");
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const selectedMarker = this.#useUnicode ? "▸" : ">";

    const optionMarkerGap = " ";
    const optionMarkerSlotWidth = measureVisibleWidth(selectedMarker) + measureVisibleWidth(optionMarkerGap);
    const hasStructuredRows = this.#hasStructuredOnboardingPromptRows(vm);
    const rawContentLines: string[] = [
      ...vm.bodyLines,
      ...(vm.technicalLines ?? []),
      ...(vm.statusLines ?? []).map((line) => line.text),
      ...this.#onboardingPromptCardRawOptionLines(vm, optionMarkerSlotWidth),
      vm.hint ?? "",
    ].filter((line) => line.length > 0);
    const maxRawContent = Math.max(0, ...rawContentLines.map((line) => measureVisibleWidth(line)));
    const requestedWidth = Math.max(24, this.#capabilities.terminalWidth);
    const naturalWidth = hasStructuredRows
      ? requestedWidth
      : Math.max(40, maxRawContent + 4, measureVisibleWidth(vm.title) + 12);
    const width = Math.min(requestedWidth, naturalWidth);
    const contentWidth = Math.max(8, width - 4);
    const innerWidth = Math.max(8, width - 2);
    const titleRuleWidth = Math.min(4, Math.max(1, innerWidth - 4));
    const leftTitleRule = `${horiz.repeat(titleRuleWidth)} `;
    const titleRaw = this.#onboardingTitle(vm.title, Math.max(1, innerWidth - measureVisibleWidth(leftTitleRule) - 2), direction);
    const top = direction === "rtl"
      ? this.#renderRtlOnboardingPromptCardTop(topLeft, topRight, horiz, innerWidth, titleRaw, titleRuleWidth)
      : this.#renderLtrOnboardingPromptCardTop(topLeft, topRight, horiz, innerWidth, titleRaw, leftTitleRule);
    const bottom = this.#surfaceBorder(`${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`);

    const lines: string[] = [top];

    if (direction === "rtl") {
      lines.push(...this.#renderRtlOnboardingBodyLines(vm.bodyLines, contentWidth, vm.bodyLineStyles));
    } else {
      for (let i = 0; i < vm.bodyLines.length; i++) {
        const text = this.#localizedNatural(vm.bodyLines[i], direction, contentWidth);
        const styledText = vm.bodyLineStyles?.[i]?.emphasis === "strong" ? this.#bold(text) : text;
        const styled = i === 0 ? this.#primary(styledText) : this.#secondary(styledText);
        lines.push(`  ${styled}`);
      }
    }

    for (const technicalLine of vm.technicalLines ?? []) {
      const text = this.#primary(this.#localizedTechnical(technicalLine, locale, contentWidth));
      lines.push(`  ${direction === "rtl" ? padVisibleStart(text, contentWidth) : text}`);
    }

    for (const statusLine of vm.statusLines ?? []) {
      lines.push(`  ${this.#renderOnboardingPromptCardStatusLine(statusLine, locale, direction, contentWidth)}`);
    }

    const hasPreOptionContent = vm.bodyLines.length > 0
      || (vm.technicalLines?.length ?? 0) > 0
      || (vm.statusLines?.length ?? 0) > 0;
    if (hasPreOptionContent && vm.options.length > 0) {
      lines.push("  ");
    }

    if (hasStructuredRows) {
      lines.push(...this.#renderStructuredOnboardingPromptCardOptions(
        vm,
        selectedMarker,
        optionMarkerGap,
        optionMarkerSlotWidth,
        locale,
        contentWidth
      ));
    } else {
      let renderedNavigationSeparator = false;
      for (let i = 0; i < vm.options.length; i++) {
        const option = vm.options[i];
        if (option.group === "navigation" && !renderedNavigationSeparator && i > 0) {
          lines.push("  ");
          renderedNavigationSeparator = true;
        }
        const isSelected = i === vm.selectedOptionIndex;
        const marker = isSelected ? this.#action(selectedMarker) : " ";
        const optionLabelWidth = Math.max(1, contentWidth - optionMarkerSlotWidth);
        const optionText = option.technical === true
          ? this.#localizedTechnical(option.label, locale, optionLabelWidth)
          : this.#localizedNatural(option.label, direction, optionLabelWidth);
        const styledOption = this.#primary(optionText);
        const optionRow = direction === "rtl"
          ? isolateRtl(closeOpenBidiIsolates(`${styledOption}${optionMarkerGap}${marker}`))
          : `${marker}${optionMarkerGap}${styledOption}`;
        lines.push(direction === "rtl"
          ? `  ${padVisibleStart(optionRow, contentWidth)}`
          : `  ${optionRow}`);
        if (option.description !== undefined) {
          lines.push(...this.#renderOnboardingPromptCardOptionDescription(option.description, direction, contentWidth));
        }
      }
    }

    if (vm.hint !== undefined && vm.hint.length > 0) {
      const hint = this.#muted(this.#localizedTechnical(vm.hint, locale, contentWidth));
      lines.push(`  ${padVisibleStart(hint, contentWidth)}`);
    }

    lines.push(bottom);
    return lines.join("\n");
  }

  #hasStructuredOnboardingPromptRows(vm: OnboardingPromptCardViewModel): boolean {
    return (vm.columns?.length ?? 0) > 0;
  }

  #renderOnboardingPromptCardStatusLine(
    line: PromptCardStatusLine,
    locale: UiLocale,
    cardDirection: TextDirection,
    contentWidth: number
  ): string {
    const direction = line.direction ?? "auto";
    const textDirection = direction === "auto" ? cardDirection : direction;
    const rendered = textDirection === "ltr"
      ? this.#localizedTechnical(line.text, locale, contentWidth)
      : this.#localizedNatural(line.text, "rtl", contentWidth);
    const styled = this.#stylePromptCardStatusLine(rendered, line.tone ?? "default");
    return textDirection === "rtl" ? padVisibleStart(styled, contentWidth) : styled;
  }

  #stylePromptCardStatusLine(
    text: string,
    tone: NonNullable<PromptCardStatusLine["tone"]>
  ): string {
    switch (tone) {
      case "active":
        return this.#severity(text, "ok");
      case "warning":
        return this.#severity(text, "warn");
      case "muted":
        return this.#muted(text);
      case "default":
        return this.#primary(text);
    }
  }

  #onboardingPromptCardRawOptionLines(vm: OnboardingPromptCardViewModel, optionMarkerSlotWidth: number): string[] {
    if (!this.#hasStructuredOnboardingPromptRows(vm)) {
      return vm.options.flatMap((option) => [`${option.label}${" ".repeat(optionMarkerSlotWidth)}`, option.description ?? ""]);
    }

    const columns = vm.columns ?? [];
    return [
      ...(vm.showColumnHeaders === false ? [] : [columns.map((column) => column.header).join("  ")]),
      ...vm.options.map((option) => [
        ...columns.map((column) => option.cells?.[column.key] ?? (column.key === "name" ? option.label : "")),
        ...this.#onboardingOptionBadges(option, vm.showCurrentBadge),
      ].filter((part) => part.length > 0).join("  ")),
    ];
  }

  #renderStructuredOnboardingPromptCardOptions(
    vm: OnboardingPromptCardViewModel,
    selectedMarker: string,
    optionMarkerGap: string,
    optionMarkerSlotWidth: number,
    locale: UiLocale,
    contentWidth: number
  ): string[] {
    const columns = vm.columns ?? [];
    if (columns.length === 0) return [];

    const tableDirection = vm.tableDirection ?? "ltr";
    const dataWidth = Math.max(8, contentWidth - optionMarkerSlotWidth);
    const layout = this.#structuredPromptColumnLayout(columns, vm.options, dataWidth);
    const lines: string[] = [];

    if (vm.showColumnHeaders !== false) {
      const header = this.#structuredPromptRow(
        columns,
        Object.fromEntries(columns.map((column) => [column.key, column.header])),
        [],
        layout,
        locale,
        "ltr",
        "header"
      );
      lines.push(tableDirection === "rtl"
        ? `  ${header}${" ".repeat(optionMarkerSlotWidth)}`
        : `  ${" ".repeat(optionMarkerSlotWidth)}${header}`);
    }

    let renderedNavigationSeparator = false;
    for (let i = 0; i < vm.options.length; i++) {
      const option = vm.options[i];
      if (option.group === "navigation" && !renderedNavigationSeparator && i > 0) {
        lines.push("  ");
        renderedNavigationSeparator = true;
      }
      const isSelected = i === vm.selectedOptionIndex;
      const marker = isSelected ? this.#action(selectedMarker) : " ";
      const row = this.#structuredPromptRow(
        columns,
        this.#structuredPromptOptionCells(option, columns),
        this.#onboardingOptionBadges(option, vm.showCurrentBadge),
        layout,
        locale,
        "ltr",
        "option"
      );
      lines.push(tableDirection === "rtl"
        ? `  ${row}${optionMarkerGap}${marker}`
        : `  ${marker}${optionMarkerGap}${row}`);
    }

    return lines;
  }

  #structuredPromptColumnLayout(
    columns: readonly OnboardingPromptColumn[],
    options: readonly OnboardingPromptOption[],
    dataWidth: number
  ): number[] {
    if (columns.length === 1) return [dataWidth];

    const gapWidth = 2 * (columns.length - 1);
    const available = Math.max(columns.length, dataWidth - gapWidth);
    const primaryIndex = this.#structuredPromptPrimaryColumnIndex(columns);
    const primaryColumn = columns[primaryIndex]!;
    const primaryNaturalWidth = Math.max(
      measureVisibleWidth(primaryColumn.header),
      ...options.map((option) => measureVisibleWidth(option.cells?.[primaryColumn.key] ?? option.label))
    );
    const nonPrimaryIndices = columns
      .map((_, index) => index)
      .filter((index) => index !== primaryIndex);
    const maxPrimaryWidth = Math.max(1, Math.min(24, available - nonPrimaryIndices.length));
    const primaryWidth = Math.max(1, Math.min(Math.max(8, primaryNaturalWidth), maxPrimaryWidth));
    const widths = Array.from({ length: columns.length }, () => 1);
    widths[primaryIndex] = primaryWidth;
    const remainingWidth = Math.max(nonPrimaryIndices.length, available - primaryWidth);
    const baseRemainingWidth = Math.max(1, Math.floor(remainingWidth / nonPrimaryIndices.length));
    let assigned = primaryWidth;
    for (let i = 0; i < nonPrimaryIndices.length; i++) {
      const index = nonPrimaryIndices[i]!;
      const width = i === nonPrimaryIndices.length - 1
        ? Math.max(1, available - assigned)
        : baseRemainingWidth;
      widths[index] = width;
      assigned += width;
    }
    return widths;
  }

  #structuredPromptOptionCells(
    option: OnboardingPromptOption,
    columns: readonly OnboardingPromptColumn[]
  ): Record<string, string> {
    const cells: Record<string, string> = { ...(option.cells ?? {}) };
    const primaryColumn = this.#structuredPromptPrimaryColumn(columns);
    if (primaryColumn !== undefined && cells[primaryColumn.key] === undefined) {
      cells[primaryColumn.key] = option.label;
    }
    if (columns.length === 1 && option.description !== undefined && cells[primaryColumn?.key ?? ""] === option.label) {
      cells[primaryColumn!.key] = `${option.label} ${option.description}`;
    }
    if (columns.length > 1 && option.description !== undefined) {
      const descriptionColumn = this.#structuredPromptDescriptionColumn(columns);
      if (descriptionColumn !== undefined && cells[descriptionColumn.key] === undefined) {
        cells[descriptionColumn.key] = option.description;
      }
    }
    return cells;
  }

  #structuredPromptPrimaryColumnIndex(columns: readonly OnboardingPromptColumn[]): number {
    const nameIndex = columns.findIndex((column) => column.key === "name");
    return nameIndex >= 0 ? nameIndex : 0;
  }

  #structuredPromptPrimaryColumn(columns: readonly OnboardingPromptColumn[]): OnboardingPromptColumn | undefined {
    return columns[this.#structuredPromptPrimaryColumnIndex(columns)];
  }

  #structuredPromptDescriptionColumn(columns: readonly OnboardingPromptColumn[]): OnboardingPromptColumn | undefined {
    const descriptionColumn = columns.find((column) => column.key === "description");
    if (descriptionColumn !== undefined) return descriptionColumn;
    const primaryIndex = this.#structuredPromptPrimaryColumnIndex(columns);
    return columns.find((_, index) => index !== primaryIndex) ?? columns[columns.length - 1];
  }

  #structuredPromptRow(
    columns: readonly OnboardingPromptColumn[],
    cells: Readonly<Record<string, string>>,
    badges: readonly string[],
    widths: readonly number[],
    locale: UiLocale,
    direction: TextDirection,
    kind: "header" | "option"
  ): string {
    const renderedCells = columns.map((column, index) => {
      const rawValue = cells[column.key] ?? "";
      const width = widths[index] ?? 1;
      if (kind === "option" && index === columns.length - 1 && badges.length > 0) {
        const primaryValue = column.key === "name" || (index === 0 && columns.every((candidate) => candidate.key !== "name"));
        return this.#structuredPromptCellWithBadges(rawValue, badges, width, locale, direction, primaryValue);
      }
      const text = kind === "header"
        ? this.#secondary(this.#localizedPromptCell(rawValue, locale, direction, width))
        : column.key === "name" || (index === 0 && columns.every((candidate) => candidate.key !== "name"))
          ? this.#primary(this.#localizedPromptCell(rawValue, locale, direction, width))
          : this.#muted(this.#localizedPromptCell(rawValue, locale, direction, width));
      return this.#padStructuredPromptCell(text, width, column.align);
    });
    return renderedCells.join("  ");
  }

  #structuredPromptCellWithBadges(
    value: string,
    badges: readonly string[],
    width: number,
    locale: UiLocale,
    direction: TextDirection,
    primaryValue: boolean
  ): string {
    const badgeText = badges.join("  ");
    const badgeWidth = measureVisibleWidth(badgeText);
    if (badgeWidth >= width) {
      return padVisibleEnd(this.#secondary(this.#localizedPromptCell(badgeText, locale, direction, width)), width);
    }

    const gap = "  ";
    const gapWidth = measureVisibleWidth(gap);
    const valueWidth = Math.max(0, width - badgeWidth - gapWidth);
    const valueText = valueWidth > 0
      ? this.#localizedPromptCell(value, locale, direction, valueWidth)
      : "";
    const styledValue = primaryValue ? this.#primary(valueText) : this.#muted(valueText);
    const styledBadges = this.#secondary(this.#localizedPromptCell(badgeText, locale, direction, badgeWidth));
    if (valueWidth === 0) {
      return padVisibleEnd(styledBadges, width);
    }
    return `${padVisibleEnd(styledValue, valueWidth)}${gap}${styledBadges}`;
  }

  #padStructuredPromptCell(text: string, width: number, align?: OnboardingPromptColumn["align"]): string {
    return align === "right" ? padVisibleStart(text, width) : padVisibleEnd(text, width);
  }

  #localizedPromptCell(value: string, locale: UiLocale, direction: TextDirection, maxWidth: number): string {
    const truncated = truncateVisible(value, maxWidth);
    if (locale === "ar") {
      return /[A-Za-z0-9][._/-]?[A-Za-z0-9]*|^[A-Z0-9_]+$/u.test(value)
        ? isolateLtr(truncated)
        : isolateRtl(closeOpenBidiIsolates(truncated));
    }
    return direction === "rtl" ? isolateRtl(closeOpenBidiIsolates(truncated)) : truncated;
  }

  #onboardingOptionBadges(option: OnboardingPromptOption, showCurrentBadge = true): readonly string[] {
    const badges = [...(option.badges ?? [])];
    if (showCurrentBadge && option.current === true && !badges.includes("Current")) {
      badges.push("Current");
    }
    return badges;
  }

  #renderLtrOnboardingPromptCardTop(
    topLeft: string,
    topRight: string,
    horiz: string,
    innerWidth: number,
    titleRaw: string,
    leftTitleRule: string
  ): string {
    const rightRuleWidth = Math.max(
      0,
      innerWidth - measureVisibleWidth(leftTitleRule) - measureVisibleWidth(titleRaw) - 1
    );
    return [
      this.#surfaceBorder(`${topLeft}${leftTitleRule}`),
      this.#brand(this.#bold(titleRaw)),
      this.#surfaceBorder(` ${horiz.repeat(rightRuleWidth)}${topRight}`),
    ].join("");
  }

  #renderRtlOnboardingPromptCardTop(
    topLeft: string,
    topRight: string,
    horiz: string,
    innerWidth: number,
    titleRaw: string,
    titleRuleWidth: number
  ): string {
    const rightTitleRule = ` ${horiz.repeat(titleRuleWidth)}`;
    const leftRuleWidth = Math.max(
      0,
      innerWidth - measureVisibleWidth(titleRaw) - measureVisibleWidth(rightTitleRule) - 1
    );
    return [
      this.#surfaceBorder(`${topLeft}${horiz.repeat(leftRuleWidth)} `),
      this.#brand(this.#bold(titleRaw)),
      this.#surfaceBorder(`${rightTitleRule}${topRight}`),
    ].join("");
  }

  #renderOnboardingPromptCardOptionDescription(
    description: string,
    direction: TextDirection,
    contentWidth: number
  ): string[] {
    const descriptionWidth = Math.max(1, contentWidth - 4);
    if (direction !== "rtl") {
      const text = this.#muted(this.#localizedNatural(description, direction, descriptionWidth));
      return [`    ${text}`];
    }

    return wrapText(description, Math.max(8, descriptionWidth)).map((segment) => {
      const text = this.#muted(isolateRtl(closeOpenBidiIsolates(segment)));
      return `  ${padVisibleStart(text, contentWidth)}`;
    });
  }

  #localizedNatural(value: string, direction: TextDirection, maxWidth: number): string {
    const truncated = truncateVisible(value, maxWidth);
    return direction === "rtl" ? isolateRtl(truncated) : truncated;
  }

  #renderRtlOnboardingBodyLines(
    bodyLines: readonly string[],
    contentWidth: number,
    bodyLineStyles?: OnboardingPromptCardViewModel["bodyLineStyles"]
  ): string[] {
    if (bodyLines.length === 0) return [];

    const blockWidth = computeRtlOnboardingBodyBlockWidth(bodyLines, contentWidth);
    const rendered: string[] = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const baseStyle = i === 0 ? this.#primary.bind(this) : this.#secondary.bind(this);
      const style = (value: string): string => {
        const styled = bodyLineStyles?.[i]?.emphasis === "strong" ? this.#bold(value) : value;
        return baseStyle(styled);
      };
      const numbered = splitNumberedRtlLine(bodyLines[i]);
      if (numbered !== undefined) {
        rendered.push(...this.#renderRtlNumberedBodyLine(numbered, blockWidth, contentWidth, style));
      } else {
        rendered.push(...this.#renderRtlCardBodyLine(bodyLines[i], blockWidth, contentWidth, style));
      }
    }
    return rendered;
  }

  #renderRtlCardBodyLine(
    line: string,
    blockWidth: number,
    contentWidth: number,
    style: (value: string) => string
  ): string[] {
    if (line.length === 0) return ["  "];
    return wrapText(line, blockWidth).map((segment) => {
      const text = style(isolateRtl(closeOpenBidiIsolates(segment)));
      return `  ${padVisibleStart(padVisibleStart(text, blockWidth), contentWidth)}`;
    });
  }

  #renderRtlNumberedBodyLine(
    line: RtlNumberedBodyLine,
    blockWidth: number,
    contentWidth: number,
    style: (value: string) => string
  ): string[] {
    const marker = style(isolateLtr(line.marker));
    const markerWidth = measureVisibleWidth(marker);
    const gap = "  ";
    const markerSlotWidth = markerWidth + measureVisibleWidth(gap);
    const textWidth = Math.max(8, blockWidth - markerSlotWidth);
    return wrapText(line.text, textWidth).map((segment, index) => {
      const text = style(isolateRtl(closeOpenBidiIsolates(segment)));
      const row = index === 0
        ? `${padVisibleStart(text, textWidth)}${gap}${marker}`
        : `${padVisibleStart(text, textWidth)}${" ".repeat(markerSlotWidth)}`;
      return `  ${padVisibleStart(padVisibleStart(row, blockWidth), contentWidth)}`;
    });
  }

  // ──────────────────────────────────────
  // Activity Timeline
  // ──────────────────────────────────────

  renderActivityTimeline(vm: ActivityTimelineViewModel): string {
    if (vm.events.length === 0) {
      return this.#dim("No activity.");
    }

    const lines = vm.events.map((event) => this.#renderTimelineEvent(event));
    return lines.join("\n");
  }

  #renderTimelineEvent(event: TimelineEvent): string {
    const marker = this.#timelineStatusMarker(event.status);
    const parts: string[] = [`${marker} ${this.#bold(event.tool)}`];

    if (event.elapsedMs !== undefined) {
      parts.push(this.#dim(`| ${formatDuration(event.elapsedMs)}`));
    }

    if (event.chars !== undefined && event.sentChars !== undefined) {
      parts.push(
        this.#dim(`| ${formatCount(event.chars)} captured / ${formatCount(event.sentChars)} sent`)
      );
      if (event.truncated) {
        parts.push(this.#dim("/ compressed"));
      }
    }

    if (event.decision !== undefined) {
      parts.push(this.#caution(`| decision: ${event.decision}`));
    }

    if (event.riskClass !== undefined) {
      parts.push(this.#caution(`| risk: ${event.riskClass}`));
    }

    return parts.join(" ");
  }

  #timelineStatusMarker(status: TimelineEvent["status"]): string {
    if (!this.#useUnicode) {
      switch (status) {
        case "pending": return "[ ]";
        case "running": return "[>]";
        case "done": return "[x]";
        case "failed": return "[-]";
        case "gated": return "[?]";
      }
    }
    switch (status) {
      case "pending":
        return this.#dim("○");
      case "running":
        return this.#action(this.#spinnerFrame(this.#tokens.contract.glyph.spinner.waiting));
      case "done":
        return this.#severity("✓", "ok");
      case "failed":
        return this.#severity("✗", "error");
      case "gated":
        return this.#caution("⚠");
    }
  }

  // ──────────────────────────────────────
  // Progress / Context Rail
  // ──────────────────────────────────────

  renderProgressRail(vm: ProgressContextRailViewModel): string {
    if (vm.steps.length === 0 && vm.sessionElapsedMs === undefined && vm.taskElapsedMs === undefined) {
      const empty = vm.title !== undefined
        ? `${this.#bold(vm.title)}\n${this.#dim("No steps.")}`
        : this.#dim("No steps.");
      return empty;
    }

    const parts: string[] = [];
    if (vm.title !== undefined) {
      parts.push(this.#bold(vm.title));
    }

    for (const step of vm.steps) {
      const marker = this.#progressStatusMarker(step.status);
      const label = step.status === "active"
        ? this.#action(step.label)
        : step.status === "failed"
          ? this.#severity(step.label, "error")
          : step.status === "done"
            ? this.#dim(step.label)
            : step.label;
      parts.push(`${marker} ${label}`);
    }

    const timerParts: string[] = [];
    if (vm.sessionElapsedMs !== undefined) {
      const glyph = this.#useUnicode ? "◷" : "sess";
      timerParts.push(`${glyph} ${formatDuration(vm.sessionElapsedMs)}`);
    }
    if (vm.taskElapsedMs !== undefined) {
      if (vm.taskElapsedMs === "idle") {
        const glyph = this.#useUnicode ? "⧖" : "task";
        timerParts.push(`${glyph} idle`);
      } else {
        const glyph = this.#useUnicode ? "⧖" : "task";
        timerParts.push(`${glyph} ${formatDuration(vm.taskElapsedMs)}`);
      }
    }
    if (timerParts.length > 0) {
      parts.push(timerParts.join("  "));
    }

    return parts.join("\n");
  }

  #progressStatusMarker(status: ProgressContextRailViewModel["steps"][number]["status"]): string {
    if (!this.#useUnicode) {
      switch (status) {
        case "pending": return "[ ]";
        case "active": return "[>]";
        case "done": return "[x]";
        case "failed": return "[-]";
      }
    }
    switch (status) {
      case "pending":
        return this.#dim("○");
      case "active":
        return this.#action(this.#spinnerFrame(this.#tokens.contract.glyph.spinner.waiting));
      case "done":
        return this.#severity("✓", "ok");
      case "failed":
        return this.#severity("✗", "error");
    }
  }

  // ──────────────────────────────────────
  // Tool Activity Rail
  // ──────────────────────────────────────

  renderToolActivityRail(vm: ToolActivityRailViewModel): string {
    if (vm.events.length === 0) {
      return this.#dim("No activity.");
    }
    const lines = vm.events.map((event) => this.#renderToolActivityEvent(event));
    return lines.join("\n");
  }

  #renderToolActivityEvent(event: ToolActivityRailEvent): string {
    const glyph = this.#toolActivityGlyph(event);
    const labelKey = event.label ?? "run";
    const label = (this.#copy as unknown as Record<string, string>)[labelKey] ?? labelKey;
    const targetRaw = event.target ?? "";
    const target = this.#locale === "ar" && targetRaw.length > 0 ? isolateLtr(targetRaw) : targetRaw;
    const elapsed = event.elapsedMs !== undefined ? formatDuration(event.elapsedMs) : "";

    const parts: string[] = [];
    parts.push(glyph);
    parts.push(label);
    if (target.length > 0) {
      parts.push(target);
    }
    if (elapsed.length > 0) {
      parts.push(this.#dim(elapsed));
    }

    const content = parts.join("  ");
    const line = this.#rail(content);
    return truncateVisible(line, this.#capabilities.terminalWidth);
  }

  #toolActivityGlyph(event: ToolActivityRailEvent): string {
    if (event.glyph) {
      return this.#useUnicode ? event.glyph : this.#asciiToolIcon(event.tool, event.glyph);
    }
    if (event.status === "failed") {
      return this.#useUnicode ? this.#severity("✗", "error") : "[-]";
    }
    if (event.status === "gated") {
      return this.#useUnicode ? this.#caution("⚠") : "[?]";
    }
    if (event.status === "running") {
      const frames = this.#useUnicode
        ? this.#tokens.contract.glyph.spinner.waiting
        : ["[>]", "[>.]", "[>..]", "[>...]", "[>..]", "[>.]"];
      return this.#brand(this.#spinnerFrame(frames));
    }
    const icon = this.#tokens.contract.toolIcon[event.tool];
    if (icon) {
      return this.#useUnicode ? icon : this.#asciiToolIcon(event.tool, icon);
    }
    if (event.status === "done") {
      return this.#useUnicode ? this.#severity("✓", "ok") : "[x]";
    }
    return this.#useUnicode ? this.#dim("○") : "[ ]";
  }

  #asciiToolIcon(tool: string, _unicode: string): string {
    const map: Record<string, string> = {
      terminal: "$",
      webSearch: "O",
      readFile: "R",
      writeFile: "W",
      searchFiles: "S",
      executeCode: "X",
      browserNavigate: "B",
      delegateTask: "D",
      mixtureOfAgents: "M",
      memory: "m",
      clarify: "?",
      cronjob: "C",
      process: "P",
      todo: "t",
      telegram: "T",
      media: "m",
    };
    return map[tool] ?? _unicode;
  }

  // ──────────────────────────────────────
  // File Change Preview
  // ──────────────────────────────────────

  renderFileChangePreview(vm: FileChangePreviewViewModel): string {
    const marker = this.#useUnicode ? "◇" : "*";
    const action = this.#fileChangeActionLabel(vm.changeType);
    const path = this.#locale === "ar" ? isolateLtr(vm.path) : vm.path;
    const lines: string[] = [
      truncateVisible(this.#rail(`${marker} ${action} ${path}`), this.#capabilities.terminalWidth),
    ];

    for (const summary of vm.summary ?? []) {
      lines.push(truncateVisible(this.#rail(`  + ${summary}`), this.#capabilities.terminalWidth));
    }

    const preview = boundedFileChangePreviewLines(vm, 8);
    for (const line of preview.lines) {
      lines.push(truncateVisible(this.#rail(`  ${this.#styleDiffLine(line)}`), this.#capabilities.terminalWidth));
    }

    if (preview.omittedLineCount > 0) {
      lines.push(truncateVisible(this.#rail(`  ${this.#dim(this.#copy.omittedDiffLines(preview.omittedLineCount))}`), this.#capabilities.terminalWidth));
    }

    return lines.join("\n");
  }

  #fileChangeActionLabel(changeType: FileChangePreviewViewModel["changeType"]): string {
    switch (changeType) {
      case "added":
        return this.#copy.created;
      case "modified":
        return this.#copy.edited;
      case "deleted":
        return this.#copy.deleted;
    }
  }

  #styleDiffLine(line: string): string {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) {
      return this.#severity(line, "ok");
    }
    if (trimmed.startsWith("-")) {
      return this.#severity(line, "error");
    }
    if (trimmed.startsWith("@@")) {
      return this.#dim(line);
    }
    return line;
  }

  // ──────────────────────────────────────
  // Picker
  // ──────────────────────────────────────

  renderPicker(vm: PickerViewModel): string {
    const lines: string[] = [this.#bold(vm.title)];

    for (let i = 0; i < vm.options.length; i++) {
      const opt = vm.options[i];
      const marker = opt.selected ? this.#action(">") : " ";
      const num = String(i + 1).padStart(2);
      const label = opt.selected ? this.#action(opt.label) : opt.label;
      lines.push(`${marker} ${num}) ${label}`);
      if (opt.description !== undefined) {
        lines.push(this.#dim(`     ${opt.description}`));
      }
    }

    return lines.join("\n");
  }

  renderSlashMenu(vm: import("../../contracts/view-model.js").SlashMenuViewModel): string {
    const visibleOptions = vm.options;
    if (visibleOptions.length === 0) {
      return this.#muted(this.#copy.slashNoMatches(this.#technical(vm.query)));
    }

    const markerWidth = 2;
    const commandWidth = Math.min(
      18,
      Math.max(...visibleOptions.map((option) => measureVisibleWidth(this.#technical(option.label))))
    );
    const gap = 4;
    const descriptionWidth = Math.max(8, this.#capabilities.terminalWidth - markerWidth - commandWidth - gap);

    return visibleOptions
      .map((option, index) => {
        const selected = index === vm.selectedIndex;
        const marker = selected ? `${this.#action(">")} ` : "  ";
        const commandText = this.#technical(option.label);
        const command = padVisibleEnd(selected ? this.#action(commandText) : this.#primary(commandText), commandWidth);
        const description = truncateVisible(
          this.#secondary(this.#slashDescription(option.id, option.description ?? "")),
          descriptionWidth
        );
        return `${marker}${command}${" ".repeat(gap)}${description}`;
      })
      .join("\n");
  }

  #technical(value: string, maxWidth?: number): string {
    const rendered = maxWidth === undefined ? value : truncateVisible(value, maxWidth);
    return this.#locale === "ar" ? isolateLtr(rendered) : rendered;
  }

  #slashDescription(commandName: string, fallback: string): string {
    switch (commandName) {
      case "help":
        return this.#copy.slashCommandHelpDescription;
      case "status":
        return this.#copy.slashCommandStatusDescription;
      case "model":
        return this.#copy.slashCommandModelDescription;
      case "tools":
        return this.#copy.slashCommandToolsDescription;
      case "skills":
        return this.#copy.slashCommandSkillsDescription;
      case "exit":
        return this.#copy.slashCommandExitDescription;
      default:
        return fallback;
    }
  }

  #modelRoute(model: { readonly provider: string; readonly id: string }): string {
    return `${this.#technical(model.provider)}/${this.#technical(model.id)}`;
  }

  #startupReadinessLabel(readiness: StartupViewModel["readiness"] | StartupDashboardViewModel["providerReadiness"]): string {
    switch (readiness) {
      case "ready":
        return this.#copy.startupReady;
      case "degraded":
        return this.#copy.startupDegraded;
      case "missing-config":
        return this.#copy.startupMissingConfig;
      case "unknown":
        return this.#copy.startupUnknown;
    }
  }

  #startupTrustLabel(value: StartupDashboardViewModel["workspaceTrust"]): string {
    switch (value) {
      case "trusted":
        return this.#copy.startupTrusted;
      case "untrusted":
        return this.#copy.startupUntrusted;
      case "unknown":
        return this.#copy.startupUnknown;
    }
  }

  #startupVerificationLabel(value: StartupDashboardViewModel["workspaceVerification"]): string {
    switch (value) {
      case "verified":
        return this.#copy.startupVerified;
      case "unverified":
        return this.#copy.startupUnverified;
      case "unknown":
        return this.#copy.startupUnknown;
    }
  }

  #startupVersionStatusLabel(value: StartupDashboardViewModel["versionStatus"]): string {
    switch (value) {
      case "up-to-date":
      case "update-available":
        return this.#technical(value);
      case "unknown":
      case undefined:
        return this.#copy.startupUnknown;
    }
  }

  #startupDashboardTitle(vm: StartupDashboardViewModel): string {
    const version = vm.version.length > 0 ? vm.version : "unknown";
    const session = vm.sessionId !== undefined
      ? `session ${formatSessionDisplayId(vm.sessionId)}`
      : "";
    const separator = this.#useUnicode ? STARTUP_TITLE_SEPARATOR : STARTUP_TITLE_SEPARATOR_ASCII;
    const raw = session.length > 0 ? `${version}${separator}${session}` : version;
    return this.#isRtl() ? isolateLtr(raw) : raw;
  }

  #startupCommands(vm: StartupDashboardViewModel): readonly { readonly name: string; readonly description: string }[] {
    if (vm.availableCommands.length > 0) {
      return vm.availableCommands;
    }
    return [
      { name: "/tools", description: this.#copy.startupCommandTools },
      { name: "/skills", description: this.#copy.startupCommandSkills },
      { name: "/model", description: this.#copy.startupCommandModel },
      { name: "/status", description: this.#copy.startupCommandStatus },
    ];
  }

  // ──────────────────────────────────────
  // Startup
  // ──────────────────────────────────────

  renderStartup(vm: StartupViewModel): string {
    const lines: string[] = [this.#heroPanel(vm.agentName, vm.taglines)];

    lines.push("");
    lines.push(this.#rail(`${this.#copy.startupModel}: ${this.#dim(this.#modelRoute(vm.model))}`));

    const readinessText = this.#locale === "ar" ? this.#startupReadinessLabel(vm.readiness) : vm.readiness;
    const readinessColor = vm.readiness === "ready"
      ? this.#severity(readinessText, "ok")
      : vm.readiness === "degraded"
        ? this.#caution(readinessText)
        : this.#severity(readinessText, "error");
    lines.push(this.#rail(`${this.#copy.startupReadiness}: ${readinessColor}`));

    for (const warning of vm.warnings) {
      lines.push("");
      lines.push(this.renderWarningError(warning));
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Startup Dashboard
  // ──────────────────────────────────────

  renderStartupDashboard(vm: StartupDashboardViewModel): string {
    if (this.#isRtl()) {
      return this.#renderStartupDashboardRtl(vm);
    }
    return this.#renderStartupDashboardLtr(vm);
  }

  #renderStartupDashboardLtr(vm: StartupDashboardViewModel): string {
    const lines: string[] = [];
    const cardTitle = this.#startupDashboardTitle(vm);

    // Model route readiness line
    const readiness = vm.providerReadiness;
    let modelDot: string;
    let modelLabel: string;
    let readinessColor: string;

    switch (readiness) {
      case "ready":
        modelDot = this.#severity("●", "ok");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#severity(this.#startupReadinessLabel(readiness), "ok");
        break;
      case "degraded":
        modelDot = this.#caution("◐");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#caution(this.#startupReadinessLabel(readiness));
        break;
      case "missing-config":
        modelDot = this.#dim("○");
        modelLabel = this.#copy.startupModelNotConfigured;
        readinessColor = this.#severity(this.#copy.startupMissingConfig, "error");
        break;
      case "unknown":
      default:
        modelDot = this.#dim("○");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#dim(this.#copy.startupUnknown);
        break;
    }

    const modelLine = `${modelDot} ${this.#bold(modelLabel)}  ·  ${readinessColor}`;

    // Two-column layout: info (left) and commands (right)
    const infoRows: string[] = [];
    const infoLabelWidth = 23;
    infoRows.push(`${padVisibleEnd(this.#copy.startupWorkspaceTrust, infoLabelWidth)}:  ${this.#startupTrustLabel(vm.workspaceTrust)}`);
    infoRows.push(`${padVisibleEnd(this.#copy.startupWorkspaceVerification, infoLabelWidth)}:  ${this.#startupVerificationLabel(vm.workspaceVerification)}`);
    if (vm.workspaceDirectory !== undefined) {
      infoRows.push(`${padVisibleEnd(this.#copy.startupWorkspaceDirectory, infoLabelWidth)}:  ${this.#technical(vm.workspaceDirectory)}`);
    }
    if (vm.securityMode !== undefined) {
      infoRows.push(`${padVisibleEnd(this.#copy.startupSecurityMode, infoLabelWidth)}:  ${this.#technical(vm.securityMode)}`);
    }
    if (vm.skillAutonomy !== undefined) {
      infoRows.push(`${padVisibleEnd(this.#copy.startupSkillAutonomy, infoLabelWidth)}:  ${this.#technical(vm.skillAutonomy)}`);
    }
    if (vm.versionStatus !== undefined) {
      infoRows.push(`${padVisibleEnd(this.#copy.startupVersionStatus, infoLabelWidth)}:  ${this.#startupVersionStatusLabel(vm.versionStatus)}`);
    }

    const cmdRows: string[] = [];
    cmdRows.push(this.#bold(this.#copy.startupInteractiveCommands));
    cmdRows.push("");
    const interactiveCommands = this.#startupCommands(vm);
    for (const cmd of interactiveCommands) {
      const name = this.#action(this.#technical(cmd.name));
      const desc = this.#dim(cmd.description);
      cmdRows.push(`${name}   ${desc}`);
    }

    // Combine side by side if width allows
    const maxInfoWidth = infoRows.length > 0 ? Math.max(...infoRows.map((r) => measureVisibleWidth(r))) : 0;
    const maxCmdWidth = cmdRows.length > 0 ? Math.max(...cmdRows.map((r) => measureVisibleWidth(r))) : 0;
    const gap = 6;
    const totalWidth = maxInfoWidth + gap + maxCmdWidth;
    const maxFrameWidth = Math.max(24, this.#capabilities.terminalWidth);
    const maxContentWidth = Math.max(8, maxFrameWidth - 4);
    const dashboardRows: string[] = [modelLine, ""];

    if (totalWidth <= maxContentWidth && maxInfoWidth > 0 && maxCmdWidth > 0) {
      const maxRows = Math.max(infoRows.length, cmdRows.length);
      for (let i = 0; i < maxRows; i++) {
        const left = infoRows[i] ?? "";
        const right = cmdRows[i] ?? "";
        const paddedLeft = padVisibleEnd(left, maxInfoWidth);
        dashboardRows.push(`${paddedLeft}${" ".repeat(gap)}${right}`);
      }
    } else {
      for (const row of infoRows) dashboardRows.push(row);
      if (infoRows.length > 0 && cmdRows.length > 0) dashboardRows.push("");
      for (const row of cmdRows) dashboardRows.push(row);
    }

    const blockWidth = Math.max(0, ...dashboardRows.map((row) => measureVisibleWidth(row)));
    const titleWidth = measureVisibleWidth(` ${cardTitle} `);
    const frameWidth = Math.min(
      maxFrameWidth,
      Math.max(40, titleWidth + 4, blockWidth + 4)
    );
    const contentWidth = Math.max(8, frameWidth - 4);

    const heroLines = [
      padVisibleAlign(this.#brand(this.#bold(vm.agentName)), frameWidth, "center"),
      "",
      ...vm.taglines
        .filter((tag) => tag.length > 0)
        .map((tag) => padVisibleAlign(this.#dim(tag), frameWidth, "center")),
    ];
    lines.push(...heroLines);
    lines.push("");

    const frameRows: string[] = [];
    const blockOffset = blockWidth < contentWidth ? Math.floor((contentWidth - blockWidth) / 2) : 0;
    for (const row of dashboardRows) {
      const alignedRow = blockWidth < contentWidth
        ? `${" ".repeat(blockOffset)}${padVisibleEnd(row, blockWidth)}`
        : row;
      frameRows.push(truncateVisible(alignedRow, contentWidth));
    }

    lines.push(this.#openSideFrame(cardTitle, frameRows, {
      minWidth: 40,
      width: frameWidth,
      renderTitle: (title) => this.#brand(this.#bold(title)),
    }));

    // Warnings
    for (const warning of vm.warnings) {
      lines.push("");
      lines.push(this.renderWarningError(warning));
    }

    return lines.join("\n");
  }

  #renderStartupDashboardRtl(vm: StartupDashboardViewModel): string {
    const lines: string[] = [];
    const cardTitle = this.#startupDashboardTitle(vm);

    const readiness = vm.providerReadiness;
    let modelDot: string;
    let modelLabel: string;
    let readinessColor: string;

    switch (readiness) {
      case "ready":
        modelDot = this.#severity("●", "ok");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#severity(this.#startupReadinessLabel(readiness), "ok");
        break;
      case "degraded":
        modelDot = this.#caution("◐");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#caution(this.#startupReadinessLabel(readiness));
        break;
      case "missing-config":
        modelDot = this.#dim("○");
        modelLabel = this.#copy.startupModelNotConfigured;
        readinessColor = this.#severity(this.#copy.startupMissingConfig, "error");
        break;
      case "unknown":
      default:
        modelDot = this.#dim("○");
        modelLabel = this.#technical(vm.model.id);
        readinessColor = this.#dim(this.#copy.startupUnknown);
        break;
    }

    const modelLine = `${this.#copy.startupModel}: ${modelDot} ${this.#bold(modelLabel)}  ·  ${readinessColor}`;

    const infoRows: string[] = [
      `${this.#copy.startupWorkspaceTrust}: ${this.#startupTrustLabel(vm.workspaceTrust)}`,
      `${this.#copy.startupWorkspaceVerification}: ${this.#startupVerificationLabel(vm.workspaceVerification)}`,
    ];
    if (vm.workspaceDirectory !== undefined) {
      infoRows.push(`${this.#copy.startupWorkspaceDirectory}: ${this.#technical(vm.workspaceDirectory)}`);
    }
    if (vm.securityMode !== undefined) {
      infoRows.push(`${this.#copy.startupSecurityMode}: ${this.#technical(vm.securityMode)}`);
    }
    if (vm.skillAutonomy !== undefined) {
      infoRows.push(`${this.#copy.startupSkillAutonomy}: ${this.#technical(vm.skillAutonomy)}`);
    }
    if (vm.versionStatus !== undefined) {
      infoRows.push(`${this.#copy.startupVersionStatus}: ${this.#startupVersionStatusLabel(vm.versionStatus)}`);
    }

    const cmdRows: string[] = [this.#bold(this.#copy.startupInteractiveCommands)];
    for (const cmd of this.#startupCommands(vm)) {
      cmdRows.push(`${this.#dim(cmd.description)}  ${this.#action(this.#technical(cmd.name))}`);
    }

    const maxFrameWidth = Math.max(24, this.#capabilities.terminalWidth);
    const maxContentWidth = Math.max(8, maxFrameWidth - 4);
    const maxInfoWidth = infoRows.length > 0 ? Math.max(...infoRows.map((row) => measureVisibleWidth(row))) : 0;
    const maxCmdWidth = cmdRows.length > 0 ? Math.max(...cmdRows.map((row) => measureVisibleWidth(row))) : 0;
    const gap = 6;
    const twoColumnWidth = maxCmdWidth + gap + maxInfoWidth;
    const dashboardRows: string[] = [modelLine, ""];

    if (twoColumnWidth <= maxContentWidth && maxInfoWidth > 0 && maxCmdWidth > 0) {
      const maxRows = Math.max(infoRows.length, cmdRows.length);
      for (let i = 0; i < maxRows; i++) {
        const left = padVisibleEnd(cmdRows[i] ?? "", maxCmdWidth);
        const right = padVisibleStart(infoRows[i] ?? "", maxInfoWidth);
        dashboardRows.push(`${left}${" ".repeat(gap)}${right}`);
      }
    } else {
      for (const row of infoRows) dashboardRows.push(row);
      if (infoRows.length > 0 && cmdRows.length > 0) dashboardRows.push("");
      for (const row of cmdRows) dashboardRows.push(row);
    }

    const rawBlockWidth = Math.max(0, ...dashboardRows.map((row) => measureVisibleWidth(row)));
    const titleWidth = measureVisibleWidth(` ${cardTitle} `);
    const frameWidth = Math.min(
      maxFrameWidth,
      Math.max(40, titleWidth + 4, rawBlockWidth + 4)
    );
    const contentWidth = Math.max(8, frameWidth - 4);
    const frameRows = dashboardRows.map((row) => {
      if (row.length === 0) return "";
      const bounded = this.#natural(row, contentWidth);
      return padVisibleStart(bounded, contentWidth);
    });

    const heroLines = [
      padVisibleAlign(this.#brand(this.#bold(vm.agentName)), frameWidth, "center"),
      "",
      ...vm.taglines
        .filter((tag) => tag.length > 0)
        .map((tag) => padVisibleAlign(this.#dim(tag), frameWidth, "center")),
    ];
    lines.push(...heroLines);
    lines.push("");
    lines.push(this.#openSideFrame(cardTitle, frameRows, {
      minWidth: 40,
      width: frameWidth,
      renderTitle: (title) => this.#brand(this.#bold(title)),
    }));

    for (const warning of vm.warnings) {
      lines.push("");
      lines.push(this.renderWarningError(warning));
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Command Result
  // ──────────────────────────────────────

  renderCommandResult(vm: CommandResultViewModel): string {
    const tag = vm.ok
      ? this.#severity("[OK]", "ok")
      : this.#severity("[FAIL]", "error");
    const lines: string[] = [`${tag} ${this.#bold(vm.title)}`];

    if (vm.blocks.length > 0) {
      lines.push("");
      for (const block of vm.blocks) {
        lines.push(this.render(block));
        lines.push("");
      }
      lines.pop(); // remove trailing blank line
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Assistant Response
  // ──────────────────────────────────────

  renderAssistantResponse(vm: AssistantResponseViewModel): string {
    const requestedWidth = Math.max(24, this.#capabilities.terminalWidth);
    const rawTitle = this.#assistantResponseTitle(vm.label, Math.max(1, requestedWidth - 4));
    const titleWidth = measureVisibleWidth(` ${rawTitle} `);
    const maxRawContent = Math.max(0, ...vm.text.split("\n").map((line) => measureVisibleWidth(line)));
    const width = Math.min(
      requestedWidth,
      Math.max(40, titleWidth + 4, maxRawContent + 4)
    );
    const contentWidth = Math.max(8, width - 4);
    const contentLines: string[] = [];

    for (const rawLine of vm.text.split("\n")) {
      for (const wrappedLine of wrapVisibleLine(rawLine, contentWidth)) {
        const bodyLine = wrappedLine.length === 0
          ? wrappedLine
          : this.#agentMessage(this.#isRtl() ? this.#natural(wrappedLine) : wrappedLine);
        contentLines.push(bodyLine);
      }
    }

    const frameTitle = this.#isRtl() ? this.#natural(rawTitle, Math.max(1, width - 4)) : rawTitle;
    const lines: string[] = [
      "",
      this.#openSideFrame(frameTitle, contentLines, {
        minWidth: 40,
        width,
        renderTitle: (title) => this.#brand(this.#bold(title)),
      }),
    ];

    if (vm.matchedSkills !== undefined && vm.matchedSkills.length > 0) {
      lines.push(this.#dim(`skills: ${vm.matchedSkills.join(", ")}`));
    }

    if (vm.progress !== undefined && vm.progress.length > 0) {
      lines.push(this.#dim(`progress: ${vm.progress.join(" -> ")}`));
    }

    return lines.join("\n");
  }

  // ──────────────────────────────────────
  // Conversation Message
  // ──────────────────────────────────────

  renderConversationMessage(vm: ConversationMessageViewModel): string {
    if (vm.role === "assistant") {
      const title = this.#useUnicode
        ? this.#copy.assistantCardTitleUnicode
        : this.#copy.assistantCardTitleAscii;
      const frameTitle = this.#isRtl() ? this.#natural(title) : title;
      const textLines = vm.text
        .split("\n")
        .map((line) => line.length === 0
          ? line
          : this.#agentMessage(this.#isRtl() ? this.#natural(line) : line));

      const frame = this.#openSideFrame(frameTitle, textLines, {
        minWidth: 40,
        width: this.#capabilities.terminalWidth,
        renderTitle: (framedTitle) => this.#brand(this.#bold(framedTitle)),
      });

      let result = frame;

      if (vm.matchedSkills !== undefined && vm.matchedSkills.length > 0) {
        result += "\n" + this.#dim(`skills: ${vm.matchedSkills.join(", ")}`);
      }

      if (vm.progress !== undefined && vm.progress.length > 0) {
        result += "\n" + this.#dim(`progress: ${vm.progress.join(" -> ")}`);
      }

      return result;
    }

    // User messages: plain text until user prompt rail is implemented
    return vm.text;
  }

  // ──────────────────────────────────────
  // Prompt Chrome Rails
  // ──────────────────────────────────────

  renderSessionStatusRail(vm: SessionStatusRailViewModel): string {
    if (this.#isRtl()) {
      return this.#renderSessionStatusRailRtl(vm);
    }
    return this.#renderSessionStatusRailLtr(vm);
  }

  #renderSessionStatusRailLtr(vm: SessionStatusRailViewModel): string {
    const eye = this.#useUnicode ? "𓂀" : "*";
    const modelPart = `${this.#brand(eye)}  ${this.#sessionStatusModelLabel(vm)}`;
    const parts: string[] = [];

    if (vm.contextUsage !== undefined) {
      const filled = formatContextCount(vm.contextUsage.filled);
      const total = formatContextCount(vm.contextUsage.total);
      parts.push(`${this.#copy.context} ${filled}/${total}`);
      parts.push(this.#contextBeads(vm.contextUsage.filled, vm.contextUsage.total));
    }

    if (vm.sessionElapsedMs !== undefined) {
      const glyph = this.#useUnicode ? "◷" : "session";
      parts.push(`${glyph} ${formatRailDuration(vm.sessionElapsedMs)}`);
    }

    if (vm.currentTurnSeconds !== undefined) {
      const glyph = this.#useUnicode ? "⧖" : "turn";
      parts.push(`${glyph} ${formatRailDuration(vm.currentTurnSeconds * 1000)}`);
    }

    if (vm.showTurnState !== false) {
      parts.push(this.#turnStateLabel(vm.turnState));
    }
    const rail = parts.length > 0
      ? `${modelPart}${this.#secondary(` | ${parts.join(" | ")}`)}`
      : modelPart;
    return this.#truncateVisibleStable(rail, this.#capabilities.terminalWidth);
  }

  #renderSessionStatusRailRtl(vm: SessionStatusRailViewModel): string {
    const eye = this.#useUnicode ? "𓂀" : "*";
    const parts: string[] = [];

    if (vm.showTurnState !== false) {
      parts.push(this.#turnStateLabel(vm.turnState));
    }

    if (vm.sessionElapsedMs !== undefined) {
      const glyph = this.#useUnicode ? "◷" : "session";
      parts.push(`${glyph} ${formatRailDuration(vm.sessionElapsedMs)}`);
    }

    if (vm.currentTurnSeconds !== undefined) {
      const glyph = this.#useUnicode ? "⧖" : "turn";
      parts.push(`${glyph} ${formatRailDuration(vm.currentTurnSeconds * 1000)}`);
    }

    if (vm.contextUsage !== undefined) {
      const filled = formatContextCount(vm.contextUsage.filled);
      const total = formatContextCount(vm.contextUsage.total);
      parts.push(this.#contextBeads(vm.contextUsage.filled, vm.contextUsage.total));
      parts.push(`${isolateLtr(`${filled}/${total}`)} ${this.#copy.context}`);
    }

    const modelPart = `${this.#sessionStatusModelLabel({ ...vm, modelLabel: isolateLtr(vm.modelLabel) })}  ${this.#brand(eye)}`;
    const rail = parts.length > 0
      ? `${this.#secondary(parts.join(" | "))}${this.#secondary(" | ")}${modelPart}`
      : modelPart;
    return this.#truncateVisibleStable(rail, this.#capabilities.terminalWidth);
  }

  renderShortcutHintRail(vm: ShortcutHintRailViewModel): string {
    const prompt = this.#action(this.#glyph("prompt"));
    const text = vm.hints.length === 0
      ? this.#copy.shortcuts
      : vm.hints.map((hint) => hint.key.length === 0 ? hint.description : `${this.#technical(hint.key)} ${hint.description}`).join(" · ");
    if (!this.#isRtl()) {
      return truncateVisible(`${prompt} ${text}`, this.#capabilities.terminalWidth);
    }

    const prefix = `${prompt} `;
    const prefixWidth = measureVisibleWidth(prefix);
    if (prefixWidth >= this.#capabilities.terminalWidth) {
      return this.#truncateVisibleStable(prefix, this.#capabilities.terminalWidth);
    }
    const textWidth = this.#capabilities.terminalWidth - prefixWidth;
    return `${prefix}${this.#natural(closeOpenBidiIsolates(truncateVisible(text, textWidth)))}`;
  }

  renderUserPromptRail(vm: UserPromptRailViewModel): string {
    const width = this.#capabilities.terminalWidth ?? 60;
    const marker = this.#useUnicode ? "↳" : ">";
    return vm.text
      .split(/\r\n|\r|\n/u)
      .map((line, index) => truncateVisible(`${index === 0 ? marker : " "} ${line}`, width))
      .join("\n");
  }

  renderActiveTurnSpinner(vm: ActiveTurnSpinnerViewModel): string {
    const eyeFrames = this.#useUnicode
      ? this.#tokens.contract.glyph.spinner.thinking
      : ["*", "*.", "*..", "*...", "*..", "*."];
    const eye = this.#spinnerFrame(eyeFrames);
    const label = vm.label ?? (vm.phase !== undefined ? ((this.#copy as unknown) as Record<string, string>)[vm.phase] : undefined);
    if (label !== undefined) {
      return `${this.#brand(eye)} ${this.#action(label)}`;
    }
    return this.#brand(eye);
  }

  #turnStateLabel(state: SessionStatusRailViewModel["turnState"]): string {
    switch (state) {
      case "idle":
        return this.#copy.idle;
      case "running":
        return this.#copy.running;
      case "blocked":
        return this.#copy.blocked;
      case "error":
        return this.#copy.error;
      case "unknown":
        return "unknown";
    }
  }

  #contextBeads(filled: number, total: number): string {
    if (total <= 0) return "0%";
    const percent = Math.max(0, Math.min(100, Math.round((filled / total) * 100)));
    const active = Math.round(percent / 10);
    if (!this.#useUnicode) {
      return `${percent}%`;
    }
    const blocks = Array.from({ length: 10 }, (_, index) => index < active ? "▰" : "▱").join(" ");
    return `${blocks} ${percent}%`;
  }

  #sessionStatusModelLabel(vm: SessionStatusRailViewModel): string {
    const label = this.#bold(vm.modelLabel);
    switch (vm.modelState) {
      case "fallback-serving":
        return this.#severity(label, "warn");
      case "failed":
        return this.#severity(label, "error");
      case "configured":
      case "primary-serving":
      case undefined:
        return this.#brand(label);
    }
  }
}

// ──────────────────────────────────────
// Static helpers
// ──────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function hexToAnsi256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ri = Math.min(5, Math.round((r / 255) * 5));
  const gi = Math.min(5, Math.round((g / 255) * 5));
  const bi = Math.min(5, Math.round((b / 255) * 5));
  return 16 + 36 * ri + 6 * gi + bi;
}

function formatContextCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
  }
  return String(value);
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

function wrapVisibleLine(line: string, maxWidth: number): string[] {
  if (line.length === 0 || measureVisibleWidth(line) <= maxWidth) {
    return [line];
  }

  const indent = line.match(/^\s*/u)?.[0] ?? "";
  const wrapped: string[] = [];
  let remaining = line;
  while (measureVisibleWidth(remaining) > maxWidth) {
    const index = visibleBreakIndex(remaining, maxWidth);
    wrapped.push(remaining.slice(0, index).trimEnd());
    remaining = `${indent}${remaining.slice(index).trimStart()}`;
    if (remaining.trim().length === 0) {
      break;
    }
  }
  if (remaining.length > 0) {
    wrapped.push(remaining);
  }
  return wrapped.length > 0 ? wrapped : [""];
}

function visibleBreakIndex(value: string, maxWidth: number): number {
  let width = 0;
  let index = 0;
  let lastWhitespaceIndex = -1;

  for (const char of value) {
    const nextWidth = width + measureTextWidth(char);
    if (nextWidth > maxWidth) {
      return lastWhitespaceIndex > 0 ? lastWhitespaceIndex : Math.max(1, index);
    }
    width = nextWidth;
    index += char.length;
    if (/\s/u.test(char)) {
      lastWhitespaceIndex = index;
    }
  }

  return value.length;
}

type RtlNumberedBodyLine = {
  readonly marker: string;
  readonly text: string;
};

function splitNumberedRtlLine(line: string): RtlNumberedBodyLine | undefined {
  const match = /^(\d+\.)\s+(.+)$/u.exec(line);
  if (match === null) return undefined;
  return { marker: match[1] ?? "", text: match[2] ?? "" };
}

function computeRtlOnboardingBodyBlockWidth(bodyLines: readonly string[], contentWidth: number): number {
  const widestLine = Math.max(0, ...bodyLines.map((line) => {
    const numbered = splitNumberedRtlLine(line);
    return measureVisibleWidth(numbered?.text ?? line);
  }));
  const preferredWidth = Math.min(88, Math.max(56, widestLine));
  return Math.max(8, Math.min(contentWidth, preferredWidth));
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

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

function formatRailDuration(ms: number): string {
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
