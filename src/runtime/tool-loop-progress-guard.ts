import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ExecutionCheckpointReader } from "../contracts/execution-checkpoint.js";
import { isTerminalCheckpointStatus } from "../session/execution-checkpoint-state.js";
import { executionEvidenceStatus } from "./execution-evidence-index.js";
import { browserDiscoveryFingerprint } from "./browser-observation-guard.js";

const INELIGIBLE_TOOLS = new Set(["plan", "delegate_task"]);

export type ToolLoopProgressKind =
  | "new-tool-result"
  | "target-mutation"
  | "verification"
  | "checkpoint-semantic-progress"
  | "repeated-tool-call"
  | "no-tool-activity";

export type ToolLoopProgressAssessment = {
  active: boolean;
  materialProgress: boolean;
  progressKinds: ToolLoopProgressKind[];
  noProgressIterations: number;
  shouldNudge: boolean;
  shouldStop: boolean;
};

/**
 * Detects a stuck foreground tool loop without consulting provider-authored
 * plans. Call and result fingerprints stay in memory and are never emitted or
 * persisted. Browser-specific semantic repetition remains the responsibility
 * of BrowserObservationGuard.
 */
export class ToolLoopProgressGuard {
  readonly #nudgeIteration: number;
  readonly #stopIteration: number;
  readonly #seenCallFingerprints = new Set<string>();
  readonly #seenResultFingerprints = new Set<string>();
  readonly #seenDiscoveryFingerprints = new Set<string>();
  readonly #successfulConnectorMutations = new Map<string, number>();
  readonly #verifiedConnectorMutations = new Map<string, number>();
  #active = false;
  #nudged = false;
  #noProgressIterations = 0;
  readonly #checkpointReader: ExecutionCheckpointReader | undefined;
  #checkpointProgressRevision: number | undefined;

