import {
  EXECUTION_PLAN_MAX_BLOCKER_CHARS,
  EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS,
  EXECUTION_PLAN_MAX_ID_CHARS,
  EXECUTION_PLAN_MAX_ITEM_CHARS,
  EXECUTION_PLAN_MAX_ITEMS,
  EXECUTION_PLAN_MAX_OBJECTIVE_CHARS,
  EXECUTION_PLAN_MAX_PROTECTED_PATHS,
  EXECUTION_PLAN_MAX_REQUIREMENTS,
  EXECUTION_PLAN_MAX_SERIALIZED_BYTES,
  EXECUTION_PLAN_MAX_TOOL_NAME_CHARS,
  type ExecutionPlan,
  type ExecutionPlanBlocker,
  type ExecutionPlanBlockerKind,
  type ExecutionPlanCapabilityAssessment,
  type ExecutionPlanCapabilityPreflight,
  type ExecutionPlanCapabilityRequirement,
  type ExecutionPlanCompletionKind,
  type ExecutionPlanControllerApi,
  type ExecutionPlanEventSink,
  type ExecutionPlanEvidence,
  type ExecutionPlanLifecycleEvent,
  type ExecutionPlanItem,
  type ExecutionPlanItemStatus,
  type ExecutionPlanMergeInput,
  type ExecutionPlanStatus,
  type ExecutionPlanWriteContext,
  type ExecutionPlanWriteInput
} from "../contracts/execution-plan.js";
import { isProtectedArgumentPattern } from "../security/protected-argument-path.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { isAcknowledgementContinuation, isExplicitNewRequest } from "./conversation-continuation-state.js";
import { ExecutionEvidenceError, ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import {
  ExecutionCapabilityPreflight,
  formatExecutionCapabilityBlocker
} from "./execution-capability-preflight.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

const ITEM_STATUSES = new Set<ExecutionPlanItemStatus>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled"
]);
const BLOCKER_KINDS = new Set<ExecutionPlanBlockerKind>([
  "user_input_required",
  "approval_required",
  "missing_capability",
  "external_state",
  "budget"
]);
const PLAN_STATUSES = new Set<ExecutionPlanStatus>([
  "active",
  "completed",
  "blocked",
  "transferred",
  "abandoned"
]);
const COMPLETION_KINDS = new Set<ExecutionPlanCompletionKind>(["reasoning"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

export class ExecutionPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPlanValidationError";
  }
}

export class ExecutionPlanController implements ExecutionPlanControllerApi {
  readonly #store: ExecutionPlanStore;
  readonly #record: ((event: ExecutionPlanLifecycleEvent, sink?: ExecutionPlanEventSink) => Promise<void>) | undefined;
  readonly #evidenceIndex: ExecutionEvidenceIndex;
  readonly #capabilityPreflight: ExecutionCapabilityPreflight | undefined;
  #awaitingResumeDecision = false;

  constructor(
    store: ExecutionPlanStore,
    record?: (event: ExecutionPlanLifecycleEvent, sink?: ExecutionPlanEventSink) => Promise<void>,
    evidenceIndex = new ExecutionEvidenceIndex(),
    capabilityPreflight?: ExecutionCapabilityPreflight
  ) {
    this.#store = store;
    this.#record = record;
    this.#evidenceIndex = evidenceIndex;
    this.#capabilityPreflight = capabilityPreflight;
  }

  current(): ExecutionPlan | undefined {
    return this.#store.current();
  }

