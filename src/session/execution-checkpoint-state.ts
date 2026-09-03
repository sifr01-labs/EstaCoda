import type {
  ExecutionCheckpointBlocker,
  ExecutionCheckpointAuthenticationStage,
  ExecutionCheckpointLifecycleEvent,
  ExecutionCheckpointOperation,
  ExecutionCheckpointOperationRequirement,
  ExecutionCheckpointQualificationReason,
  ExecutionCheckpointSafeFact,
  ExecutionCheckpointStatus,
  ForegroundExecutionCheckpoint
} from "../contracts/execution-checkpoint.js";
import {
  EXECUTION_CHECKPOINT_MAX_BLOCKER_CHARS,
  EXECUTION_CHECKPOINT_MAX_ARTIFACTS,
  EXECUTION_CHECKPOINT_MAX_CONNECTORS,
  EXECUTION_CHECKPOINT_MAX_FACTS,
  EXECUTION_CHECKPOINT_MAX_LABELS,
  EXECUTION_CHECKPOINT_MAX_OBJECTIVE_CHARS,
  EXECUTION_CHECKPOINT_MAX_OPERATIONS,
  EXECUTION_CHECKPOINT_MAX_SERIALIZED_BYTES,
  EXECUTION_CHECKPOINT_VERSION
} from "../contracts/execution-checkpoint.js";
import type {
  ExecutionCompletionFloor,
  ExecutionEvidenceRecord,
  ExecutionTerminationCause
} from "../contracts/execution-plan.js";
import type { IntentTaskClass } from "../contracts/intent.js";
import type { SessionEvent } from "../contracts/session.js";
import { redactString, redactValue } from "../utils/redaction.js";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const STATUSES = new Set<ExecutionCheckpointStatus>([
  "active", "awaiting_user", "retryable", "blocked", "completed", "cancelled", "superseded"
]);
const QUALIFICATION_REASONS = new Set<ExecutionCheckpointQualificationReason>([
  "cross_system", "verified_mutation", "external_multi_step", "user_input_interruption", "multi_item"
]);
const OPERATION_REQUIREMENTS = new Set<ExecutionCheckpointOperationRequirement>([
  "read", "mutation", "verification", "artifact_relay", "protected_transfer"
]);
const COMPLETION_FLOORS = new Set<ExecutionCompletionFloor>([
  "none", "read", "mutation", "mutation_with_verification"
]);
const TERMINATION_CAUSES = new Set<ExecutionTerminationCause>([
  "normal", "provider_failed", "budget_exhausted", "browser_no_progress", "tool_loop_no_progress",
  "user_input_required", "deadline_reached", "cancelled"
]);
const TASK_CLASSES = new Set<IntentTaskClass>([
  "conversation", "repo-inspection", "code-review", "repo-change", "docs-writing",
  "release-validation", "provider-diagnostics", "browser-operation", "architecture-advice",
  "research", "media-generation", "attachment-analysis", "general"
]);
const CHECKPOINT_KEYS = new Set([
  "version", "id", "sessionId", "profileId", "originTurnId", "revision", "progressRevision",
  "originalObjective", "latestUserCorrection", "status", "qualificationReasons", "selectedSkillName", "taskClass",
  "intentLabels", "requiredOperations", "connectorIds", "completionFloor", "blocker",
  "artifactReferences", "safeFacts", "operations", "authenticationRecoveryStage",
  "lastTerminationCause", "lastProviderFailureClass", "createdAt", "updatedAt"
]);
const TRANSITIONS = new Set<ExecutionCheckpointLifecycleEvent["transition"]>([
  "created", "carried_forward", "corrected", "artifact_attached", "facts_retained", "operation_planned",
  "operation_dispatched", "operation_settled", "operation_verified", "authentication_stage_updated",
  "attempt_settled", "blocked", "cancelled", "superseded"
]);
const SAFE_FACT_KINDS = new Set<ExecutionCheckpointSafeFact["kind"]>([
  "workspace_id", "collection_id", "specification_id", "product_name", "artifact_id", "artifact_hash"
]);
const OPERATION_STATUSES = new Set<ExecutionCheckpointOperation["status"]>([
  "planned", "dispatched", "settled", "verified", "failed", "uncertain"
]);
const AUTHENTICATION_RECOVERY_STAGES = new Set<ExecutionCheckpointAuthenticationStage>([
  "credentials_submitted",
  "challenge_required",
  "challenge_submitted",
  "authentication_revalidation_required"
]);

