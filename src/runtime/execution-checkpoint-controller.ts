import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutionCheckpointAttemptSettlement,
  ExecutionCheckpointBlocker,
  ExecutionCheckpointArtifactReference,
  ExecutionCheckpointAuthenticationStage,
  ExecutionCheckpointCreationInput,
  ExecutionCheckpointLifecycleEvent,
  ExecutionCheckpointOperationCoordinates,
  ExecutionCheckpointOperationStatus,
  ExecutionCheckpointSafeFact,
  ExecutionCheckpointResource,
  ExecutionCheckpointReader,
  ExecutionCheckpointTransition,
  ForegroundExecutionCheckpoint
} from "../contracts/execution-checkpoint.js";
import {
  EXECUTION_CHECKPOINT_MAX_FACTS,
  EXECUTION_CHECKPOINT_MAX_OPERATIONS,
  EXECUTION_CHECKPOINT_VERSION
} from "../contracts/execution-checkpoint.js";
import {
  checkpointEvent,
  checkpointResourcesOnlyAdvance,
  cloneExecutionCheckpoint,
  isTerminalCheckpointStatus,
  sanitizeCheckpointText,
  validateExecutionCheckpoint
} from "../session/execution-checkpoint-state.js";
import { isAcknowledgementContinuation, isExplicitNewRequest } from "./conversation-continuation-state.js";

export class ExecutionCheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionCheckpointConflictError";
  }
}

export type ExecutionCheckpointControllerOptions = {
  sessionId: string | (() => string);
  profileId: string;
  record?: (event: ExecutionCheckpointLifecycleEvent) => Promise<void>;
  now?: () => string;
  createId?: () => string;
};

export type ExecutionCheckpointTurnPreparation = {
  disposition: "none" | "continuation" | "correction" | "cancelled" | "superseded";
  checkpoint?: ForegroundExecutionCheckpoint;
};