  async write(
    input: ExecutionPlanWriteInput,
    originTurnId: string,
    sink?: ExecutionPlanEventSink,
    context?: ExecutionPlanWriteContext
  ): Promise<ExecutionPlan> {
    this.#awaitingResumeDecision = false;
    const previous = this.#store.current();
    const items = validateWriteItems(input.items).map((item) => this.#validateCompletion(item));
    const requirements = validateCapabilityRequirements(input.requirements, items);
    let plan = validatePlan({
      objective: boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
      originTurnId: stableId(originTurnId, "originTurnId", 256),
      revision: (previous?.revision ?? 0) + 1,
      status: "active",
      items,
      ...(requirements === undefined ? {} : { requirements })
    });
    if (requirements !== undefined) {
      const capabilityPreflight = this.#capabilityPreflight === undefined
        ? unavailableCapabilityPreflight(requirements)
        : await this.#capabilityPreflight.assess(requirements, context);
      plan = validatePlan({
        ...plan,
        items: applyCapabilityBlockers(plan.items, requirements, capabilityPreflight),
        capabilityPreflight
      });
    }
    await this.#recordTransition({
      kind: plan.status === "active" ? "execution-plan-started" : eventKindForPlan(plan),
      plan
    }, sink);
    return this.#store.replace(plan);
  }

  async merge(input: ExecutionPlanMergeInput, sink?: ExecutionPlanEventSink): Promise<ExecutionPlan> {
    this.#awaitingResumeDecision = false;
    const current = this.#store.current();
    if (current === undefined) {
      throw new ExecutionPlanValidationError("No execution plan exists. Call plan with operation=write first.");
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ExecutionPlanValidationError("merge requires at least one item update.");
    }

    const items = current.items.map((item) => ({ ...item }));
    const indexes = new Map(items.map((item, index) => [item.id, index]));
    const patchedIds = new Set<string>();
    const completionValidationIds = new Set<string>();
    for (const rawPatch of input.items) {
      if (!isRecord(rawPatch)) {
        throw new ExecutionPlanValidationError("Each merge item must be an object.");
      }
      const id = stableId(rawPatch.id, "item id", EXECUTION_PLAN_MAX_ID_CHARS);
      if (patchedIds.has(id)) {
        throw new ExecutionPlanValidationError(`merge contains duplicate item id: ${id}`);
      }
      patchedIds.add(id);
      const index = indexes.get(id);
      if (index === undefined) {
        if (typeof rawPatch.content !== "string") {
          throw new ExecutionPlanValidationError(`New item ${id} requires content.`);
        }
        const item = validateItem({
          id,
          content: rawPatch.content,
          status: rawPatch.status ?? "pending",
          evidenceCallIds: rawPatch.evidenceCallIds,
          completionKind: rawPatch.completionKind,
          blocker: rawPatch.blocker ?? undefined
        });
        indexes.set(id, items.length);
        items.push(item);
        if (item.status === "completed") completionValidationIds.add(id);
        continue;
      }

      const existing = items[index]!;
      const statusLeavesBlockedState = rawPatch.status !== undefined &&
        rawPatch.status !== "blocked" &&
        rawPatch.status !== "cancelled";
      items[index] = validateItem({
        ...existing,
        ...(rawPatch.content === undefined ? {} : { content: rawPatch.content }),
        ...(rawPatch.status === undefined ? {} : { status: rawPatch.status }),
        ...(rawPatch.evidenceCallIds === undefined ? {} : { evidenceCallIds: rawPatch.evidenceCallIds }),
        ...(rawPatch.completionKind === undefined ? {} : { completionKind: rawPatch.completionKind }),
        ...(rawPatch.blocker === undefined
          ? statusLeavesBlockedState
            ? { blocker: undefined }
            : {}
          : rawPatch.blocker === null
            ? { blocker: undefined }
            : { blocker: rawPatch.blocker })
      });
      if (
        rawPatch.status === "completed" ||
        rawPatch.evidenceCallIds !== undefined ||
        rawPatch.completionKind !== undefined
      ) {
        completionValidationIds.add(id);
      }
    }

    if (isTerminalExtension(current, items)) {
      throw new ExecutionPlanValidationError(
        "merge cannot extend a Mission while completing its final unfinished objective item. " +
        "Report optional follow-up work in the final response or wait for a separate user-authorized request."
      );
    }

    const plan = validatePlan({
      ...current,
      objective: input.objective === undefined
        ? current.objective
        : boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
      revision: current.revision + 1,
      status: "active",
      items: items.map((item) => completionValidationIds.has(item.id) ? this.#validateCompletion(item) : item)
    });
    await this.#recordTransition({ kind: eventKindForPlan(plan), plan }, sink);
    return this.#store.replace(plan);
  }

  #validateCompletion(item: ExecutionPlanItem): ExecutionPlanItem {
    if (item.status !== "completed") {
      return {
        ...item,
        evidence: undefined
      };
    }
    if (item.completionKind === "reasoning") {
      if (item.evidenceCallIds !== undefined && item.evidenceCallIds.length > 0) {
        throw new ExecutionPlanValidationError(
          `Completed reasoning item ${item.id} must not include evidence call IDs.`
        );
      }
      return { ...item, evidenceCallIds: undefined, evidence: undefined };
    }
    if (item.evidenceCallIds === undefined || item.evidenceCallIds.length === 0) {
      throw new ExecutionPlanValidationError(
        `Completed item ${item.id} requires successful evidenceCallIds or completionKind=reasoning.`
      );
    }
    try {
      return {
        ...item,
        completionKind: undefined,
        evidence: this.#evidenceIndex.resolve(item.evidenceCallIds)
      };
    } catch (error) {
      if (error instanceof ExecutionEvidenceError) {
        throw new ExecutionPlanValidationError(error.message);
      }
      throw error;
    }
  }

  hydrate(plan: ExecutionPlan): ExecutionPlan {
    const hydrated = this.#store.hydrate(validateHydratedPlan(plan));
    this.#awaitingResumeDecision = true;
    return hydrated;
  }

  async transfer(taskIds: readonly string[], sink?: ExecutionPlanEventSink): Promise<ExecutionPlan | undefined> {
    const current = this.#store.current();
    if (current === undefined || current.status === "transferred" || current.status === "abandoned") return current;
    const trustedTaskIds = [...new Set(taskIds.map((id) => stableId(id, "task id", 256)))].slice(0, 16);
    if (trustedTaskIds.length === 0) return current;
    const plan = lifecyclePlan(current, "transferred");
    await this.#recordTransition({
      kind: "execution-plan-transferred",
      plan,
      taskIds: trustedTaskIds
    }, sink);
    return this.#store.replace(plan);
  }

  async abandon(sink?: ExecutionPlanEventSink): Promise<ExecutionPlan | undefined> {
    const current = this.#store.current();
    if (current === undefined || current.status === "abandoned") return current;
    const plan = lifecyclePlan(current, "abandoned");
    await this.#recordTransition({ kind: "execution-plan-abandoned", plan }, sink);
    return this.#store.replace(plan);
  }

  clear(): void {
    this.#awaitingResumeDecision = false;
    this.#store.clear();
  }

  async prepareForTurn(userText: string, sink?: ExecutionPlanEventSink): Promise<void> {
    const current = this.#store.current();
    if (current === undefined) return;
    if (current.status === "completed" || current.status === "transferred" || current.status === "abandoned") {
      this.clear();
      return;
    }
    if (isExecutionPlanCancellation(userText)) {
      await this.abandon(sink);
      this.clear();
      return;
    }
    if (shouldResumeUserInputBlockedPlan(current, userText)) {
      this.#awaitingResumeDecision = false;
      const plan = resumeUserInputBlockedPlan(current);
      await this.#recordTransition({ kind: "execution-plan-updated", plan }, sink);
      this.#store.replace(plan);
      return;
    }
    if (this.#awaitingResumeDecision) {
      this.#awaitingResumeDecision = false;
      if (!isExecutionPlanResumeRequest(userText)) {
        await this.abandon(sink);
        this.clear();
        return;
      }
      await sink?.({ kind: eventKindForPlan(current), plan: current });
      return;
    }
    if (!isAcknowledgementContinuation(userText) && isExplicitNewRequest(userText)) {
      await this.abandon(sink);
      this.clear();
      return;
    }
    await sink?.({ kind: eventKindForPlan(current), plan: current });
  }

  async #recordTransition(event: ExecutionPlanLifecycleEvent, sink?: ExecutionPlanEventSink): Promise<void> {
    if (this.#record !== undefined) {
      await this.#record(event, sink);
      return;
    }
    await sink?.(event);
  }
}