export class ExecutionCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionCheckpointValidationError";
  }
}

export function cloneExecutionCheckpoint(
  checkpoint: ForegroundExecutionCheckpoint
): ForegroundExecutionCheckpoint {
  return {
    ...checkpoint,
    qualificationReasons: [...checkpoint.qualificationReasons],
    intentLabels: [...checkpoint.intentLabels],
    requiredOperations: [...checkpoint.requiredOperations],
    connectorIds: [...checkpoint.connectorIds],
    artifactReferences: checkpoint.artifactReferences.map((reference) => ({ ...reference })),
    safeFacts: checkpoint.safeFacts.map((fact) => ({ ...fact })),
    operations: checkpoint.operations.map((operation) => ({ ...operation })),
    ...(checkpoint.blocker === undefined ? {} : { blocker: { ...checkpoint.blocker } })
  };
}

/**
 * Replays only a coherent, profile-owned checkpoint chain. Malformed, stale,
 * conflicting, and cross-owner events are ignored rather than entering runtime state.
 */
export function hydratableExecutionCheckpoint(input: {
  events: readonly SessionEvent[];
  sessionId: string;
  profileId: string;
}): ForegroundExecutionCheckpoint | undefined {
  let current: ForegroundExecutionCheckpoint | undefined;
  let receiptDerivedCompletion = false;
  let observedReceiptFloor: ExecutionCompletionFloor | undefined;
  const successfulMutations = new Map<string, string>();
  for (const event of input.events) {
    if (event.kind === "execution-evidence-recorded" && event.status === "success") {
      observedReceiptFloor = strongestCompletionFloor(
        observedReceiptFloor,
        receiptFloor(event, successfulMutations)
      );
      if (event.executionEffect?.kind === "mutation") {
        successfulMutations.set(event.toolCallId, event.tool);
      }
      continue;
    }
    if (event.kind === "execution-final-outcome-recorded") {
      const expectedFloor = current?.completionFloor ?? event.completionFloor;
      receiptDerivedCompletion = (
        event.status === "completed" || event.status === "completed_with_recovered_errors"
      ) && event.completionFloor === expectedFloor && completionFloorCoveredByReceipt(expectedFloor, observedReceiptFloor);
      observedReceiptFloor = undefined;
      continue;
    }
    if (event.kind !== "execution-checkpoint-updated") continue;
    if (!TRANSITIONS.has(event.transition)) continue;
    let candidate: ForegroundExecutionCheckpoint;
    try {
      candidate = validateExecutionCheckpoint(event.checkpoint);
    } catch {
      continue;
    }
    if (candidate.sessionId !== input.sessionId || candidate.profileId !== input.profileId) continue;
    if (candidate.status === "completed" && !receiptDerivedCompletion) continue;
    if (current === undefined) {
      if (
        (event.transition !== "created" && event.transition !== "carried_forward") ||
        (event.transition === "created" && (
          candidate.revision !== 1 || candidate.progressRevision !== 0 || candidate.status !== "active" ||
          candidate.artifactReferences.length !== 0 || candidate.safeFacts.length !== 0 || candidate.operations.length !== 0 ||
          candidate.authenticationRecoveryStage !== undefined
        )) ||
        isTerminalCheckpointStatus(candidate.status)
      ) continue;
      current = candidate;
      receiptDerivedCompletion = false;
      observedReceiptFloor = undefined;
      successfulMutations.clear();
      continue;
    }
    if (candidate.id === current.id) {
      if (isTerminalCheckpointStatus(current.status)) continue;
      if (candidate.revision !== current.revision + 1) continue;
      if (!sameImmutableCheckpointState(current, candidate)) continue;
      if (!isCoherentTransition(event.transition, current, candidate)) continue;
      if (candidate.status === "completed" && !receiptDerivedCompletion) continue;
      current = candidate;
      receiptDerivedCompletion = false;
      continue;
    }
    if (
      !isTerminalCheckpointStatus(current.status) ||
      event.transition !== "created" ||
      candidate.revision !== 1 ||
      candidate.status !== "active"
    ) continue;
    current = candidate;
    receiptDerivedCompletion = false;
    observedReceiptFloor = undefined;
    successfulMutations.clear();
  }
  return current === undefined ? undefined : cloneExecutionCheckpoint(current);
}

