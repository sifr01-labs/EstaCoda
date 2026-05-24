import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ToolDefinition } from "../contracts/tool.js";

export type ToolActivityRendererOptions = {
  tools: readonly ToolDefinition[];
  now?: () => number;
};

export class ToolActivityRenderer {
  readonly #tools: Map<string, ToolDefinition>;
  readonly #starts = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(options: ToolActivityRendererOptions) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#now = options.now ?? (() => Date.now());
  }

  render(event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>): string {
    if (event.kind === "tool-start") {
      this.#pushStart(this.#eventKey(event));
      const target = event.targetSummary ?? event.tool;
      return `[>] ${toolIcon(event.tool)} ${toolAction(event.tool, this.#tools.get(event.tool))} · preparing ${target}${event.stepId === undefined ? "" : ` · ${event.stepId}`}`;
    }

    const elapsed = this.#popElapsed(this.#eventKey(event));
    const target = event.targetSummary === undefined ? "" : ` · ${event.targetSummary}`;
    if (event.decision !== undefined && event.decision !== "allow") {
      return `⚠ ${toolIcon(event.tool)} ${event.tool}${target} gated · ${humanRisk(event.riskClass)}${elapsed}`;
    }

    const status = event.ok === false ? "failed" : "done";
    const icon = event.ok === false ? "🩸" : toolIcon(event.tool);

    return `${icon} ${event.tool}${target} ${status}${elapsed}${renderToolSize(event)}`;
  }

  #pushStart(tool: string): void {
    const starts = this.#starts.get(tool) ?? [];
    starts.push(this.#now());
    this.#starts.set(tool, starts);
  }

  #popElapsed(tool: string): string {
    const starts = this.#starts.get(tool);
    const startedAt = starts?.shift();

    if (starts !== undefined && starts.length === 0) {
      this.#starts.delete(tool);
    }

    if (startedAt === undefined) {
      return "";
    }

    return ` · ${formatDuration(this.#now() - startedAt)}`;
  }

  #eventKey(event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>): string {
    return event.activityId ?? `${event.tool}\0${event.targetSummary ?? ""}`;
  }
}

export function renderToolSize(event: Extract<RuntimeEvent, { kind: "tool-result" }>): string {
  if (event.chars === undefined || event.sentChars === undefined) {
    return "";
  }

  return ` · ${formatCount(event.chars)} captured / ${formatCount(event.sentChars)} sent${event.truncated ? " / compressed" : ""}`;
}

export function toolIcon(tool: string): string {
  if (tool.includes("artifact")) return "💎";
  if (tool.includes("media")) return "🧿";
  if (tool.includes("web.extract")) return "🧿";
  if (tool.includes("browser")) return "🧿";
  if (tool.includes("workspace") || tool.includes("file")) return "💎";
  if (tool.includes("terminal") || tool.includes("process")) return "🔥";
  if (tool.includes("execute") || tool.includes("python")) return "🗡️";
  if (tool.includes("memory")) return "💠";
  if (tool.includes("trajectory")) return "🩸";
  if (tool.includes("delegate")) return "⚔️";
  if (tool.includes("workflow") || tool.includes("skill")) return "☥";
  if (tool.includes("config") || tool.includes("onboarding")) return "🔧";
  return "𓂀";
}

function toolAction(tool: string, definition: ToolDefinition | undefined): string {
  if (definition?.progressLabel !== undefined) {
    return definition.progressLabel;
  }

  if (tool.includes("artifact")) return "recording artifact";
  if (tool.includes("media.extract-frame")) return "extracting preview frame";
  if (tool.includes("media.inspect")) return "inspecting media";
  if (tool.includes("media.probe")) return "checking media tools";
  if (tool.includes("web.extract")) return "extracting web content";
  if (tool.includes("browser.navigate")) return "navigating browser";
  if (tool.includes("workspace")) return "reading workspace";
  if (tool.includes("memory")) return "writing memory";
  if (tool.includes("trajectory")) return "recording trajectory";
  if (tool.includes("workflow")) return "planning workflow";
  if (tool.includes("terminal") || tool.includes("process")) return "running process";
  if (tool.includes("execute") || tool.includes("python")) return "executing code";
  if (tool.includes("config")) return "updating config";
  return "running tool";
}

function humanRisk(riskClass: string | undefined): string {
  switch (riskClass) {
    case "destructive-local":
      return "destructive local action";
    case "credential-access":
      return "credential or secret access";
    case "external-side-effect":
      return "external side effect";
    case "spend-money":
      return "may spend money";
    case "sandbox-escape":
      return "sandbox boundary";
    case "workspace-write":
      return "workspace write";
    default:
      return riskClass ?? "policy gate";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.max(0, ms)}ms`;
  }

  return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function formatCount(value: number): string {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }

  return String(value);
}
