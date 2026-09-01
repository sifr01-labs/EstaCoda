import { createHash } from "node:crypto";
import type { ToolExecutionEffect } from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { ToolExecutionRecord } from "./tool-executor.js";

const MAX_OPERATIONS = 32;

export type ExecutionOperationStatus = "verification-required" | "verified";

export type ExecutionOperationReceipt = {
  operationId: string;
  mutationTool: string;
  mutationCallId: string;
  status: ExecutionOperationStatus;
  targetSummary?: string;
  verificationTool?: string;
  verificationCallId?: string;
};

type StoredOperation = ExecutionOperationReceipt & {
  semanticKey: string;
  targetKey?: string;
  connector?: ToolExecutionEffect["connector"];
  identities: Set<string>;
};

/**
 * Runtime-owned, per-turn semantic mutation state.
 *
 * Successful mutations stay pending until a separately registered verifier
 * succeeds. Once verified, equivalent observations cannot regress the receipt.
 */
export class ExecutionOperationLedger {
  readonly #operations = new Map<string, StoredOperation>();
  #scope: string | undefined;

  reset(): void {
    this.#operations.clear();
    this.#scope = undefined;
  }

  admission(input: {
    tool: string;
    value: Record<string, unknown>;
    scope?: string;
  }): ExecutionOperationReceipt | undefined {
    this.#syncScope(input.scope);
    const operation = this.#operations.get(semanticMutationKey(input.tool, input.value));
    return operation === undefined ? undefined : publicReceipt(operation);
  }

  observe(execution: ToolExecutionRecord, scope?: string): void {
    this.#syncScope(scope);
    if (execution.decision !== "allow" || execution.result?.ok !== true) return;
    const effect = execution.executionEffect;
    if (effect?.kind === "mutation") {
      if (effect.connector === undefined) return;
      this.#observeMutation(execution, effect);
      return;
    }
    if (effect?.kind === "verification" && effect.connector !== undefined) {
      this.#observeVerification(execution, effect);
    }
  }

  snapshot(): ExecutionOperationReceipt[] {
    return [...this.#operations.values()].map(publicReceipt);
  }

  #syncScope(scope: string | undefined): void {
    if (scope === undefined) return;
    const normalized = scope.trim();
    if (normalized.length === 0) return;
    if (this.#scope !== undefined && this.#scope !== normalized) {
      this.#operations.clear();
    }
    this.#scope = normalized;
  }

  #observeMutation(
    execution: ToolExecutionRecord,
    effect: Extract<ToolExecutionEffect, { kind: "mutation" }>
  ): void {
    if (execution.input === undefined) return;
    const semanticKey = semanticMutationKey(execution.tool.name, execution.input);
    const existing = this.#operations.get(semanticKey);
    if (existing?.status === "verified") return;
    const mutationCallId = safeCallId(execution.toolCallId, semanticKey);
    const targetSummary = safeOptionalText(execution.targetSummary, 240);
    const targetKey = safeOptionalText(execution.targetKey, 512);
    const operation: StoredOperation = {
      operationId: semanticKey.slice(0, 24),
      semanticKey,
      mutationTool: execution.tool.name,
      mutationCallId,
      status: "verification-required",
      identities: executionIdentities(execution),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(targetKey === undefined ? {} : { targetKey }),
      ...(effect.connector === undefined ? {} : { connector: { ...effect.connector } })
    };
    this.#operations.delete(semanticKey);
    this.#operations.set(semanticKey, operation);
    while (this.#operations.size > MAX_OPERATIONS) {
      const oldest = this.#operations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#operations.delete(oldest);
    }
  }

  #observeVerification(
    execution: ToolExecutionRecord,
    effect: Extract<ToolExecutionEffect, { kind: "verification" }>
  ): void {
    const verifierTargetKey = safeOptionalText(execution.targetKey, 512);
    const verifierIdentities = executionIdentities(execution);
    const candidates = [...this.#operations.values()].reverse();
    let operation: StoredOperation | undefined;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (
        candidate.status !== "verification-required" ||
        !effect.verifies.includes(candidate.mutationTool) ||
        !connectorsCompatible(effect.connector, candidate.connector)
      ) continue;
      const score = targetCompatibilityScore(
        verifierTargetKey,
        candidate.targetKey,
        verifierIdentities,
        candidate.identities
      );
      if (score > bestScore) {
        operation = candidate;
        bestScore = score;
      }
    }
    if (operation === undefined) return;
    operation.status = "verified";
    operation.verificationTool = execution.tool.name;
    operation.verificationCallId = safeCallId(execution.toolCallId, operation.semanticKey);
  }
}