function receiptFloor(
  event: Extract<ExecutionEvidenceRecord, { status: "success" }>,
  successfulMutations: ReadonlyMap<string, string>
): ExecutionCompletionFloor {
  if (
    event.executionEffect?.kind === "verification" &&
    event.verifiedMutation !== undefined &&
    successfulMutations.get(event.verifiedMutation.toolCallId) === event.verifiedMutation.tool
  ) {
    return "mutation_with_verification";
  }
  if (event.executionEffect?.kind === "mutation" || (
    event.riskClass !== "read-only-local" && event.riskClass !== "read-only-network"
  )) return "mutation";
  return "read";
}

function strongestCompletionFloor(
  current: ExecutionCompletionFloor | undefined,
  candidate: ExecutionCompletionFloor
): ExecutionCompletionFloor {
  const rank: Record<ExecutionCompletionFloor, number> = {
    none: 0,
    read: 1,
    mutation: 2,
    mutation_with_verification: 3
  };
  return current === undefined || rank[candidate] > rank[current] ? candidate : current;
}

function completionFloorCoveredByReceipt(
  required: ExecutionCompletionFloor,
  observed: ExecutionCompletionFloor | undefined
): boolean {
  if (observed === undefined) return false;
  if (required === "none" || required === "read") return true;
  if (required === "mutation") return observed === "mutation" || observed === "mutation_with_verification";
  return observed === "mutation_with_verification";
}

function isCoherentTransition(
  transition: ExecutionCheckpointLifecycleEvent["transition"],
  current: ForegroundExecutionCheckpoint,
  candidate: ForegroundExecutionCheckpoint
): boolean {
  if (Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt)) return false;
  const correctionUnchanged = candidate.latestUserCorrection === current.latestUserCorrection;
  const progressDelta = candidate.progressRevision - current.progressRevision;
  if (transition === "corrected") {
    return candidate.status === "active" && progressDelta === 0 &&
      candidate.latestUserCorrection !== undefined && !correctionUnchanged &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      sameOperations(current.operations, candidate.operations) &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage;
  }
  if (transition === "artifact_attached") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 1 &&
      candidate.artifactReferences.length === current.artifactReferences.length + 1 &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      sameOperations(current.operations, candidate.operations) &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage &&
      current.artifactReferences.every((reference, index) =>
        sameArtifactReference(reference, candidate.artifactReferences[index])
      );
  }
  if (transition === "facts_retained") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 1 &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameOperations(current.operations, candidate.operations) &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage &&
      safeFactsOnlyAdvance(current.safeFacts, candidate.safeFacts);
  }
  if (transition === "operation_planned") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 0 &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      operationTransitionIs(current.operations, candidate.operations, "planned") &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage;
  }
  if (transition === "operation_dispatched") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 1 &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      operationTransitionIs(current.operations, candidate.operations, "dispatched") &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage;
  }
  if (transition === "operation_settled") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 0 &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      operationTransitionIs(current.operations, candidate.operations, "settled", "failed", "uncertain") &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage;
  }
  if (transition === "operation_verified") {
    return candidate.status === current.status && correctionUnchanged && progressDelta === 1 &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      operationTransitionIs(current.operations, candidate.operations, "verified", "failed") &&
      current.authenticationRecoveryStage === candidate.authenticationRecoveryStage;
  }
  if (transition === "authentication_stage_updated") {
    return candidate.status === current.status && correctionUnchanged &&
      sameArtifactReferences(current.artifactReferences, candidate.artifactReferences) &&
      sameSafeFacts(current.safeFacts, candidate.safeFacts) &&
      sameOperations(current.operations, candidate.operations) &&
      candidate.authenticationRecoveryStage !== current.authenticationRecoveryStage &&
      progressDelta === (authenticationStageAdvanced(
        current.authenticationRecoveryStage,
        candidate.authenticationRecoveryStage
      ) ? 1 : 0);
  }
  if (!correctionUnchanged) return false;
  if (!sameArtifactReferences(current.artifactReferences, candidate.artifactReferences)) return false;
  if (!sameSafeFacts(current.safeFacts, candidate.safeFacts)) return false;
  if (!sameOperations(current.operations, candidate.operations)) return false;
  if (current.authenticationRecoveryStage !== candidate.authenticationRecoveryStage) return false;
  if (transition === "attempt_settled") {
    const statusAllowed = candidate.status === "awaiting_user" || candidate.status === "retryable" ||
      candidate.status === "blocked" || candidate.status === "completed";
    return statusAllowed && progressDelta === (candidate.status === "completed" ? 1 : 0);
  }
  if (transition === "blocked") {
    return (candidate.status === "blocked" || candidate.status === "awaiting_user") && progressDelta === 0;
  }
  if (transition === "cancelled") return candidate.status === "cancelled" && progressDelta === 0;
  if (transition === "superseded") return candidate.status === "superseded" && progressDelta === 0;
  return false;
}

