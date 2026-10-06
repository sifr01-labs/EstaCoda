import type { RoutingStatus, RoutingDecision } from '../../contracts/routing.js';
import type { RuntimeEventSink } from '../../contracts/runtime-event.js';
import type { SessionDB } from '../../contracts/session.js';

export function routingStatus(stage: RoutingStatus['stage'], decision: Pick<RoutingDecision, 'configuredMode' | 'actualEngine' | 'model' | 'fallbackReason' | 'partialFallback' | 'diagnostics'>): RoutingStatus {
  return { stage, configuredMode: decision.configuredMode, actualEngine: decision.actualEngine, ...(decision.partialFallback ? { partialFallback: true } : {}), ...(decision.diagnostics ? { diagnostics: decision.diagnostics } : {}),
    ...(decision.model && /^jev-[A-Za-z0-9._-]{1,100}$/.test(decision.model) ? { model: decision.model } : {}),
    ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}) };
}
export async function recordRoutingStatus(input: { db: SessionDB; sessionId: string; turnMessageId?: string; status: RoutingStatus; onEvent?: RuntimeEventSink }): Promise<void> {
  const event = { kind: 'routing-status' as const, ...input.status, ...(input.turnMessageId ? { turnMessageId: input.turnMessageId } : {}) };
  await input.db.appendEvent(input.sessionId, event);
  await input.onEvent?.(event);
}

/** Small current-turn facts; detailed candidate evidence stays behind the status tool. */
export function routingNotice(turnId: string, ...decisions: Array<RoutingDecision | import('../../contracts/routing.js').CapabilityRoutingDecision | undefined>): string | undefined {
  const stages = ['intent-skills', 'capabilities'] as const;
  const statuses = decisions.flatMap((decision, i) => decision ? [{ stage: stages[i], configuredMode: decision.configuredMode, actualEngine: decision.actualEngine,
    partialFallback: decision.partialFallback, fallbackReason: decision.fallbackReason, contacted: decision.diagnostics?.contacted }] : []);
  if (!statuses.some(status => status.fallbackReason)) return undefined;
  return `Current turn ${turnId}: runtime routing facts (not authorization): ${JSON.stringify(statuses)}. For details use config.provider.execution_status. Do not infer runtime configuration from workspace files.`;
}
