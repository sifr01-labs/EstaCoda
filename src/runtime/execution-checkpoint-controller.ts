import { randomUUID } from "node:crypto";
import type {
  ExecutionCheckpointAttemptSettlement,
  ExecutionCheckpointBlocker,
  ExecutionCheckpointArtifactReference,
  ExecutionCheckpointCreationInput,
  ExecutionCheckpointLifecycleEvent,
  ExecutionCheckpointReader,
  ExecutionCheckpointTransition,
  ForegroundExecutionCheckpoint
} from "../contracts/execution-checkpoint.js";
import { EXECUTION_CHECKPOINT_VERSION } from "../contracts/execution-checkpoint.js";
import {
  checkpointEvent,
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
