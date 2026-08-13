import { createHash } from "node:crypto";
import type { ExecutionPlan, ExecutionPlanItem } from "../contracts/execution-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { executionEvidenceStatus } from "./execution-evidence-index.js";

const MUTATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);
const BROWSER_STATE_CHANGE_TOOLS = new Set([
  "browser.click",
  "browser.type",
  "browser.fill_protected_form",
  "browser.select",
  "browser.press",
  "browser.dialog",
  "browser.cdp"
]);
const DISCOVERY_TERMS = new Set([
  "discover", "find", "identify", "inspect", "investigate", "list", "locate", "open", "read", "review",
  "ابحث", "افتح", "اقرأ", "اكتشف", "حدد", "راجع", "فتش", "تحقق"
]);
const VERIFICATION_TERMS = new Set([
  "assert", "check", "confirm", "test", "validate", "verification", "verify",
  "أكد", "اختبر", "تحقق", "تأكد"
]);
const GENERIC_GOAL_TERMS = new Set([
  "a", "add", "an", "and", "build", "change", "click", "configure", "create", "delete", "do", "edit",
  "enter", "execute", "for", "mission", "of", "remove", "set", "step", "task", "the", "then", "to", "type",
  "update", "work",
  "أدخل", "أن", "أنشئ", "اضبط", "احذف", "انقر", "ثم", "حدّث", "غيّر", "في", "قم", "مهمة", "من"
]);
const MAX_DISCOVERY_OBSERVATIONS_PER_ITEM = 2;

export type ExecutionProgressKind =
  | "plan-transition"
  | "new-required-evidence"
  | "target-mutation"
  | "verification"
  | "concrete-blocker"
  | "incidental-observation";

export type ExecutionPlanProgressAssessment = {
  active: boolean;
  materialProgress: boolean;
  progressKinds: ExecutionProgressKind[];
  activeItemId?: string;
  noProgressIterations: number;
  shouldNudge: boolean;
  shouldStop: boolean;
};

type PlanProgressState = {
  semanticFingerprint: string;
  blockerKeys: Set<string>;
  verificationKeys: Set<string>;
  focus?: ExecutionPlanFocus;
};

type ExecutionPlanFocus = {
  key: string;
  itemId: string;
  discovery: boolean;
  verification: boolean;
  significantTerms: Set<string>;
};

/**
 * Tracks goal-directed progress for one provider turn. Content-derived keys are
 * hashed, remain in memory, and are never emitted or persisted.
 */