function sameImmutableCheckpointState(
  current: ForegroundExecutionCheckpoint,
  candidate: ForegroundExecutionCheckpoint
): boolean {
  return current.id === candidate.id &&
    current.sessionId === candidate.sessionId &&
    current.profileId === candidate.profileId &&
    current.originTurnId === candidate.originTurnId &&
    current.originalObjective === candidate.originalObjective &&
    current.createdAt === candidate.createdAt &&
    current.selectedSkillName === candidate.selectedSkillName &&
    current.taskClass === candidate.taskClass &&
    current.completionFloor === candidate.completionFloor &&
    sameStringArray(current.qualificationReasons, candidate.qualificationReasons) &&
    sameStringArray(current.intentLabels, candidate.intentLabels) &&
    sameStringArray(current.requiredOperations, candidate.requiredOperations) &&
    sameStringArray(current.connectorIds, candidate.connectorIds);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function executionCheckpointCarryForwardEvent(input: {
  events: readonly SessionEvent[];
  sourceSessionId: string;
  sessionId: string;
  profileId: string;
}): ExecutionCheckpointLifecycleEvent | undefined {
  const latest = hydratableExecutionCheckpoint({
    events: input.events,
    sessionId: input.sourceSessionId,
    profileId: input.profileId
  });
  if (latest === undefined || isTerminalCheckpointStatus(latest.status)) return undefined;
  return checkpointEvent("carried_forward", validateExecutionCheckpoint({
    ...latest,
    sessionId: input.sessionId,
    profileId: input.profileId
  }));
}

export function validateExecutionCheckpoint(input: unknown): ForegroundExecutionCheckpoint {
  if (!isRecord(input)) throw new ExecutionCheckpointValidationError("Checkpoint must be an object.");
  const unknownKeys = Object.keys(input).filter((key) => !CHECKPOINT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ExecutionCheckpointValidationError("Checkpoint contains unsupported state.");
  }
  if (input.version !== EXECUTION_CHECKPOINT_VERSION) {
    throw new ExecutionCheckpointValidationError("Checkpoint version is unsupported.");
  }
  const status = enumValue(input.status, STATUSES, "status");
  const checkpoint: ForegroundExecutionCheckpoint = {
    version: EXECUTION_CHECKPOINT_VERSION,
    id: token(input.id, "id", 128),
    sessionId: token(input.sessionId, "sessionId", 256),
    profileId: token(input.profileId, "profileId", 128),
    originTurnId: token(input.originTurnId, "originTurnId", 256),
    revision: positiveInteger(input.revision, "revision"),
    progressRevision: nonNegativeInteger(input.progressRevision, "progressRevision"),
    originalObjective: safePersistedText(input.originalObjective, "originalObjective", EXECUTION_CHECKPOINT_MAX_OBJECTIVE_CHARS),
    ...(input.latestUserCorrection === undefined
      ? {}
      : { latestUserCorrection: safePersistedText(input.latestUserCorrection, "latestUserCorrection", EXECUTION_CHECKPOINT_MAX_OBJECTIVE_CHARS) }),
    status,
    qualificationReasons: enumArray(
      input.qualificationReasons,
      QUALIFICATION_REASONS,
      "qualificationReasons",
      5,
      true
    ),
    ...(input.selectedSkillName === undefined
      ? {}
      : { selectedSkillName: token(input.selectedSkillName, "selectedSkillName", 128) }),
    ...(input.taskClass === undefined ? {} : { taskClass: enumValue(input.taskClass, TASK_CLASSES, "taskClass") }),
    intentLabels: boundedTextArray(input.intentLabels, "intentLabels", EXECUTION_CHECKPOINT_MAX_LABELS, 80),
    requiredOperations: enumArray(
      input.requiredOperations,
      OPERATION_REQUIREMENTS,
      "requiredOperations",
      5,
      true
    ),
    connectorIds: boundedTextArray(input.connectorIds, "connectorIds", EXECUTION_CHECKPOINT_MAX_CONNECTORS, 128),
    artifactReferences: artifactReferences(input.artifactReferences),
    safeFacts: safeFacts(input.safeFacts),
    operations: operations(input.operations),
    ...(input.authenticationRecoveryStage === undefined
      ? {}
      : {
          authenticationRecoveryStage: enumValue(
            input.authenticationRecoveryStage,
            AUTHENTICATION_RECOVERY_STAGES,
            "authenticationRecoveryStage"
          )
        }),
    completionFloor: enumValue(input.completionFloor, COMPLETION_FLOORS, "completionFloor"),
    ...(input.blocker === undefined ? {} : { blocker: validateBlocker(input.blocker) }),
    ...(input.lastTerminationCause === undefined
      ? {}
      : { lastTerminationCause: enumValue(input.lastTerminationCause, TERMINATION_CAUSES, "lastTerminationCause") }),
    ...(input.lastProviderFailureClass === undefined
      ? {}
      : { lastProviderFailureClass: token(input.lastProviderFailureClass, "lastProviderFailureClass", 80) }),
    createdAt: timestamp(input.createdAt, "createdAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt")
  };
  if (checkpoint.progressRevision > checkpoint.revision) {
    throw new ExecutionCheckpointValidationError("Checkpoint progress revision exceeds its state revision.");
  }
  if (Date.parse(checkpoint.updatedAt) < Date.parse(checkpoint.createdAt)) {
    throw new ExecutionCheckpointValidationError("Checkpoint update precedes its creation.");
  }
  if (checkpoint.status === "awaiting_user" && checkpoint.blocker?.kind !== "user_input_required") {
    throw new ExecutionCheckpointValidationError("An awaiting-user checkpoint requires a user-input blocker.");
  }
  if ((checkpoint.status === "completed" || checkpoint.status === "cancelled" || checkpoint.status === "superseded") && checkpoint.blocker !== undefined) {
    throw new ExecutionCheckpointValidationError("A terminal checkpoint cannot retain a blocker.");
  }
  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > EXECUTION_CHECKPOINT_MAX_SERIALIZED_BYTES) {
    throw new ExecutionCheckpointValidationError("Checkpoint exceeds its serialized size limit.");
  }
  return checkpoint;
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

function artifactReferences(input: unknown): ForegroundExecutionCheckpoint["artifactReferences"] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > EXECUTION_CHECKPOINT_MAX_ARTIFACTS) {
    throw new ExecutionCheckpointValidationError("artifactReferences is not a bounded array.");
  }
  const references = input.map((value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "id" && key !== "sha256")) {
      throw new ExecutionCheckpointValidationError("artifactReferences contains malformed state.");
    }
    return {
      id: token(value.id, "artifactReferences.id", 200),
      sha256: sha256(value.sha256)
    };
  });
  if (new Set(references.map((reference) => reference.id)).size !== references.length) {
    throw new ExecutionCheckpointValidationError("artifactReferences contains duplicates.");
  }
  return references;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ExecutionCheckpointValidationError("artifactReferences.sha256 is invalid.");
  }
  return value;
}

