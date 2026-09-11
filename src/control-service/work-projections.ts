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
