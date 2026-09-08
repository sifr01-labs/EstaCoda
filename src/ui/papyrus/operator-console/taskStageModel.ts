import type { TaskCardState } from "./operatorConsoleState.js";

export type TaskStageName = "plan" | "subagents" | "synthesis" | "deliver";
export type TaskStageStatus = "completed" | "warning" | "active" | "pending" | "failed";

export type TaskStageState = {
  readonly name: TaskStageName;
  readonly status: TaskStageStatus;
};

export type TaskStageModel = {
  readonly stages: readonly TaskStageState[];
  readonly current: TaskStageName;
  readonly workerOutcomes?: {
    readonly usable: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly total: number;
  };
  readonly degraded: boolean;
};

const SETTLED_TASK_STATUSES: ReadonlySet<TaskCardState["status"]> = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

/** Derive the user-facing workflow without treating worker completion as Task completion. */
export function deriveTaskStageModel(card: TaskCardState): TaskStageModel {
  const workerProgress = card.phase.workerProgress;
  const current = currentStage(card);
  const degraded = card.status === "partial" ||
    (workerProgress !== undefined && (workerProgress.failed > 0 || workerProgress.cancelled > 0));
  return {
    current,
    degraded,
    ...(workerProgress === undefined ? {} : {
      workerOutcomes: {
        usable: workerProgress.usable,
        failed: workerProgress.failed,
        cancelled: workerProgress.cancelled,
        total: workerProgress.total,
      },
    }),
    stages: [
      { name: "plan", status: planStatus(card, current) },
      { name: "subagents", status: subagentStatus(card) },
      { name: "synthesis", status: synthesisStatus(card, current) },
      { name: "deliver", status: deliveryStatus(card, current) },
    ],
  };
}

function currentStage(card: TaskCardState): TaskStageName {
  if (SETTLED_TASK_STATUSES.has(card.status)) return "deliver";
  if (card.phase.name === "synthesizing" || hasActiveSynthesis(card)) return "synthesis";
  if (card.phase.name === "delegating" || card.subagents.length > 0) return "subagents";
  return "plan";
}

function planStatus(card: TaskCardState, current: TaskStageName): TaskStageStatus {
  if (current === "plan") return card.status === "failed" ? "failed" : "active";
  return card.planRevision !== undefined || card.steps.length > 0 ? "completed" : "pending";
}

function subagentStatus(card: TaskCardState): TaskStageStatus {
  const progress = card.phase.workerProgress;
  if (progress === undefined || progress.total === 0) return "pending";
  if (progress.settled < progress.total) return "active";
  if (progress.usable === 0 && (progress.failed > 0 || progress.cancelled > 0)) return "failed";
  if (progress.failed > 0 || progress.cancelled > 0) return "warning";
  return "completed";
}

function synthesisStatus(card: TaskCardState, current: TaskStageName): TaskStageStatus {
  const synthesis = card.steps.find((step) => step.executorRole === "synthesis");
  if (current === "synthesis") {
    if (synthesis?.status === "failed" || card.status === "failed") return "failed";
    if (synthesis?.status === "waiting_for_input" || synthesis?.status === "waiting_for_approval") return "warning";
    return "active";
  }
  if (current === "deliver") {
    if (card.status === "failed" || synthesis?.status === "failed") return "failed";
    if (card.status === "partial") return "warning";
    return synthesis?.status === "completed" || card.status === "completed" ? "completed" : "pending";
  }
  return "pending";
}

function deliveryStatus(card: TaskCardState, current: TaskStageName): TaskStageStatus {
  if (current !== "deliver") return "pending";
  if (card.status === "failed" || card.status === "cancelled") return "failed";
  if (card.status === "partial") return "warning";
  return card.status === "completed" ? "completed" : "active";
}

function hasActiveSynthesis(card: TaskCardState): boolean {
  return card.steps.some((step) => step.executorRole === "synthesis" && (
    step.status === "ready" ||
    step.status === "running" ||
    step.status === "waiting_for_input" ||
    step.status === "waiting_for_approval"
  ));
}