function sameArtifactReferences(
  left: ForegroundExecutionCheckpoint["artifactReferences"],
  right: ForegroundExecutionCheckpoint["artifactReferences"]
): boolean {
  return left.length === right.length && left.every((reference, index) => sameArtifactReference(reference, right[index]));
}

function sameArtifactReference(
  left: ForegroundExecutionCheckpoint["artifactReferences"][number],
  right: ForegroundExecutionCheckpoint["artifactReferences"][number] | undefined
): boolean {
  return right !== undefined && left.id === right.id && left.sha256 === right.sha256;
}

function safeFacts(input: unknown): ExecutionCheckpointSafeFact[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > EXECUTION_CHECKPOINT_MAX_FACTS) {
    throw new ExecutionCheckpointValidationError("safeFacts is not a bounded array.");
  }
  const facts = input.map((value) => {
    if (!isRecord(value) || Object.keys(value).some((key) =>
      !["kind", "value", "sourceTool", "connectorId", "observedAt"].includes(key)
    )) throw new ExecutionCheckpointValidationError("safeFacts contains malformed state.");
    const kind = enumValue(value.kind, SAFE_FACT_KINDS, "safeFacts.kind");
    const factValue = kind === "artifact_hash"
      ? sha256(value.value)
      : kind === "product_name"
        ? safePersistedText(value.value, "safeFacts.value", 160)
        : token(value.value, "safeFacts.value", 200);
    return {
      kind,
      value: factValue,
      sourceTool: token(value.sourceTool, "safeFacts.sourceTool", 160),
      ...(value.connectorId === undefined ? {} : { connectorId: token(value.connectorId, "safeFacts.connectorId", 128) }),
      observedAt: timestamp(value.observedAt, "safeFacts.observedAt")
    };
  });
  if (new Set(facts.map((fact) => `${fact.kind}\0${fact.value}`)).size !== facts.length) {
    throw new ExecutionCheckpointValidationError("safeFacts contains duplicates.");
  }
  return facts;
}

