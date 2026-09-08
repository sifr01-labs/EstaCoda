import { createHash } from "node:crypto";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition, ToolResult, ToolRiskClass } from "../contracts/tool.js";
import type {
  ToolExecutionRecord,
  ToolReadLedger,
  ToolReadLedgerScope
} from "../tools/tool-executor.js";
import { redactObject, redactSensitiveText } from "../utils/redaction.js";

const MAX_CONSUMED_FEEDBACK_SUMMARY_CHARS = 4_000;

export type ToolFeedbackEntry = {
  plan: ToolCallPlan;
  execution?: ToolExecutionRecord;
};

export type ToolFeedbackSummary = {
  callId: string;
  tool: string;
  status: ToolCallPlan["status"];
  ok?: boolean;
  riskClass?: ToolRiskClass;
  targetSummary?: string;
  resultChars: number;
};

export type TurnToolFeedbackLedger = {
  latest: ToolFeedbackEntry[];
  consumed: ToolFeedbackSummary[];
  omittedCount: number;
  repeatedMcpReadCount?: number;
};

export function createTurnToolFeedbackLedger(): TurnToolFeedbackLedger {
  return {
    latest: [],
    consumed: [],
    omittedCount: 0,
    repeatedMcpReadCount: 0
  };
}

export function recordTurnToolFeedbackBatch(
  ledger: TurnToolFeedbackLedger,
  plans: readonly ToolCallPlan[],
  executions: readonly ToolExecutionRecord[]
): TurnToolFeedbackLedger {
  if (plans.length === 0) {
    return ledger;
  }

  const newlyConsumed = ledger.latest.map(summarizeFeedbackEntry);
  const consumed = [...ledger.consumed, ...newlyConsumed];
  let omittedCount = ledger.omittedCount;
  while (consumed.length > 0 && estimatedSummaryChars(consumed) > MAX_CONSUMED_FEEDBACK_SUMMARY_CHARS) {
    consumed.shift();
    omittedCount += 1;
  }

  const executionsByCallId = new Map(
    executions
      .filter((execution) => typeof execution.toolCallId === "string")
      .map((execution) => [execution.toolCallId!, execution])
  );

  return {
    latest: plans.map((plan, index) => {
      const positionalExecution = executions[index];
      return {
        plan,
        execution: executionsByCallId.get(plan.id) ?? (
          positionalExecution?.toolCallId === undefined ? positionalExecution : undefined
        )
      };
    }),
    consumed,
    omittedCount,
    repeatedMcpReadCount: (ledger.repeatedMcpReadCount ?? 0) + executions.filter(isReusedMcpRead).length
  };
}

type McpReadReceipt = {
  revision: number;
  sourceToolCallId?: string;
  summary: string;
};

/** Turn-local only. It never persists raw MCP results or inputs. */
export class TurnMcpReadLedger implements ToolReadLedger {
  #scope: ToolReadLedgerScope;
  #revision = 0;
  readonly #receipts = new Map<string, McpReadReceipt>();

  constructor(scope: ToolReadLedgerScope) {
    this.#scope = { ...scope };
  }

  reuse(input: {
    scope: ToolReadLedgerScope;
    tool: ToolDefinition;
    input: Record<string, unknown>;
    toolCallId?: string;
  }): ToolResult | undefined {
    this.#adoptScope(input.scope);
    if (!isMcpReadTool(input.tool) || isTaskStatusRead(input.tool)) return undefined;
    const key = this.#key(input.tool.name, input.input);
    const receipt = this.#receipts.get(key);
    if (receipt === undefined) return undefined;

    return {
      ok: true,
      content: [
        `Unchanged MCP read: ${input.tool.name} was already confirmed at the current target revision.`,
        `Prior receipt (${receipt.sourceToolCallId ?? "earlier call"}):`,
        receipt.summary,
        "Do not repeat this read again unless a mutation or new input changes the target."
      ].join("\n"),
      metadata: {
        _estacoda_context_summary: `Reused unchanged ${input.tool.name} receipt at target revision ${receipt.revision}.`,
        mcpReadReuse: true,
        sourceToolCallId: receipt.sourceToolCallId,
        targetRevision: receipt.revision
      }
    };
  }

