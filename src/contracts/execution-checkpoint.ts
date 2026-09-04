import type { ExecutionCompletionFloor, ExecutionFinalOutcome, ExecutionTerminationCause } from "./execution-plan.js";
import type { IntentTaskClass } from "./intent.js";
import type { ProviderErrorClass } from "./provider.js";

export const EXECUTION_CHECKPOINT_VERSION = 1 as const;
// Resource continuity has its own allowance; it must not crowd out the operation journal.
export const EXECUTION_CHECKPOINT_MAX_SERIALIZED_BYTES = 24 * 1024;
export const EXECUTION_CHECKPOINT_MAX_RESOURCE_BYTES = 8 * 1024;
export const EXECUTION_CHECKPOINT_MAX_OBJECTIVE_CHARS = 2_000;
export const EXECUTION_CHECKPOINT_MAX_LABELS = 16;
export const EXECUTION_CHECKPOINT_MAX_CONNECTORS = 8;
export const EXECUTION_CHECKPOINT_MAX_ARTIFACTS = 16;
export const EXECUTION_CHECKPOINT_MAX_FACTS = 24;
export const EXECUTION_CHECKPOINT_MAX_RESOURCES = 16;
export const EXECUTION_CHECKPOINT_MAX_OPERATIONS = 16;
export const EXECUTION_CHECKPOINT_MAX_BLOCKER_CHARS = 500;

export type ExecutionCheckpointStatus =
  | "active"
  | "awaiting_user"
  | "retryable"
  | "blocked"
  | "completed"
  | "cancelled"
  | "superseded";

export type ExecutionCheckpointQualificationReason =
  | "cross_system"
  | "verified_mutation"
  | "external_multi_step"
  | "user_input_interruption"
  | "multi_item";

/** Coarse task needs. Concrete tools are always resolved from the current registry. */
export type ExecutionCheckpointOperationRequirement =
  | "read"
  | "mutation"
  | "verification"
  | "artifact_relay"
  | "protected_transfer";

export type ExecutionCheckpointBlocker = {
  kind: "user_input_required" | "approval_required" | "missing_capability" | "external_state";
  summary: string;
};

export type ExecutionCheckpointArtifactReference = {
  id: string;
  sha256: string;
};

export type ExecutionCheckpointSafeFactKind =
  | "resource_id"
  | "workspace_id"
  | "collection_id"
  | "specification_id"
  | "product_name"
  | "artifact_id"
  | "artifact_hash";

export type ExecutionCheckpointSafeFact = {
  kind: ExecutionCheckpointSafeFactKind;
  value: string;
  sourceTool: string;
  connectorId?: string;
  observedAt: string;
};

/** Grounded source identity and related receipts. No workflow stage or completion authority. */
export type ExecutionCheckpointResource = {
  id: string;
  name: string;
  sourceUrl: string;
  sourceTool: "browser.extract" | "browser.download";
  artifactReferences: ExecutionCheckpointArtifactReference[];
  destinationFacts: ExecutionCheckpointSafeFact[];
  operationIds: string[];
};

export type ExecutionCheckpointOperationStatus =
  | "planned"
  | "dispatched"
  | "settled"
  | "verified"
  | "failed"
  | "uncertain";

/** Reviewed semantic coordinates. No raw arguments or secret-derived hashes. */
export type ExecutionCheckpointOperationCoordinates = {
  connectorId: string;
  operation: string;
  destinationId?: string;
  subjectId?: string;
  artifactHash?: string;
  operationRevision: number;
};

