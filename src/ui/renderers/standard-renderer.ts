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
  OnboardingPromptCardViewModel,
  PlainFallbackViewModel,
  PickerViewModel,
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
import { measureTextWidth, measureVisibleWidth, padVisibleEnd, padVisibleAlign, openHorizontalFrame, truncateVisible } from "./layout.js";
import type { UiLocale } from "../../ui/cli-ui-copy.js";
import { chromeCopy } from "../../ui/cli-ui-copy.js";
import { isolateLtr } from "../../ui/bidi.js";

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

  #onboardingTitle(title: string, maxWidth: number): string {
    const symbol = this.#useUnicode ? "𓂀" : "*";
    return truncateVisible(`${symbol}  ${title}`, maxWidth);
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
      this.#rail(`taskflow: ${vm.taskflowActive ? this.#severity("active", "ok") : this.#dim("inactive")}`),
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
        return padVisibleAlign(text, widths[i], col.alignment ?? "left");
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
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const selectedMarker = this.#useUnicode ? "▸" : ">";

    const rawContentLines: string[] = [
      ...vm.bodyLines,
      ...(vm.technicalLines ?? []),
      ...vm.options.flatMap((option) => [option.label, option.description ?? ""]),
      vm.hint ?? "",
    ].filter((line) => line.length > 0);
    const maxRawContent = Math.max(0, ...rawContentLines.map((line) => measureVisibleWidth(line)));
    const requestedWidth = Math.max(24, this.#capabilities.terminalWidth);
    const naturalWidth = Math.max(40, maxRawContent + 4, measureVisibleWidth(vm.title) + 12);
    const width = Math.min(requestedWidth, naturalWidth);
    const contentWidth = Math.max(8, width - 4);
    const innerWidth = Math.max(8, width - 2);
    const leftTitleRule = `${horiz.repeat(Math.min(4, Math.max(1, innerWidth - 4)))} `;
    const titleRaw = this.#onboardingTitle(vm.title, Math.max(1, innerWidth - measureVisibleWidth(leftTitleRule) - 2));
    const rightRuleWidth = Math.max(
      0,
      innerWidth - measureVisibleWidth(leftTitleRule) - measureVisibleWidth(titleRaw) - 1
    );
    const top = [
      this.#surfaceBorder(`${topLeft}${leftTitleRule}`),
      this.#brand(this.#bold(titleRaw)),
      this.#surfaceBorder(` ${horiz.repeat(rightRuleWidth)}${topRight}`),
    ].join("");
    const bottom = this.#surfaceBorder(`${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`);

    const lines: string[] = [top];

    for (let i = 0; i < vm.bodyLines.length; i++) {
      const text = truncateVisible(vm.bodyLines[i], contentWidth);
      lines.push(`  ${i === 0 ? this.#primary(text) : this.#secondary(text)}`);
    }

    for (const technicalLine of vm.technicalLines ?? []) {
      lines.push(`  ${this.#primary(this.#localizedTechnical(technicalLine, locale, contentWidth))}`);
    }

    const hasPreOptionContent = vm.bodyLines.length > 0 || (vm.technicalLines?.length ?? 0) > 0;
    if (hasPreOptionContent && vm.options.length > 0) {
      lines.push("  ");
    }

    for (let i = 0; i < vm.options.length; i++) {
      const option = vm.options[i];
      const isSelected = i === vm.selectedOptionIndex;
      const marker = isSelected ? this.#action(selectedMarker) : " ";
      const optionText = option.technical === true
        ? this.#localizedTechnical(option.label, locale, Math.max(1, contentWidth - 2))
        : truncateVisible(option.label, Math.max(1, contentWidth - 2));
      lines.push(`  ${marker} ${this.#primary(optionText)}`);
      if (option.description !== undefined) {
        lines.push(`    ${this.#muted(truncateVisible(option.description, Math.max(1, contentWidth - 4)))}`);
      }
    }

    if (vm.hint !== undefined && vm.hint.length > 0) {
      lines.push(`  ${this.#muted(truncateVisible(vm.hint, contentWidth))}`);
    }

    lines.push(bottom);
    return lines.join("\n");
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
    const visibleOptions = vm.options.slice(0, 6);
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

  #technical(value: string): string {
    return this.#locale === "ar" ? isolateLtr(value) : value;
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
    const lines: string[] = [];

    // Version / session separator line
    const versionText = vm.version.length > 0 ? this.#technical(vm.version) : this.#copy.startupUnknown;
    const sessionText = vm.sessionId !== undefined ? this.#technical(vm.sessionId) : "";
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const vert = this.#useUnicode ? "│" : "|";
    const eye = this.#useUnicode ? "𓂀" : "*";
    const cardTitle = sessionText
      ? `${versionText}  ${eye}  ${sessionText}`
      : versionText;

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
    const titleWidth = measureTextWidth(cardTitle);
    const frameWidth = Math.min(
      maxFrameWidth,
      Math.max(40, titleWidth + 4, blockWidth + 4)
    );
    const contentWidth = Math.max(8, frameWidth - 4);
    const boundedTitleText = truncateVisible(cardTitle, Math.max(1, frameWidth - 2));
    const boundedTitle = this.#brand(this.#bold(boundedTitleText));
    const boundedTitleWidth = measureVisibleWidth(boundedTitle);
    const titleAvail = Math.max(0, frameWidth - 2 - boundedTitleWidth);
    const titleLeft = Math.floor(titleAvail / 2);
    const titleRight = titleAvail - titleLeft;

    const heroLines = [
      padVisibleAlign(this.#brand(this.#bold(vm.agentName)), frameWidth, "center"),
      "",
      ...vm.taglines
        .filter((tag) => tag.length > 0)
        .map((tag) => padVisibleAlign(this.#dim(tag), frameWidth, "center")),
    ];
    lines.push(...heroLines);
    lines.push("");

    lines.push([
      this.#surfaceBorder(`${topLeft}${horiz.repeat(titleLeft)}`),
      boundedTitle,
      this.#surfaceBorder(`${horiz.repeat(titleRight)}${topRight}`),
    ].join(""));

    const blockOffset = blockWidth < contentWidth ? Math.floor((contentWidth - blockWidth) / 2) : 0;
    for (const row of dashboardRows) {
      const alignedRow = blockWidth < contentWidth
        ? `${" ".repeat(blockOffset)}${padVisibleEnd(row, blockWidth)}`
        : row;
      const content = padVisibleEnd(truncateVisible(alignedRow, contentWidth), contentWidth);
      lines.push([
        this.#surfaceBorder(vert),
        " ",
        content,
        " ",
        this.#surfaceBorder(vert),
      ].join(""));
    }

    lines.push(this.#surfaceBorder(`${bottomLeft}${horiz.repeat(frameWidth - 2)}${bottomRight}`));

    // Warnings
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
    const horiz = this.#useUnicode ? "─" : "-";
    const topLeft = this.#useUnicode ? "╭" : "+";
    const topRight = this.#useUnicode ? "╮" : "+";
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const bottomRight = this.#useUnicode ? "╯" : "+";
    const vert = this.#useUnicode ? "│" : "|";
    const requestedWidth = Math.max(24, this.#capabilities.terminalWidth);
    const rawTitle = this.#assistantResponseTitle(vm.label, Math.max(1, requestedWidth - 4));
    const titleWidth = measureVisibleWidth(rawTitle);
    const maxRawContent = Math.max(0, ...vm.text.split("\n").map((line) => measureVisibleWidth(line)));
    const width = Math.min(
      requestedWidth,
      Math.max(40, titleWidth + 4, maxRawContent + 4)
    );
    const contentWidth = Math.max(8, width - 4);
    const boundedTitle = truncateVisible(rawTitle, Math.max(1, width - 2));
    const boundedTitleWidth = measureVisibleWidth(boundedTitle);
    const titleAvail = Math.max(0, width - 2 - boundedTitleWidth);
    const titleLeft = Math.floor(titleAvail / 2);
    const titleRight = titleAvail - titleLeft;

    const top = [
      this.#surfaceBorder(`${topLeft}${horiz.repeat(titleLeft)}`),
      this.#brand(this.#bold(boundedTitle)),
      this.#surfaceBorder(`${horiz.repeat(titleRight)}${topRight}`),
    ].join("");
    const bottom = this.#surfaceBorder(`${bottomLeft}${horiz.repeat(width - 2)}${bottomRight}`);

    const lines: string[] = ["", top];

    for (const rawLine of vm.text.split("\n")) {
      for (const wrappedLine of wrapVisibleLine(rawLine, contentWidth)) {
        lines.push([
          this.#surfaceBorder(vert),
          " ",
          padVisibleEnd(wrappedLine, contentWidth),
          " ",
          this.#surfaceBorder(vert),
        ].join(""));
      }
    }

    lines.push(bottom);

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
      const brandTitle = this.#brand(this.#bold(title));
      const textLines = vm.text.split("\n");

      const frame = openHorizontalFrame(textLines, {
        useUnicode: this.#useUnicode,
        title: brandTitle,
        width: this.#capabilities.terminalWidth,
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
    const eye = this.#useUnicode ? "𓂀" : "*";
    const modelLabel = this.#locale === "ar" ? isolateLtr(vm.modelLabel) : vm.modelLabel;
    const parts: string[] = [`${this.#brand(eye)}  ${this.#brand(this.#bold(modelLabel))}`];

    if (vm.contextUsage !== undefined) {
      const filled = formatContextCount(vm.contextUsage.filled);
      const total = formatContextCount(vm.contextUsage.total);
      const contextValue = this.#locale === "ar" ? isolateLtr(`${filled}/${total}`) : `${filled}/${total}`;
      parts.push(`${this.#copy.context} ${contextValue}`);
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
    return truncateVisible(parts.join(" | "), this.#capabilities.terminalWidth);
  }

  renderShortcutHintRail(vm: ShortcutHintRailViewModel): string {
    const prompt = this.#action(this.#glyph("prompt"));
    const text = vm.hints.length === 0
      ? this.#copy.shortcuts
      : vm.hints.map((hint) => hint.key.length === 0 ? hint.description : `${hint.key} ${hint.description}`).join(" · ");
    return truncateVisible(`${prompt} ${text}`, this.#capabilities.terminalWidth);
  }

  renderUserPromptRail(vm: UserPromptRailViewModel): string {
    const bullet = this.#useUnicode ? "\u25b8" : ">";
    const width = this.#capabilities.terminalWidth ?? 60;
    const fill = this.#useUnicode ? "─" : "-";
    const line = `+${fill.repeat(Math.max(0, width - 2))}+`;
    const promptText = truncateVisible(`${bullet} ${vm.text}`, width);
    return `${promptText}\n${line}`;
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
    return `${"◉".repeat(active)}${"·".repeat(10 - active)} ${percent}%`;
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
