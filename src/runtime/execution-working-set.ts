import { parsePollingCoordinates } from "../contracts/execution-checkpoint.js";
import { createHash } from "node:crypto";
import type { ToolRiskClass } from "../contracts/tool.js";
import type {
  ExecutionCheckpointAuthenticationStage,
  ExecutionCheckpointReader
} from "../contracts/execution-checkpoint.js";
import { isTerminalCheckpointStatus } from "../session/execution-checkpoint-state.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  ExecutionOperationLedger,
  type ExecutionOperationReceipt
} from "../tools/execution-operation-ledger.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { executionEvidenceStatus } from "./execution-evidence-index.js";

const MAX_FACTS = 24;
const MAX_FACT_SUMMARY_CHARS = 320;
const MAX_STRUCTURED_NODES = 128;
const MAX_STRUCTURED_DEPTH = 5;
const MAX_SCALAR_CHARS = 160;
const MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);
const MUTATION_TOOL_VERBS = new Set([
  "add", "create", "delete", "edit", "patch", "post", "put", "remove", "set", "type", "update", "write"
]);
const READ_TOOL_VERBS = new Set([
  "check", "fetch", "get", "inspect", "list", "query", "read", "retrieve", "search", "snapshot", "tabs"
]);
const INELIGIBLE_TOOLS = new Set(["plan", "delegate_task"]);
const INELIGIBLE_IDENTIFIER_FIELDS = new Set(["callid", "profileid", "sessionid", "toolcallid", "turnid"]);
const SENSITIVE_FIELD = /(?:api.?key|auth|authorization|cookie|credential|otp|pass(?:word|code)?|secret|token)/iu;
const IDENTIFIER_FIELD = /(?:^id$|id$|ids$|identifier$|uid$|uuid$)/iu;
const CONNECTOR_TARGET_REFERENCE_FIELD = /^(?:collection|environment|organization|project|repository|spec|team|workspace)$/iu;
const LABEL_FIELD = /(?:^name$|displayname$|label$|title$)/iu;
const COUNT_FIELD = /(?:^count$|count$|total$)/iu;

export type ExecutionWorkingFact = {
  key: string;
  summary: string;
  sourceCallId: string;
  targetKey?: string;
  observedAt: string;
  freshness: "current-turn" | "historical";
};

export type ExecutionWorkingSet = {
  visibleTurnId: string;
  scope?: "visible-turn" | "checkpoint";
  authenticationRecoveryStage?: ExecutionCheckpointAuthenticationStage;
  facts: ExecutionWorkingFact[];
  operations: ExecutionOperationReceipt[];
  resources?: import("../contracts/execution-checkpoint.js").ExecutionCheckpointResource[];
};

type StoredFact = {
  fact: ExecutionWorkingFact;
  namespace: string;
  identities: Set<string>;
};

export class ExecutionWorkingSetController {
  readonly #profileId: string;
  readonly #now: () => Date;
  readonly #facts = new Map<string, StoredFact>();
  readonly #operations = new ExecutionOperationLedger();
  readonly #checkpointReader: ExecutionCheckpointReader | undefined;
  #sessionId: string;
  #visibleTurnId: string | undefined;

  constructor(input: {
    profileId: string;
    sessionId: string;
    now?: () => Date;
    checkpointReader?: ExecutionCheckpointReader;
  }) {
    this.#profileId = input.profileId;
    this.#sessionId = input.sessionId;
    this.#now = input.now ?? (() => new Date());
    this.#checkpointReader = input.checkpointReader;
  }

  beginTurn(visibleTurnId: string, sessionId = this.#sessionId): void {
    this.#syncScope(visibleTurnId, sessionId);
    for (const stored of this.#facts.values()) {
      stored.fact.freshness = "historical";
    }
  }