export class ExecutionCheckpointController implements ExecutionCheckpointReader {
  readonly #sessionId: () => string;
  readonly #profileId: string;
  readonly #record: ((event: ExecutionCheckpointLifecycleEvent) => Promise<void>) | undefined;
  readonly #now: () => string;
  readonly #createId: () => string;
  #checkpoint: ForegroundExecutionCheckpoint | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ExecutionCheckpointControllerOptions) {
    if (typeof options.sessionId === "string") {
      const sessionId = options.sessionId;
      this.#sessionId = () => sessionId;
    } else {
      this.#sessionId = options.sessionId;
    }
    this.#profileId = options.profileId;
    this.#record = options.record;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => `checkpoint:${randomUUID()}`);
  }

  current(): ForegroundExecutionCheckpoint | undefined {
    return this.#checkpoint === undefined ? undefined : cloneExecutionCheckpoint(this.#checkpoint);
  }

  hydrate(checkpoint: ForegroundExecutionCheckpoint): ForegroundExecutionCheckpoint {
    const validated = validateExecutionCheckpoint(checkpoint);
    if (validated.sessionId !== this.#sessionId() || validated.profileId !== this.#profileId) {
      throw new ExecutionCheckpointConflictError("Checkpoint does not belong to this runtime.");
    }
    this.#checkpoint = validated;
    return cloneExecutionCheckpoint(validated);
  }

  async ensure(input: ExecutionCheckpointCreationInput): Promise<ForegroundExecutionCheckpoint> {
    return await this.#serialize(async () => {
      const current = this.#checkpoint;
      if (current !== undefined && !isTerminalCheckpointStatus(current.status)) {
        return cloneExecutionCheckpoint(current);
      }
      const now = this.#now();
      const checkpoint = validateExecutionCheckpoint({
        version: EXECUTION_CHECKPOINT_VERSION,
        id: this.#createId(),
        sessionId: this.#sessionId(),
        profileId: this.#profileId,
        originTurnId: input.originTurnId,
        revision: 1,
        progressRevision: 0,
        originalObjective: sanitizeCheckpointText(input.originalObjective, 2_000),
        status: "active",
        qualificationReasons: input.qualificationReasons,
        ...(input.selectedSkillName === undefined ? {} : { selectedSkillName: input.selectedSkillName }),
        ...(input.taskClass === undefined ? {} : { taskClass: input.taskClass }),
        intentLabels: input.intentLabels,
        requiredOperations: input.requiredOperations,
        connectorIds: input.connectorIds,
        artifactReferences: [],
        safeFacts: [],
        operations: [],
        completionFloor: input.completionFloor,
        createdAt: now,
        updatedAt: now
      });
      await this.#persist("created", checkpoint);
      this.#checkpoint = checkpoint;
      return cloneExecutionCheckpoint(checkpoint);
    });
  }

  async settleAttempt(
    expectedRevision: number,
    input: ExecutionCheckpointAttemptSettlement
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "attempt_settled", (current) => {
      if (isTerminalCheckpointStatus(current.status)) return current;
      const status = settlementStatus(input, current);
      const blocker = settlementBlocker(input, status) ?? (
        (status === "blocked" || status === "awaiting_user") ? current.blocker : undefined
      );
      const completed = status === "completed" && current.status !== "completed";
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + (completed ? 1 : 0),
        status,
        ...(blocker === undefined ? { blocker: undefined } : { blocker }),
        lastTerminationCause: input.outcome.terminationCause,
        ...(input.providerFailureClass === undefined
          ? { lastProviderFailureClass: undefined }
          : { lastProviderFailureClass: input.providerFailureClass }),
        updatedAt: this.#now()
      };
    });
  }

  async block(
    expectedRevision: number,
    blocker: ExecutionCheckpointBlocker
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "blocked", (current) => ({
      ...current,
      revision: current.revision + 1,
      status: blocker.kind === "user_input_required" ? "awaiting_user" : "blocked",
      blocker: {
        kind: blocker.kind,
        summary: sanitizeCheckpointText(blocker.summary, 500)
      },
      updatedAt: this.#now()
    }));
  }

  async attachArtifact(
    expectedRevision: number,
    reference: ExecutionCheckpointArtifactReference
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "artifact_attached", (current) => {
      if (current.artifactReferences.some((candidate) => candidate.id === reference.id)) return current;
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + 1,
        artifactReferences: [...current.artifactReferences, { ...reference }],
        updatedAt: this.#now()
      };
    });
  }

  async retainFacts(
    expectedRevision: number,
    facts: readonly ExecutionCheckpointSafeFact[]
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "facts_retained", (current) => {
      const existing = new Set(current.safeFacts.map((fact) => `${fact.kind}\0${fact.value}`));
      const additions = facts
        .filter((fact) => !existing.has(`${fact.kind}\0${fact.value}`))
        .slice(0, Math.max(0, EXECUTION_CHECKPOINT_MAX_FACTS - current.safeFacts.length));
      if (additions.length === 0) return current;
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + 1,
        safeFacts: [...current.safeFacts, ...additions.map((fact) => ({ ...fact }))],
        updatedAt: this.#now()
      };
    });
  }

  async retainResources(
    expectedRevision: number,
    resources: readonly ExecutionCheckpointResource[]
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "resources_retained", (current) => {
      if (!checkpointResourcesOnlyAdvance(current.resources ?? [], resources)) return current;
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + 1,
        resources: structuredClone([...resources]),
        updatedAt: this.#now()
      };
    });
  }

  async planOperation(
    expectedRevision: number,
    coordinates: ExecutionCheckpointOperationCoordinates
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "operation_planned", (current) => {
      const id = executionCheckpointOperationId(coordinates);
      const existingIndex = current.operations.findIndex((operation) => operation.id === id);
      const now = this.#now();
      if (existingIndex >= 0) {
        const existing = current.operations[existingIndex]!;
        if (existing.status !== "failed") return current;
        const operations = current.operations.map((operation, index) => index === existingIndex
          ? { ...operation, status: "planned" as const, updatedAt: now }
          : operation);
        return { ...current, revision: current.revision + 1, operations, updatedAt: now };
      }
      if (current.operations.length >= EXECUTION_CHECKPOINT_MAX_OPERATIONS) return current;
      return {
        ...current,
        revision: current.revision + 1,
        operations: [...current.operations, {
          id,
          ...coordinates,
          status: "planned",
          createdAt: now,
          updatedAt: now
        }],
        updatedAt: now
      };
    });
  }

  async dispatchOperation(
    expectedRevision: number,
    operationId: string
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#updateOperation(expectedRevision, operationId, "operation_dispatched", "dispatched", true);
  }

  async settleOperation(
    expectedRevision: number,
    operationId: string,
    status: Extract<ExecutionCheckpointOperationStatus, "settled" | "failed" | "uncertain">
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#updateOperation(expectedRevision, operationId, "operation_settled", status, false);
  }

  async verifyOperation(
    expectedRevision: number,
    operationId: string,
    outcome: "present" | "absent"
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#updateOperation(
      expectedRevision,
      operationId,
      "operation_verified",
      outcome === "present" ? "verified" : "failed",
      true
    );
  }

  async updateAuthenticationRecoveryStage(
    expectedRevision: number,
    stage: ExecutionCheckpointAuthenticationStage | undefined
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, "authentication_stage_updated", (current) => {
      if (current.authenticationRecoveryStage === stage) return current;
      const semanticProgress = authenticationStageAdvanced(current.authenticationRecoveryStage, stage);
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + (semanticProgress ? 1 : 0),
        ...(stage === undefined
          ? { authenticationRecoveryStage: undefined }
          : { authenticationRecoveryStage: stage }),
        updatedAt: this.#now()
      };
    });
  }

  async prepareForTurn(userText: string): Promise<ExecutionCheckpointTurnPreparation> {
    const current = this.current();
    if (current === undefined || isTerminalCheckpointStatus(current.status)) {
      return { disposition: "none" };
    }
    if (isExplicitCheckpointCancellation(userText)) {
      const checkpoint = await this.#close(current.revision, "cancelled", "cancelled");
      return { disposition: "cancelled", ...(checkpoint === undefined ? {} : { checkpoint }) };
    }
    if (isCheckpointCorrection(userText, current)) {
      const checkpoint = await this.#transition(current.revision, "corrected", (checkpoint) => ({
        ...checkpoint,
        revision: checkpoint.revision + 1,
        status: "active",
        blocker: undefined,
        latestUserCorrection: sanitizeCheckpointText(userText, 2_000),
        updatedAt: this.#now()
      }));
      return { disposition: "correction", ...(checkpoint === undefined ? {} : { checkpoint }) };
    }
    if (isCheckpointBlockerResponse(userText, current)) {
      return { disposition: "continuation", checkpoint: current };
    }
    if (!isAcknowledgementContinuation(userText) && isExplicitCheckpointSupersession(userText)) {
      const checkpoint = await this.#close(current.revision, "superseded", "superseded");
      return { disposition: "superseded", ...(checkpoint === undefined ? {} : { checkpoint }) };
    }
    return { disposition: "continuation", checkpoint: current };
  }

  async #close(
    expectedRevision: number,
    status: "cancelled" | "superseded",
    transition: Extract<ExecutionCheckpointTransition, "cancelled" | "superseded">
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, transition, (current) => ({
      ...current,
      revision: current.revision + 1,
      status,
      blocker: undefined,
      lastTerminationCause: status === "cancelled" ? "cancelled" : current.lastTerminationCause,
      updatedAt: this.#now()
    }));
  }

  async #updateOperation(
    expectedRevision: number,
    operationId: string,
    transition: Extract<ExecutionCheckpointTransition,
      "operation_dispatched" | "operation_settled" | "operation_verified">,
    status: ExecutionCheckpointOperationStatus,
    semanticProgress: boolean
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#transition(expectedRevision, transition, (current) => {
      const index = current.operations.findIndex((operation) => operation.id === operationId);
      const existingStatus = current.operations[index]?.status;
      const sourceAllowed = transition === "operation_dispatched"
        ? existingStatus === "planned"
        : transition === "operation_settled"
          ? existingStatus === "dispatched"
          : existingStatus !== undefined && ["dispatched", "settled", "uncertain"].includes(existingStatus);
      if (index < 0 || existingStatus === status || !sourceAllowed) return current;
      const now = this.#now();
      return {
        ...current,
        revision: current.revision + 1,
        progressRevision: current.progressRevision + (semanticProgress ? 1 : 0),
        operations: current.operations.map((operation, candidateIndex) => candidateIndex === index
          ? { ...operation, status, updatedAt: now }
          : operation),
        updatedAt: now
      };
    });
  }

  async #transition(
    expectedRevision: number,
    transition: ExecutionCheckpointTransition,
    update: (current: ForegroundExecutionCheckpoint) => ForegroundExecutionCheckpoint
  ): Promise<ForegroundExecutionCheckpoint | undefined> {
    return await this.#serialize(async () => {
      const current = this.#checkpoint;
      if (current === undefined) return undefined;
      if (current.revision !== expectedRevision) {
        throw new ExecutionCheckpointConflictError(
          `Checkpoint revision changed from ${expectedRevision} to ${current.revision}.`
        );
      }
      if (isTerminalCheckpointStatus(current.status)) return cloneExecutionCheckpoint(current);
      const next = validateExecutionCheckpoint({ ...update(current), sessionId: this.#sessionId() });
      if (next.revision === current.revision) return cloneExecutionCheckpoint(current);
      await this.#persist(transition, next);
      this.#checkpoint = next;
      return cloneExecutionCheckpoint(next);
    });
  }

  async #persist(
    transition: ExecutionCheckpointTransition,
    checkpoint: ForegroundExecutionCheckpoint
  ): Promise<void> {
    await this.#record?.(checkpointEvent(transition, checkpoint));
  }

  async #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#writeQueue.then(work, work);
    this.#writeQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function authenticationStageAdvanced(
  current: ExecutionCheckpointAuthenticationStage | undefined,
  next: ExecutionCheckpointAuthenticationStage | undefined
): boolean {
  if (current !== undefined && next === undefined) return true;
  const rank: Record<ExecutionCheckpointAuthenticationStage, number> = {
    credentials_submitted: 1,
    challenge_required: 2,
    challenge_submitted: 3,
    authentication_revalidation_required: 4
  };
  return next !== undefined && rank[next] > (current === undefined ? 0 : rank[current]);
}