function isTerminalExtension(current: ExecutionPlan, nextItems: readonly ExecutionPlanItem[]): boolean {
  const existingIds = new Set(current.items.map((item) => item.id));
  const unfinishedExisting = current.items.filter((item) => !isTerminalItemStatus(item.status));
  if (unfinishedExisting.length === 0 || deriveStatus([...nextItems]) !== "active") return false;

  const nextById = new Map(nextItems.map((item) => [item.id, item]));
  const completesExistingWork = unfinishedExisting.some((item) => nextById.get(item.id)?.status === "completed");
  const settlesAllExistingWork = unfinishedExisting.every((item) => {
    const next = nextById.get(item.id);
    return next !== undefined && isTerminalItemStatus(next.status);
  });
  const appendsUnfinishedWork = nextItems.some((item) =>
    !existingIds.has(item.id) && !isTerminalItemStatus(item.status)
  );
  return completesExistingWork && settlesAllExistingWork && appendsUnfinishedWork;
}

function isTerminalItemStatus(status: ExecutionPlanItemStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function isExecutionPlanResumeRequest(text: string): boolean {
  const normalized = normalizedUserResponse(text);
  return isAcknowledgementContinuation(normalized) ||
    /^(?:please\s+)?(?:(?:ok|okay|yes|yeah|yep|sure)\s+)?(?:let(?:'|’)s\s+)?(?:resume(?:\s+that)?|continue(?:\s+that)?|retry|try\s+again|do\s+it|go\s+ahead|pick\s+up\s+where\s+we\s+left\s+off)\b/iu.test(normalized);
}

function shouldResumeUserInputBlockedPlan(plan: ExecutionPlan, text: string): boolean {
  if (!plan.items.some((item) => item.status === "blocked" && item.blocker?.kind === "user_input_required")) {
    return false;
  }
  const normalized = normalizedUserResponse(text);
  if (!/[\p{L}\p{N}]/u.test(normalized) || isExecutionPlanCancellation(normalized)) return false;
  return isExecutionPlanResumeRequest(normalized) || !isExplicitNewRequest(normalized);
}

function resumeUserInputBlockedPlan(plan: ExecutionPlan): ExecutionPlan {
  let activeItemSelected = plan.items.some((item) => item.status === "in_progress");
  const items = plan.items.map((item): ExecutionPlanItem => {
    if (item.status !== "blocked" || item.blocker?.kind !== "user_input_required") {
      return { ...item };
    }
    const { blocker: _blocker, evidence: _evidence, evidenceCallIds: _evidenceCallIds, completionKind: _completionKind, ...rest } = item;
    const status = activeItemSelected ? "pending" : "in_progress";
    activeItemSelected = true;
    return { ...rest, status };
  });
  return validatePlan({ ...plan, revision: plan.revision + 1, status: "active", items });
}

function isExecutionPlanCancellation(text: string): boolean {
  return /^(?:stop|never\s*mind|new\s+topic|cancel|drop\s+it)\b/iu.test(normalizedUserResponse(text));
}

function normalizedUserResponse(text: string): string {
  return text.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!…]+$/gu, "")
    .trim();
}

function eventKindForPlan(plan: ExecutionPlan): ExecutionPlanLifecycleEvent["kind"] {
  if (plan.status === "completed") return "execution-plan-completed";
  if (plan.status === "blocked") return "execution-plan-blocked";
  if (plan.status === "abandoned") return "execution-plan-abandoned";
  return "execution-plan-updated";
}

function lifecyclePlan(plan: ExecutionPlan, status: "transferred" | "abandoned"): ExecutionPlan {
  return { ...plan, revision: plan.revision + 1, status };
}

function validateHydratedPlan(input: ExecutionPlan): ExecutionPlan {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    throw new ExecutionPlanValidationError("Persisted execution plan is malformed.");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new ExecutionPlanValidationError("Persisted execution plan revision is invalid.");
  }
  if (!PLAN_STATUSES.has(input.status)) {
    throw new ExecutionPlanValidationError("Persisted execution plan status is invalid.");
  }
  const items = input.items.map((item) => {
    if (!isRecord(item)) throw new ExecutionPlanValidationError("Persisted execution plan item is malformed.");
    return validateItem(item, { persisted: true });
  });
  const requirements = validateCapabilityRequirements(input.requirements, items);
  const capabilityPreflight = validateCapabilityPreflight(input.capabilityPreflight, requirements);
  const validated = validatePlan({
    objective: boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
    originTurnId: stableId(input.originTurnId, "originTurnId", 256),
    revision: input.revision,
    status: "active",
    items,
    ...(requirements === undefined ? {} : { requirements }),
    ...(capabilityPreflight === undefined ? {} : { capabilityPreflight })
  });
  const derived = validated.status;
  if (input.status !== derived && input.status !== "transferred" && input.status !== "abandoned") {
    throw new ExecutionPlanValidationError("Persisted execution plan status does not match its items.");
  }
  const plan = { ...validated, status: input.status };
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > EXECUTION_PLAN_MAX_SERIALIZED_BYTES) {
    throw new ExecutionPlanValidationError(`Execution plan exceeds ${EXECUTION_PLAN_MAX_SERIALIZED_BYTES} serialized bytes.`);
  }
  return plan;
}

