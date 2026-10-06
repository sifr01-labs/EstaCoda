import type { SessionEvent } from '../contracts/session.js';
import { formatRoutingStatus } from '../contracts/desktop-control/routing.js';

/** Reads only this session and this turn; never combines stages from different turns. */
export function inspectRouting(events: readonly SessionEvent[], options: { turnId?: string; offset?: number; details?: boolean } = {}) {
  const records = events.filter((event): event is Extract<SessionEvent, { kind: 'routing-status' }> => event.kind === 'routing-status');
  const turnId = options.turnId ?? records.at(-1)?.turnMessageId;
  const stages = new Map((turnId ? records.filter(event => event.turnMessageId === turnId) : []).map(event => [event.stage, event]));
  const candidates = [...stages.values()].flatMap(event => (event.diagnostics?.candidates ?? []).map(candidate => ({ stage: event.stage, ...candidate })));
  const offset = options.offset ?? 0;
  return { turnId, state: stages.size ? 'recorded' : 'unknown', stages: [...stages.values()].map(event => ({
    stage: event.stage, configuredMode: event.configuredMode, actualEngine: event.actualEngine, model: event.model,
    partialFallback: event.partialFallback, fallbackReason: event.fallbackReason, summary: formatRoutingStatus(event),
    contacted: event.diagnostics?.contacted ?? 'unknown', failure: event.diagnostics?.failure,
    batches: event.diagnostics?.batches.map(batch => ({ index: batch.index, state: batch.state, questionCount: batch.questionIds.length, failure: batch.failure })),
    candidateCount: event.diagnostics?.candidateCount, truncatedCandidates: event.diagnostics?.truncatedCandidates,
    evidenceAvailable: event.diagnostics !== undefined
  })), ...(options.details ? { candidates: candidates.slice(offset, offset + 20), totalCandidates: candidates.length,
    ...(offset + 20 < candidates.length ? { nextOffset: offset + 20 } : {}) } : {}) };
}
