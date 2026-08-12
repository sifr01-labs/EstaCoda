import type { ExecutionEvidenceRecord, ExecutionPlanEvidence } from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { SessionEvent } from "../contracts/session.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { normalizeExecutionEvidenceRecord } from "../session/execution-evidence-state.js";

const INELIGIBLE_EVIDENCE_TOOLS = new Set(["plan", "delegate_task"]);
const MAX_EVIDENCE_TARGET_CHARS = 240;
const MAX_INDEXED_EXECUTIONS = 1_024;

type IndexedExecutionEvidence =
  | { status: "success"; evidence: ExecutionPlanEvidence }
  | { status: "failed" | "blocked" | "unavailable" | "ineligible"; tool: string };

export class ExecutionEvidenceIndex {
  readonly #byCallId = new Map<string, IndexedExecutionEvidence>();

  record(execution: ToolExecutionRecord): ExecutionEvidenceRecord | undefined {
    const toolCallId = execution.toolCallId;
    if (toolCallId === undefined || toolCallId.trim().length === 0) return undefined;
    const status = INELIGIBLE_EVIDENCE_TOOLS.has(execution.tool.name)
      ? "ineligible"
      : execution.decision !== "allow"
        ? "blocked"
        : execution.result?.ok === true
          ? "success"
          : "failed";
    const targetSummary = safeTargetSummary(execution.targetSummary);
    const record: ExecutionEvidenceRecord = status === "success"
      ? {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool: execution.tool.name,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary })
        }
      : {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool: execution.tool.name,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary })
        };
    this.#indexRecord(record);
    return record;
  }

  recordUnavailable(toolCallId: string, tool: string): ExecutionEvidenceRecord {
    const record: ExecutionEvidenceRecord = {
      kind: "execution-evidence-recorded",
      toolCallId,
      tool,
      status: "unavailable"
    };
    this.#indexRecord(record);
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

  #set(toolCallId: string, evidence: IndexedExecutionEvidence): void {
    this.#byCallId.delete(toolCallId);
    this.#byCallId.set(toolCallId, evidence);
    while (this.#byCallId.size > MAX_INDEXED_EXECUTIONS) {
      const oldest = this.#byCallId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#byCallId.delete(oldest);
    }
  }

  #indexRecord(record: ExecutionEvidenceRecord): void {
    if (record.status !== "success") {
      this.#set(record.toolCallId, { status: record.status, tool: record.tool });
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
      }
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