function validateWriteItems(input: unknown): ExecutionPlanItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ExecutionPlanValidationError("write requires at least one plan item.");
  }
  return input.map((item) => {
    if (!isRecord(item)) {
      throw new ExecutionPlanValidationError("Each plan item must be an object.");
    }
    return validateItem({
      id: item.id,
      content: item.content,
      status: item.status ?? "pending",
      evidenceCallIds: item.evidenceCallIds,
      completionKind: item.completionKind,
      blocker: item.blocker
    });
  });
}

function validatePlan(input: ExecutionPlan): ExecutionPlan {
  if (input.items.length > EXECUTION_PLAN_MAX_ITEMS) {
    throw new ExecutionPlanValidationError(`Execution plans support at most ${EXECUTION_PLAN_MAX_ITEMS} items.`);
  }
  const ids = new Set<string>();
  let inProgress = 0;
  for (const item of input.items) {
    if (ids.has(item.id)) {
      throw new ExecutionPlanValidationError(`Duplicate item id: ${item.id}`);
    }
    ids.add(item.id);
    if (item.status === "in_progress") inProgress += 1;
  }
  if (inProgress > 1) {
    throw new ExecutionPlanValidationError("Only one plan item may be in_progress.");
  }

  const plan = {
    ...input,
    status: deriveStatus(input.items, input.capabilityPreflight)
  };
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > EXECUTION_PLAN_MAX_SERIALIZED_BYTES) {
    throw new ExecutionPlanValidationError(`Execution plan exceeds ${EXECUTION_PLAN_MAX_SERIALIZED_BYTES} serialized bytes.`);
  }
  return plan;
}