  constructor(input: {
    existingExecutions?: readonly ToolExecutionRecord[];
    noProgressNudgeIteration: number;
    maxNoProgressIterations: number;
    checkpointReader?: ExecutionCheckpointReader;
  }) {
    this.#stopIteration = normalizeStopIteration(input.maxNoProgressIterations);
    this.#nudgeIteration = normalizeNudgeIteration(
      input.noProgressNudgeIteration,
      this.#stopIteration
    );
    this.#checkpointReader = input.checkpointReader;
    this.#checkpointProgressRevision = activeCheckpointProgressRevision(input.checkpointReader);
    this.#seed(input.existingExecutions ?? []);
  }

  observe(executions: readonly ToolExecutionRecord[]): ToolLoopProgressAssessment {
    const eligible = executions.filter((execution) => !INELIGIBLE_TOOLS.has(execution.tool.name));
    if (eligible.length === 0 && !this.#active) {
      return assessment({
        active: false,
        progressKinds: [],
        noProgressIterations: 0,
        shouldNudge: false,
        shouldStop: false
      });
    }

    if (eligible.length > 0) this.#active = true;
    const progressKinds = new Set<ToolLoopProgressKind>();
    let materialProgress = false;
    const currentCheckpointRevision = activeCheckpointProgressRevision(this.#checkpointReader);
    const checkpointControlsProgress = currentCheckpointRevision !== undefined;
    const checkpointAdvanced =
      currentCheckpointRevision !== undefined &&
      currentCheckpointRevision > (this.#checkpointProgressRevision ?? 0);
    if (checkpointAdvanced) {
      materialProgress = true;
      progressKinds.add("checkpoint-semantic-progress");
    }
    this.#checkpointProgressRevision = currentCheckpointRevision;

    for (const execution of eligible) {
      const status = executionEvidenceStatus(execution);
      if (status !== "success" || execution.result?.metadata?.mcpReadReuse === true) continue;

      const callFingerprint = fingerprint({
        tool: execution.tool.name,
        input: execution.input,
        target: execution.targetKey ?? execution.targetSummary
      });
      const callIsNew = !this.#seenCallFingerprints.has(callFingerprint);
      this.#seenCallFingerprints.add(callFingerprint);
      const browserDiscovery = browserDiscoveryFingerprint(execution);
      const discovery = browserDiscovery ?? connectorDiscoveryFingerprint(execution);
      const discoveryIsNew = discovery !== undefined && !this.#seenDiscoveryFingerprints.has(discovery);
      if (discovery !== undefined) this.#seenDiscoveryFingerprints.add(discovery);

      // A snapshot can reveal newly expanded controls with exactly the same input.
      // Connector rereads, however, must not reset the counter through payload churn.
      if (!callIsNew && !(browserDiscovery !== undefined && discoveryIsNew)) {
        progressKinds.add("repeated-tool-call");
        continue;
      }

      const connectorMutation = successfulConnectorMutationKey(execution);
      if (connectorMutation !== undefined) increment(this.#successfulConnectorMutations, connectorMutation);
      const verifiedConnectorMutation = execution.executionEffect?.kind === "verification" &&
        execution.result?.metadata?._estacoda_verification_evidence !== false &&
        consumeConnectorMutationVerification(
          execution.executionEffect,
          this.#successfulConnectorMutations,
          this.#verifiedConnectorMutations
        );
      if (
        execution.executionEffect?.kind === "mutation" &&
        (!checkpointControlsProgress || (!checkpointAdvanced && connectorMutation !== undefined))
      ) {
        materialProgress = true;
        progressKinds.add("target-mutation");
        continue;
      }
      if (
        execution.executionEffect?.kind === "verification" &&
        execution.result?.metadata?._estacoda_verification_evidence !== false &&
        (
          !checkpointControlsProgress ||
          (!checkpointAdvanced && verifiedConnectorMutation)
        )
      ) {
        materialProgress = true;
        progressKinds.add("verification");
        continue;
      }

      if (checkpointControlsProgress && discoveryIsNew) {
        materialProgress = true;
        progressKinds.add("new-tool-result");
        continue;
      }

      const resultFingerprint = fingerprint({
        tool: execution.tool.name,
        ok: execution.result?.ok,
        content: execution.result?.content,
        structuredContent: execution.result?.metadata?.structuredContent
      });
      const resultIsNew = !this.#seenResultFingerprints.has(resultFingerprint);
      this.#seenResultFingerprints.add(resultFingerprint);
      if (!resultIsNew) {
        progressKinds.add("repeated-tool-call");
        continue;
      }
      if (!checkpointControlsProgress) {
        materialProgress = true;
        progressKinds.add("new-tool-result");
      }
    }

    if (!materialProgress && progressKinds.size === 0) {
      progressKinds.add(eligible.length === 0 ? "no-tool-activity" : "repeated-tool-call");
    }

    this.#noProgressIterations = materialProgress ? 0 : this.#noProgressIterations + 1;
    const shouldNudge = !this.#nudged && this.#noProgressIterations >= this.#nudgeIteration;
    if (shouldNudge) this.#nudged = true;

    return assessment({
      active: this.#active,
      progressKinds,
      noProgressIterations: this.#noProgressIterations,
      shouldNudge,
      shouldStop: this.#noProgressIterations >= this.#stopIteration
    });
  }

  #seed(executions: readonly ToolExecutionRecord[]): void {
    for (const execution of executions) {
      if (
        INELIGIBLE_TOOLS.has(execution.tool.name) ||
        executionEvidenceStatus(execution) !== "success" ||
        execution.result?.metadata?.mcpReadReuse === true
      ) continue;
      this.#active = true;
      const discovery = browserDiscoveryFingerprint(execution) ?? connectorDiscoveryFingerprint(execution);
      if (discovery !== undefined) this.#seenDiscoveryFingerprints.add(discovery);
      this.#seenCallFingerprints.add(fingerprint({
        tool: execution.tool.name,
        input: execution.input,
        target: execution.targetKey ?? execution.targetSummary
      }));
      this.#seenResultFingerprints.add(fingerprint({
        tool: execution.tool.name,
        ok: execution.result?.ok,
        content: execution.result?.content,
        structuredContent: execution.result?.metadata?.structuredContent
      }));
      const connectorMutation = successfulConnectorMutationKey(execution);
      if (connectorMutation !== undefined) increment(this.#successfulConnectorMutations, connectorMutation);
      if (execution.executionEffect?.kind === "verification" && execution.result?.metadata?._estacoda_verification_evidence !== false) {
        consumeConnectorMutationVerification(
          execution.executionEffect,
          this.#successfulConnectorMutations,
          this.#verifiedConnectorMutations
        );
      }
    }
  }
}

