import type { SessionEvent, SessionMessage, SessionRecord } from '../contracts/session.js';
import type { ActivityProjection, WorkDisplayStatus, WorkProjection } from '../contracts/desktop-control/index.js';
import { deriveSessionDescription } from '../session/session-presentation.js';
import { redactSensitiveText } from '../utils/redaction.js';

export const safeText = (text: string, max = 2_048): string => redactSensitiveText(text).slice(0, max);
export const timestamp = (value: string): number => Math.max(0, Date.parse(value) || 0);
/** Lifecycle and evidence are separate: transcript existence is never proof of completion. */
export function sessionWork(session: SessionRecord, events: readonly SessionEvent[], active: boolean): WorkProjection {
  const outcome = [...events].reverse().find((event) => event.kind === 'execution-final-outcome-recorded');
  let status: WorkDisplayStatus = 'draft';
  if (outcome?.kind === 'execution-final-outcome-recorded') {
    status = ({ completed: 'completed', completed_with_recovered_errors: 'completed', partially_completed: 'partial',
      blocked: 'needs_attention', failed: 'failed', cancelled: 'cancelled' } as const)[outcome.status];
  } else if (session.endedAt) status = session.endReason === 'cancelled' ? 'cancelled' : 'partial';
  if (active) status = 'running';
  return { id: `session:${session.id}`, canonicalId: session.id, profileId: session.profileId, kind: 'session',
    ...(session.parentSessionId ? { parentWorkId: `session:${session.parentSessionId}` } : {}),
    title: deriveSessionDescription(session.title).slice(0, 240), status, updatedAt: timestamp(session.updatedAt),
    target: session.executionTarget ? { targetId: session.executionTarget.targetId, targetGeneration: session.executionTarget.targetGeneration,
      label: 'Workspace', isolation: 'unknown' } : null };
}
export function sessionActivity(session: SessionRecord, messages: readonly SessionMessage[]): ActivityProjection[] {
  return messages.filter((message) => message.role === 'user' || message.role === 'agent').map((message, sequence) => ({
    id: `message:${message.id}`, workId: `session:${session.id}`, profileId: session.profileId, sequence,
    timestamp: timestamp(message.createdAt), kind: 'message', role: message.role === 'user' ? 'user' : 'assistant', text: safeText(message.content, 16_384),
  }));
}
export type DisplayEvent = { id: string; createdAt: string; event: SessionEvent };
/** Only allowlisted display events enter this projection; raw tool inputs/results are never copied. */
export function appendSessionEvents(session: SessionRecord, activity: ActivityProjection[], events: DisplayEvent[]): ActivityProjection[] {
  for (const { id, createdAt, event } of events) {
    const base = { id: `event:${id}`, workId: `session:${session.id}`, profileId: session.profileId, sequence: 0, timestamp: timestamp(createdAt) };
    if (event.kind === 'tool-called' || event.kind === 'tool-result') activity.push({ ...base, kind: 'tool', name: safeText(event.tool, 160),
      state: event.kind === 'tool-called' ? 'running' : event.result.ok ? 'completed' : 'failed',
      summary: event.kind === 'tool-called' ? 'Tool started' : event.result.ok ? 'Tool completed' : 'Tool failed' });
    else if ('plan' in event && event.kind.startsWith('execution-plan-') && 'items' in event.plan) activity.push({ ...base, kind: 'plan',
      steps: event.plan.items.slice(0, 64).map((step) => ({ id: step.id, title: safeText(step.content, 240),
        status: step.status === 'completed' ? 'completed' : step.status === 'in_progress' ? 'running' : 'pending' })) });
    else if (event.kind === 'execution-final-outcome-recorded') {
      const status = sessionWork(session, [event], false).status;
      activity.push({ ...base, kind: 'result', status,
        evidence: { state: status === 'failed' ? 'failed' : status === 'partial' ? 'partial' : 'unverified',
          summary: 'Canonical execution outcome. Inspect evidence before relying on external effects.', artifactIds: [] },
        usage: { reportedTokens: null, cost: null } });
    } else if (event.kind === 'agent-cancelled') activity.push({ ...base, kind: 'status', status: 'cancelled', reason: 'Execution cancelled' });
  }
  return activity.sort((a, b) => a.timestamp - b.timestamp).map((item, sequence) => ({ ...item, sequence }));
}