export type ExecutionCheckpointOperation = ExecutionCheckpointOperationCoordinates & {
  id: string;
  status: ExecutionCheckpointOperationStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Restart-safe authentication recovery hint. Live browser evidence remains the
 * only authority for whether authentication has actually completed.
 */
export type ExecutionCheckpointAuthenticationStage =
  | "credentials_submitted"
  | "challenge_required"
  | "challenge_submitted"
  | "authentication_revalidation_required";

/**
 * Runtime-owned foreground continuity. It is not model-writable and grants no
 * tool, connector, authentication, approval, or completion authority.
 */
export type ForegroundExecutionCheckpoint = {
  version: typeof EXECUTION_CHECKPOINT_VERSION;
  id: string;
  sessionId: string;
  profileId: string;
  originTurnId: string;
  revision: number;
  /** Changes only for allowlisted semantic progress, never ordinary state writes. */
  progressRevision: number;
  originalObjective: string;
  /** Latest bounded user-authored correction; never provider-authored prose. */
  latestUserCorrection?: string;
  status: ExecutionCheckpointStatus;
  qualificationReasons: ExecutionCheckpointQualificationReason[];
  selectedSkillName?: string;
  taskClass?: IntentTaskClass;
  intentLabels: string[];
  requiredOperations: ExecutionCheckpointOperationRequirement[];
  connectorIds: string[];
  /** Session-owned references only. Local paths never enter checkpoint state. */
  artifactReferences: ExecutionCheckpointArtifactReference[];
  /** Fixed-schema, reviewed facts only; never arbitrary key/value memory. */
  safeFacts: ExecutionCheckpointSafeFact[];
  /** Optional for version-1 compatibility. Runtime-owned, bounded relational continuity. */
  resources?: ExecutionCheckpointResource[];
  /** Crash-aware external operation journal keyed only by reviewed coordinates. */
  operations: ExecutionCheckpointOperation[];
  /** Safe recovery hint only; never an authenticated-state assertion. */
  authenticationRecoveryStage?: ExecutionCheckpointAuthenticationStage;
  completionFloor: ExecutionCompletionFloor;
  blocker?: ExecutionCheckpointBlocker;
  lastTerminationCause?: ExecutionTerminationCause;
  lastProviderFailureClass?: ProviderErrorClass | string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionCheckpointTransition =
  | "created"
  | "carried_forward"
  | "corrected"
  | "artifact_attached"
  | "facts_retained"
  | "resources_retained"
  | "operation_planned"
  | "operation_dispatched"
  | "operation_settled"
  | "operation_verified"
  | "authentication_stage_updated"
  | "attempt_settled"
  | "blocked"
  | "cancelled"
  | "superseded";

export type ExecutionCheckpointLifecycleEvent = {
  kind: "execution-checkpoint-updated";
  transition: ExecutionCheckpointTransition;
  checkpoint: ForegroundExecutionCheckpoint;
};

export type ExecutionCheckpointCreationInput = {
  originTurnId: string;
  originalObjective: string;
  qualificationReasons: ExecutionCheckpointQualificationReason[];
  selectedSkillName?: string;
  taskClass?: IntentTaskClass;
  intentLabels: string[];
  requiredOperations: ExecutionCheckpointOperationRequirement[];
  connectorIds: string[];
  completionFloor: ExecutionCompletionFloor;
};

export type ExecutionCheckpointAttemptSettlement = {
  outcome: ExecutionFinalOutcome;
  providerFailureClass?: ProviderErrorClass | string;
};

export type ExecutionCheckpointReader = {
  current(): ForegroundExecutionCheckpoint | undefined;
};

/** Narrow runtime API used to retain artifacts before provider-loop continuation. */
export type ExecutionCheckpointArtifactController = ExecutionCheckpointReader & {
  attachArtifact(
    expectedRevision: number,
    reference: ExecutionCheckpointArtifactReference
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
};

export type ExecutionCheckpointJournalController = ExecutionCheckpointArtifactController & {
  retainResources(
    expectedRevision: number,
    resources: readonly ExecutionCheckpointResource[]
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
  retainFacts(
    expectedRevision: number,
    facts: readonly ExecutionCheckpointSafeFact[]
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
  planOperation(
    expectedRevision: number,
    coordinates: ExecutionCheckpointOperationCoordinates
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
  dispatchOperation(expectedRevision: number, operationId: string): Promise<ForegroundExecutionCheckpoint | undefined>;
  settleOperation(
    expectedRevision: number,
    operationId: string,
    status: Extract<ExecutionCheckpointOperationStatus, "settled" | "failed" | "uncertain">
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
  verifyOperation(
    expectedRevision: number,
    operationId: string,
    outcome: "present" | "absent"
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
};

export type ExecutionCheckpointSupervisionController = ExecutionCheckpointJournalController & {
  updateAuthenticationRecoveryStage(
    expectedRevision: number,
    stage: ExecutionCheckpointAuthenticationStage | undefined
  ): Promise<ForegroundExecutionCheckpoint | undefined>;
};
