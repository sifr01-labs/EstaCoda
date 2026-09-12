import {basename} from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { taskActions } from './action-projections.js';
import { taskListCursor, type TaskListCursor } from '../tasks/task-store.js';
import type { Task, TaskAttempt, TaskStatus } from '../contracts/task.js';
import type { ActivityProjection, WorkDisplayStatus, WorkProjection } from '../contracts/desktop-control/index.js';
import type { TaskStore } from '../tasks/task-store.js';
import { TaskOperatorService } from '../tasks/task-operator-service.js';
import { safeText, timestamp } from './work-projections.js';
import type { WorkState } from './work-snapshot.js';
const statuses: Record<TaskStatus, WorkDisplayStatus> = {
  planning: 'draft', queued: 'queued', running: 'running', waiting_for_host: 'queued', waiting_for_input: 'needs_attention',
  waiting_for_approval: 'needs_attention', paused: 'paused', completed: 'completed', partial: 'partial', failed: 'failed', cancelled: 'cancelled',
};
export function taskWork(task: Task, visibleSessions: ReadonlySet<string>): WorkProjection {
  return { id: `task:${task.id}`, canonicalId: task.id, profileId: task.profileId, kind: 'task', modelBinding:{sessionId:task.originSessionId,taskId:task.id},
    ...(task.parentTaskId ? { parentWorkId: `task:${task.parentTaskId}` } : visibleSessions.has(task.originSessionId) ? { parentWorkId: `session:${task.originSessionId}` } : {}),
    title: safeText(task.objective, 240) || 'Task', status: statuses[task.status],
    ...(task.waitReason ? { reason: safeText(task.waitReason.summary) } : {}), updatedAt: timestamp(task.updatedAt),
    target: task.executionTarget ? { targetId: task.executionTarget.targetId, targetGeneration: task.executionTarget.targetGeneration, label: safeText(basename(task.executionTarget.workspace.canonicalPath),240)||'Workspace', isolation: 'unknown' } : null };
}
export function attemptWork(task: WorkProjection, attempt: TaskAttempt): WorkProjection {
  const status: WorkDisplayStatus = ({ queued: 'queued', leased: 'running', running: 'running', waiting_for_input: 'needs_attention',
    waiting_for_approval: 'needs_attention', completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'partial', expired: 'partial' } as const)[attempt.status];
  return { ...task, actions: [{ id: 'inspect_result', enabled: true }], id: `attempt:${attempt.id}`, canonicalId: attempt.id, kind: 'task_attempt', parentWorkId: task.id,
    title: `Attempt ${attempt.attemptNumber}`, status, updatedAt: timestamp(attempt.updatedAt) };
}
export async function appendTaskWork(state: WorkState, store: TaskStore, signal?: AbortSignal): Promise<void> {
  const service = new TaskOperatorService({ store });
  const visible = new Set(state.work.filter((w) => w.kind === 'session' && !w.parentWorkId).map((w) => w.canonicalId));
  let visited = 0;
  for (const task of allTasks(store)) {
    if (++visited % 32 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const work = taskWork(task, visible); work.actions = taskActions(task, store); state.work.push(work);
    const projection = service.status(task.id);
    let sequence = 0;
    const base = () => ({ id: `activity:${task.id}:${sequence}`, profileId: task.profileId, workId: work.id, sequence: sequence++, timestamp: timestamp(task.updatedAt) });
    const activity: ActivityProjection[] = [{ ...base(), kind: 'plan', steps: projection.steps.map((step) => ({ id: step.stepId, title: safeText(step.title, 240),
      status: step.status === 'completed' ? 'completed' : step.status === 'failed' ? 'failed' : step.status === 'running' ? 'running' : 'pending' })) }];
    for (const result of projection.results) activity.push({ ...base(), kind: 'result', status: work.status,
      evidence: { state: 'unverified', summary: safeText(result.displaySummary ?? result.summary ?? 'Result available'), artifactIds: [] },
      usage: { reportedTokens: projection.usage.usageComplete ? projection.usage.totalTokens : null, cost: projection.usage.pricingComplete && projection.usage.usageComplete && projection.usage.providerCalls > 0 ? { amount: projection.usage.estimatedCostUsd, currency: 'USD' } : null } });
    state.activity[work.id] = activity;
    for (const attempt of store.listAttempts(task.id)) {
      const run = attemptWork(work, attempt); state.work.push(run);
      const worker=attempt.workerSessionId?state.work.find(item=>item.id==='session:'+attempt.workerSessionId):undefined;
      if(worker){worker.parentWorkId=run.id;worker.actions=[{id:'inspect_result',enabled:true}];delete worker.modelBinding;}
      state.activity[run.id] = [{ id: `status:${attempt.id}`, profileId: task.profileId, workId: run.id,
        sequence: 0, timestamp: timestamp(attempt.updatedAt), kind: 'status', status: run.status }];
    }
  }
  state.work.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function* allTasks(store: TaskStore): Generator<Task> {
  let cursor: TaskListCursor | undefined;
  for (;;) {
    const tasks = store.listTasks({ limit: 100, order: 'updated_desc', cursor });
    for (const task of tasks) yield task;
    if (tasks.length < 100) return;
    cursor = taskListCursor(tasks[tasks.length - 1]!, 'updated_desc');
  }
}
