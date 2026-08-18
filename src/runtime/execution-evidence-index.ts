import type {
  ExecutionEvidenceCandidate,
  ExecutionEvidenceRecord,
  ExecutionPlanEvidence
} from "../contracts/execution-plan.js";
import type { ToolExecutionEffect } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { SessionEvent } from "../contracts/session.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { normalizeExecutionEvidenceRecord } from "../session/execution-evidence-state.js";

const INELIGIBLE_EVIDENCE_TOOLS = new Set(["plan", "delegate_task"]);
const MAX_EVIDENCE_TARGET_CHARS = 240;
const MAX_INDEXED_EXECUTIONS = 1_024;
const MAX_EVIDENCE_CANDIDATES = 8;

type IndexedExecutionEvidence =
  | {
      status: "success";
      evidence: ExecutionPlanEvidence;
      record: ExecutionEvidenceRecord;
      visibleTurnId?: string;
      targetKey?: string;
      executionEffect?: ToolExecutionEffect;
    }
  | {
      status: "failed" | "blocked" | "unavailable" | "ineligible";
      tool: string;
      record: ExecutionEvidenceRecord;
      visibleTurnId?: string;
    };

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
    const safeTurnId = safeVisibleTurnId(visibleTurnId);
    const executionEffect = status === "ineligible" ? undefined : cloneExecutionEffect(execution.executionEffect);
    const verifiedMutation = status === "success" && executionEffect?.kind === "verification"
      ? this.#latestCompatibleMutation({ execution, visibleTurnId: safeTurnId, effect: executionEffect })
      : undefined;
    const record: ExecutionEvidenceRecord = status === "success"
      ? {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary }),
          ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId }),
          ...(executionEffect === undefined ? {} : { executionEffect }),
          ...(verifiedMutation === undefined ? {} : { verifiedMutation })
        }
      : {
          kind: "execution-evidence-recorded",
          toolCallId,
          tool,
          status,
          riskClass: execution.riskClass,
          ...(targetSummary === undefined ? {} : { targetSummary }),
          ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId }),
          ...(executionEffect === undefined ? {} : { executionEffect })
        };
    const normalized = normalizeExecutionEvidenceRecord(record);
    if (normalized === undefined) return undefined;
    this.#indexRecord(normalized, execution.targetKey);
    return normalized;
  }

  recordUnavailable(toolCallId: string, tool: string, visibleTurnId?: string): ExecutionEvidenceRecord {
    const safeTurnId = safeVisibleTurnId(visibleTurnId);
    const record: ExecutionEvidenceRecord = {
      kind: "execution-evidence-recorded",
      toolCallId,
      tool,
      status: "unavailable",
      ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId })
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

  recordsForTurn(visibleTurnId: string): ExecutionEvidenceRecord[] {
    const safeTurnId = safeVisibleTurnId(visibleTurnId);
    if (safeTurnId === undefined) return [];
    return [...this.#byCallId.values()].flatMap((entry) => {
      if (entry.visibleTurnId !== safeTurnId) return [];
      const safe = normalizeExecutionEvidenceRecord(entry.record);
      return safe === undefined ? [] : [safe];
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

  #indexRecord(record: ExecutionEvidenceRecord, targetKey?: string): void {
    const safeTurnId = safeVisibleTurnId(record.visibleTurnId);
    const safeKey = safeTargetKey(targetKey);
    if (record.status !== "success") {
      this.#set(record.toolCallId, {
        status: record.status,
        tool: record.tool,
        record,
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
      record,
      ...(safeKey === undefined ? {} : { targetKey: safeKey }),
      ...(record.executionEffect === undefined ? {} : { executionEffect: cloneExecutionEffect(record.executionEffect) }),
      ...(safeTurnId === undefined ? {} : { visibleTurnId: safeTurnId })
    });
  }

  #latestCompatibleMutation(input: {
    execution: ToolExecutionRecord;
    visibleTurnId?: string;
    effect: Extract<ToolExecutionEffect, { kind: "verification" }>;
  }): { toolCallId: string; tool: string } | undefined {
    if (input.visibleTurnId === undefined) return undefined;
    const verifierTargetKey = safeTargetKey(input.execution.targetKey);
    const candidates = [...this.#byCallId.values()].reverse();
    for (const candidate of candidates) {
      if (
        candidate.status !== "success" ||
        candidate.visibleTurnId !== input.visibleTurnId ||
        candidate.executionEffect?.kind !== "mutation" ||
        !input.effect.verifies.includes(candidate.evidence.tool) ||
        !connectorsCompatible(input.effect.connector, candidate.executionEffect.connector)
      ) continue;
      if (
        verifierTargetKey !== undefined &&
        candidate.targetKey !== undefined &&
        verifierTargetKey !== candidate.targetKey
      ) continue;
      return {
        toolCallId: candidate.evidence.toolCallId,
        tool: candidate.evidence.tool
      };
    }
    return undefined;
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

function safeTargetKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  return safe.length > 0 && safe.length <= 512 && safe === value.trim() ? safe : undefined;
}

function cloneExecutionEffect(effect: ToolExecutionEffect | undefined): ToolExecutionEffect | undefined {
  if (effect === undefined) return undefined;
  const connector = effect.connector === undefined ? {} : { connector: { ...effect.connector } };
  return effect.kind === "verification"
    ? { kind: "verification", verifies: [...effect.verifies], ...connector }
    : { kind: effect.kind, ...connector };
}

function connectorsCompatible(
  verifier: ToolExecutionEffect["connector"],
  mutation: ToolExecutionEffect["connector"]
): boolean {
  if (verifier === undefined || mutation === undefined) return true;
  return verifier.kind === mutation.kind && verifier.id === mutation.id;
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