export function executionCheckpointOperationId(coordinates: ExecutionCheckpointOperationCoordinates): string {
  return `operation:${createHash("sha256").update(JSON.stringify([
    coordinates.connectorId,
    coordinates.operation,
    coordinates.destinationId ?? null,
    coordinates.subjectId ?? null,
    coordinates.artifactHash ?? null,
    coordinates.operationRevision
  ])).digest("hex").slice(0, 32)}`;
}

function settlementStatus(
  input: ExecutionCheckpointAttemptSettlement,
  current: ForegroundExecutionCheckpoint
): ForegroundExecutionCheckpoint["status"] {
  const { outcome } = input;
  if (
    (outcome.status === "completed" || outcome.status === "completed_with_recovered_errors") &&
    outcome.completionFloor === current.completionFloor
  ) return "completed";
  if (outcome.terminationCause === "user_input_required") return "awaiting_user";
  if (
    outcome.terminationCause === "provider_failed" ||
    outcome.terminationCause === "budget_exhausted" ||
    outcome.terminationCause === "deadline_reached" ||
    outcome.status === "partially_completed" ||
    outcome.status === "cancelled"
  ) return "retryable";
  return "blocked";
}

function settlementBlocker(
  input: ExecutionCheckpointAttemptSettlement,
  status: ForegroundExecutionCheckpoint["status"]
): ExecutionCheckpointBlocker | undefined {
  if (status !== "awaiting_user") return undefined;
  return {
    kind: "user_input_required",
    summary: "Execution is waiting for user input before it can continue."
  };
}

