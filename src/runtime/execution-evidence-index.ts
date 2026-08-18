import type {
  ExecutionEvidenceCandidate,
  ExecutionEvidenceRecord,
  ExecutionPlanEvidence
} from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { SessionEvent } from "../contracts/session.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { normalizeExecutionEvidenceRecord } from "../session/execution-evidence-state.js";

const INELIGIBLE_EVIDENCE_TOOLS = new Set(["plan", "delegate_task"]);
const MAX_EVIDENCE_TARGET_CHARS = 240;
const MAX_INDEXED_EXECUTIONS = 1_024;
const MAX_EVIDENCE_CANDIDATES = 8;

type IndexedExecutionEvidence =
  | { status: "success"; evidence: ExecutionPlanEvidence; visibleTurnId?: string }
  | { status: "failed" | "blocked" | "unavailable" | "ineligible"; tool: string; visibleTurnId?: string };

export type ExecutionEvidenceStatus = IndexedExecutionEvidence["status"];

export function executionEvidenceStatus(execution: ToolExecutionRecord): ExecutionEvidenceStatus {
  return INELIGIBLE_EVIDENCE_TOOLS.has(execution.tool.name)
    ? "ineligible"
    : execution.decision !== "allow"
      ? "blocked"
      : execution.result?.ok === true
        ? "success"
        : "failed";
}

export class ExecutionEvidenceIndex {
  readonly #byCallId = new Map<string, IndexedExecutionEvidence>();

  record(execution: ToolExecutionRecord, visibleTurnId?: string): ExecutionEvidenceRecord | undefined {
    const toolCallId = safeToolCallId(execution.toolCallId);
    const tool = safeIdentifier(execution.tool.name);
    if (toolCallId === undefined || tool === undefined) return undefined;
    const status = executionEvidenceStatus(execution);
    const targetSummary = safeTargetSummary(execution.targetSummary);
    const record: ExecutionEvidenceRecord = status === "success"
      ? {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary })
        }
      : {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary })
        };
    this.#indexRecord(record, visibleTurnId);
    return record;
  }

  recordUnavailable(toolCallId: string, tool: string, visibleTurnId?: string): ExecutionEvidenceRecord {
    const record: ExecutionEvidenceRecord = {
      kind: "execution-evidence-recorded",
      toolCallId,
      tool,
      status: "unavailable"
    };
    this.#indexRecord(record, visibleTurnId);
    return record;
  }

  hydrate(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.kind !== "execution-evidence-recorded") continue;
      const record = normalizeExecutionEvidenceRecord(event);
      if (record !== undefined) this.#indexRecord(record);
    }
  }

  resolve(toolCallIds: readonly string[]): ExecutionPlanEvidence[] {
    return toolCallIds.map((toolCallId) => {
      const indexed = this.#byCallId.get(toolCallId);
      if (indexed === undefined) {
        throw new ExecutionEvidenceError(`Unknown evidence call id: ${toolCallId}`);
      }
      if (indexed.status !== "success") {
        throw new ExecutionEvidenceError(
          `Evidence call ${toolCallId} is ${indexed.status} and cannot prove completion.`
        );
      }
      return { ...indexed.evidence };
    });
  }

  candidatesForTurn(input: {
    visibleTurnId: string;
    preferredTools?: readonly string[];
  }): ExecutionEvidenceCandidate[] {
    const visibleTurnId = safeVisibleTurnId(input.visibleTurnId);
    if (visibleTurnId === undefined) return [];

    const preferredTools = new Set(input.preferredTools ?? []);
    const recent = [...this.#byCallId.values()]
      .reverse()
      .filter((entry): entry is Extract<IndexedExecutionEvidence, { status: "success" }> =>
        entry.status === "success" && entry.visibleTurnId === visibleTurnId
      );
    const ordered = [
      ...recent.filter((entry) => preferredTools.has(entry.evidence.tool)),
      ...recent.filter((entry) => !preferredTools.has(entry.evidence.tool))
    ];
    return ordered.slice(0, MAX_EVIDENCE_CANDIDATES).map((entry) => ({
      toolCallId: entry.evidence.toolCallId,
      tool: entry.evidence.tool,
      riskClass: entry.evidence.riskClass,
      ...(entry.evidence.targetSummary === undefined ? {} : { targetSummary: entry.evidence.targetSummary })
    }));
  }

  #set(toolCallId: string, evidence: IndexedExecutionEvidence): void {
    this.#byCallId.delete(toolCallId);
    this.#byCallId.set(toolCallId, evidence);
    while (this.#byCallId.size > MAX_INDEXED_EXECUTIONS) {
      const oldest = this.#byCallId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#byCallId.delete(oldest);
    }
  }

  #indexRecord(record: ExecutionEvidenceRecord, visibleTurnId?: string): void {
    const safeTurnId = safeVisibleTurnId(visibleTurnId);
    if (record.status !== "success") {
      this.#set(record.toolCallId, {
        status: record.status,
        tool: record.tool,
        ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId })
      });
      return;
    }
    const targetSummary = safeTargetSummary(record.targetSummary);
    this.#set(record.toolCallId, {
      status: "success",
      evidence: {
        toolCallId: record.toolCallId,
        tool: record.tool,
        outcome: "success",
        riskClass: record.riskClass,
        ...(targetSummary === undefined ? {} : { targetSummary })
      },
      ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId })
    });
  }
}

export class ExecutionEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEvidenceError";
  }
}

function safeTargetSummary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (safe.length === 0) return undefined;
  return [...safe].slice(0, MAX_EVIDENCE_TARGET_CHARS).join("");
}

function safeVisibleTurnId(value: string | undefined): string | undefined {
  return safeIdentifier(value);
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = value.trim();
  return safe.length > 0 && safe.length <= 256 ? safe : undefined;
}

function safeToolCallId(value: string | undefined): string | undefined {
  const safe = safeIdentifier(value);
  if (safe === undefined) return undefined;
  return redactSensitiveText(safe) === safe ? safe : undefined;
}