export function semanticMutationKey(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(stableExecutionValue({ tool, input })).digest("hex");
}

function publicReceipt(operation: StoredOperation): ExecutionOperationReceipt {
  return {
    operationId: operation.operationId,
    mutationTool: operation.mutationTool,
    mutationCallId: operation.mutationCallId,
    status: operation.status,
    ...(operation.targetSummary === undefined ? {} : { targetSummary: operation.targetSummary }),
    ...(operation.verificationTool === undefined ? {} : { verificationTool: operation.verificationTool }),
    ...(operation.verificationCallId === undefined ? {} : { verificationCallId: operation.verificationCallId })
  };
}

function connectorsCompatible(
  verifier: ToolExecutionEffect["connector"],
  mutation: ToolExecutionEffect["connector"]
): boolean {
  if (verifier === undefined || mutation === undefined) return true;
  return verifier.kind === mutation.kind && verifier.id === mutation.id;
}

function targetCompatibilityScore(
  verifier: string | undefined,
  mutation: string | undefined,
  verifierIdentities: ReadonlySet<string>,
  mutationIdentities: ReadonlySet<string>
): number {
  if (verifier !== undefined && mutation !== undefined && verifier === mutation) return 1_000;
  const identityMatches = [...verifierIdentities]
    .filter((identity) => mutationIdentities.has(identity))
    .length;
  if (identityMatches > 0) return identityMatches;
  return verifier !== undefined && mutation !== undefined ? -1 : 0;
}

function executionIdentities(execution: ToolExecutionRecord): Set<string> {
  const identities = new Set<string>();
  collectInputIdentities(execution.input, identities);
  const continuity = execution.result?.metadata?._estacoda_continuity_facts;
  if (Array.isArray(continuity)) {
    for (const entry of continuity.slice(0, 32)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.kind !== "identifier" || typeof record.field !== "string") continue;
      if (!identifierField(record.field) || sensitiveField(record.field)) continue;
      addIdentity(record.field, record.value, identities);
    }
  }
  return identities;
}

function collectInputIdentities(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 5 || value === null || output.size >= 32) return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) collectInputIdentities(entry, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [field, entry] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (sensitiveField(field)) continue;
    if (identifierField(field)) addIdentity(field, entry, output);
    if (typeof entry === "object") collectInputIdentities(entry, output, depth + 1);
  }
}

function identifierField(field: string): boolean {
  const normalized = field.replace(/[_-]+/gu, "").toLocaleLowerCase();
  if (["callid", "profileid", "sessionid", "toolcallid", "turnid"].includes(normalized)) return false;
  return /(?:^id$|id$|identifier$|uid$|uuid$|hash$|sha256$|ref$|reference$)/u.test(normalized) ||
    /^(?:collection|environment|organization|project|repository|spec|team|workspace)$/u.test(normalized);
}

function sensitiveField(field: string): boolean {
  return /(?:api.?key|auth|authorization|cookie|credential|otp|pass(?:word|code)?|secret|token)/iu.test(field);
}

function addIdentity(field: string, value: unknown, output: Set<string>): void {
  if ((typeof value !== "string" && typeof value !== "number") || output.size >= 32) return;
  const normalized = redactSensitiveText(String(value)).replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  if (normalized.length > 0 && normalized !== "[redacted]" && normalized.length <= 160) {
    output.add(`${field.replace(/[_-]+/gu, "").toLocaleLowerCase()}:${normalized}`);
  }
}

function safeCallId(value: string | undefined, semanticKey: string): string {
  return safeOptionalText(value, 128) ?? `runtime-${semanticKey.slice(0, 16)}`;
}

function safeOptionalText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && normalized !== "[REDACTED]" && normalized.length <= maxChars
    ? normalized
    : undefined;
}

function stableExecutionValue(value: unknown): string {
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (entry: unknown, depth: number): string => {
    if (visited >= 256 || depth > 6) return JSON.stringify("[TRUNCATED]");
    visited += 1;
    if (typeof entry === "string") return JSON.stringify([...entry].slice(0, 2_000).join(""));
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry) ?? "undefined";
    if (seen.has(entry)) return JSON.stringify("[CIRCULAR]");
    seen.add(entry);
    if (Array.isArray(entry)) {
      return `[${entry.slice(0, 64).map((item) => visit(item, depth + 1)).join(",")}]`;
    }
    return `{${Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, item]) => `${JSON.stringify(key)}:${visit(item, depth + 1)}`)
      .join(",")}}`;
  };
  return visit(value, 0);
}
