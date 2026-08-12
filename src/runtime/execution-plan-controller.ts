import {
  EXECUTION_PLAN_MAX_BLOCKER_CHARS,
  EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS,
  EXECUTION_PLAN_MAX_ID_CHARS,
  EXECUTION_PLAN_MAX_ITEM_CHARS,
  EXECUTION_PLAN_MAX_ITEMS,
  EXECUTION_PLAN_MAX_OBJECTIVE_CHARS,
  EXECUTION_PLAN_MAX_SERIALIZED_BYTES,
  type ExecutionPlan,
  type ExecutionPlanBlocker,
  type ExecutionPlanBlockerKind,
  type ExecutionPlanControllerApi,
  type ExecutionPlanEventSink,
  type ExecutionPlanLifecycleEvent,
  type ExecutionPlanItem,
  type ExecutionPlanItemStatus,
  type ExecutionPlanMergeInput,
  type ExecutionPlanStatus,
  type ExecutionPlanWriteInput
} from "../contracts/execution-plan.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { isAcknowledgementContinuation, isExplicitNewRequest } from "./conversation-continuation-state.js";
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
  #awaitingResumeDecision = false;

  constructor(
    store: ExecutionPlanStore,
    record?: (event: ExecutionPlanLifecycleEvent, sink?: ExecutionPlanEventSink) => Promise<void>
  ) {
    this.#store = store;
    this.#record = record;
  }

  current(): ExecutionPlan | undefined {
    return this.#store.current();
  }

  async write(
    input: ExecutionPlanWriteInput,
    originTurnId: string,
    sink?: ExecutionPlanEventSink
  ): Promise<ExecutionPlan> {
    this.#awaitingResumeDecision = false;
    const previous = this.#store.current();
    const plan = validatePlan({
      objective: boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
      originTurnId: stableId(originTurnId, "originTurnId", 256),
      revision: (previous?.revision ?? 0) + 1,
      status: "active",
      items: validateWriteItems(input.items)
    });
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
          blocker: rawPatch.blocker ?? undefined
        });
        indexes.set(id, items.length);
        items.push(item);
        continue;
      }

      const existing = items[index]!;
      items[index] = validateItem({
        ...existing,
        ...(rawPatch.content === undefined ? {} : { content: rawPatch.content }),
        ...(rawPatch.status === undefined ? {} : { status: rawPatch.status }),
        ...(rawPatch.evidenceCallIds === undefined ? {} : { evidenceCallIds: rawPatch.evidenceCallIds }),
        ...(rawPatch.blocker === undefined
          ? {}
          : rawPatch.blocker === null
            ? { blocker: undefined }
            : { blocker: rawPatch.blocker })
      });
    }

    const plan = validatePlan({
      ...current,
      objective: input.objective === undefined
        ? current.objective
        : boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
      revision: current.revision + 1,
      status: "active",
      items
    });
    await this.#recordTransition({ kind: eventKindForPlan(plan), plan }, sink);
    return this.#store.replace(plan);
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

function isExecutionPlanResumeRequest(text: string): boolean {
  return isAcknowledgementContinuation(text) ||
    /^(resume|resume that|continue|continue that|pick up where we left off)\b/iu.test(text.trim());
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
  const validated = validatePlan({
    objective: boundedText(input.objective, "objective", EXECUTION_PLAN_MAX_OBJECTIVE_CHARS),
    originTurnId: stableId(input.originTurnId, "originTurnId", 256),
    revision: input.revision,
    status: "active",
    items: input.items.map((item) => {
      if (!isRecord(item)) throw new ExecutionPlanValidationError("Persisted execution plan item is malformed.");
      return validateItem(item);
    })
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
    status: deriveStatus(input.items)
  };
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > EXECUTION_PLAN_MAX_SERIALIZED_BYTES) {
    throw new ExecutionPlanValidationError(`Execution plan exceeds ${EXECUTION_PLAN_MAX_SERIALIZED_BYTES} serialized bytes.`);
  }
  return plan;
}

function validateItem(input: Record<string, unknown>): ExecutionPlanItem {
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
  return {
    id,
    content,
    status,
    ...(evidenceCallIds === undefined ? {} : { evidenceCallIds }),
    ...(blocker === undefined ? {} : { blocker })
  };
}

function validateBlocker(input: unknown, id: string): ExecutionPlanBlocker {
  if (!isRecord(input) || !BLOCKER_KINDS.has(input.kind as ExecutionPlanBlockerKind)) {
    throw new ExecutionPlanValidationError(`Item ${id} has an invalid blocker kind.`);
  }
  return {
    kind: input.kind as ExecutionPlanBlockerKind,
    summary: boundedText(input.summary, `blocker summary for ${id}`, EXECUTION_PLAN_MAX_BLOCKER_CHARS)
  };
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

function deriveStatus(items: ExecutionPlanItem[]): ExecutionPlanStatus {
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