function validateItem(
  input: Record<string, unknown>,
  options: { persisted?: boolean } = {}
): ExecutionPlanItem {
  const id = stableId(input.id, "item id", EXECUTION_PLAN_MAX_ID_CHARS);
  const content = boundedText(input.content, `content for ${id}`, EXECUTION_PLAN_MAX_ITEM_CHARS);
  const status = itemStatus(input.status, id);
  const blocker = input.blocker === undefined ? undefined : validateBlocker(input.blocker, id);
  if ((status === "blocked" || status === "cancelled") && blocker === undefined) {
    throw new ExecutionPlanValidationError(`${status} item ${id} requires a blocker reason.`);
  }
  if (status !== "blocked" && status !== "cancelled" && blocker !== undefined) {
    throw new ExecutionPlanValidationError(`Only blocked or cancelled item ${id} may include a blocker.`);
  }
  const evidenceCallIds = validateEvidenceCallIds(input.evidenceCallIds, id);
  const completionKind = validateCompletionKind(input.completionKind, id);
  if (completionKind === "reasoning" && !isClearlyReasoningOnlyContent(content)) {
    throw new ExecutionPlanValidationError(
      `Consequential action item ${id} cannot use completionKind=reasoning.`
    );
  }
  const evidence = options.persisted ? validatePersistedEvidence(input.evidence, id) : undefined;
  if (options.persisted === true) {
    if (status === "completed" && completionKind !== "reasoning" && (evidence === undefined || evidence.length === 0)) {
      throw new ExecutionPlanValidationError(`Persisted completed item ${id} has no harness evidence.`);
    }
    if (status !== "completed" && evidence !== undefined) {
      throw new ExecutionPlanValidationError(`Only completed persisted item ${id} may include evidence.`);
    }
    if (
      evidence !== undefined &&
      (evidenceCallIds === undefined ||
        evidence.length !== evidenceCallIds.length ||
        evidence.some((entry, index) => entry.toolCallId !== evidenceCallIds[index]))
    ) {
      throw new ExecutionPlanValidationError(`Persisted evidence for ${id} does not match its call IDs.`);
    }
  }
  return {
    id,
    content,
    status,
    ...(evidenceCallIds === undefined ? {} : { evidenceCallIds }),
    ...(completionKind === undefined ? {} : { completionKind }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(blocker === undefined ? {} : { blocker })
  };
}

function validateCompletionKind(input: unknown, id: string): ExecutionPlanCompletionKind | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !COMPLETION_KINDS.has(input as ExecutionPlanCompletionKind)) {
    throw new ExecutionPlanValidationError(`Item ${id} has an invalid completion kind.`);
  }
  return input as ExecutionPlanCompletionKind;
}

function validateBlocker(input: unknown, id: string): ExecutionPlanBlocker {
  if (!isRecord(input) || !BLOCKER_KINDS.has(input.kind as ExecutionPlanBlockerKind)) {
    throw new ExecutionPlanValidationError(`Item ${id} has an invalid blocker kind.`);
  }
  const summary = boundedText(input.summary, `blocker summary for ${id}`, EXECUTION_PLAN_MAX_BLOCKER_CHARS);
  if (isNonConcreteBlockerSummary(summary)) {
    throw new ExecutionPlanValidationError(`Item ${id} requires a concrete blocker, not a request to pause or continue.`);
  }
  return {
    kind: input.kind as ExecutionPlanBlockerKind,
    summary
  };
}