export class ExecutionPlanProgressGuard {
  readonly #nudgeIteration: number;
  readonly #stopIteration: number;
  readonly #seenObservations = new Set<string>();
  readonly #seenMutations = new Set<string>();
  readonly #verifiedFocuses = new Set<string>();
  readonly #discoveryCounts = new Map<string, number>();
  readonly #nudgedFocuses = new Set<string>();
  #planState: PlanProgressState | undefined;
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
    this.#planState = planProgressState(input.plan);
    this.#classifyExecutions(input.existingExecutions ?? [], this.#planState?.focus);
  }

  observe(input: {
    plan?: ExecutionPlan;
    executions: readonly ToolExecutionRecord[];
  }): ExecutionPlanProgressAssessment {
    const nextPlanState = planProgressState(input.plan);
    const progressKinds = new Set<ExecutionProgressKind>();
    this.#classifyPlanTransition(this.#planState, nextPlanState, progressKinds);
    this.#planState = nextPlanState;
    this.#classifyExecutions(input.executions, nextPlanState?.focus, progressKinds);
    const active = hasUnfinishedExecutionPlan(input.plan);

    if (!active) {
      this.#noProgressIterations = 0;
      return assessment({
        active: false,
        progressKinds,
        activeItemId: nextPlanState?.focus?.itemId,
        noProgressIterations: 0,
        shouldNudge: false,
        shouldStop: false
      });
    }

    const materialProgress = hasMaterialProgress(progressKinds);
    if (!materialProgress) progressKinds.add("incidental-observation");
    this.#noProgressIterations = materialProgress ? 0 : this.#noProgressIterations + 1;
    const focusKey = nextPlanState?.focus?.key;
    const shouldNudge = this.#noProgressIterations >= this.#nudgeIteration &&
      focusKey !== undefined &&
      !this.#nudgedFocuses.has(focusKey);
    if (shouldNudge) this.#nudgedFocuses.add(focusKey);

    return assessment({
      active: true,
      progressKinds,
      activeItemId: nextPlanState?.focus?.itemId,
      noProgressIterations: this.#noProgressIterations,
      shouldNudge,
      shouldStop: this.#noProgressIterations >= this.#stopIteration
    });
  }

  #classifyPlanTransition(
    previous: PlanProgressState | undefined,
    next: PlanProgressState | undefined,
    progressKinds: Set<ExecutionProgressKind>
  ): void {
    if (previous?.semanticFingerprint === next?.semanticFingerprint) return;
    progressKinds.add("plan-transition");
    if (hasNewKey(previous?.blockerKeys, next?.blockerKeys)) {
      progressKinds.add("concrete-blocker");
    }
    if (hasNewKey(previous?.verificationKeys, next?.verificationKeys)) {
      progressKinds.add("verification");
    }
  }

  #classifyExecutions(
    executions: readonly ToolExecutionRecord[],
    focus: ExecutionPlanFocus | undefined,
    progressKinds?: Set<ExecutionProgressKind>
  ): void {
    for (const execution of executions) {
      if (executionEvidenceStatus(execution) !== "success" || focus === undefined) continue;

      if (isExplicitBrowserNoChange(execution)) {
        progressKinds?.add("incidental-observation");
        continue;
      }

      if (isMutationExecution(execution)) {
        const mutationKey = fingerprint({
          focus: focus.key,
          tool: execution.tool.name,
          targetKey: execution.targetKey,
          input: execution.input
        });
        if (isExecutionRelevant(execution, focus) && !this.#seenMutations.has(mutationKey)) {
          this.#seenMutations.add(mutationKey);
          progressKinds?.add("target-mutation");
        } else {
          progressKinds?.add("incidental-observation");
        }
        continue;
      }

      const observationKey = fingerprint({
        focus: focus.key,
        tool: execution.tool.name,
        target: execution.targetKey ?? execution.targetSummary
      });
      const isNewObservation = !this.#seenObservations.has(observationKey);
      this.#seenObservations.add(observationKey);
      if (!isNewObservation || !isExecutionRelevant(execution, focus)) {
        progressKinds?.add("incidental-observation");
        continue;
      }

      if (focus.verification) {
        if (!this.#verifiedFocuses.has(focus.key)) {
          this.#verifiedFocuses.add(focus.key);
          progressKinds?.add("verification");
        } else {
          progressKinds?.add("incidental-observation");
        }
        continue;
      }

      const discoveryCount = this.#discoveryCounts.get(focus.key) ?? 0;
      if (discoveryCount < MAX_DISCOVERY_OBSERVATIONS_PER_ITEM) {
        this.#discoveryCounts.set(focus.key, discoveryCount + 1);
        progressKinds?.add("new-required-evidence");
      } else {
        progressKinds?.add("incidental-observation");
      }
    }
  }
}

function assessment(input: {
  active: boolean;
  progressKinds: Set<ExecutionProgressKind>;
  activeItemId?: string;
  noProgressIterations: number;
  shouldNudge: boolean;
  shouldStop: boolean;
}): ExecutionPlanProgressAssessment {
  const progressKinds = [...input.progressKinds];
  return {
    active: input.active,
    materialProgress: hasMaterialProgress(input.progressKinds),
    progressKinds,
    ...(input.activeItemId === undefined ? {} : { activeItemId: input.activeItemId }),
    noProgressIterations: input.noProgressIterations,
    shouldNudge: input.shouldNudge,
    shouldStop: input.shouldStop
  };
}