function operations(input: unknown): ExecutionCheckpointOperation[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > EXECUTION_CHECKPOINT_MAX_OPERATIONS) {
    throw new ExecutionCheckpointValidationError("operations is not a bounded array.");
  }
  const entries = input.map((value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => ![
      "id", "connectorId", "operation", "destinationId", "subjectId", "artifactHash",
      "operationRevision", "status", "createdAt", "updatedAt"
    ].includes(key))) throw new ExecutionCheckpointValidationError("operations contains malformed state.");
    const operation: ExecutionCheckpointOperation = {
      id: token(value.id, "operations.id", 80),
      connectorId: token(value.connectorId, "operations.connectorId", 128),
      operation: token(value.operation, "operations.operation", 160),
      ...(value.destinationId === undefined ? {} : {
        destinationId: operationCoordinate(value.destinationId, "operations.destinationId")
      }),
      ...(value.subjectId === undefined ? {} : {
        subjectId: operationCoordinate(value.subjectId, "operations.subjectId")
      }),
      ...(value.artifactHash === undefined ? {} : { artifactHash: sha256(value.artifactHash) }),
      operationRevision: boundedPositiveInteger(value.operationRevision, "operations.operationRevision", 1_000_000),
      status: enumValue(value.status, OPERATION_STATUSES, "operations.status"),
      createdAt: timestamp(value.createdAt, "operations.createdAt"),
      updatedAt: timestamp(value.updatedAt, "operations.updatedAt")
    };
    if (Date.parse(operation.updatedAt) < Date.parse(operation.createdAt)) {
      throw new ExecutionCheckpointValidationError("Operation update precedes its creation.");
    }
    if (operation.destinationId === undefined && operation.subjectId === undefined && operation.artifactHash === undefined) {
      throw new ExecutionCheckpointValidationError("Operation lacks reviewed semantic coordinates.");
    }
    return operation;
  });
  if (new Set(entries.map((operation) => operation.id)).size !== entries.length) {
    throw new ExecutionCheckpointValidationError("operations contains duplicate IDs.");
  }
  return entries;
}

