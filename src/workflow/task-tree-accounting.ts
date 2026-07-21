import type { Task, TaskAttempt, TaskStep } from "../contracts/task.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { TaskStore } from "./task-store.js";

const MAX_TASK_TREE_RECORDS = 1_000;

export type TaskExecutionScope = {
  task: Task;
  step: TaskStep;
};

/** Returns a Task plus every durable descendant in deterministic breadth-first order. */
export function listTaskTree(store: TaskStore, taskId: string): readonly Task[] {
  const root = store.getTask(taskId);
  if (root === null) return [];
  const tasks: Task[] = [root];
  const seen = new Set([root.id]);
  for (let index = 0; index < tasks.length; index++) {
    for (const child of store.listChildTasks(tasks[index]!.id)) {
      if (seen.has(child.id)) throw new Error("Task tree contains a repeated descendant.");
      seen.add(child.id);
      tasks.push(child);
      if (tasks.length > MAX_TASK_TREE_RECORDS) {
        throw new Error(`Task tree exceeds ${MAX_TASK_TREE_RECORDS} durable records.`);
      }
    }
  }
  return tasks;
}

export function listTaskTreeAttempts(store: TaskStore, taskId: string): readonly TaskAttempt[] {
  return listTaskTree(store, taskId).flatMap((task) => store.listAttempts(task.id));
}

export function listTaskTreeUsageEntries(store: TaskStore, taskId: string): readonly ProviderUsageEntry[] {
  return listTaskTree(store, taskId).flatMap((task) => store.listProviderUsageEntries({ taskId: task.id }));
}

/** Includes the parent Step's Attempts and every descendant tree created by those Attempts. */
export function listStepTreeAttempts(
  store: TaskStore,
  taskId: string,
  stepId: string
): readonly TaskAttempt[] {
  const ownAttempts = store.listAttempts(taskId, stepId);
  const parentAttemptIds = new Set(ownAttempts.map((attempt) => attempt.id));
  const descendantRoots = store.listChildTasks(taskId).filter((child) =>
    child.parentAttemptId !== undefined && parentAttemptIds.has(child.parentAttemptId)
  );
  return [
    ...ownAttempts,
    ...descendantRoots.flatMap((child) => listTaskTreeAttempts(store, child.id))
  ];
}

/** Current Task/Step first, then every immutable ancestor scope that owns this descendant work. */
export function listTaskExecutionScopes(
  store: TaskStore,
  task: Task,
  step: TaskStep
): readonly TaskExecutionScope[] {
  const scopes: TaskExecutionScope[] = [{ task, step }];
  const seen = new Set([task.id]);
  let current = task;
  while (current.parentTaskId !== undefined || current.parentAttemptId !== undefined) {
    if (current.parentTaskId === undefined || current.parentAttemptId === undefined) {
      throw new Error("Task budget lineage is incomplete.");
    }
    const parent = store.getTask(current.parentTaskId);
    const parentAttempt = store.getAttempt(current.parentAttemptId);
    const parentStep = parentAttempt === null ? null : store.getStep(parentAttempt.stepId);
    if (parent === null || parentAttempt === null || parentStep === null ||
        parentAttempt.taskId !== parent.id || parentStep.taskId !== parent.id ||
        parent.rootTaskId !== task.rootTaskId || seen.has(parent.id)) {
      throw new Error("Task budget lineage is invalid.");
    }
    seen.add(parent.id);
    scopes.push({ task: parent, step: parentStep });
    current = parent;
  }
  if (current.id !== task.rootTaskId) throw new Error("Task budget lineage does not reach its declared root.");
  return scopes;
}
