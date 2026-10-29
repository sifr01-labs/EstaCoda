import { settledLocalCommandExit } from "./local-command-result.js";
import { commandFileChanges, commandFileObservation } from "./file-output-evidence.js";
import { toolResultFingerprint } from "./tool-result-fingerprint.js";
import { matchesFileOutputPath, requestedFileOutputs } from "../contracts/request-requirements.js";
import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ExecutionCheckpointReader } from "../contracts/execution-checkpoint.js";
import { isTerminalCheckpointStatus } from "../session/execution-checkpoint-state.js";
import { executionEvidenceStatus } from "./execution-evidence-index.js";
import { browserDiscoveryFingerprint } from "./browser-observation-guard.js";

const INELIGIBLE_TOOLS = new Set(["plan"]);

export type ToolLoopProgressKind =
  | "new-tool-result"
  | "target-mutation"
  | "verification"
  | "checkpoint-semantic-progress"
  | "managed-process-wait"
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
  readonly #research: boolean;
  readonly #seenResearchSources = new Set<string>();
  readonly #seenFileObservations = new Set<string>();
  readonly #seenFileWrites = new Set<string>();
  readonly #pendingCommandReadbacks = new Set<string>();
  readonly #seenFileReadbacks = new Set<string>();
  readonly #pendingFileReadbacks = new Set<string>();
  readonly #seenRecoveryIds = new Set<string>();
  readonly #resultReadEnds = new Map<string, number>();
  readonly #seenCallFingerprints = new Set<string>();
  readonly #seenResultFingerprints = new Set<string>();
  readonly #seenCommandObservations = new Set<string>();
  readonly #seenDiscoveryFingerprints = new Set<string>();
  readonly #seenProcessExits = new Set<string>();
  readonly #seenWaitCalls = new Set<string>();
  readonly #successfulConnectorMutations = new Map<string, number>();
  readonly #verifiedConnectorMutations = new Map<string, number>();
  #active = false;
  #nudged = false;
  #noProgressIterations = 0;
  readonly #checkpointReader: ExecutionCheckpointReader | undefined;
  #checkpointProgressRevision: number | undefined;

  constructor(input: {
    research?: boolean;
    existingExecutions?: readonly ToolExecutionRecord[];
    noProgressNudgeIteration: number;
    maxNoProgressIterations: number;
    checkpointReader?: ExecutionCheckpointReader;
  }) {
    this.#research = input.research === true;
    this.#stopIteration = normalizeStopIteration(input.maxNoProgressIterations);
    this.#nudgeIteration = normalizeNudgeIteration(
      input.noProgressNudgeIteration,
      this.#stopIteration
    );
    this.#checkpointReader = input.checkpointReader;
    this.#checkpointProgressRevision = activeCheckpointProgressRevision(input.checkpointReader);
    this.#seed(input.existingExecutions ?? []);
  }

  observe(executions: readonly ToolExecutionRecord[], unchangedCompletionRepair = false): ToolLoopProgressAssessment {
    const eligible = executions.filter((execution) => !INELIGIBLE_TOOLS.has(execution.tool.name));
    // A submitted correction is judged by the completion validator, whose own
    // repair bound applies. Do not stop a valid final answer on an empty tool batch.
    if (eligible.length === 0 && unchangedCompletionRepair) return assessment({
      active: this.#active, progressKinds: [], noProgressIterations: this.#noProgressIterations,
      shouldNudge: false, shouldStop: false
    });
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
    let waitingForProcess = false;
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
      if (status === "success" && execution.readReuseOf === undefined && execution.result?.metadata?.mcpReadReuse !== true) {
        const turn = this.#checkpointReader?.current()?.originTurnId;
        const observation = commandFileObservation(execution, turn);
        if (observation?.completed && !observation.serviceCheckpoint && !this.#seenFileObservations.has(observation.id)) {
          this.#seenFileObservations.add(observation.id);
          for (const output of commandFileChanges(execution, turn)) {
            if (output.contentSha256) this.#pendingFileReadbacks.add(fingerprint({ path: output.path, contentSha256: output.contentSha256 }));
            else if (output.metadataFingerprint) this.#pendingCommandReadbacks.add(output.path);
            else this.#pendingCommandReadbacks.delete(output.path);
          }
        }
      }
      if (execution.readReuseOf !== undefined || execution.result?.metadata?.mcpReadReuse === true) continue;
      // Failed diagnostics and changed results from the same command are useful
      // observations, not completion evidence. Admission failures and unfinished
      // commands cannot earn progress; deadlines still bound novel diagnostics.
      const commandObservation = commandObservationFingerprint(execution);
      if (commandObservation !== undefined) {
        const novel = !this.#seenCommandObservations.has(commandObservation);
        this.#seenCommandObservations.add(commandObservation);
        if (novel && !unchangedCompletionRepair) {
          materialProgress = true;
          progressKinds.add("new-tool-result");
        } else progressKinds.add("repeated-tool-call");
        continue;
      }
      if (status !== "success") continue;
      // Host-owned, bounded waits are not stuck model polling. Preserve the
      // counter rather than pretending time elapsed is deliverable progress.
      // Deadlines, provider budgets and cancellation still bound the execution.
      if (execution.tool.name === "process.logs") {
        const metadata = execution.result?.metadata;
        const process = metadata?.process as { id?: string; status?: string } | undefined;
        if (typeof process?.id === "string" && process.id === execution.input?.id) {
          if (process.status === "running" && !unchangedCompletionRepair &&
            typeof metadata?.waitedMs === "number" && Number.isFinite(metadata.waitedMs) && metadata.waitedMs >= 1_000 &&
            execution.toolCallId !== undefined && !this.#seenWaitCalls.has(execution.toolCallId)) {
            this.#seenWaitCalls.add(execution.toolCallId);
            waitingForProcess = true;
            progressKinds.add("managed-process-wait");
          }
          if (["exited", "failed", "stopped"].includes(process.status ?? "") && !unchangedCompletionRepair &&
            !this.#seenProcessExits.has(process.id)) {
            this.#seenProcessExits.add(process.id);
            materialProgress = true;
            progressKinds.add("new-tool-result");
          }
        }
        // Logs and clocks alone are not semantic progress, even without a checkpoint.
        continue;
      }
      if (execution.tool.name === "capability.request" && Array.isArray(execution.result?.metadata?.requests) &&
        !execution.result.metadata.requests.some((request: unknown) => request !== null && typeof request === "object" && "status" in request && request.status === "queued")) continue;

      // Trusted tool receipts can advance recovery/delivery before the durable
      // checkpoint catches up. Changing reasons, clocks or page sizes cannot.
      if (execution.tool.name === "capability.request" || execution.tool.name === "task.result.read") {
        if (this.#observeRecoveryOrResult(execution)) {
          materialProgress = true;
          progressKinds.add("new-tool-result");
        }
        continue;
      }

      // New page text can repair a citation-free candidate. Merely discovering
      // more URLs cannot; identical pages and reused reads still do not count.
      if (unchangedCompletionRepair && execution.tool.name === "web.search") continue;
      if (this.#research) {
        const sources = researchEvidence(execution);
        const newEvidence = sources.some((source) => !this.#seenResearchSources.has(source));
        sources.forEach((source) => this.#seenResearchSources.add(source));
        if (newEvidence) {
          materialProgress = true;
          progressKinds.add("new-tool-result");
          continue;
        }
        // Source order, query wording and retrieval timestamps are not evidence.
        if (execution.tool.name === "web.search" || execution.tool.name === "web.extract") continue;
      }
      if (execution.tool.name === "delegate_task") {
        if (typeof execution.result?.metadata?.taskId === "string" && execution.result.metadata.idempotentReplay === false) {
          materialProgress = true;
          progressKinds.add("target-mutation");
        }
        continue;
      }
      // File edits and delivery can progress before checkpoint projection
      // catches up. Count exact file versions, not changing model prose.
      if (checkpointControlsProgress) {
        const metadata = execution.result?.metadata;
        const outputs = execution.tool.name === "file.patch" && Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
        let reportProgress = false;
        for (const output of outputs) {
          if (output === null || typeof output !== "object") continue;
          const { path, contentSha256 } = output as Record<string, unknown>;
          const requestedFiles = requestedFileOutputs(this.#checkpointReader?.current()?.requestRequirements).filter(file => file.path !== undefined);
          if (typeof path !== "string" || (requestedFiles.length > 0 && !requestedFiles.some(file => matchesFileOutputPath(path, file))) ||
            typeof contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(contentSha256)) continue;
          const key = fingerprint({ path, contentSha256 });
          if ((execution.tool.name === "file.write" || execution.tool.name === "file.patch") &&
            metadata?.changed !== false && !this.#seenFileWrites.has(key)) {
            this.#seenFileWrites.add(key);
            this.#pendingFileReadbacks.add(key);
            progressKinds.add("target-mutation");
            reportProgress = true;
          } else if (execution.tool.name === "file.read" && metadata?.materialized === true &&
            metadata.completeFileRead === true && !this.#seenFileReadbacks.has(key) &&
            (this.#pendingFileReadbacks.delete(key) || this.#pendingCommandReadbacks.delete(path))) {
            this.#seenFileReadbacks.add(key);
            progressKinds.add("verification");
            reportProgress = true;
          }
        }
        if (reportProgress) { materialProgress = true; continue; }
        if (["file.write", "file.patch", "file.read"].includes(execution.tool.name)) continue;
      }
      const callFingerprint = toolCallFingerprint(execution);
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
      // Connector observations still need their checkpoint relationship.
      // Completed command diagnostics are handled separately above.
      if (!checkpointControlsProgress) {
        materialProgress = true;
        progressKinds.add("new-tool-result");
      }
    }

    if (!materialProgress && progressKinds.size === 0) {
      progressKinds.add(eligible.length === 0 ? "no-tool-activity" : "repeated-tool-call");
    }

    this.#noProgressIterations = materialProgress ? 0 : this.#noProgressIterations + (waitingForProcess ? 0 : 1);
    if (materialProgress) this.#nudged = false;
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
      const commandObservation = commandObservationFingerprint(execution);
      if (commandObservation !== undefined) {
        this.#seenCommandObservations.add(commandObservation);
        this.#active = true;
      }
      if (
        INELIGIBLE_TOOLS.has(execution.tool.name) ||
        executionEvidenceStatus(execution) !== "success" ||
        (execution.readReuseOf !== undefined || execution.result?.metadata?.mcpReadReuse === true)
      ) continue;
      this.#active = true;
      if (execution.tool.name === "process.logs") {
        const process = execution.result?.metadata?.process as { id?: string; status?: string } | undefined;
        if (typeof process?.id === "string" && ["exited", "failed", "stopped"].includes(process.status ?? "")) this.#seenProcessExits.add(process.id);
        if (execution.toolCallId) this.#seenWaitCalls.add(execution.toolCallId);
      }
      this.#observeRecoveryOrResult(execution);
      if (this.#research) researchEvidence(execution).forEach((source) => this.#seenResearchSources.add(source));
      const discovery = browserDiscoveryFingerprint(execution) ?? connectorDiscoveryFingerprint(execution);
      if (discovery !== undefined) this.#seenDiscoveryFingerprints.add(discovery);
      this.#seenCallFingerprints.add(toolCallFingerprint(execution));
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

  #observeRecoveryOrResult(execution: ToolExecutionRecord): boolean {
    const metadata = execution.result?.metadata;
    if (execution.tool.name === "capability.request" && Array.isArray(metadata?.requests)) {
      let added = false;
      for (const request of metadata.requests.slice(0, 8)) {
        if (!request || typeof request !== "object" || request.status !== "queued" || typeof request.id !== "string") continue;
        if (!this.#seenRecoveryIds.has(request.id)) added = true;
        this.#seenRecoveryIds.add(request.id);
      }
      return added;
    }
    if (execution.tool.name !== "task.result.read" || metadata?.disposition !== "accepted") return false;
    const { taskId, resultId, contentHash, offset, nextOffset, totalChars } = metadata;
    const sourceTaskId = this.#checkpointReader?.current()?.requestRequirements?.sourceTaskId;
    const end = nextOffset ?? totalChars;
    if (typeof taskId !== "string" || (sourceTaskId !== undefined && taskId !== sourceTaskId) ||
      typeof resultId !== "string" || typeof contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(contentHash) ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof end !== "number" || !Number.isSafeInteger(end) || end <= offset || !execution.result?.content.trim()) return false;
    const key = fingerprint({ taskId, resultId, contentHash });
    const previousEnd = this.#resultReadEnds.get(key) ?? 0;
    this.#resultReadEnds.set(key, Math.max(previousEnd, end));
    return end > previousEnd;
  }
}

function toolCallFingerprint(execution: ToolExecutionRecord): string {
  // Process deadlines and transient target handles do not make a command new.
  const input = execution.input ?? {};
  if (execution.tool.name === "terminal.run") {
    return fingerprint({ tool: execution.tool.name, command: input.command });
  }
  if (execution.tool.name === "terminal.inspect") {
    return fingerprint({ tool: execution.tool.name, argv: input.argv });
  }
  return fingerprint({ tool: execution.tool.name, input: execution.input,
    target: execution.targetKey ?? execution.targetSummary });
}

function commandObservationFingerprint(execution: ToolExecutionRecord): string | undefined {
  const code = settledLocalCommandExit(execution);
  if (code === undefined) return undefined;
  return fingerprint({ code, result: toolResultFingerprint(execution) });
}

function connectorDiscoveryFingerprint(execution: ToolExecutionRecord): string | undefined {
  const effect = execution.executionEffect;
  if ((effect?.kind !== "read" && effect?.kind !== "verification") || effect.connector?.kind !== "mcp" ||
      execution.riskClass !== "read-only-network" || (execution.readReuseOf !== undefined || execution.result?.metadata?.mcpReadReuse === true)) return undefined;
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

/** Observations may advance research without satisfying the completion checkpoint. */
function researchEvidence(execution: ToolExecutionRecord): string[] {
  const metadata = execution.result?.metadata;
  const canonicalUrl = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) return undefined; url.hash = ""; return url.href; } catch { return undefined; }
  };
  if (execution.tool.name === "web.search" && Array.isArray(metadata?.results)) {
    return metadata.results.slice(0, 20).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("url" in entry)) return [];
      const url = canonicalUrl(entry.url);
      return url ? ["search:" + url] : [];
    });
  }
  if (execution.tool.name === "web.extract") {
    const url = canonicalUrl(metadata?.url);
    const content = metadata?.content ?? execution.result?.content;
    if (url && typeof content === "string" && content.trim()) return ["extract:" + fingerprint({url, content}, true)];
  }
  return [];
}