  observe(input: {
    scope: ToolReadLedgerScope;
    execution: ToolExecutionRecord;
  }): void {
    this.#adoptScope(input.scope);
    const { execution } = input;
    if (!isMcpTool(execution.tool) || execution.decision !== "allow") return;
    if (!isMcpReadTool(execution.tool)) {
      this.#revision += 1;
      this.#receipts.clear();
      return;
    }
    if (isTaskStatusRead(execution.tool) || !isAuthoritativeRead(execution.result) || isReusedMcpRead(execution)) return;
    this.#receipts.set(this.#key(execution.tool.name, execution.input ?? {}), {
      revision: this.#revision,
      sourceToolCallId: execution.toolCallId,
      summary: compactReadSummary(execution.result!)
    });
  }

  #adoptScope(scope: ToolReadLedgerScope): void {
    if (scope.profileId === this.#scope.profileId && scope.sessionId === this.#scope.sessionId) return;
    this.#scope = { ...scope };
    this.#revision = 0;
    this.#receipts.clear();
  }

  #key(tool: string, input: Record<string, unknown>): string {
    return `${tool}:${normalizedInputHash(input)}:${this.#revision}`;
  }
}

function isMcpTool(tool: ToolDefinition): boolean {
  return tool.toolsets.includes("mcp");
}

function isMcpReadTool(tool: ToolDefinition): boolean {
  return isMcpTool(tool) && (tool.riskClass === "read-only-local" || tool.riskClass === "read-only-network");
}

function isAuthoritativeRead(result: ToolResult | undefined): result is ToolResult {
  if (result?.ok !== true) return false;
  if (result.metadata?._estacoda_verification_evidence === false) return false;
  if (containsPartialResultMarker(result.metadata, 0, new Set())) return false;
  const rawContent = result.content.includes("\nFull MCP response:\n")
    ? result.content.split("\nFull MCP response:\n", 2)[1]
    : result.content;
  try {
    return !containsPartialResultMarker(JSON.parse(rawContent ?? ""), 0, new Set());
  } catch {
    return true;
  }
}

function isTaskStatusRead(tool: ToolDefinition): boolean {
  // Status polling observes externally changing state; it is never an
  // unchanged-read shortcut, even when the previous response was complete.
  return /(?:task|job).*status|status.*(?:task|job)/iu.test(tool.name);
}

function containsPartialResultMarker(value: unknown, depth: number, seen: Set<object>): boolean {
  if (depth > 6 || typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsPartialResultMarker(entry, depth + 1, seen));
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/gu, "").toLowerCase();
    if (["status", "state"].includes(normalized) && typeof entry === "string" &&
      /^(?:pending|queued|running|processing|in[ _-]?progress|accepted)$/iu.test(entry)) return true;
    if (["partial", "ispartial", "incomplete", "truncated", "hasmore"].includes(normalized) && entry === true) {
      return true;
    }
    if (["nextcursor", "nextpage", "continuationtoken"].includes(normalized) && entry !== undefined && entry !== null && entry !== "") {
      return true;
    }
    if (containsPartialResultMarker(entry, depth + 1, seen)) return true;
  }
  return false;
}

function isReusedMcpRead(execution: ToolExecutionRecord): boolean {
  return execution.result?.metadata?.mcpReadReuse === true;
}

function normalizedInputHash(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 24);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compactReadSummary(result: ToolResult): string {
  const preferred = result.metadata?._estacoda_context_summary;
  if (typeof preferred === "string" && preferred.trim().length > 0) {
    return truncate(redactSensitiveText(preferred).trim(), 1_500);
  }
  try {
    return truncate(JSON.stringify(redactObject(JSON.parse(result.content), { strict: true })), 1_500);
  } catch {
    return `MCP read succeeded with ${result.content.length} unstructured characters; exact content was delivered in the prior tool result.`;
  }
}

function summarizeFeedbackEntry(entry: ToolFeedbackEntry): ToolFeedbackSummary {
  const targetSummary = entry.execution?.targetSummary === undefined
    ? undefined
    : truncate(redactSensitiveText(entry.execution.targetSummary).trim(), 240);
  return {
    callId: entry.plan.id,
    tool: entry.plan.tool || "unknown",
    status: entry.plan.status,
    ...(entry.plan.result === undefined ? {} : { ok: entry.plan.result.ok }),
    ...(entry.execution === undefined ? {} : { riskClass: entry.execution.riskClass }),
    ...(targetSummary === undefined || targetSummary.length === 0 ? {} : { targetSummary }),
    resultChars: entry.plan.result?.content.length ?? 0
  };
}

function estimatedSummaryChars(summaries: readonly ToolFeedbackSummary[]): number {
  return summaries.reduce((sum, summary) => (
    sum + 96 + summary.callId.length + summary.tool.length + (summary.targetSummary?.length ?? 0)
  ), 0);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
