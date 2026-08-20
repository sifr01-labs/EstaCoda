import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolExecutionEffect, ToolRiskClass } from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";

const MAX_CARRIED_EXECUTION_EVIDENCE = 1_024;
const MAX_VERIFICATION_RELATIONSHIPS = 16;
const MAX_TOOL_NAME_CHARS = 160;

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
  const tool = boundedToolName(record.tool);
  if (toolCallId === undefined || tool === undefined || !isEvidenceStatus(record.status)) return undefined;
  const targetSummary = safeTargetSummary(record.targetSummary);
  const visibleTurnId = boundedIdentifier(record.visibleTurnId);
  const executionEffect = normalizeToolExecutionEffect(record.executionEffect);
  if (record.status === "success") {
    if (!isToolRiskClass(record.riskClass)) return undefined;
    const verifiedMutation = normalizeVerifiedMutation(record.verifiedMutation, executionEffect, toolCallId);
    return {
      kind: "execution-evidence-recorded",
      toolCallId,
      tool,
      status: "success",
      riskClass: record.riskClass,
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(visibleTurnId === undefined ? {} : { visibleTurnId }),
      ...(executionEffect === undefined ? {} : { executionEffect }),
      ...(verifiedMutation === undefined ? {} : { verifiedMutation })
    };
  }
  return {
    kind: "execution-evidence-recorded",
    toolCallId,
    tool,
    status: record.status,
    ...(isToolRiskClass(record.riskClass) ? { riskClass: record.riskClass } : {}),
    ...(targetSummary === undefined ? {} : { targetSummary }),
    ...(visibleTurnId === undefined ? {} : { visibleTurnId }),
    ...(executionEffect === undefined ? {} : { executionEffect })
  };
}

function normalizeToolExecutionEffect(value: unknown): ToolExecutionEffect | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ToolExecutionEffect>;
  const connector = normalizeConnector(candidate.connector);
  if (candidate.kind === "read" || candidate.kind === "mutation") {
    return {
      kind: candidate.kind,
      ...(connector === undefined ? {} : { connector })
    };
  }
  if (candidate.kind !== "verification" || !Array.isArray(candidate.verifies)) return undefined;
  const verifies = [...new Set(candidate.verifies.flatMap((tool) => {
    const safe = boundedToolName(tool);
    return safe === undefined ? [] : [safe];
  }))].slice(0, MAX_VERIFICATION_RELATIONSHIPS);
  if (verifies.length === 0) return undefined;
  return {
    kind: "verification",
    verifies,
    ...(connector === undefined ? {} : { connector })
  };
}

function normalizeVerifiedMutation(
  value: unknown,
  effect: ToolExecutionEffect | undefined,
  verifierCallId: string
): { toolCallId: string; tool: string } | undefined {
  if (effect?.kind !== "verification" || typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { toolCallId?: unknown; tool?: unknown };
  const toolCallId = boundedIdentifier(candidate.toolCallId);
  const tool = boundedToolName(candidate.tool);
  if (
    toolCallId === undefined ||
    toolCallId === verifierCallId ||
    tool === undefined ||
    !effect.verifies.includes(tool)
  ) return undefined;
  return { toolCallId, tool };
}

function normalizeConnector(value: unknown): { kind: "mcp"; id: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { kind?: unknown; id?: unknown };
  const id = boundedIdentifier(candidate.id);
  if (candidate.kind !== "mcp" || id === undefined || redactSensitiveText(id) !== id) return undefined;
  return { kind: "mcp", id };
}

function boundedToolName(value: unknown): string | undefined {
  const safe = boundedIdentifier(value);
  return safe === undefined || safe.length > MAX_TOOL_NAME_CHARS || redactSensitiveText(safe) !== safe
    ? undefined
    : safe;
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
