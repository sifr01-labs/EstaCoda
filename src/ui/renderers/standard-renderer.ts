// v0.95 Standard Renderer
// ANSI/Unicode output for all ViewModel types.
// Falls back to plain ASCII when capabilities restrict color or Unicode.

import type { TerminalCapabilities } from "../../contracts/ui.js";
import type {
  ActivityTimelineViewModel,
  ApprovalSecurityViewModel,
  CommandResultViewModel,
  KeyValueBlockViewModel,
  ListViewModel,
  PlainFallbackViewModel,
  PickerViewModel,
  ProgressContextRailViewModel,
  StartupViewModel,
  StatusViewModel,
  TableViewModel,
  TimelineEvent,
  ViewModel,
  ViewModelSeverity,
  WarningErrorViewModel,
} from "../../contracts/view-model.js";
import type { ResolvedTokens, TokenGlyph } from "../../contracts/ui-tokens.js";
import { measureTextWidth } from "./layout.js";

export interface StandardRendererOptions {
  readonly tokens: ResolvedTokens;
  readonly capabilities: TerminalCapabilities;
}

export class StandardRenderer {
  readonly #tokens: ResolvedTokens;
  readonly #capabilities: TerminalCapabilities;
  readonly #useColor: boolean;
  readonly #useUnicode: boolean;

  constructor(options: StandardRendererOptions) {
    this.#tokens = options.tokens;
    this.#capabilities = options.capabilities;
    this.#useColor =
      this.#capabilities.supportsColor &&
      this.#tokens.contract.behavior.allowAnsiColor;
    this.#useUnicode = this.#capabilities.supportsUnicode;
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
      case "commandResult":
        return this.renderCommandResult(vm);
      case "plainFallback":
        return this.renderPlainFallback(vm);
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
    const width = Math.min(
      this.#capabilities.terminalWidth,
      Math.max(title.length + 4, ...contentLines.map((l) => measureTextWidth(l))) + 4
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
    lines.push(`${vert} ${this.#bold(title).padEnd(width - 4)} ${vert}`);
    lines.push(`${vert}${horiz.repeat(width - 2)}${vert}`);
    for (const line of contentLines) {
      lines.push(`${vert} ${line.padEnd(width - 4)} ${vert}`);
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
      this.#brand(padAlign(col.header, widths[i], col.alignment ?? "left"))
    );
    lines.push(headerCells.join("  "));

    // Separator
    const horiz = this.#useUnicode ? "─" : "-";
    const sepCells = vm.columns.map((col, i) =>
      horiz.repeat(Math.max(col.header.length, widths[i]))
    );
    lines.push(this.#dim(sepCells.join("  ")));

    // Data rows
    for (const row of vm.rows) {
      const cells = vm.columns.map((col, i) => {
        const raw = row[col.key];
        const text = raw === undefined ? "" : String(raw);
        return padAlign(text, widths[i], col.alignment ?? "left");
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
    const contentLines: string[] = [
      `Target: ${vm.targetSummary}`,
    ];

    if (vm.riskClass !== undefined) {
      contentLines.push(`Risk: ${this.#caution(vm.riskClass)}`);
    }

    if (vm.details !== undefined && vm.details.length > 0) {
      for (const detail of vm.details) {
        contentLines.push(this.#dim(detail));
      }
    }

    contentLines.push("");
    contentLines.push(this.#bold("Actions:"));
    for (const action of vm.actions) {
      const tag = action.severity !== undefined
        ? `${this.#inlineSignal(action.severity)} `
        : "";
      contentLines.push(`  ${action.id}) ${tag}${action.label}`);
    }

    const title = `${this.#severity(vm.severity.toUpperCase(), vm.severity)} Approval required: ${vm.toolName}`;
    return this.#framedPanel(title, contentLines);
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
    if (vm.steps.length === 0) {
      const empty = vm.title !== undefined
        ? `${this.#bold(vm.title)}\n${this.#dim("No steps.")}`
        : this.#dim("No steps.");
      return empty;
    }

    const lines: string[] = [];
    if (vm.title !== undefined) {
      lines.push(this.#bold(vm.title));
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
      lines.push(`${marker} ${label}`);
    }

    return lines.join("\n");
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

function computeColumnWidths(
  columns: readonly { readonly key: string; readonly header: string }[],
  rows: readonly Record<string, unknown>[]
): number[] {
  return columns.map((col) => {
    let width = col.header.length;
    for (const row of rows) {
      const raw = row[col.key];
      const text = raw === undefined ? "" : String(raw);
      width = Math.max(width, text.length);
    }
    return width;
  });
}

function padAlign(text: string, width: number, alignment: string): string {
  if (alignment === "right") {
    return text.padStart(width);
  }
  if (alignment === "center") {
    const totalPad = Math.max(0, width - text.length);
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return " ".repeat(left) + text + " ".repeat(right);
  }
  return text.padEnd(width);
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
