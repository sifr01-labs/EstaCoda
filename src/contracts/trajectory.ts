export type TrajectoryEventKind =
  | "session-start"
  | "user-input"
  | "context-expanded"
  | "skill-selected"
  | "skill-workflow-planned"
  | "skill-workflow-step"
  | "tool-plan"
  | "tool-call"
  | "tool-gated"
  | "tool-result"
  | "artifact-created"
  | "memory-write"
  | "delegation-started"
  | "delegation-finished"
  | "provider-completion"
  | "provider-continuation"
  | "provider-iteration"
  | "provider-budget-exhausted"
  | "agent-cancelled"
  | "prompt-assembled"
  | "session-history-packed"
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
  outcome?: {
    success: boolean;
    summary: string;
    userAccepted?: boolean;
  };
};

export type CompressedTrajectory = {
  id: string;
  sourceTrajectoryId: string;
  summary: string;
  preservedEventIds: string[];
  evaluationSignals: Record<string, unknown>;
};
