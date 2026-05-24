// v0.95 Tool Activity ViewModel Builders
// Replaces string-based ToolActivityRenderer with structured ViewModels.
// All icon resolution is token-driven; default CLI uses semantic Unicode/text.

import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import type {
  ActivityTimelineViewModel,
  ApprovalAction,
  ApprovalSecurityViewModel,
  CommandResultViewModel,
  ListViewModel,
  ProgressContextRailViewModel,
  TimelineEvent,
  ToolActivityRailEvent,
  ToolActivityRailViewModel,
  ViewModel,
  WarningErrorViewModel,
} from "../contracts/view-model.js";
import {
  buildActivityTimelineViewModel,
  buildApprovalSecurityViewModel,
  buildCommandResultViewModel,
  buildListViewModel,
  buildProgressContextRailViewModel,
  buildToolActivityRailViewModel,
  buildWarningErrorViewModel,
  listItem,
  timelineEvent,
  progressStep,
  toolActivityRailEvent,
} from "../ui/view-models/builders.js";
import { toolActivityLabelKey } from "../ui/tool-labels.js";

// ─────────────────────────────────────────────────────────────
// Tool glyph resolution (capability-gated, token-driven)
// ─────────────────────────────────────────────────────────────

const TOOL_NAME_TO_TOKEN_KEY: Readonly<Record<string, string>> = {
  artifact: "writeFile",
  media: "media",
  "web.extract": "webSearch",
  browser: "browserNavigate",
  workspace: "readFile",
  file: "readFile",
  terminal: "terminal",
  process: "process",
  execute: "executeCode",
  python: "executeCode",
  memory: "memory",
  trajectory: "writeFile",
  delegate: "delegateTask",
  workflow: "mixtureOfAgents",
  skill: "mixtureOfAgents",
  config: "readFile",
  onboarding: "readFile",
  cronjob: "cronjob",
  todo: "todo",
  telegram: "telegram",
  clarify: "clarify",
};

export function resolveToolGlyph(tool: string, tokens?: ResolvedTokens): string {
  if (tokens !== undefined) {
    for (const [pattern, key] of Object.entries(TOOL_NAME_TO_TOKEN_KEY)) {
      if (tool.includes(pattern)) {
        const glyph = tokens.contract.toolIcon[key];
        if (glyph !== undefined) {
          return glyph;
        }
      }
    }
    return tokens.contract.glyph.toolPrefix;
  }

  // Fallback when no tokens provided: plain ASCII
  return "|";
}

// ─────────────────────────────────────────────────────────────
// Tool label resolution
// ─────────────────────────────────────────────────────────────