function validatePersistedEvidence(input: unknown, id: string): ExecutionPlanItem["evidence"] {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS) {
    throw new ExecutionPlanValidationError(`Persisted evidence for ${id} is invalid.`);
  }
  return input.map((entry) => {
    if (!isRecord(entry) || entry.outcome !== "success") {
      throw new ExecutionPlanValidationError(`Persisted evidence for ${id} is malformed.`);
    }
    const riskClass = entry.riskClass;
    if (!isToolRiskClass(riskClass)) {
      throw new ExecutionPlanValidationError(`Persisted evidence for ${id} has an invalid risk class.`);
    }
    return {
      toolCallId: stableId(entry.toolCallId, `evidence call id for ${id}`, 256),
      tool: boundedText(entry.tool, `evidence tool for ${id}`, 256),
      outcome: "success" as const,
      riskClass,
      ...(entry.targetSummary === undefined
        ? {}
        : { targetSummary: boundedText(entry.targetSummary, `evidence target for ${id}`, 240) })
    };
  });
}

function isToolRiskClass(input: unknown): input is ExecutionPlanEvidence["riskClass"] {
  return input === "read-only-local" || input === "read-only-network" || input === "workspace-write" ||
    input === "external-side-effect" || input === "credential-access" || input === "destructive-local" ||
    input === "shared-state-mutation" || input === "spend-money" || input === "sandbox-escape";
}

export function isClearlyReasoningOnlyContent(content: string): boolean {
  const normalized = content.trim();
  const startsAsReasoning = /^(explain|summarize|compare|analyze|analyse|assess|recommend|answer|reason|describe|brainstorm|outline|review)\b/iu.test(normalized) ||
    /^(اشرح|لخص|قارن|حلل|قيّم|قيم|اقترح|أجب|اجب|صف|راجع)(?:\s|$)/u.test(normalized);
  const includesConsequentialAction = /\b(create|change|update|edit|write|delete|remove|install|configure|commit|push|publish|deploy|send|submit|approve|reject|purchase|pay|upload|download|execute|run|launch|open|navigate|click|type|test|verify|validate|fix|implement|build)\b/iu.test(normalized) ||
    /(أنشئ|انشئ|غيّر|غير|حدّث|حدث|عدّل|عدل|اكتب|احذف|أزل|ازل|ثبّت|ثبت|هيّئ|هيئ|نفّذ|نفذ|شغّل|شغل|افتح|انتقل|انقر|اختبر|تحقق|أصلح|اصلح|طبّق|طبق|ابنِ|ابني)/u.test(normalized);
  return startsAsReasoning && !includesConsequentialAction;
}

function isNonConcreteBlockerSummary(summary: string): boolean {
  const normalized = summary.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  return /\b(need|require) more time\b/u.test(normalized) ||
    /\b(would|do) you like me to continue\b/u.test(normalized) ||
    /\b(should|may|can) i continue\b/u.test(normalized) ||
    /^(work is )?(still )?(pending|in progress|not finished)( for now)?$/u.test(normalized) ||
    /(أحتاج|احتاج|نحتاج) (إلى |الى )?مزيد من الوقت/u.test(normalized) ||
    /(هل )?(تريد|ترغب) (مني )?(أن |ان )?أستمر/u.test(normalized);
}

function validateEvidenceCallIds(input: unknown, id: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS) {
    throw new ExecutionPlanValidationError(
      `Item ${id} supports at most ${EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS} evidence call IDs.`
    );
  }
  const values = input.map((value) => stableId(value, `evidence call id for ${id}`, 256));
  return [...new Set(values)];
}

function itemStatus(input: unknown, id: string): ExecutionPlanItemStatus {
  if (typeof input !== "string" || !ITEM_STATUSES.has(input as ExecutionPlanItemStatus)) {
    throw new ExecutionPlanValidationError(`Item ${id} has an invalid status.`);
  }
  return input as ExecutionPlanItemStatus;
}

