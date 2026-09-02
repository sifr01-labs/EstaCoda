import type { ExecutionCompletionFloor, ExecutionFinalOutcome, ExecutionTerminationCause } from "./execution-plan.js";
import type { IntentTaskClass } from "./intent.js";
import type { ProviderErrorClass } from "./provider.js";

export const EXECUTION_CHECKPOINT_VERSION = 1 as const;
export const EXECUTION_CHECKPOINT_MAX_SERIALIZED_BYTES = 16 * 1024;
export const EXECUTION_CHECKPOINT_MAX_OBJECTIVE_CHARS = 2_000;
export const EXECUTION_CHECKPOINT_MAX_LABELS = 16;
export const EXECUTION_CHECKPOINT_MAX_CONNECTORS = 8;
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
