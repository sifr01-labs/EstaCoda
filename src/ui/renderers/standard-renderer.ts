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
      case "startupDashboard":
      case "startupRuntime":
      case "fileChangePreview":
      case "slashMenu":
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

  #caution(text: string): string {
    return this.#color(text, this.#tokens.contract.palette.caution);
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
      this.#rail(`security: ${this.#severity(vm.securityMode, vm.securityMode === "open" ? "warn" : "ok")}`),
      this.#rail(`skills: ${vm.skillCount}${vm.skillAutonomy !== undefined ? ` (${vm.skillAutonomy})` : ""}`),
      this.#rail(`tools: ${vm.toolCount}`),
      this.#rail(`mcp: ${vm.mcp.active}/${vm.mcp.total}`),
      this.#rail(`taskflow: ${vm.taskflowActive ? this.#severity("active", "ok") : this.#dim("inactive")}`),
    ];

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
        ? ["\uD80C\uDDE0", "\uD80C\uDDE0\u00B7", "\uD80C\uDDE0\u00B7\u00B7", "\uD80C\uDDE0\u00B7\u00B7\u00B7", "\uD80C\uDDE0\u00B7\u00B7", "\uD80C\uDDE0\u00B7"]
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

  // ──────────────────────────────────────
  // Startup
  // ──────────────────────────────────────

  renderStartup(vm: StartupViewModel): string {
    const lines: string[] = [this.#heroPanel(vm.agentName, vm.taglines)];

    lines.push("");
    lines.push(this.#rail(`model: ${this.#dim(`${vm.model.provider}/${vm.model.id}`)}`));

    const readinessColor = vm.readiness === "ready"
      ? this.#severity("ready", "ok")
      : vm.readiness === "degraded"
        ? this.#caution("degraded")
        : this.#severity("missing-config", "error");
    lines.push(this.#rail(`readiness: ${readinessColor}`));

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

    // Hero
    lines.push(this.#heroPanel(vm.agentName, vm.taglines));
    lines.push("");

    // Version / session separator line
    const versionText = vm.version ?? "unknown";
    const sessionText = vm.sessionId ?? "";
    const horiz = this.#useUnicode ? "─" : "-";
    const eye = this.#useUnicode ? "𓂀" : "*";
    const sepLabel = sessionText
      ? `${versionText}  ${eye}  ${sessionText}`
      : versionText;
    const sepWidth = Math.min(
      this.#capabilities.terminalWidth,
      Math.max(measureTextWidth(sepLabel) + 4, 40)
    );
    const sideLen = Math.max(0, Math.floor((sepWidth - measureTextWidth(sepLabel)) / 2) - 1);
    const sepLine = `${horiz.repeat(sideLen)} ${sepLabel} ${horiz.repeat(sideLen)}`;
    lines.push(this.#dim(sepLine));
    lines.push("");

    // Model route readiness line
    const readiness = vm.providerReadiness;
    let modelDot: string;
    let modelLabel: string;
    let readinessColor: string;

    switch (readiness) {
      case "ready":
        modelDot = this.#severity("●", "ok");
        modelLabel = vm.model.id;
        readinessColor = this.#severity("ready", "ok");
        break;
      case "degraded":
        modelDot = this.#caution("◐");
        modelLabel = vm.model.id;
        readinessColor = this.#caution("degraded");
        break;
      case "missing-config":
        modelDot = this.#dim("○");
        modelLabel = "model not configured";
        readinessColor = this.#severity("missing config", "error");
        break;
      case "unknown":
      default:
        modelDot = this.#dim("○");
        modelLabel = vm.model.id;
        readinessColor = this.#dim("unknown");
        break;
    }

    const modelLine = `${modelDot} ${this.#bold(modelLabel)}  ·  ${readinessColor}`;
    lines.push(this.#rail(modelLine));
    lines.push("");

    // Two-column layout: info (left) and commands (right)
    const infoRows: string[] = [];
    infoRows.push(`Workspace Trust        :  ${vm.workspaceTrust}`);
    infoRows.push(`Workspace Verification :  ${vm.workspaceVerification}`);
    if (vm.workspaceDirectory !== undefined) {
      infoRows.push(`Workspace Directory    :  ${vm.workspaceDirectory}`);
    }
    if (vm.securityMode !== undefined) {
      infoRows.push(`User Security Mode     :  ${vm.securityMode}`);
    }
    if (vm.skillAutonomy !== undefined) {
      infoRows.push(`User Skill Autonomy    :  ${vm.skillAutonomy}`);
    }
    if (vm.versionStatus !== undefined) {
      infoRows.push(`Version Status         :  ${vm.versionStatus}`);
    }

    const cmdRows: string[] = [];
    cmdRows.push(this.#bold("Interactive Commands:"));
    cmdRows.push("");
    const interactiveCommands = [
      { name: "/tools", description: "Browse runtime tools" },
      { name: "/skills", description: "Browse skills" },
      { name: "/model", description: "Show or switch model" },
      { name: "/status", description: "Show session status" },
    ];
    for (const cmd of interactiveCommands) {
      const name = this.#action(cmd.name);
      const desc = this.#dim(cmd.description);
      cmdRows.push(`${name}   ${desc}`);
    }

    // Combine side by side if width allows
    const maxInfoWidth = infoRows.length > 0 ? Math.max(...infoRows.map((r) => measureTextWidth(r))) : 0;
    const maxCmdWidth = cmdRows.length > 0 ? Math.max(...cmdRows.map((r) => measureTextWidth(r))) : 0;
    const gap = 6;
    const totalWidth = maxInfoWidth + gap + maxCmdWidth;

    if (totalWidth <= this.#capabilities.terminalWidth && maxInfoWidth > 0 && maxCmdWidth > 0) {
      const maxRows = Math.max(infoRows.length, cmdRows.length);
      for (let i = 0; i < maxRows; i++) {
        const left = infoRows[i] ?? "";
        const right = cmdRows[i] ?? "";
        const paddedLeft = padVisibleEnd(left, maxInfoWidth);
        lines.push(`${paddedLeft}${" ".repeat(gap)}${right}`);
      }
    } else {
      for (const row of infoRows) lines.push(row);
      if (infoRows.length > 0 && cmdRows.length > 0) lines.push("");
      for (const row of cmdRows) lines.push(row);
    }

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
    const bottomLeft = this.#useUnicode ? "╰" : "+";
    const vert = this.#useUnicode ? "│" : "|";
    const width = Math.min(
      this.#capabilities.terminalWidth,
      Math.max(vm.label.length + 4, ...vm.text.split("\n").map((l) => measureTextWidth(l))) + 4
    );

    const top = `${topLeft}${horiz.repeat(width - 2)}`;
    const bottom = `${bottomLeft}${horiz.repeat(width - 2)}`;

    const lines: string[] = ["", top];
    lines.push(`${vert} ${this.#brand(this.#bold(vm.label))}`);

    for (const rawLine of vm.text.split("\n")) {
      lines.push(`${vert} ${rawLine}`);
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
    const eye = this.#useUnicode ? "\uD80C\uDDE0" : "*";
    const modelLabel = this.#locale === "ar" ? isolateLtr(vm.modelLabel) : vm.modelLabel;
    const parts: string[] = [`${this.#brand(eye)} ${modelLabel}`];

    if (vm.contextUsage !== undefined) {
      const filled = formatContextCount(vm.contextUsage.filled);
      const total = formatContextCount(vm.contextUsage.total);
      const contextValue = this.#locale === "ar" ? isolateLtr(`${filled}/${total}`) : `${filled}/${total}`;
      parts.push(`${this.#copy.context} ${contextValue}`);
      parts.push(this.#contextBeads(vm.contextUsage.filled, vm.contextUsage.total));
    }

    if (vm.sessionElapsedMs !== undefined) {
      const glyph = this.#useUnicode ? "◷" : "session";
      parts.push(`${glyph} ${formatDuration(vm.sessionElapsedMs)}`);
    }

    if (vm.currentTurnSeconds !== undefined) {
      const glyph = this.#useUnicode ? "⧖" : "turn";
      parts.push(`${glyph} ${vm.currentTurnSeconds}s`);
    }

    parts.push(this.#turnStateLabel(vm.turnState));
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
      ? ["\uD80C\uDDE0", "\uD80C\uDDE0\u00B7", "\uD80C\uDDE0\u00B7\u00B7", "\uD80C\uDDE0\u00B7\u00B7\u00B7", "\uD80C\uDDE0\u00B7\u00B7", "\uD80C\uDDE0\u00B7"]
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

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

function formatCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(value);
}
