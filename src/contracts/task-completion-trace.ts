export type TaskCompletionTraceCategory =
  | "plan"
  | "search"
  | "read"
  | "execute"
  | "write"
  | "validate"
  | "wait"
  | "retry"
  | "failure"
  | "deliver";

export type TaskCompletionTraceOutcome =
  | "complete"
  | "complete_with_warnings"
  | "failed"
  | "cancelled";

export type TaskCompletionTraceSpan = {
  readonly category: TaskCompletionTraceCategory;
  readonly scope: {
    readonly kind: "task" | "subagent" | "synthesis" | "delivery";
    readonly label: string;
  };
  readonly status: "completed" | "failed";
  readonly durationMs: number;
  readonly label: string;
};

/** Versioned, bounded presentation snapshot persisted with a delivered Task answer. */
export type TaskCompletionTraceSnapshot = {
  readonly version: 1;
  readonly taskId: string;
  readonly stage: "task" | "synthesis" | "delivery";
  readonly outcome: TaskCompletionTraceOutcome;
  readonly answerAvailable: boolean;
  readonly activityCount: number;
  readonly activityCountComplete: boolean;
  readonly totalDurationMs: number;
  readonly hasEarlierActivities: boolean;
  readonly spans: readonly TaskCompletionTraceSpan[];
  readonly workerOutcomes?: {
    readonly usable: number;
    readonly failed: number;
    readonly cancelled: number;
    /** Optional only for version-1 snapshots written before lifecycle integration. */
    readonly total?: number;
  };
};