export function resolveToolLabel(tool: string, definitions?: Map<string, ToolDefinition>): string {
  const definition = definitions?.get(tool);
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

// ─────────────────────────────────────────────────────────────
// Risk class humanization
// ─────────────────────────────────────────────────────────────

export function humanRisk(riskClass: string | undefined): string {
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

// ─────────────────────────────────────────────────────────────
// Duration / count formatting
// ─────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.max(0, ms)}ms`;
  }
  return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

export function formatCount(value: number): string {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────
// Tool Activity ViewModel Builder
// ─────────────────────────────────────────────────────────────

export interface ToolActivityViewModelBuilderOptions {
  readonly tools: readonly ToolDefinition[];
  readonly now?: () => number;
}

export class ToolActivityViewModelBuilder {
  readonly #tools: Map<string, ToolDefinition>;
  readonly #starts = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(options: ToolActivityViewModelBuilderOptions) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#now = options.now ?? (() => Date.now());
  }

  buildTimelineEvent(
    event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>
  ): TimelineEvent {
    if (event.kind === "tool-start") {
      this.#pushStart(this.#eventKey(event));
      return timelineEvent(event.tool, "running");
    }

    const elapsed = this.#popElapsed(this.#eventKey(event));
    const decision = event.decision !== undefined && event.decision !== "allow"
      ? (event.decision as "ask" | "block")
      : undefined;

    if (decision !== undefined) {
      return timelineEvent(event.tool, "gated", {
        elapsedMs: elapsed ?? undefined,
        decision,
        riskClass: event.riskClass,
      });
    }

    const status = event.ok === false ? "failed" : "done";
    return timelineEvent(event.tool, status, {
      elapsedMs: elapsed ?? undefined,
      chars: event.chars,
      sentChars: event.sentChars,
      truncated: event.truncated,
    });
  }

  buildActivityTimeline(
    events: readonly Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>[]
  ): ActivityTimelineViewModel {
    const timelineEvents = events.map((e) => this.buildTimelineEvent(e));
    return buildActivityTimelineViewModel({ events: timelineEvents });
  }

  buildToolActivityRailEvent(
    event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" | "provider-tool-call" }>
  ): ToolActivityRailEvent {
    if (event.kind === "tool-start") {
      this.#pushStart(this.#eventKey(event));
      return toolActivityRailEvent(event.tool, "running", {
        label: "preparing",
        target: event.targetSummary ?? event.tool,
        activityId: event.activityId,
      });
    }

    if (event.kind === "provider-tool-call") {
      const tool = event.name ?? "provider-tool";
      return toolActivityRailEvent(tool, "running", {
        label: toolActivityLabelKey(tool),
      });
    }

    const elapsed = this.#popElapsed(this.#eventKey(event));
    const decision = event.decision !== undefined && event.decision !== "allow"
      ? (event.decision as "ask" | "block")
      : undefined;

    if (decision !== undefined) {
      return toolActivityRailEvent(event.tool, "gated", {
        elapsedMs: elapsed ?? undefined,
        label: "gated",
        riskClass: event.riskClass,
        target: event.targetSummary,
        activityId: event.activityId,
      });
    }

    const status = event.ok === false ? "failed" : "done";
    return toolActivityRailEvent(event.tool, status, {
      elapsedMs: elapsed ?? undefined,
      label: status === "failed" ? "failed" : toolActivityLabelKey(event.tool),
      target: event.targetSummary,
      activityId: event.activityId,
    });
  }

  buildToolActivityRail(
    events: readonly Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" | "provider-tool-call" }>[]
  ): ToolActivityRailViewModel {
    const railEvents = events.map((e) => this.buildToolActivityRailEvent(e));
    return buildToolActivityRailViewModel({ events: railEvents });
  }

  #pushStart(tool: string): void {
    const starts = this.#starts.get(tool) ?? [];
    starts.push(this.#now());
    this.#starts.set(tool, starts);
  }

  #popElapsed(tool: string): number | undefined {
    const starts = this.#starts.get(tool);
    const startedAt = starts?.shift();

    if (starts !== undefined && starts.length === 0) {
      this.#starts.delete(tool);
    }

    if (startedAt === undefined) {
      return undefined;
    }

    return this.#now() - startedAt;
  }

  #eventKey(event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>): string {
    return event.activityId ?? `${event.tool}\0${event.targetSummary ?? ""}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Security Audit ViewModel Builder
// ─────────────────────────────────────────────────────────────

export interface BuildSecurityAuditInput {
  readonly events: readonly Extract<SessionEvent, { kind: "security-assessed" }>[];
  readonly debug: boolean;
}

export function buildSecurityAuditViewModel(input: BuildSecurityAuditInput): ViewModel {
  if (input.events.length === 0) {
    return buildWarningErrorViewModel({
      severity: "info",
      title: "Security audit",
      message: "No tool security decisions have been recorded for this session yet.",
    });
  }

  const blocks: ViewModel[] = [];

  if (input.debug) {
    for (const event of input.events) {
      const details = buildSecurityEventDetails(event);
      blocks.push(
        buildWarningErrorViewModel({
          severity: event.assessment.decision === "allow" ? "info" : "warn",
          title: `${event.tool} -> ${event.assessment.decision}`,
          message: `risk=${event.riskClass} rule=${event.assessment.deterministicRule ?? "policy"}`,
          details,
        })
      );
    }
  } else {
    const items = input.events.map((event) =>
      listItem(
        `${event.tool} -> ${event.assessment.decision}`,
        `risk=${event.riskClass} rule=${event.assessment.deterministicRule ?? "policy"}`
      )
    );
    blocks.push(buildListViewModel({ items }));
  }

  return buildCommandResultViewModel({
    ok: true,
    title: "Security audit",
    blocks,
  });
}

function buildSecurityEventDetails(
  event: Extract<SessionEvent, { kind: "security-assessed" }>
): string[] {
  const assessment = event.assessment;
  const details: string[] = [
    `mode: ${assessment.mode}`,
    `risk: ${assessment.risk}`,
    `risk class: ${event.riskClass}`,
    `deterministic rule: ${assessment.deterministicRule ?? "none"}`,
    `reason: ${assessment.reason}`,
  ];

  if (event.targetKey !== undefined) {
    details.push(`target key: ${event.targetKey}`);
  }
  if (event.targetSummary !== undefined) {
    details.push(`target: ${event.targetSummary}`);
  }

  details.push(`assessor: ${renderAssessorDebug(assessment)}`);
  return details;
}

function renderAssessorDebug(assessment: { assessor?: { used?: boolean; status?: string; provider?: string; model?: string; decision?: string; risk?: string; confidence?: number; reason?: string } }): string {
  const assessor = assessment.assessor;
  if (assessor === undefined) {
    return "not used";
  }
  if (assessor.used !== true) {
    return `not used (${assessor.status ?? "disabled"})`;
  }

  const parts: string[] = [`used status=${assessor.status ?? "unknown"}`];
  if (assessor.provider !== undefined) parts.push(`provider=${assessor.provider}`);
  if (assessor.model !== undefined) parts.push(`model=${assessor.model}`);
  if (assessor.decision !== undefined) parts.push(`decision=${assessor.decision}`);
  if (assessor.risk !== undefined) parts.push(`risk=${assessor.risk}`);
  if (assessor.confidence !== undefined) parts.push(`confidence=${assessor.confidence}`);
  if (assessor.reason !== undefined) parts.push(`reason=${assessor.reason}`);

  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────
// Approval Prompt ViewModel Builder
// ─────────────────────────────────────────────────────────────

export function buildApprovalPromptViewModel(
  execution: ToolExecutionRecord,
  options?: { allowPersistentApproval?: boolean }
): ApprovalSecurityViewModel {
  const details: string[] = [];
  if (execution.targetSummary !== undefined) {
    details.push(`Target: ${execution.targetSummary}`);
  }

  const actions: ApprovalAction[] = [
    { id: "once", label: "Allow once" },
    { id: "session", label: "Allow for this session" },
  ];
  if (options?.allowPersistentApproval !== false) {
    actions.push({ id: "always", label: "Always allow" });
  }
  actions.push({ id: "deny", label: "Deny", severity: "error" });

  return buildApprovalSecurityViewModel({
    toolName: execution.tool.name,
    riskClass: execution.riskClass,
    targetSummary: execution.targetSummary ?? execution.targetKey ?? execution.tool.name,
    severity: "warn",
    actions,
    details,
  });
}

// ─────────────────────────────────────────────────────────────
// Setup Needed ViewModel Builder
// ─────────────────────────────────────────────────────────────

export interface SetupNeededInfo {
  readonly capability: string;
  readonly provider?: string;
  readonly model?: string;
  readonly requiredSecret: string;
}

export function buildSetupNeededViewModel(setup: SetupNeededInfo): WarningErrorViewModel {
  return buildWarningErrorViewModel({
    severity: "warn",
    title: "Setup required",
    message: `${setup.capability} needs one protected credential before I can continue.`,
    details: [
      `Provider: ${setup.provider ?? "default"}`,
      `Model: ${setup.model ?? "default"}`,
      `Secret env: ${setup.requiredSecret}`,
      "The key is captured by the CLI and is not sent to the model or written to the transcript.",
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Turn Progress Rail Builder
// ─────────────────────────────────────────────────────────────

export interface BuildTurnProgressRailOptions {
  readonly toolExecutions: readonly ToolExecutionRecord[];
  readonly sessionElapsedMs?: number;
  readonly taskElapsedMs?: number | "idle";
}

export function buildTurnProgressRail(options: BuildTurnProgressRailOptions): ProgressContextRailViewModel {
  const steps = options.toolExecutions.map((execution) => {
    const status = execution.decision === "ask"
      ? "pending"
      : execution.result?.ok === false
        ? "failed"
        : execution.result !== undefined
          ? "done"
          : "active";

    return progressStep(execution.tool.name, status);
  });

  return buildProgressContextRailViewModel({
    title: options.toolExecutions.length > 0 ? "Turn progress" : undefined,
    steps,
    sessionElapsedMs: options.sessionElapsedMs,
    taskElapsedMs: options.taskElapsedMs,
  });
}