function deriveStatus(
  items: ExecutionPlanItem[],
  capabilityPreflight?: ExecutionPlanCapabilityPreflight
): ExecutionPlanStatus {
  if (capabilityPreflight?.status === "blocked") return "blocked";
  if (items.every((item) => item.status === "cancelled")) {
    return "abandoned";
  }
  if (items.every((item) => item.status === "completed" || item.status === "cancelled")) {
    return "completed";
  }
  if (
    items.some((item) => item.status === "blocked") &&
    items.every((item) => item.status === "completed" || item.status === "blocked" || item.status === "cancelled")
  ) {
    return "blocked";
  }
  return "active";
}

function validateCapabilityRequirements(
  input: unknown,
  items: readonly ExecutionPlanItem[]
): ExecutionPlanCapabilityRequirement[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > EXECUTION_PLAN_MAX_REQUIREMENTS) {
    throw new ExecutionPlanValidationError(
      `requirements must contain 1-${EXECUTION_PLAN_MAX_REQUIREMENTS} capability declarations.`
    );
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  const ids = new Set<string>();
  const requirements = input.map((entry) => {
    if (!isRecord(entry)) throw new ExecutionPlanValidationError("Each capability requirement must be an object.");
    const id = stableId(entry.id, "requirement id", EXECUTION_PLAN_MAX_ID_CHARS);
    if (ids.has(id)) throw new ExecutionPlanValidationError(`Duplicate requirement id: ${id}`);
    ids.add(id);
    const itemId = stableId(entry.itemId, `item id for requirement ${id}`, EXECUTION_PLAN_MAX_ID_CHARS);
    const item = itemById.get(itemId);
    if (item === undefined) throw new ExecutionPlanValidationError(`Requirement ${id} references unknown item ${itemId}.`);
    if (item.status === "completed" || item.status === "cancelled") {
      throw new ExecutionPlanValidationError(`Requirement ${id} must reference unfinished item ${itemId}.`);
    }
    const tool = stableId(entry.tool, `tool for requirement ${id}`, EXECUTION_PLAN_MAX_TOOL_NAME_CHARS);
    if (entry.capability !== "read" && entry.capability !== "mutate" && entry.capability !== "verify") {
      throw new ExecutionPlanValidationError(`Requirement ${id} has an invalid capability.`);
    }
    const capability: ExecutionPlanCapabilityRequirement["capability"] = entry.capability;
    const protectedPaths = validateProtectedPaths(entry.protectedPaths, id);
    if (protectedPaths !== undefined && capability !== "mutate") {
      throw new ExecutionPlanValidationError(`Only mutation requirement ${id} may declare protected paths.`);
    }
    if (entry.protectedSource !== undefined && entry.protectedSource !== "browser") {
      throw new ExecutionPlanValidationError(`Requirement ${id} has an invalid protected source.`);
    }
    if (entry.protectedSource !== undefined && protectedPaths === undefined) {
      throw new ExecutionPlanValidationError(`Requirement ${id} needs protected paths when a protected source is declared.`);
    }
    return {
      id,
      itemId,
      tool,
      capability,
      ...(protectedPaths === undefined ? {} : { protectedPaths }),
      ...(entry.protectedSource === undefined ? {} : { protectedSource: "browser" as const })
    };
  });
  for (const capability of ["read", "mutate", "verify"] as const) {
    if (!requirements.some((requirement) => requirement.capability === capability)) {
      throw new ExecutionPlanValidationError(
        `Cross-system requirements must declare a destination ${capability} capability.`
      );
    }
  }
  return requirements;
}

