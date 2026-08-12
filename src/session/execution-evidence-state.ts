import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";

const MAX_CARRIED_EXECUTION_EVIDENCE = 1_024;

/**
 * Preserve only bounded, safe execution receipts across semantic compaction.
 * Raw tool inputs and outputs live in other event kinds and are never copied.
 */
export function executionEvidenceCarryForwardEvents(
  events: readonly SessionEvent[]
): ExecutionEvidenceRecord[] {
  const latestByCallId = new Map<string, ExecutionEvidenceRecord>();
  for (const event of events) {
    if (event.kind !== "execution-evidence-recorded") continue;
    const safe = normalizeExecutionEvidenceRecord(event);
    if (safe === undefined) continue;
    latestByCallId.delete(safe.toolCallId);
    latestByCallId.set(safe.toolCallId, safe);
    while (latestByCallId.size > MAX_CARRIED_EXECUTION_EVIDENCE) {
      const oldest = latestByCallId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      latestByCallId.delete(oldest);
    }
  }
  return [...latestByCallId.values()];
}

export function normalizeExecutionEvidenceRecord(
  record: ExecutionEvidenceRecord
): ExecutionEvidenceRecord | undefined {
  const toolCallId = boundedIdentifier(record.toolCallId);
  const tool = boundedIdentifier(record.tool);
  if (toolCallId === undefined || tool === undefined || !isEvidenceStatus(record.status)) return undefined;
  const targetSummary = safeTargetSummary(record.targetSummary);
  if (record.status === "success") {
    if (!isToolRiskClass(record.riskClass)) return undefined;
    return {
      kind: "execution-evidence-recorded",
      toolCallId,
      tool,
      status: "success",
      riskClass: record.riskClass,
      ...(targetSummary === undefined ? {} : { targetSummary })
    };
  }
  return {
    kind: "execution-evidence-recorded",
    toolCallId,
    tool,
    status: record.status,
    ...(isToolRiskClass(record.riskClass) ? { riskClass: record.riskClass } : {}),
    ...(targetSummary === undefined ? {} : { targetSummary })
  };
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.trim();
  return bounded.length > 0 && bounded.length <= 256 ? bounded : undefined;
}

function safeTargetSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (safe.length === 0) return undefined;
  return [...safe].slice(0, 240).join("");
}

function isEvidenceStatus(value: unknown): value is ExecutionEvidenceRecord["status"] {
  return value === "success" || value === "failed" || value === "blocked" ||
    value === "unavailable" || value === "ineligible";
}

function isToolRiskClass(value: unknown): value is ToolRiskClass {
  return value === "read-only-local" || value === "read-only-network" || value === "workspace-write" ||
    value === "external-side-effect" || value === "credential-access" || value === "destructive-local" ||
    value === "shared-state-mutation" || value === "spend-money" || value === "sandbox-escape";
}
