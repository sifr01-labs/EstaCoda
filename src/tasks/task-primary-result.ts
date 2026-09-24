import type { Task, TaskResult } from "../contracts/task.js";
import type { TaskStore } from "./task-store.js";

/** Objective accounting is separate from successful foreground dispatch. */
export function taskRequestCompletion(store: TaskStore, task: Task): { researchComplete: boolean; fileOutputPending: boolean } {
  if (task.activePlanRevisionId === undefined) return { researchComplete: false, fileOutputPending: false };
  const steps = store.listSteps(task.id, task.activePlanRevisionId);
  const contract = steps.find((step) => step.executor.requestContract !== undefined)?.executor.requestContract;
  if (contract === undefined) return { researchComplete: true, fileOutputPending: false };
  const workers = steps.filter((step) => step.executor.role !== "synthesis");
  const accepted = new Set(store.listResults(task.id).filter((result) => result.disposition === "accepted" && result.status === "available").map((result) => result.stepId));
  const expected = contract.requirements.delegation?.count;
  return {
    researchComplete: (expected === undefined || workers.length === expected) && workers.every((worker) => worker.status === "completed" && accepted.has(worker.id)) &&
      (contract.requirements.research === undefined || (workers.every((worker) => worker.executor.research !== undefined) &&
        new Set(workers.map((worker) => worker.executor.research?.scope)).size === workers.length)),
    // Synthesis authority is intentionally read-only. Saving is a separately
    // verified workspace action, never inferred from an accepted text result.
    fileOutputPending: contract.requirements.fileOutput !== undefined
  };
}

/**
 * A synthesis-role Step is the fixed graph's declared terminal answer. Intermediate
 * worker Results remain readable, but operator and delivery surfaces lead with this Result.
 */
export function taskPrimaryResult(store: TaskStore, task: Task): TaskResult | undefined {
  const synthesisStepId = taskPrimaryResultStepId(store, task);
  if (synthesisStepId === undefined) return undefined;
  return store.listResults(task.id)
    .find((result) => result.status === "available" && result.disposition === "accepted" && result.stepId === synthesisStepId);
}

export function taskPrimaryResultStepId(store: TaskStore, task: Task): string | undefined {
  if (task.activePlanRevisionId === undefined) return undefined;
  return store.listSteps(task.id, task.activePlanRevisionId)
    .find((step) => step.executor.kind === "agent" && step.executor.role === "synthesis")?.id;
}

export function orderTaskResults(
  results: readonly TaskResult[],
  primary: TaskResult | undefined
): readonly TaskResult[] {
  if (primary === undefined) return results;
  return [primary, ...results.filter((result) => result.id !== primary.id)];
}
