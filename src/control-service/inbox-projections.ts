import type { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { SQLiteTaskStore } from '../tasks/sqlite-task-store.js';
import { validPendingAction } from '../security/pending-action-approval.js';
import { WorkspaceTrustStore } from '../security/workspace-trust-store.js';
import type { InboxProjection } from '../contracts/desktop-control/index.js';
import type { WorkState } from './work-snapshot.js';
import { safeText, timestamp } from './work-projections.js';
import type { CronJob } from '../cron/cron-store.js';

export async function appendInbox(state: WorkState, sessions: SQLiteSessionDB, input: { homeDir: string; profileId: string }, jobs: CronJob[]): Promise<void> {
  const inbox = state.inbox ??= [], store = new SQLiteTaskStore({ db: sessions.db, profileId: input.profileId });
  const add = (id: string, workId: string | null, kind: InboxProjection['kind'], title: string, summary: string, createdAt: number) => {
    inbox.push({ id, profileId: input.profileId, workId, kind, title, summary: safeText(summary), createdAt, approval: null });
  };
  for (const task of store.listTasks({ limit: 1000 })) {
    const workId = `task:${task.id}`;
    if (task.waitReason) add(`wait:${task.id}`, workId, task.waitReason.kind === 'eligible_host' ? 'setup' : 'input', 'Task needs attention', task.waitReason.summary, timestamp(task.waitReason.requestedAt));
    if (task.status === 'failed' || task.status === 'partial') add(`failure:${task.id}`, workId, 'failure', task.status === 'partial' ? 'Task partially completed' : 'Task failed',
      task.failure?.uncertainSideEffects ? 'Review possible side effects before retrying.' : 'Review the Task results and execution history.', timestamp(task.updatedAt));
  }
  for (const delivery of store.listDeliveryBindings({ statuses: ['failed'], limit: 1000 })) {
    add(`delivery:${delivery.id}`, `task:${delivery.taskId}`, 'delivery', 'Result delivery failed', 'The result was retained. Review the delivery destination before retrying.', timestamp(delivery.createdAt));
  }
  const approvals = sessions.db.query<{ id: string; session_id: string; channel: string; approval_kind: string; command_preview: string; request_payload: string | null; requested_at: string }>(
    "select id, session_id, channel, approval_kind, substr(command_preview,1,2048) as command_preview, request_payload, requested_at from pending_approvals where profile_id=? and status='pending' and expires_at>? order by requested_at, id limit 1001"
  ).all(input.profileId, new Date().toISOString());
  for (const row of approvals) {
    const session = await sessions.getSessionForProfile(row.session_id, input.profileId);
    const target = session?.executionTarget;
    if (!session || !target) continue;
    let payload: { executionApproval?: unknown; desktopBinding?: { targetId: string; targetGeneration: number }; taskApprovalLinkId?: string } = {};
    try { if (row.request_payload) payload = JSON.parse(row.request_payload); } catch { /* unbound requests cannot authorize */ }
    const link = payload.taskApprovalLinkId ? store.getApprovalLink(payload.taskApprovalLinkId) : null;
    const task = link ? store.getTask(link.taskId) : null;
    const workId = task ? `task:${task.id}` : `session:${session.id}`;
    const bound = row.approval_kind === 'task' ? Boolean(link && link.status === 'pending' && link.authorizedSessionId === session.id && link.pendingApprovalId === row.id && task && !['completed', 'partial', 'failed', 'cancelled'].includes(task.status))
      : row.approval_kind === 'command' && validPendingAction(payload.executionApproval) && payload.executionApproval.executionScope.profileId === input.profileId &&
        payload.executionApproval.executionScope.sessionId === session.id && payload.executionApproval.expiresAt > Date.now() &&
        (row.channel !== 'desktop' || (payload.desktopBinding?.targetId === target.targetId && payload.desktopBinding.targetGeneration === target.targetGeneration));
    if (!bound) { add(`approval-renew:${row.id}`, workId, 'setup', 'Action needs review in its owning surface', 'This request requires setup or renewed authorization.', timestamp(row.requested_at)); continue; }
    const summary = safeText(row.command_preview) || 'Review the requested action';
    inbox.push({ id: `approval:${row.id}`, profileId: input.profileId, workId, kind: 'approval', title: 'Approval required', summary, createdAt: timestamp(row.requested_at),
      approval: { id: row.id, sessionId: session.id, target: { targetId: target.targetId, targetGeneration: target.targetGeneration },
        actionSummary: summary, scope: 'once', decisions: ['approved', 'denied'] } });
    const work = state.work.find((work) => work.id === workId); if (work) work.status = 'needs_attention';
  }
  const uncertain = sessions.db.query<{ operation_id: string; session_id: string; accepted_at: number }>(
    "select operation_id, session_id, accepted_at from session_control_receipts where profile_id=? and status='uncertain' order by accepted_at desc limit 1000").all(input.profileId);
  for (const row of uncertain) add(`uncertain:${row.operation_id}`, `session:${row.session_id}`, 'input', 'Review interrupted operation', 'The previous owner could not confirm this operation. Inspect its effects before retrying.', row.accepted_at);
  const trust = new WorkspaceTrustStore(input);
  const trustByPath = new Map<string, boolean>();
  for (const work of state.work.filter((work) => work.kind === 'session')) {
    const session = await sessions.getSessionForProfile(work.canonicalId, input.profileId);
    if (session?.executionTarget) {
      let trusted = false;
      try {
        const path = session.executionTarget.workspace.canonicalPath;
        trusted = trustByPath.get(path) ?? await trust.isTrusted(path); trustByPath.set(path, trusted);
      } catch { /* unavailable path */ }
      if (!trusted) add(`trust:${session.id}`, work.id, 'trust', 'Workspace trust required', 'Review workspace trust before continuing execution.', work.updatedAt);
    }
    if (work.status === 'failed' || work.status === 'partial') add(`session-failure:${work.canonicalId}`, work.id, 'failure', 'Work needs review', 'Review the final outcome and evidence before continuing.', work.updatedAt);
  }
  appendSchedules(state, sessions, input.profileId, jobs, add);
}
function appendSchedules(state: WorkState, sessions: SQLiteSessionDB, profileId: string, jobs: CronJob[], add: (id: string, workId: string | null, kind: InboxProjection['kind'], title: string, summary: string, createdAt: number) => void): void {
  const exists = sessions.db.query("select name from sqlite_master where type='table' and name='cron_executions'").get();
  for (const job of jobs) {
    const workId = `schedule:${job.id}`;
    state.work.push({ id: workId, canonicalId: job.id, profileId, kind: 'schedule', title: safeText(job.name, 240) || 'Schedule', target: null,
      status: job.status === 'paused' ? 'paused' : job.lastStatus === 'failed' ? 'failed' : job.status === 'completed' ? 'completed' : 'queued', updatedAt: timestamp(job.updatedAt) });
    if (job.lastStatus === 'failed') add(`schedule-failure:${job.id}`, workId, 'failure', 'Schedule failed', 'Review the latest schedule execution.', timestamp(job.updatedAt));
    if (!exists) continue;
    const rows = sessions.db.query<{ id: string; session_id: string | null; status: string; started_at: string; delivery_results_json: string | null }>(
      'select id, session_id, status, started_at, delivery_results_json from cron_executions where job_id=? and session_id in (select id from sessions where profile_id=?) order by started_at desc limit 100').all(job.id, profileId);
    for (const row of rows) {
      const sessionWork = state.work.find((work) => work.id === `session:${row.session_id}`);
      const id = `schedule-run:${row.id}`;
      state.work.push({ id, canonicalId: row.id, profileId, kind: 'scheduled_execution', parentWorkId: workId, title: 'Scheduled execution',
        status: row.status === 'running' ? 'running' : row.status === 'failed' ? 'failed' : row.status === 'cancelled' ? 'cancelled' : row.status === 'skipped' ? 'partial' : 'completed',
        target: sessionWork?.target ?? null, updatedAt: timestamp(row.started_at) });
      if (sessionWork) {
        sessionWork.parentWorkId = id;
      }
      try {
        const deliveries = JSON.parse(row.delivery_results_json ?? '{}');
        if (Object.values(deliveries).some((v) => typeof v === 'object' && v !== null && 'success' in v && v.success === false)) {
          add(`schedule-delivery:${row.id}`, id, 'delivery', 'Schedule delivery failed', 'Review the configured delivery destination.', timestamp(row.started_at));
        }
      } catch { /* malformed delivery is not execution success evidence */ }
    }
  }
}