function planProgressState(plan: ExecutionPlan | undefined): PlanProgressState | undefined {
  if (plan === undefined) return undefined;
  return {
    semanticFingerprint: semanticPlanFingerprint(plan),
    blockerKeys: new Set(plan.items.flatMap((item) => item.blocker === undefined
      ? []
      : [fingerprint({ id: item.id, status: item.status, blocker: item.blocker })])),
    verificationKeys: new Set(plan.items.flatMap((item) =>
      item.status === "completed" && isVerificationItem(item) && item.evidence !== undefined
        ? item.evidence.map((entry) => fingerprint({ id: item.id, toolCallId: entry.toolCallId }))
        : [])),
    focus: executionPlanFocus(plan)
  };
}

function executionPlanFocus(plan: ExecutionPlan): ExecutionPlanFocus | undefined {
  if (!hasUnfinishedExecutionPlan(plan)) return undefined;
  const item = plan.items.find((entry) => entry.status === "in_progress") ??
    plan.items.find((entry) => entry.status === "pending");
  if (item === undefined) return undefined;
  const terms = tokenSet(item.content);
  return {
    key: `${plan.originTurnId}:${item.id}`,
    itemId: item.id,
    discovery: hasAnyTerm(terms, DISCOVERY_TERMS),
    verification: hasAnyTerm(terms, VERIFICATION_TERMS),
    significantTerms: new Set([...terms].filter((term) => !GENERIC_GOAL_TERMS.has(term)))
  };
}

function isExecutionRelevant(execution: ToolExecutionRecord, focus: ExecutionPlanFocus): boolean {
  const executionTerms = tokenSet([
    execution.tool.name,
    execution.targetKey,
    execution.targetSummary
  ].filter((value): value is string => value !== undefined).join(" "));
  if ([...focus.significantTerms].some((term) => executionTerms.has(term))) return true;
  if (focus.significantTerms.size === 0) return true;
  if (BROWSER_STATE_CHANGE_TOOLS.has(execution.tool.name) && !focus.discovery && !focus.verification) return true;
  if (!isMutationExecution(execution) && (focus.discovery || focus.verification)) return true;
  return false;
}

function isMutationExecution(execution: ToolExecutionRecord): boolean {
  if (MUTATION_RISK_CLASSES.has(execution.riskClass)) return true;
  if (!BROWSER_STATE_CHANGE_TOOLS.has(execution.tool.name)) return false;
  const outcome = browserActionOutcome(execution);
  return outcome === undefined || outcome === "changed";
}

function isExplicitBrowserNoChange(execution: ToolExecutionRecord): boolean {
  const outcome = browserActionOutcome(execution);
  return outcome === "no-change" || outcome === "timeout";
}

function browserActionOutcome(execution: ToolExecutionRecord): string | undefined {
  const snapshot = execution.result?.metadata?.snapshot;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const delta = (snapshot as Record<string, unknown>).actionDelta;
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) return undefined;
  const outcome = (delta as Record<string, unknown>).outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

function isVerificationItem(item: ExecutionPlanItem): boolean {
  return hasAnyTerm(tokenSet(item.content), VERIFICATION_TERMS);
}

function hasUnfinishedExecutionPlan(plan: ExecutionPlan | undefined): boolean {
  const waitingForUser = plan?.items.some((item) =>
    item.status === "blocked" && item.blocker?.kind === "user_input_required"
  ) === true;
  return plan?.status === "active" && !waitingForUser && plan.items.some((item) =>
    item.status === "pending" || item.status === "in_progress"
  );
}

function semanticPlanFingerprint(plan: ExecutionPlan): string {
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

function hasMaterialProgress(kinds: ReadonlySet<ExecutionProgressKind>): boolean {
  return [...kinds].some((kind) => kind !== "incidental-observation");
}

function hasNewKey(previous: ReadonlySet<string> | undefined, next: ReadonlySet<string> | undefined): boolean {
  if (next === undefined) return false;
  return [...next].some((key) => previous?.has(key) !== true);
}

function hasAnyTerm(terms: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  return [...terms].some((term) => candidates.has(term));
}

function tokenSet(input: string): Set<string> {
  const expanded = input.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2").toLocaleLowerCase();
  return new Set(expanded.match(/[\p{L}\p{N}]+/gu) ?? []);
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
