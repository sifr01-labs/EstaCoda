import type { RoutingStatus, RoutingDecision } from '../../contracts/routing.js';
import type { RuntimeEventSink } from '../../contracts/runtime-event.js';
import type { SessionDB } from '../../contracts/session.js';

export function routingStatus(stage: RoutingStatus['stage'], decision: Pick<RoutingDecision, 'configuredMode' | 'actualEngine' | 'model' | 'fallbackReason'>): RoutingStatus {
  return { stage, configuredMode: decision.configuredMode, actualEngine: decision.actualEngine,
    ...(decision.model && /^jev-[A-Za-z0-9._-]{1,100}$/.test(decision.model) ? { model: decision.model } : {}),
    ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}) };
}
export async function recordRoutingStatus(input: { db: SessionDB; sessionId: string; turnMessageId?: string; status: RoutingStatus; onEvent?: RuntimeEventSink }): Promise<void> {
  const event = { kind: 'routing-status' as const, ...input.status, ...(input.turnMessageId ? { turnMessageId: input.turnMessageId } : {}) };
  await input.db.appendEvent(input.sessionId, event);
  await input.onEvent?.(event);
}
