import type {
  ExecutionCompletionFloor,
  ConfirmedActionReceipt,
  ExecutionFinalOutcomeStatus,
  ExecutionTerminationCause,
  UncertainActionReceipt
} from "./execution-plan.js";

export type TrajectoryEventKind =
  | "session-start"
  | "user-input"
  | "context-expanded"
  | "skill-selected"
  | "skill-playbook-planned"
  | "skill-playbook-step"
  | "tool-plan"
  | "tool-call"
  | "tool-gated"
  | "tool-result"
  | "artifact-created"
  | "memory-write"
  | "memory-conclusion"
  | "memory-promotion"
  | "memory-promotion-failed"
  | "memory-file-compaction"
  | "provider-completion"
  | "provider-continuation"
  | "provider-iteration"
  | "provider-tool-inventory"
  | "provider-budget-exhausted"
  | "execution-plan-started"
  | "execution-plan-updated"
  | "execution-plan-completed"
  | "execution-plan-blocked"
  | "execution-plan-transferred"
  | "execution-plan-abandoned"
  | "execution-checkpoint-updated"
  | "execution-evidence-recorded"
  | "execution-final-outcome-recorded"
  | "skill-route-usage"
  | "skill-route-telemetry"
  | "skill-lifecycle-changed"
  | "security-risk-escalated"
  | "agent-cancelled"
  | "prompt-assembled"
  | "session-recall-stage"
  | "session-recall-decision"
  | "external-memory-recall"
  | "external-memory-mirror-write"
  | "session-history-packed"
  | "session-history-compressed"
  | "session-compression-state"
  | "progress"
  | "fallback"
  | "assistant-output"
  | "user-correction"
  | "session-end";

export type TrajectoryEvent = {
  id: string;
  kind: TrajectoryEventKind;
  timestamp: string;
  data: Record<string, unknown>;
};

export type Trajectory = {
  id: string;
  profileId: string;
  sessionId: string;
  modelId: string;
  events: TrajectoryEvent[];
  executionMetrics?: ExecutionMetricSnapshot;
  executionReferences?: { definitionRevision: string; authorityRevision: string };
  outcome?: {
    success: boolean;
    status?: ExecutionFinalOutcomeStatus;
    terminationCause?: ExecutionTerminationCause;
    completionFloor?: ExecutionCompletionFloor;
    summary: string;
    userAccepted?: boolean;
    confirmedActions?: ConfirmedActionReceipt[];
    uncertainActions?: UncertainActionReceipt[];
  };
};

export type CompressedTrajectory = {
  id: string;
  sourceTrajectoryId: string;
  summary: string;
  preservedEventIds: string[];
  evaluationSignals: Record<string, unknown>;
};

/** Bounded cumulative observations; missing usage is not zero-token inference. */
export type ExecutionMetricSnapshot = {
  version: 1; elapsedMs: number; providerCompletions: number; providerDispatches: number; reportedTokens: number; usageReports: number;
  approvalRequests: number; deniedTools: number; toolResults: number; failedTools: number; cancellations: number;
  checkpointUpdates: number; completedTurns: number; failedTurns: number;
};