function validateProtectedPaths(input: unknown, requirementId: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > EXECUTION_PLAN_MAX_PROTECTED_PATHS) {
    throw new ExecutionPlanValidationError(
      `Requirement ${requirementId} supports 1-${EXECUTION_PLAN_MAX_PROTECTED_PATHS} protected paths.`
    );
  }
  const values = input.map((value) => {
    if (typeof value !== "string" || !isProtectedArgumentPattern(value)) {
      throw new ExecutionPlanValidationError(`Requirement ${requirementId} has an invalid protected path.`);
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new ExecutionPlanValidationError(`Requirement ${requirementId} contains duplicate protected paths.`);
  }
  return values;
}

function validateCapabilityPreflight(
  input: unknown,
  requirements: readonly ExecutionPlanCapabilityRequirement[] | undefined
): ExecutionPlanCapabilityPreflight | undefined {
  if (input === undefined) {
    if (requirements !== undefined) {
      throw new ExecutionPlanValidationError("Persisted capability requirements are missing their runtime preflight.");
    }
    return undefined;
  }
  if (!isRecord(input) || requirements === undefined || !Array.isArray(input.assessments)) {
    throw new ExecutionPlanValidationError("Persisted capability preflight is malformed.");
  }
  if (input.status !== "ready" && input.status !== "blocked") {
    throw new ExecutionPlanValidationError("Persisted capability preflight status is invalid.");
  }
  if (input.assessments.length !== requirements.length) {
    throw new ExecutionPlanValidationError("Persisted capability preflight does not match its requirements.");
  }
  const assessments = input.assessments.map((entry, index) => {
    const requirement = requirements[index]!;
    if (!isRecord(entry) || entry.requirementId !== requirement.id || entry.itemId !== requirement.itemId ||
      entry.tool !== requirement.tool || entry.capability !== requirement.capability ||
      (entry.status !== "ready" && entry.status !== "missing" && entry.status !== "unavailable" && entry.status !== "incompatible")) {
      throw new ExecutionPlanValidationError("Persisted capability assessment is malformed.");
    }
    const reasonCode = entry.reasonCode;
    if (entry.status === "ready") {
      if (reasonCode !== undefined) throw new ExecutionPlanValidationError("Ready capability assessment has a failure reason.");
    } else if (reasonCode !== "tool_missing" && reasonCode !== "tool_unavailable" &&
      reasonCode !== "protected_path_missing" && reasonCode !== "risk_mismatch") {
      throw new ExecutionPlanValidationError("Failed capability assessment has an invalid reason.");
    }
    return {
      requirementId: requirement.id,
      itemId: requirement.itemId,
      tool: requirement.tool,
      capability: requirement.capability,
      status: entry.status,
      ...(reasonCode === undefined ? {} : { reasonCode })
    } as ExecutionPlanCapabilityAssessment;
  });
  const derived = assessments.every((assessment) => assessment.status === "ready") ? "ready" : "blocked";
  if (input.status !== derived) throw new ExecutionPlanValidationError("Persisted capability preflight status is inconsistent.");
  return { status: derived, assessments };
}

function unavailableCapabilityPreflight(
  requirements: readonly ExecutionPlanCapabilityRequirement[]
): ExecutionPlanCapabilityPreflight {
  return {
    status: "blocked",
    assessments: requirements.map((requirement) => ({
      requirementId: requirement.id,
      itemId: requirement.itemId,
      tool: requirement.tool,
      capability: requirement.capability,
      status: "unavailable",
      reasonCode: "tool_unavailable"
    }))
  };
}

function applyCapabilityBlockers(
  items: readonly ExecutionPlanItem[],
  requirements: readonly ExecutionPlanCapabilityRequirement[],
  preflight: ExecutionPlanCapabilityPreflight
): ExecutionPlanItem[] {
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const firstFailureByItem = new Map<string, ExecutionPlanCapabilityAssessment>();
  for (const assessment of preflight.assessments) {
    if (assessment.status !== "ready" && !firstFailureByItem.has(assessment.itemId)) {
      firstFailureByItem.set(assessment.itemId, assessment);
    }
  }
  return items.map((item) => {
    const assessment = firstFailureByItem.get(item.id);
    if (assessment === undefined) return { ...item };
    return {
      ...item,
      status: "blocked",
      evidenceCallIds: undefined,
      evidence: undefined,
      completionKind: undefined,
      blocker: {
        kind: "missing_capability",
        summary: formatExecutionCapabilityBlocker({
          assessment,
          requirement: requirementById.get(assessment.requirementId)
        })
      }
    };
  });
}

function boundedText(input: unknown, field: string, maxChars: number): string {
  if (typeof input !== "string") {
    throw new ExecutionPlanValidationError(`${field} must be a string.`);
  }
  const value = redactSensitiveText(input).replace(/\s+/gu, " ").trim();
  if (value.length === 0) {
    throw new ExecutionPlanValidationError(`${field} must not be empty.`);
  }
  if ([...value].length > maxChars) {
    throw new ExecutionPlanValidationError(`${field} must be ${maxChars} characters or fewer.`);
  }
  return value;
}

function stableId(input: unknown, field: string, maxChars: number): string {
  if (typeof input !== "string") {
    throw new ExecutionPlanValidationError(`${field} must be a string.`);
  }
  const value = input.trim();
  if (value.length === 0 || value.length > maxChars || !SAFE_ID.test(value)) {
    throw new ExecutionPlanValidationError(
      `${field} must be 1-${maxChars} characters using letters, numbers, dot, colon, underscore, or hyphen.`
    );
  }
  return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
