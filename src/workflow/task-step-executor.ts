import type {
  Task,
  TaskAttempt,
  TaskAttemptLease,
  TaskFailure,
  TaskResultKind,
  TaskStep,
  TaskUsageTotals
} from "../contracts/task.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { ProviderSpendDenialReason } from "../contracts/provider-spend.js";
import type { TaskApprovalRequest } from "./task-approval-service.js";

export const TASK_STEP_HOST_HANDOFF_ABORT_REASON = "task-step-host-handoff";

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
      usageEntries?: readonly ProviderUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "failed";
      failure: TaskFailure;
      /** Safe, inspection-only output. It never satisfies dependencies or changes the failed outcome. */
      diagnosticResults?: readonly TaskExecutorResultContent[];
      usage?: TaskUsageTotals;
      usageEntries?: readonly ProviderUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "waiting_for_approval";
      approval: TaskApprovalRequest;
      usage?: TaskUsageTotals;
      usageEntries?: readonly ProviderUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "spending_denied";
      reason: ProviderSpendDenialReason;
      usage?: TaskUsageTotals;
      usageEntries?: readonly ProviderUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    }
  | {
      outcome: "cancelled";
      usage?: TaskUsageTotals;
      usageEntries?: readonly ProviderUsageEntry[];
      workerSessionId?: string;
      trajectoryId?: string;
    };

export type TaskAttemptCheckpoint = {
  workerSessionId?: string;
  trajectoryId?: string;
  activity?: TaskAttemptActivity;
};

export type TaskTraceCategory =
  | "terminal"
  | "search"
  | "plan"
  | "read"
  | "edit"
  | "answer"
  | "wait"
  | "finish"
  | "failed";

export type TaskAttemptActivity = {
  kind: "worker" | "provider" | "tool" | "assistant";
  label: string;
  traceCategory: TaskTraceCategory;
  toolCategory?: string;
  assistantPreview?: string;
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