function sameSafeFacts(
  left: readonly ExecutionCheckpointSafeFact[],
  right: readonly ExecutionCheckpointSafeFact[]
): boolean {
  return left.length === right.length && left.every((fact, index) => {
    const candidate = right[index];
    return candidate !== undefined && fact.kind === candidate.kind && fact.value === candidate.value &&
      fact.sourceTool === candidate.sourceTool && fact.connectorId === candidate.connectorId &&
      fact.observedAt === candidate.observedAt;
  });
}

function safeFactsOnlyAdvance(
  current: readonly ExecutionCheckpointSafeFact[],
  candidate: readonly ExecutionCheckpointSafeFact[]
): boolean {
  return candidate.length > current.length && current.every((fact, index) =>
    sameSafeFacts([fact], candidate[index] === undefined ? [] : [candidate[index]])
  );
}

function sameOperations(
  left: readonly ExecutionCheckpointOperation[],
  right: readonly ExecutionCheckpointOperation[]
): boolean {
  return left.length === right.length && left.every((operation, index) => {
    const candidate = right[index];
    return candidate !== undefined && sameOperationCore(operation, candidate) &&
      operation.status === candidate.status && operation.updatedAt === candidate.updatedAt;
  });
}

function operationTransitionIs(
  current: readonly ExecutionCheckpointOperation[],
  candidate: readonly ExecutionCheckpointOperation[],
  ...allowedStatuses: ExecutionCheckpointOperation["status"][]
): boolean {
  if (allowedStatuses.length === 1 && allowedStatuses[0] === "planned" && candidate.length === current.length + 1) {
    return sameOperations(current, candidate.slice(0, -1)) && candidate.at(-1)?.status === "planned";
  }
  if (candidate.length !== current.length) return false;
  let changed = 0;
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = candidate[index]!;
    if (!sameOperationCore(before, after)) return false;
    if (before.status === after.status && before.updatedAt === after.updatedAt) continue;
    changed += 1;
    if (!allowedStatuses.includes(after.status)) return false;
    if (after.status === "planned" && before.status !== "failed") return false;
    if (after.status === "dispatched" && before.status !== "planned") return false;
    if (["settled", "failed", "uncertain"].includes(after.status) &&
      !allowedStatuses.includes("verified") && before.status !== "dispatched") return false;
    if (after.status === "verified" && !["settled", "dispatched", "uncertain"].includes(before.status)) return false;
    if (after.status === "failed" && allowedStatuses.includes("verified") && !["settled", "dispatched", "uncertain"].includes(before.status)) return false;
  }
  return changed === 1;
}

function sameOperationCore(left: ExecutionCheckpointOperation, right: ExecutionCheckpointOperation): boolean {
  return left.id === right.id && left.connectorId === right.connectorId && left.operation === right.operation &&
    left.destinationId === right.destinationId && left.subjectId === right.subjectId &&
    left.artifactHash === right.artifactHash && left.operationRevision === right.operationRevision &&
    left.createdAt === right.createdAt;
}

export function sanitizeCheckpointText(value: string, maxChars: number): string {
  const normalized = normalizeText(value, Math.max(value.length, maxChars)).slice(0, maxChars).trim();
  const checkpointRedacted = normalized
    .replace(
      /\b((?:otp|mfa|2fa|one[ -]?time\s+(?:code|password)|verification\s+code)\s*(?::|=|\bis\b)?\s*)\d{4,10}\b/giu,
      "$1[REDACTED]"
    )
    .replace(
      /\b((?:client|consumer)[ -]?(?:key|secret)|password|api[ -]?key|access[ -]?token)\s*(?::|=|\bis\b)\s*[^\s,;]+/giu,
      "$1=[REDACTED]"
    );
  const structurallyRedacted = redactString(checkpointRedacted, { strict: true });
  const strictlyRedacted = redactValue("checkpointText", structurallyRedacted, { strict: true });
  const redacted = typeof strictlyRedacted === "string" ? strictlyRedacted : "[REDACTED]";
  return redacted.slice(0, maxChars).trim();
}

