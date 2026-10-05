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

/** Root Task workers are depth one; each durable parent Task adds one nesting level. */
export function taskDelegationDepth(store: TaskStore, task: Task, step: TaskStep): number {
  return listTaskExecutionScopes(store, task, step).length;
}

/** The same cumulative admission check is used by scheduling and operator actions. */
export function taskExecutionLimitBlockReason(store: TaskStore, task: Task, step: TaskStep, now: number, ignoredAttemptId?: string): string | undefined {
  for (const [index, scope] of listTaskExecutionScopes(store, task, step).entries()) {
    const prefix = index === 0 ? "" : "ancestor-";
    const taskAttempts = listTaskTreeAttempts(store, scope.task.id).filter(attempt => attempt.id !== ignoredAttemptId);
    const stepAttempts = listStepTreeAttempts(store, scope.task.id, scope.step.id).filter(attempt => attempt.id !== ignoredAttemptId);
    for (const [kind, attempts, limits, startedAt] of [
      ["task", taskAttempts, scope.task.executionLimits, scope.task.startedAt],
      ["step", stepAttempts, scope.step.executionLimits, stepAttempts.map(attempt => attempt.startedAt).filter((value): value is string => value !== undefined).sort()[0]]
    ] as const) {
      const calls = attempts.reduce((total, attempt) => total + Math.max(1, attempt.usage.providerCalls), 0);
      const tokens = attempts.reduce((total, attempt) => total + attempt.usage.totalTokens, 0);
      if (calls >= limits.maxProviderCalls) return `${prefix}${kind}-provider-call-limit-exhausted`;
      if (tokens >= limits.maxTotalTokens) return `${prefix}${kind}-token-limit-exhausted`;
      if (startedAt !== undefined && now - Date.parse(startedAt) >= limits.maxWallClockMs) return `${prefix}${kind}-wall-clock-limit-exhausted`;
    }
  }
  return undefined;
}

export function taskRetryBlockReason(store: TaskStore, task: Task, step: TaskStep, now: number): string | undefined {
  if (store.listAttempts(task.id, step.id).length >= step.retryPolicy.maxAttempts) return "step-attempt-limit-exhausted";
  return taskExecutionLimitBlockReason(store, task, step, now);
}

export function executionLimitRecoveryMessage(reason: string): string {
  const limit = reason.includes("provider-call") ? "provider call" : reason.includes("token") ? "token" : reason.includes("attempt") ? "attempt" : "time";
  return `The ${reason.includes("task-") ? "task" : "step"} ${limit} limit is exhausted. Resume cannot reset this limit. Retained results remain available; start a new task with the relevant results and an appropriate execution limit.`;
}
