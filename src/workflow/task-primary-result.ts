import type { Task, TaskResult } from "../contracts/task.js";
import type { TaskStore } from "./task-store.js";

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