export function checkpointEvent(
  transition: ExecutionCheckpointLifecycleEvent["transition"],
  checkpoint: ForegroundExecutionCheckpoint
): ExecutionCheckpointLifecycleEvent {
  return { kind: "execution-checkpoint-updated", transition, checkpoint: cloneExecutionCheckpoint(checkpoint) };
}

export function isTerminalCheckpointStatus(status: ExecutionCheckpointStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "superseded";
}

function validateBlocker(input: unknown): ExecutionCheckpointBlocker {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "kind" && key !== "summary")) {
    throw new ExecutionCheckpointValidationError("Checkpoint blocker is malformed.");
  }
  const kinds = new Set<ExecutionCheckpointBlocker["kind"]>([
    "user_input_required", "approval_required", "missing_capability", "external_state"
  ]);
  return {
    kind: enumValue(input.kind, kinds, "blocker.kind"),
    summary: safePersistedText(input.summary, "blocker.summary", EXECUTION_CHECKPOINT_MAX_BLOCKER_CHARS)
  };
}

function safePersistedText(input: unknown, field: string, maxChars: number): string {
  if (typeof input !== "string") throw new ExecutionCheckpointValidationError(`${field} must be text.`);
  const normalized = normalizeText(input, maxChars);
  if (sanitizeCheckpointText(normalized, maxChars) !== normalized) {
    throw new ExecutionCheckpointValidationError(`${field} contains sensitive content.`);
  }
  return normalized;
}

/**
 * Operation coordinates are typed opaque identifiers supplied by reviewed tool
 * metadata. They must retain UUIDs and hashes that strict free-text entropy
 * filtering would otherwise mistake for credentials.
 */
function operationCoordinate(input: unknown, field: string): string {
  if (typeof input !== "string") throw new ExecutionCheckpointValidationError(`${field} must be text.`);
  const normalized = normalizeText(input, 200);
  if (redactString(normalized) !== normalized) {
    throw new ExecutionCheckpointValidationError(`${field} contains sensitive content.`);
  }
  if (!SAFE_TOKEN.test(normalized)) {
    throw new ExecutionCheckpointValidationError(`${field} is not a safe opaque identifier.`);
  }
  return normalized;
}

function normalizeText(input: string, maxChars: number): string {
  const normalized = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maxChars) {
    throw new ExecutionCheckpointValidationError(`Checkpoint text must contain 1-${maxChars} characters.`);
  }
  return normalized;
}

function boundedTextArray(input: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(input) || input.length > maxItems) {
    throw new ExecutionCheckpointValidationError(`${field} is not a bounded array.`);
  }
  const values = input.map((entry) => safePersistedText(entry, field, maxChars));
  if (new Set(values).size !== values.length) throw new ExecutionCheckpointValidationError(`${field} contains duplicates.`);
  return values;
}

function enumArray<T extends string>(
  input: unknown,
  allowed: ReadonlySet<T>,
  field: string,
  maxItems: number,
  requireOne: boolean
): T[] {
  if (!Array.isArray(input) || input.length > maxItems || (requireOne && input.length === 0)) {
    throw new ExecutionCheckpointValidationError(`${field} is not a bounded array.`);
  }
  const values = input.map((entry) => enumValue(entry, allowed, field));
  if (new Set(values).size !== values.length) throw new ExecutionCheckpointValidationError(`${field} contains duplicates.`);
  return values;
}

function enumValue<T extends string>(input: unknown, allowed: ReadonlySet<T>, field: string): T {
  if (typeof input !== "string" || !allowed.has(input as T)) {
    throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  }
  return input as T;
}

function token(input: unknown, field: string, maxChars: number): string {
  if (typeof input !== "string" || input.length > maxChars || !SAFE_TOKEN.test(input)) {
    throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  }
  return input as number;
}

function boundedPositiveInteger(input: unknown, field: string, max: number): number {
  const value = positiveInteger(input, field);
  if (value > max) throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  return value;
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  }
  return input as number;
}

function timestamp(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length > 64 || !Number.isFinite(Date.parse(input))) {
    throw new ExecutionCheckpointValidationError(`${field} is invalid.`);
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