  observe(
    executions: readonly ToolExecutionRecord[],
    visibleTurnId: string,
    sessionId = this.#sessionId
  ): void {
    this.#syncScope(visibleTurnId, sessionId);
    for (const execution of executions) {
      this.#operations.observe(execution);
      if (executionEvidenceStatus(execution) !== "success" || INELIGIBLE_TOOLS.has(execution.tool.name)) {
        continue;
      }
      const namespace = toolNamespace(execution.tool.name);
      const identities = executionIdentities(execution);
      const mutation = isMutationExecution(execution);
      if (mutation) {
        this.#invalidate(namespace, identities);
        if (!execution.tool.toolsets.includes("mcp")) continue;
      }
      const sourceCallId = safeSourceCallId(execution.toolCallId);
      if (sourceCallId === undefined) continue;
      for (const candidate of factCandidates(execution, namespace)) {
        this.#upsert({
          key: candidate.key,
          summary: candidate.summary,
          sourceCallId,
          targetKey: candidate.targetKey,
          namespace,
          identities: candidate.identities
        });
      }
    }
  }

  snapshot(visibleTurnId: string, sessionId = this.#sessionId): ExecutionWorkingSet | undefined {
    this.#syncScope(visibleTurnId, sessionId);
    const candidateCheckpoint = this.#checkpointReader?.current();
    const checkpoint = candidateCheckpoint !== undefined && !isTerminalCheckpointStatus(candidateCheckpoint.status)
      ? candidateCheckpoint
      : undefined;
    // Checkpoint locators are historical receipts, not cached current state.
    // Merge them on every provider iteration so unrelated writes and live-fact
    // eviction cannot hide them until the next user turn.
    const facts = [...this.#facts.values()].map(({ fact }) => ({ ...fact }));
    const summaries = new Set(facts.map((fact) => fact.summary));
    for (const fact of checkpoint?.safeFacts ?? []) {
      const summary = `${fact.kind !== "polling_coordinates" || fact.connectorId === undefined ? "" : `${fact.connectorId}: `}${checkpointFactSummary(fact.kind, fact.value)}`;
      if (summaries.has(summary)) continue;
      summaries.add(summary);
      facts.push({
        key: `checkpoint:${fact.kind}:${fact.value}`,
        summary,
        sourceCallId: `checkpoint:${checkpoint!.id}`,
        observedAt: fact.observedAt,
        freshness: "historical"
      });
    }
    const durableOperations: ExecutionOperationReceipt[] = (checkpoint?.operations ?? []).map((operation) => ({
      operationId: operation.id,
      mutationTool: operation.operation,
      mutationCallId: operation.id,
      status: operation.status,
      targetSummary: checkpointOperationSummary(operation)
    }));
    const operations = [...new Map([
      ...this.#operations.snapshot(),
      ...durableOperations
    ].map((operation) => [operation.operationId, operation])).values()];
    if (facts.length === 0 && operations.length === 0 && (checkpoint?.resources?.length ?? 0) === 0 && checkpoint?.authenticationRecoveryStage === undefined) {
      return undefined;
    }
    return {
      visibleTurnId,
      scope: checkpoint === undefined ? "visible-turn" : "checkpoint",
      ...(checkpoint?.authenticationRecoveryStage === undefined
        ? {}
        : { authenticationRecoveryStage: checkpoint.authenticationRecoveryStage }),
      facts,
      operations,
      ...(checkpoint?.resources === undefined ? {} : { resources: structuredClone(checkpoint.resources) })
    };
  }

  clear(): void {
    this.#facts.clear();
    this.#operations.reset();
    this.#visibleTurnId = undefined;
  }

  #syncScope(visibleTurnId: string, sessionId: string): void {
    const normalizedTurnId = visibleTurnId.trim();
    if (normalizedTurnId.length === 0) {
      throw new Error("Execution working-set turn ID must be non-empty.");
    }
    if (sessionId !== this.#sessionId) {
      this.clear();
      this.#sessionId = sessionId;
    }
    const scopedTurnId = `${this.#profileId}:${this.#sessionId}:${normalizedTurnId}`;
    if (this.#visibleTurnId !== undefined && this.#visibleTurnId !== scopedTurnId) {
      this.clear();
    }
    this.#visibleTurnId = scopedTurnId;
  }

  #invalidate(namespace: string, identities: Set<string>): void {
    for (const [key, stored] of this.#facts) {
      if (stored.namespace !== namespace) continue;
      if (
        identities.size === 0 ||
        stored.identities.size === 0 ||
        intersects(identities, stored.identities)
      ) {
        this.#facts.delete(key);
      }
    }
  }

  #upsert(input: {
    key: string;
    summary: string;
    sourceCallId: string;
    targetKey?: string;
    namespace: string;
    identities: Set<string>;
  }): void {
    const safeSummary = safeFactSummary(input.summary);
    if (safeSummary === undefined) return;
    const targetKey = safeTargetKey(input.targetKey);
    const fact: ExecutionWorkingFact = {
      key: input.key,
      summary: safeSummary,
      sourceCallId: input.sourceCallId,
      ...(targetKey === undefined ? {} : { targetKey }),
      observedAt: this.#now().toISOString(),
      freshness: "current-turn"
    };
    this.#facts.delete(input.key);
    this.#facts.set(input.key, {
      fact,
      namespace: input.namespace,
      identities: new Set(input.identities)
    });
    while (this.#facts.size > MAX_FACTS) {
      const oldest = this.#facts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#facts.delete(oldest);
    }
  }
}

