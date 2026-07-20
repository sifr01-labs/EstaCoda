import type {
  Task,
  TaskAttempt,
  TaskAttemptLease,
  TaskFailure,
  TaskResultKind,
  TaskStep,
  TaskUsageEntry,
  TaskUsageTotals
} from "../contracts/task.js";
import type { TaskApprovalRequest } from "./task-approval-service.js";

export type TaskExecutorResultContent = {
  kind: TaskResultKind;
  content: string | Uint8Array;
  mimeType?: string;
  summary?: string;
  expiresAt?: string;
};

export type TaskExecutorSettlement =
  | {
      outcome: "succeeded";
      results?: readonly TaskExecutorResultContent[];
      usage?: TaskUsageTotals;
      usageEntries?: readonly TaskUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "failed";
      failure: TaskFailure;
      usage?: TaskUsageTotals;
      usageEntries?: readonly TaskUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "waiting_for_approval";
      approval: TaskApprovalRequest;
      usage?: TaskUsageTotals;
      usageEntries?: readonly TaskUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "cancelled";
      usage?: TaskUsageTotals;
      usageEntries?: readonly TaskUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    };

export type TaskAttemptCheckpoint = {
  workerSessionId?: string;
  trajectoryId?: string;
};

export type TaskStepExecutionInput = {
  task: Task;
  step: TaskStep;
  attempt: TaskAttempt;
  signal: AbortSignal;
  /** Renews the fenced lease. A cancellation request aborts the signal and is returned to the executor. */
  heartbeat: () => TaskAttemptLease;
  /** Durably links worker progress to the Attempt while renewing the same fenced lease. */
  checkpoint: (checkpoint: TaskAttemptCheckpoint) => TaskAttemptLease;
};

/** An executor performs one Attempt. It never decides Step or Task completion. */
export interface TaskStepExecutor {
  readonly kind: TaskStep["executor"]["kind"];
  execute(input: TaskStepExecutionInput): Promise<TaskExecutorSettlement>;
}

export type ResolveTaskStepExecutor = (task: Task, step: TaskStep) => TaskStepExecutor | undefined;
