import type { RoutingSelection, RoutingFallbackReason } from '../../contracts/routing.js';
import type { RoutingEvidence } from '../../contracts/desktop-control/routing.js';
import type { JevDecisionResult } from './types.js';

/** Merge only unresolved candidates with Standard. Invalidation defeats all prior answers. */
export function resolveJevSelection(result: JevDecisionResult, candidates: readonly { id: string; questionId: string; standard: boolean }[]) {
  const discard = ['stale', 'cancelled', 'timeout', 'accounting-failed', 'invalid-request'].includes(result.failure?.code ?? '');
  const answers = new Map(result.answers.map(answer => [answer.id, answer]));
  const expectedIds = new Set(candidates.map(candidate => candidate.questionId));
  const ambiguous = answers.size !== result.answers.length || result.answers.some(answer => !expectedIds.has(answer.id));
  const diagnostics: RoutingEvidence = {
    contacted: result.usageEntries.length > 0, candidateCount: candidates.length, truncatedCandidates: candidates.length > 2048 || undefined,
    ...(result.failure ? { failure: { ...result.failure } } : {}),
    batches: result.batches ?? [], candidates: []
  };
  let resolved = 0;
  const selections: RoutingSelection[] = candidates.map(candidate => {
    const answer = answers.get(candidate.questionId);
    const probability = answer && 'probability' in answer && Number.isFinite(answer.probability) && answer.probability >= 0 && answer.probability <= 1 ? answer.probability : undefined;
    const usable = !discard && !ambiguous && answer && 'type' in answer && answer.type === 'noul' && probability !== undefined && ['accepted', 'rejected'].includes(answer.status);
    const source = usable ? 'jev' as const : 'standard' as const;
    if (usable) resolved++;
    const outcome = discard ? 'discarded' : ambiguous ? 'invalid' : !answer ? 'missing' : 'type' in answer && (answer.type !== 'noul' || probability === undefined) ? 'invalid' : answer.status;
    if (diagnostics.candidates.length < 2048) diagnostics.candidates.push({ id: candidate.id.slice(0, 256), questionId: candidate.questionId, outcome, probability, source });
    return { id: candidate.id, probability, source, selected: usable ? answer.status === 'accepted' : candidate.standard };
  });
  const fallbackCount = candidates.length - resolved;
  const code = result.failure?.code;
  const fallbackReason: RoutingFallbackReason | undefined = discard ? code === 'timeout' ? 'timeout' : 'engine-unavailable'
    : code ? ['authentication', 'billing-rejected', 'credentials-unavailable', 'rate-limited', 'invalid-response'].includes(code) ? code as RoutingFallbackReason : 'service-error'
    : fallbackCount ? diagnostics.candidates.some(c => c.outcome === 'invalid' || c.outcome === 'missing') ? 'invalid-response' : 'uncertain' : undefined;
  return { selections, diagnostics, actualEngine: resolved > 0 || candidates.length === 0 && result.status === 'ok' ? 'jev' as const : 'standard' as const,
    partialFallback: resolved > 0 && fallbackCount > 0 || undefined, fallbackReason, model: result.models[0] };
}
