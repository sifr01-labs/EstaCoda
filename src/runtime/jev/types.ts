import type { ProviderUsageEntry, ProviderUsageLineage, ProviderUsageTotals } from '../../contracts/provider-usage.js';
import type { ResolvedRoutingConfig } from '../../contracts/routing.js';

type QuestionBase = { id: string; instructions: string; description: string };
export type JevQuestion = QuestionBase & (
  | { type: 'noul'; criteria?: { true: string; false: string } }
  | { type: 'choice'; options: readonly { id: string; description: string }[] }
  | { type: 'score'; levels: readonly string[] }
);
/** Caller supplies only the relevant request and continuity, never a session history/config object. */
export type JevContext = {
  userRequest: string;
  continuity?: string;
  material?: readonly { kind: 'quoted' | 'retrieved'; text: string }[];
};
export type JevSnapshot = {
  config: ResolvedRoutingConfig;
  configurationRevision: string;
  catalogRevision: string;
};
/** Selection thresholds belong to the caller's calibrated policy, not the HTTP adapter. */
export type JevThresholds = { acceptAt: number; rejectAt: number; minConfidence: number };
export type JevAnswer = { id: string } & (
  | { type: 'noul'; status: 'accepted' | 'rejected' | 'uncertain'; probability: number }
  | { type: 'choice'; status: 'accepted' | 'uncertain'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; status: 'accepted' | 'uncertain'; score: number; probabilities: Record<string, number>; confidence: number }
  | { status: 'missing' | 'invalid' }
);
export type JevFailure = {
  code: 'invalid-request' | 'credentials-unavailable' | 'authentication' | 'rate-limited' | 'overloaded'
    | 'service-error' | 'network-error' | 'timeout' | 'cancelled' | 'stale' | 'invalid-response' | 'accounting-failed';
  httpStatus?: number;
  retryAfterMs?: number;
};
export type JevDecisionResult = {
  schemaVersion: 1;
  status: 'ok' | 'partial' | 'failed' | 'disabled';
  configurationRevision: string;
  catalogRevision: string;
  models: string[];
  answers: JevAnswer[];
  failure?: JevFailure;
  usage: ProviderUsageTotals;
  /** Canonical facts, also retained if the local recorder fails; never re-dispatch to retry accounting. */
  usageEntries: ProviderUsageEntry[];
};
export type JevEvaluation = {
  context: JevContext;
  questions: readonly JevQuestion[];
  thresholds: JevThresholds;
  usage: ProviderUsageLineage & { requestKey: string };
  signal?: AbortSignal;
};
