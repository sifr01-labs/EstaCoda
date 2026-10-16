import { taskExecutionLimitBlockReason, taskRetryBlockReason, executionLimitRecoveryMessage } from "../tasks/task-tree-accounting.js";
import type { ActionId, ActionProjection, WorkProjection, InboxProjection } from '../contracts/desktop-control/index.js';
import type { SessionRecord } from '../contracts/session.js';
import type { Task } from '../contracts/task.js';
import type { TaskStore } from '../tasks/task-store.js';
import { MAX_GUIDANCE_RECORDS } from '../tasks/fixed-task-service.js';

export function action(id: ActionId, enabled = true, reason = 'This action is unavailable in the current state.', stepId?: string): ActionProjection {
  return { id, enabled, ...(enabled ? {} : { reason }), ...(stepId ? { stepId } : {}) };
}
export function sessionActions(session: SessionRecord, work: WorkProjection): ActionProjection[] {
  const bound = Boolean(session.executionTarget), open = !session.endedAt;
  return [action('inspect_result'), action('sessions.resume', bound && open, 'This Session is ended or has no execution target.'),
    action('sessions.send', bound && open, 'This Session is ended or has no execution target.'),
    action('sessions.cancelTurn', bound && open && (work.executionModelActive === true || work.status === 'queued'), 'There is no active turn to cancel.')].map(item => item.id.startsWith('sessions.') ? { ...item, sessionId: session.id } : item);
}
export function taskActions(task: Task, store: TaskStore): ActionProjection[] {
  const live = !['completed', 'partial', 'failed', 'cancelled'].includes(task.status), bound = Boolean(task.executionTarget);
  const reason = 'This Task is settled or has no execution target.';
  const actions = [action('inspect_result'), action('tasks.pause', bound && live && task.status !== 'paused', reason),
    action('tasks.cancel', bound && live, reason), action('tasks.resume', bound && task.status === 'paused', 'Only paused Tasks can resume.'),
    action('tasks.guide', bound && live && store.listGuidance(task.id).length < MAX_GUIDANCE_RECORDS, 'This Task cannot accept more guidance.')];
  const steps = task.activePlanRevisionId ? store.listSteps(task.id, task.activePlanRevisionId).filter(step => step.status === 'waiting_for_input') : [];
  const retryState = bound && ['paused', 'waiting_for_input'].includes(task.status);
  if (!steps.length) actions.push(action('tasks.retry', false, 'No Step is waiting for retry.'));
  for (const step of steps) {
    const blocked = retryState ? taskRetryBlockReason(store, task, step, Date.now()) : undefined;
    actions.push(action('tasks.retry', retryState && blocked === undefined,
      blocked ? executionLimitRecoveryMessage(blocked) : 'Retry requires a waiting Task and remaining Attempt budget.', step.id));
  }
  if (task.status === 'paused' && task.waitReason?.kind === 'execution_limit' && task.activePlanRevisionId) {
    const candidates = store.listSteps(task.id, task.activePlanRevisionId).filter(step => step.status === 'ready' || step.status === 'waiting_for_input');
    const reasons = candidates.map(step => taskExecutionLimitBlockReason(store, task, step, Date.now()));
    if (reasons.length && reasons.every(Boolean)) Object.assign(actions.find(item => item.id === 'tasks.resume')!, action('tasks.resume', false, executionLimitRecoveryMessage(reasons[0]!)));
  }
  return actions.map(item => item.id.startsWith('tasks.') ? { ...item, sessionId: task.originSessionId } : item);
}
/** Snapshot hints only. Core revalidates target, policy and lifecycle at dispatch. */
export function constrainActions(work: WorkProjection, trusted: boolean, configured: boolean): void {
  work.actions = work.actions?.map(item => {
    if (!item.enabled || !['sessions.send', 'sessions.resume', 'tasks.resume', 'tasks.retry', 'tasks.guide'].includes(item.id)) return item;
    if (!trusted) return { ...item, ...action(item.id, false, 'Workspace trust or target repair is required.', item.stepId) };
    if (!configured) return { ...item, ...action(item.id, false, 'Review model and provider setup before continuing.', item.stepId) };
    return item;
  });
}
export function inboxActions(item: InboxProjection, work?: WorkProjection): ActionProjection[] {
  const inspect = item.workId ? [action('open_work')] : [];
  if (item.approval) return [...inspect, action('approve_once', item.approval.decisions.includes('approved'), 'Review workspace trust, target validity and provider setup before approval.'),
    action('reject', item.approval.decisions.includes('denied'), 'This request can no longer be rejected.')];
  const review = { trust: 'review_trust', setup: 'review_setup', evolution: 'review_evolution', delivery: 'review_delivery', failure: 'inspect_result', input: 'open_work' } as const;
  const id = item.kind === 'approval' ? 'open_work' : review[item.kind];
  const actions = inspect.some(item => item.id === id) ? inspect : [...inspect, action(id, id !== 'open_work' || Boolean(item.workId))];
  if (item.kind === 'input' || item.kind === 'failure') actions.push(...(work?.actions ?? []).filter(item => ['sessions.send', 'tasks.guide', 'tasks.retry'].includes(item.id)));
  return actions;
}
