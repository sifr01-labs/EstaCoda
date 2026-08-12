import { createHash } from "node:crypto";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

const INELIGIBLE_PROGRESS_TOOLS = new Set(["plan", "delegate_task"]);
const MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);

export type ExecutionPlanProgressAssessment = {
  active: boolean;
  materialProgress: boolean;
  noProgressIterations: number;
  shouldNudge: boolean;
  shouldStop: boolean;
};

/**
 * Tracks semantic progress for one provider turn. Content-derived fingerprints
 * stay in memory and are never emitted or persisted.
 */
export class ExecutionPlanProgressGuard {
  readonly #nudgeIteration: number;
  readonly #stopIteration: number;
  readonly #seenEvidence = new Set<string>();
  readonly #seenMutations = new Set<string>();
  #planFingerprint: string | undefined;
  #noProgressIterations = 0;

  constructor(input: {
    plan?: ExecutionPlan;
    existingExecutions?: readonly ToolExecutionRecord[];
    noProgressNudgeIteration: number;
    maxNoProgressIterations: number;
  }) {
    this.#stopIteration = normalizeStopIteration(input.maxNoProgressIterations);
    this.#nudgeIteration = normalizeNudgeIteration(
      input.noProgressNudgeIteration,
      this.#stopIteration
    );
    this.#planFingerprint = semanticPlanFingerprint(input.plan);
    this.#rememberExecutions(input.existingExecutions ?? []);
  }

  observe(input: {
    plan?: ExecutionPlan;
    executions: readonly ToolExecutionRecord[];
  }): ExecutionPlanProgressAssessment {
    const nextPlanFingerprint = semanticPlanFingerprint(input.plan);
    const planChanged = nextPlanFingerprint !== this.#planFingerprint;
    this.#planFingerprint = nextPlanFingerprint;
    const executionProgress = this.#rememberExecutions(input.executions);
    const active = hasUnfinishedExecutionPlan(input.plan);

    if (!active) {
      this.#noProgressIterations = 0;
      return {
        active: false,
        materialProgress: planChanged || executionProgress,
        noProgressIterations: 0,
        shouldNudge: false,
        shouldStop: false
      };
    }

    const materialProgress = planChanged || executionProgress;
    this.#noProgressIterations = materialProgress ? 0 : this.#noProgressIterations + 1;
    return {
      active: true,
      materialProgress,
      noProgressIterations: this.#noProgressIterations,
      shouldNudge: this.#noProgressIterations === this.#nudgeIteration,
      shouldStop: this.#noProgressIterations >= this.#stopIteration
    };
  }

  #rememberExecutions(executions: readonly ToolExecutionRecord[]): boolean {
    let materialProgress = false;
    for (const execution of executions) {
      if (
        execution.decision !== "allow" ||
        execution.result?.ok !== true ||
        INELIGIBLE_PROGRESS_TOOLS.has(execution.tool.name)
      ) {
        continue;
      }

      if (MUTATION_RISK_CLASSES.has(execution.riskClass)) {
        const mutationKey = execution.toolCallId ?? fingerprint({
          tool: execution.tool.name,
          targetKey: execution.targetKey,
          result: execution.result
        });
        if (!this.#seenMutations.has(mutationKey)) {
          this.#seenMutations.add(mutationKey);
          materialProgress = true;
        }
        continue;
      }

      const evidenceKey = fingerprint({
        tool: execution.tool.name,
        result: execution.result
      });
      if (!this.#seenEvidence.has(evidenceKey)) {
        this.#seenEvidence.add(evidenceKey);
        materialProgress = true;
      }
    }
    return materialProgress;
  }
}

function hasUnfinishedExecutionPlan(plan: ExecutionPlan | undefined): boolean {
  return plan?.status === "active" && plan.items.some((item) =>
    item.status === "pending" || item.status === "in_progress"
  );
}

function semanticPlanFingerprint(plan: ExecutionPlan | undefined): string | undefined {
  if (plan === undefined) return undefined;
  return fingerprint({
    status: plan.status,
    items: plan.items.map((item) => ({
      id: item.id,
      status: item.status,
      evidenceCallIds: item.evidence?.map((entry) => entry.toolCallId).sort(),
      blocker: item.blocker
    }))
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (seen.has(value)) return JSON.stringify("[Circular]");
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  const serialized = `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry, seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return serialized;
}

function normalizeStopIteration(value: number): number {
  return Number.isFinite(value) ? Math.max(2, Math.floor(value)) : 6;
}

function normalizeNudgeIteration(value: number, stopIteration: number): number {
  if (!Number.isFinite(value)) return Math.min(3, stopIteration - 1);
  return Math.min(Math.max(1, Math.floor(value)), stopIteration - 1);
}
