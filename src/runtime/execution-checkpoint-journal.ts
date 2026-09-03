import type {
  ExecutionCheckpointOperation,
  ExecutionCheckpointOperationCoordinates,
  ExecutionCheckpointSafeFact,
  ExecutionCheckpointSafeFactKind
} from "../contracts/execution-checkpoint.js";
import type {
  RegisteredTool,
  ToolExecutionEffect,
  ToolOperationIdentity,
  ToolOperationVerification,
  ToolResult
} from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";

const SAFE_FACT_FIELDS = new Map<string, ExecutionCheckpointSafeFactKind>([
  ["workspaceid", "workspace_id"],
  ["collectionid", "collection_id"],
  ["specificationid", "specification_id"],
  ["specid", "specification_id"],
  ["productname", "product_name"],
  ["artifactid", "artifact_id"],
  ["artifactreference", "artifact_id"],
  ["artifacthash", "artifact_hash"],
  ["sha256", "artifact_hash"]
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

export function checkpointSafeFactsFromResult(input: {
  tool: RegisteredTool;
  result: ToolResult;
  observedAt: string;
}): ExecutionCheckpointSafeFact[] {
  if (!input.result.ok) return [];
  const values = input.result.metadata?._estacoda_continuity_facts;
  if (!Array.isArray(values)) return [];
  const output: ExecutionCheckpointSafeFact[] = [];
  const seen = new Set<string>();
  for (const entry of values.slice(0, 24)) {
    if (!isRecord(entry) || typeof entry.field !== "string" || typeof entry.value !== "string") continue;
    const kind = SAFE_FACT_FIELDS.get(entry.field.replace(/[_-]+/gu, "").toLocaleLowerCase());
    if (kind === undefined || entry.kind !== (kind === "product_name" ? "label" : "identifier")) continue;
    const value = safeFactValue(kind, entry.value);
    if (value === undefined) continue;
    const key = `${kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      kind,
      value,
      sourceTool: input.tool.name,
      ...(input.tool.connector === undefined ? {} : { connectorId: input.tool.connector.id }),
      observedAt: input.observedAt
    });
  }
  return output;
}

export function checkpointOperationCoordinates(input: {
  tool: RegisteredTool;
  effect: ToolExecutionEffect | undefined;
  value: Record<string, unknown>;
}): ExecutionCheckpointOperationCoordinates | undefined {
  if (input.effect?.kind !== "mutation" || input.effect.connector === undefined || input.tool.operationJournal === undefined) {
    return undefined;
  }
  let identity: ToolOperationIdentity | undefined;
  try {
    identity = input.tool.operationJournal.identify(input.value);
  } catch {
    return undefined;
  }
  const normalized = normalizeIdentity(identity);
  if (normalized === undefined) return undefined;
  return {
    connectorId: input.effect.connector.id,
    operation: input.tool.name,
    ...normalized
  };
}

export function checkpointVerificationMatch(input: {
  tool: RegisteredTool;
  effect: ToolExecutionEffect | undefined;
  value: Record<string, unknown>;
  result: ToolResult;
  operations: readonly ExecutionCheckpointOperation[];
}): { operationId: string; outcome: "present" | "absent" } | undefined {
  const connector = input.effect?.connector;
  if (
    input.effect?.kind !== "verification" ||
    connector === undefined ||
    !input.result.ok
  ) return undefined;
  const effect = input.effect;
  const connectorId = connector.id;
  const compatible = input.operations.filter((operation) =>
    operation.connectorId === connectorId &&
    effect.verifies.includes(operation.operation) &&
    ["dispatched", "settled", "uncertain"].includes(operation.status)
  );
  if (input.tool.operationJournal?.verify === undefined) {
    return compatible.length === 1
      ? { operationId: compatible[0]!.id, outcome: "present" }
      : undefined;
  }
  let verification: ToolOperationVerification | undefined;
  try {
    verification = input.tool.operationJournal.verify(input.value, input.result);
  } catch {
    return undefined;
  }
  if (verification === undefined) return undefined;
  const normalized = normalizeIdentity(verification);
  if (normalized === undefined) return undefined;
  const candidates = compatible.filter((operation) => coordinatesMatch(operation, normalized));
  return candidates.length === 1 ? { operationId: candidates[0]!.id, outcome: verification.outcome } : undefined;
}

function normalizeIdentity(input: ToolOperationIdentity | undefined): Omit<ExecutionCheckpointOperationCoordinates, "connectorId" | "operation"> | undefined {
  if (input === undefined || !isRecord(input)) return undefined;
  const destinationId = safeCoordinate(input.destinationId);
  const subjectId = safeCoordinate(input.subjectId);
  const artifactHash = typeof input.artifactHash === "string" && /^[a-f0-9]{64}$/u.test(input.artifactHash)
    ? input.artifactHash
    : undefined;
  if (input.destinationId !== undefined && destinationId === undefined) return undefined;
  if (input.subjectId !== undefined && subjectId === undefined) return undefined;
  if (input.artifactHash !== undefined && artifactHash === undefined) return undefined;
  if (destinationId === undefined && subjectId === undefined && artifactHash === undefined) return undefined;
  const operationRevision = input.operationRevision ?? 1;
  if (!Number.isSafeInteger(operationRevision) || operationRevision < 1 || operationRevision > 1_000_000) return undefined;
  return {
    ...(destinationId === undefined ? {} : { destinationId }),
    ...(subjectId === undefined ? {} : { subjectId }),
    ...(artifactHash === undefined ? {} : { artifactHash }),
    operationRevision
  };
}

function coordinatesMatch(
  operation: ExecutionCheckpointOperation,
  identity: Omit<ExecutionCheckpointOperationCoordinates, "connectorId" | "operation">
): boolean {
  return operation.operationRevision === identity.operationRevision &&
    (identity.destinationId === undefined || operation.destinationId === identity.destinationId) &&
    (identity.subjectId === undefined || operation.subjectId === identity.subjectId) &&
    (identity.artifactHash === undefined || operation.artifactHash === identity.artifactHash);
}

function safeFactValue(kind: ExecutionCheckpointSafeFactKind, input: string): string | undefined {
  let normalized = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (kind === "artifact_id" && normalized.startsWith("artifact://")) normalized = normalized.slice("artifact://".length);
  if (kind === "artifact_hash") return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
  const max = kind === "product_name" ? 160 : 200;
  if (normalized.length === 0 || normalized.length > max) return undefined;
  if (redactSensitiveText(normalized) !== normalized) return undefined;
  return kind === "product_name" || SAFE_IDENTIFIER.test(normalized) ? normalized : undefined;
}

function safeCoordinate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= 200 && SAFE_IDENTIFIER.test(normalized) &&
    redactSensitiveText(normalized) === normalized
    ? normalized
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