type FactCandidate = {
  key: string;
  summary: string;
  targetKey?: string;
  identities: Set<string>;
};

function factCandidates(
  execution: ToolExecutionRecord,
  namespace: string
): FactCandidate[] {
  const candidates: FactCandidate[] = [];
  const isMcpExecution = execution.tool.toolsets.includes("mcp");
  const inputScalars = collectSafeScalars(execution.input, isMcpExecution)
    .filter((entry) => entry.kind === "identifier");
  const structuredScalars = isMcpExecution
    ? collectReviewedContinuityScalars(execution.result?.metadata?._estacoda_continuity_facts)
    : collectSafeScalars(execution.result?.metadata?.structuredContent);
  const allScalars = [...inputScalars, ...structuredScalars];
  const identities = new Set(
    allScalars
      .filter((entry) => entry.kind === "identifier")
      .map((entry) => normalizeIdentity(entry.value))
  );
  for (const scalar of allScalars) {
    const summary = `${humanizeField(scalar.field)}: ${scalar.value}`;
    const identity = scalar.kind === "identifier" ? normalizeIdentity(scalar.value) : undefined;
    const targetKey = identity === undefined ? execution.targetKey : `${namespace}:${scalar.field}:${identity}`;
    candidates.push({
      key: factKey(namespace, scalar.field, scalar.value),
      summary,
      ...(targetKey === undefined ? {} : { targetKey }),
      identities: identity === undefined ? new Set(identities) : new Set([identity])
    });
  }

  const contextSummary = isMcpExecution
    ? undefined
    : execution.result?.metadata?._estacoda_context_summary;
  if (typeof contextSummary === "string" && contextSummary.trim().length > 0) {
    candidates.push({
      key: factKey(namespace, "context", contextSummary),
      summary: contextSummary,
      ...(execution.targetKey === undefined ? {} : { targetKey: execution.targetKey }),
      identities: new Set(identities)
    });
  } else if (!isMcpExecution && execution.targetSummary !== undefined && execution.targetSummary.trim().length > 0) {
    candidates.push({
      key: factKey(namespace, "target", execution.targetSummary),
      summary: `${execution.tool.name}: ${execution.targetSummary}`,
      ...(execution.targetKey === undefined ? {} : { targetKey: execution.targetKey }),
      identities: new Set(identities)
    });
  }
  return dedupeCandidates(candidates);
}

function collectReviewedContinuityScalars(value: unknown): SafeScalar[] {
  if (!Array.isArray(value)) return [];
  const output: SafeScalar[] = [];
  for (const entry of value.slice(0, MAX_FACTS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.field !== "string" || SENSITIVE_FIELD.test(record.field)) continue;
    const kind = reviewedContinuityKind(record.field);
    if (kind === undefined || record.kind !== kind) continue;
    const scalar = safeReviewedContinuityValue(record.value);
    if (scalar !== undefined) output.push({ field: record.field, value: scalar, kind });
  }
  return output;
}

function reviewedContinuityKind(field: string): "identifier" | "label" | undefined {
  const normalized = field.replace(/[_-]+/gu, "").toLocaleLowerCase();
  if (normalized === "pollingcoordinates") return "identifier";
  if (INELIGIBLE_IDENTIFIER_FIELDS.has(normalized)) return undefined;
  if (/(?:^id$|id$|identifier$|uid$|uuid$|hash$|sha256$|ref$|reference$)/u.test(normalized)) return "identifier";
  if (/(?:^name$|name$|label$|title$)/u.test(normalized)) return "label";
  return undefined;
}

function safeReviewedContinuityValue(value: unknown): string | undefined {
  const scalar = safeScalarValue(value);
  if (scalar === undefined) return undefined;
  const original = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : undefined;
  return original === scalar ? scalar : undefined;
}

type SafeScalar = {
  field: string;
  value: string;
  kind: "identifier" | "label" | "count";
};

function collectSafeScalars(input: unknown, includeConnectorTargetReferences = false): SafeScalar[] {
  const output: SafeScalar[] = [];
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_STRUCTURED_DEPTH || visited >= MAX_STRUCTURED_NODES || value === null) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD.test(field)) continue;
      const kind = scalarKind(field, includeConnectorTargetReferences);
      if (kind !== undefined) {
        const scalar = safeScalarValue(entry);
        if (scalar !== undefined) output.push({ field, value: scalar, kind });
      }
      if (typeof entry === "object") visit(entry, depth + 1);
    }
  };
  visit(input, 0);
  return output;
}

