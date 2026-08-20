import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { executionEvidenceStatus } from "./execution-evidence-index.js";

const INELIGIBLE_TOOLS = new Set(["plan", "delegate_task"]);

export type ToolLoopProgressKind =
  | "new-tool-result"
  | "target-mutation"
  | "verification"
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
  #active = false;
  #nudged = false;
  #noProgressIterations = 0;

  constructor(input: {
    existingExecutions?: readonly ToolExecutionRecord[];
    noProgressNudgeIteration: number;
    maxNoProgressIterations: number;
  }) {
    this.#stopIteration = normalizeStopIteration(input.maxNoProgressIterations);
    this.#nudgeIteration = normalizeNudgeIteration(
      input.noProgressNudgeIteration,
      this.#stopIteration
    );
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

    for (const execution of eligible) {
      const status = executionEvidenceStatus(execution);
      if (status !== "success") continue;

      const callFingerprint = fingerprint({
        tool: execution.tool.name,
        input: execution.input,
        target: execution.targetKey ?? execution.targetSummary
      });
      const callIsNew = !this.#seenCallFingerprints.has(callFingerprint);
      this.#seenCallFingerprints.add(callFingerprint);

      if (!callIsNew) {
        progressKinds.add("repeated-tool-call");
        continue;
      }

      if (execution.executionEffect?.kind === "mutation") {
        materialProgress = true;
        progressKinds.add("target-mutation");
        continue;
      }
      if (execution.executionEffect?.kind === "verification") {
        materialProgress = true;
        progressKinds.add("verification");
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
      materialProgress = true;
      progressKinds.add("new-tool-result");
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
        executionEvidenceStatus(execution) !== "success"
      ) continue;
      this.#active = true;
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
    }
  }
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
      kind === "new-tool-result" || kind === "target-mutation" || kind === "verification"
    ),
    progressKinds,
    noProgressIterations: input.noProgressIterations,
    shouldNudge: input.shouldNudge,
    shouldStop: input.shouldStop
  };
}

function normalizeStopIteration(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 6;
}

function normalizeNudgeIteration(value: number, stopIteration: number): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3;
  return Math.min(normalized, stopIteration);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (entry: unknown, depth: number): string => {
    if (visited >= 256 || depth > 6) return JSON.stringify("[TRUNCATED]");
    visited += 1;
    if (typeof entry === "string") return JSON.stringify([...entry].slice(0, 2_000).join(""));
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