function isExplicitCheckpointCancellation(text: string): boolean {
  return /^(?:(?:stop|never\s*mind|nevermind|cancel|drop\s+it|cancel\s+that|forget\s+that)|(?:توقف|ألغ\s+ذلك|الغ\s+ذلك|دعك\s+من\s+ذلك))(?:[.!…]+)?$/iu.test(text.normalize("NFKC").trim());
}

function isExplicitCheckpointSupersession(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return /^\/[a-z0-9][a-z0-9_-]*(?:\s|$)/iu.test(normalized) ||
    /^(?:(?:forget\s+that|never\s*mind\s+that|new\s+topic)|(?:(?:انس|انسى|دعك\s+من)\s+(?:ذلك|هذا)|موضوع\s+جديد))\s*[:.!،-]\s*[\p{L}\p{N}]/iu.test(normalized) ||
    /^(?:ok(?:ay)?|yes|great|thanks?)[,!.، -]+(?:now\s+)?(?:can\s+you|please|tell\s+me|explain|review|implement|fix|write|create|show|summarize|search|run|update|change|add|remove)\b/iu.test(normalized) ||
    isExplicitNewRequest(normalized);
}

function isCheckpointBlockerResponse(
  text: string,
  checkpoint: ForegroundExecutionCheckpoint
): boolean {
  if (checkpoint.status !== "awaiting_user" || checkpoint.blocker?.kind !== "user_input_required") {
    return false;
  }
  const normalized = text.normalize("NFKC").trim();
  return /^(?:please\s+)?(?:continue|done|ready|approved|entered|submitted|sent|provided|i\s+(?:entered|submitted|sent|provided)|the\s+(?:code|otp)|(?:code|otp)\s+is)\b/iu.test(normalized) ||
    /^\d{4,12}$/u.test(normalized) ||
    /^(?:تابع|تم|جاهز|وافقت|أدخلت|أرسلت|قدمت|الرمز)/u.test(normalized);
}

function isCheckpointCorrection(
  text: string,
  checkpoint: ForegroundExecutionCheckpoint
): boolean {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  const correctionCue = /\b(?:actually|instead|other|different|same|switch|change|correction|correct)\b/iu.test(normalized) ||
    /(?:بدل[ًا]?|الأخر(?:ى)?|الآخر(?:ة)?|غي[ّ]?ر|تصحيح)/u.test(normalized);
  if (!correctionCue) return false;
  const missionSurface = [
    checkpoint.selectedSkillName,
    ...checkpoint.connectorIds,
    "workspace",
    "collection",
    "account",
    "destination",
    "product",
    "api",
    "browser",
    "tab",
    "مساحة العمل",
    "مجموعة",
    "حساب",
    "وجهة",
    "منتج",
    "واجهة",
    "متصفح",
    "تبويب"
  ].filter((value): value is string => value !== undefined);
  return missionSurface.some((value) => normalized.includes(value.toLocaleLowerCase("en-US")));
}