function executionIdentities(execution: ToolExecutionRecord): Set<string> {
  return new Set(collectSafeScalars(execution.input, execution.tool.toolsets.includes("mcp"))
    .filter((entry) => entry.kind === "identifier")
    .map((entry) => normalizeIdentity(entry.value)));
}

function isMutationExecution(execution: ToolExecutionRecord): boolean {
  if (execution.executionEffect?.kind === "mutation") return true;
  if (
    execution.executionEffect?.kind === "read" ||
    execution.executionEffect?.kind === "verification"
  ) return false;
  if (toolHasVerb(execution.tool.name, MUTATION_TOOL_VERBS)) return true;
  if (toolHasVerb(execution.tool.name, READ_TOOL_VERBS)) return false;
  return MUTATION_RISK_CLASSES.has(execution.riskClass);
}

function toolHasVerb(toolName: string, verbs: ReadonlySet<string>): boolean {
  return toolName
    .split(/(?=[\p{Lu}])|[._-]+/u)
    .some((part) => verbs.has(part.toLocaleLowerCase()));
}

function scalarKind(
  field: string,
  includeConnectorTargetReferences = false
): SafeScalar["kind"] | undefined {
  if (INELIGIBLE_IDENTIFIER_FIELDS.has(field.replace(/[_-]+/gu, "").toLocaleLowerCase())) return undefined;
  if (IDENTIFIER_FIELD.test(field)) return "identifier";
  if (includeConnectorTargetReferences && CONNECTOR_TARGET_REFERENCE_FIELD.test(field)) return "identifier";
  if (LABEL_FIELD.test(field)) return "label";
  if (COUNT_FIELD.test(field)) return "count";
  return undefined;
}

function safeScalarValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_SCALAR_CHARS) return undefined;
  const redacted = redactSensitiveText(normalized).trim();
  if (redacted.length === 0 || redacted === "[REDACTED]") return undefined;
  return redacted;
}

function safeFactSummary(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  const redacted = redactSensitiveText(normalized).trim();
  if (redacted.length === 0 || redacted === "[REDACTED]") return undefined;
  return [...redacted].slice(0, MAX_FACT_SUMMARY_CHARS).join("");
}

function safeSourceCallId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized === "[REDACTED]") return undefined;
  return [...normalized].slice(0, 128).join("");
}

function safeTargetKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized === "[REDACTED]") return undefined;
  return [...normalized].slice(0, 240).join("");
}

function dedupeCandidates(input: readonly FactCandidate[]): FactCandidate[] {
  return [...new Map(input.map((candidate) => [candidate.key, candidate])).values()];
}

function factKey(namespace: string, field: string, value: string): string {
  return createHash("sha256").update(`${namespace}\0${field}\0${value}`).digest("hex").slice(0, 24);
}

function toolNamespace(toolName: string): string {
  const segments = toolName.split(".");
  return segments[0] === "mcp" && segments.length >= 2
    ? segments.slice(0, 2).join(".")
    : segments[0] ?? toolName;
}

function humanizeField(field: string): string {
  const words = field
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim();
  return words.replace(/\bid\b/giu, "ID").replace(/^./u, (character) => character.toLocaleUpperCase());
}

function checkpointFactSummary(kind: import("../contracts/execution-checkpoint.js").ExecutionCheckpointSafeFactKind, value: string): string {
  if (kind === "polling_coordinates") return `Task status arguments: ${JSON.stringify(parsePollingCoordinates(value))}`;
  const label: Record<Exclude<typeof kind, "polling_coordinates">, string> = {
    environment_id: "Environment ID",
    resource_id: "Resource ID",
    workspace_id: "Workspace ID",
    collection_id: "Collection ID",
    specification_id: "Specification ID",
    task_id: "Remote Task ID",
    product_name: "Product Name",
    artifact_id: "Artifact ID",
    artifact_hash: "Artifact Hash"
  };
  return `${label[kind]}: ${value}`;
}

function checkpointOperationSummary(
  operation: import("../contracts/execution-checkpoint.js").ExecutionCheckpointOperation
): string {
  return [
    `connector=${operation.connectorId}`,
    operation.destinationId === undefined ? undefined : `destination=${operation.destinationId}`,
    operation.subjectId === undefined ? undefined : `subject=${operation.subjectId}`,
    operation.artifactHash === undefined ? undefined : `artifact=${operation.artifactHash}`,
    `revision=${operation.operationRevision}`
  ].filter((value): value is string => value !== undefined).join(" · ");
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((entry) => right.has(entry));
}