function connectorDiscoveryFingerprint(execution: ToolExecutionRecord): string | undefined {
  const effect = execution.executionEffect;
  if ((effect?.kind !== "read" && effect?.kind !== "verification") || effect.connector?.kind !== "mcp" ||
      execution.riskClass !== "read-only-network" || execution.result?.metadata?.mcpReadReuse === true) return undefined;
  let evidence: unknown = execution.result?.metadata?.structuredContent;
  if (evidence === undefined) {
    const content = execution.result?.content.trim();
    if (!content) return undefined;
    try { evidence = JSON.parse(content); } catch { evidence = content; }
  }
  // Discovery is not verification authority. Markdown and JSON reads both matter;
  // transport metadata, tool-call IDs and explicit clocks do not create new evidence.
  return fingerprint({ connector: effect.connector, evidence }, true);
}

function successfulConnectorMutationKey(execution: ToolExecutionRecord): string | undefined {
  const effect = execution.executionEffect;
  if (effect?.kind !== "mutation" || effect.connector === undefined) return undefined;
  return connectorMutationKey(effect.connector.kind, effect.connector.id, execution.tool.name);
}

function consumeConnectorMutationVerification(
  effect: Extract<NonNullable<ToolExecutionRecord["executionEffect"]>, { kind: "verification" }>,
  successfulMutations: ReadonlyMap<string, number>,
  verifiedMutations: Map<string, number>
): boolean {
  const connector = effect.connector;
  if (connector === undefined) return false;
  for (const tool of effect.verifies) {
    const key = connectorMutationKey(connector.kind, connector.id, tool);
    if ((successfulMutations.get(key) ?? 0) <= (verifiedMutations.get(key) ?? 0)) continue;
    increment(verifiedMutations, key);
    return true;
  }
  return false;
}

function connectorMutationKey(kind: string, id: string, tool: string): string {
  return `${kind}\0${id}\0${tool}`;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function assessment(input: {
  active: boolean;
  progressKinds: Set<ToolLoopProgressKind> | ToolLoopProgressKind[];
  noProgressIterations: number;
  shouldNudge: boolean;
  shouldStop: boolean;
}): ToolLoopProgressAssessment {
  const progressKinds = [...input.progressKinds];
  return {
    active: input.active,
    materialProgress: progressKinds.some((kind) =>
      kind === "new-tool-result" || kind === "target-mutation" || kind === "verification" ||
      kind === "checkpoint-semantic-progress"
    ),
    progressKinds,
    noProgressIterations: input.noProgressIterations,
    shouldNudge: input.shouldNudge,
    shouldStop: input.shouldStop
  };
}

function activeCheckpointProgressRevision(reader: ExecutionCheckpointReader | undefined): number | undefined {
  const checkpoint = reader?.current();
  return checkpoint === undefined || isTerminalCheckpointStatus(checkpoint.status)
    ? undefined
    : checkpoint.progressRevision;
}

function normalizeStopIteration(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 6;
}

function normalizeNudgeIteration(value: number, stopIteration: number): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3;
  return Math.min(normalized, stopIteration);
}

function fingerprint(value: unknown, ignoreClocks = false): string {
  return createHash("sha256").update(stableStringify(value, ignoreClocks)).digest("hex");
}

function stableStringify(value: unknown, ignoreClocks = false): string {
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (entry: unknown, depth: number): string => {
    if (visited >= 256 || depth > 6) return JSON.stringify("[TRUNCATED]");
    visited += 1;
    if (typeof entry === "string") {
      const bounded = [...entry].slice(0, 2_000).join("");
      return JSON.stringify(ignoreClocks
        ? bounded.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "[timestamp]")
        : bounded);
    }
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry) ?? "undefined";
    if (seen.has(entry)) return JSON.stringify("[CIRCULAR]");
    seen.add(entry);
    if (Array.isArray(entry)) return `[${entry.slice(0, 64).map((item) => visit(item, depth + 1)).join(",")}]`;
    return `{${Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, item]) => `${JSON.stringify(key)}:${visit(item, depth + 1)}`)
      .join(",")}}`;
  };
  return visit(value, 0);
}
