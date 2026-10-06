import { randomUUID } from 'node:crypto';
import { profileHeaderEnvironment } from '../../config/header-secret-references.js';
import { normalizeRoutingConfig } from '../../config/routing-config.js';
import { ROUTING_DECISION_VERSION } from '../../contracts/routing.js';
import type { ProviderUsageEntry, ProviderUsageContext } from '../../contracts/provider-usage.js';
import type { ProviderUsage, ResolvedModelRoute } from '../../contracts/provider.js';
import { resolveRuntimeCredential } from '../../providers/runtime-credential-resolver.js';
import { providerUsageEntryFromAttempt, providerUsageTotals } from '../../providers/provider-usage-ledger.js';
import { JEV_LIMITS, prepareJevBatches, redactJevBatches } from './payload.js';
import { object, readJevAnswers, readJevUsage, resolvedJevModel } from './response.js';
import type { JevAnswer, JevDecisionResult, JevEvaluation, JevFailure, JevSnapshot } from './types.js';

const endpoint = 'https://api.typesafe.ai/v1/systemone';
export type JevDecisionClientOptions = {
  homeDir: string;
  profileId: string;
  /** Re-read at dispatch and acceptance boundaries. Caller increments revisions when routing/catalog change. */
  snapshot(): JevSnapshot;
  /** Required existing ledger owner; no parallel usage store. */
  recordUsage(entries: readonly ProviderUsageEntry[]): Promise<void>;
  fetch?: typeof globalThis.fetch;
};
class Failure extends Error {
  constructor(readonly failure: JevFailure) { super(failure.code); }
}
function route(model: string): ResolvedModelRoute {
  return { provider: 'typesafe', id: model, profile: { provider: 'typesafe', id: model,
    contextWindowTokens: 64_000, supportsTools: false, supportsVision: false, supportsStructuredOutput: true,
    // Release-pinned price, verified from TypeSafe's model documentation. Unknown versions stay unpriced.
    ...(model === 'jev-1.13.0' ? { cost: { inputPerMillionTokens: 0.042, outputPerMillionTokens: 0 } } : {}),
  } };
}
function snapshot(input: JevSnapshot): JevSnapshot {
  for (const value of [input.configurationRevision, input.catalogRevision]) if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Failure({ code: 'invalid-request' });
  return { config: normalizeRoutingConfig(input.config), configurationRevision: input.configurationRevision, catalogRevision: input.catalogRevision };
}
function identity(value: JevSnapshot): string { return JSON.stringify(value); }
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(60_000, Math.ceil(ms)) : undefined;
}
function httpFailure(response: Response): JevFailure {
  const code = response.status === 401 || response.status === 403 ? 'authentication' : response.status === 402 ? 'billing-rejected' : response.status === 429 ? 'rate-limited' : response.status === 529 ? 'overloaded' : 'service-error';
  const retryAfterMs = ['rate-limited', 'overloaded'].includes(code) ? retryAfter(response) : undefined;
  return { code, httpStatus: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
/** Even injected transports/readers that ignore AbortSignal cannot make routing wait indefinitely. */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > JEV_LIMITS.responseBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Failure({ code: 'invalid-response' });
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await abortable(() => reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > JEV_LIMITS.responseBytes) throw new Failure({ code: 'invalid-response' });
      chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Failure({ code: 'invalid-response' }); }
  } finally { void reader.cancel().catch(() => undefined); }
}

/** Typed decision transport only; selection consumers are wired by subsequent routing commits. */
export class JevDecisionClient {
  constructor(private readonly options: JevDecisionClientOptions) {}

  async evaluate(input: JevEvaluation): Promise<JevDecisionResult> {
    let current: JevSnapshot;
    try { current = snapshot(this.options.snapshot()); }
    catch { return this.result(undefined, [], [], [], { code: 'invalid-request' }); }
    const batchEvidence: NonNullable<JevDecisionResult['batches']> = [];
    const entries: ProviderUsageEntry[] = [], answers: JevAnswer[] = [], models: string[] = [];
    if (current.config.mode === 'standard') return this.result(current, answers, models, entries, undefined, 'disabled');
    const signal = input.signal;
    const controller = new AbortController();
    const cancel = () => controller.abort(new Failure({ code: 'cancelled' }));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Failure({ code: 'timeout' })), current.config.jev.timeoutMs);
    const check = () => {
      controller.signal.throwIfAborted();
      try { if (identity(snapshot(this.options.snapshot())) === identity(current)) return; } catch { /* Unreadable current state cannot authorize an old decision. */ }
      throw new Failure({ code: 'stale' });
    };
    try {
      check();
      // Snapshot validated payload and thresholds before the first asynchronous operation.
      let batches = prepareJevBatches(current.config.jev.id, input.context, input.questions, input.thresholds);
      const policy = { ...input.thresholds };
      if (!input.usage || typeof input.usage.requestKey !== 'string' || !input.usage.requestKey.trim() || input.usage.requestKey.length > 470) throw new Failure({ code: 'invalid-request' });
      const context: ProviderUsageContext = { requestKey: `${input.usage.requestKey}:${randomUUID()}`, sourceKind: 'auxiliary', auxiliaryKind: 'routing',
        executionSessionId: input.usage.executionSessionId, sessionBudgetScopeId: input.usage.sessionBudgetScopeId, visibleTurnId: input.usage.visibleTurnId,
        taskId: input.usage.taskId, rootTaskId: input.usage.rootTaskId, planRevisionId: input.usage.planRevisionId, stepId: input.usage.stepId, attemptId: input.usage.attemptId };
      const makeEntry = (index: number, dispatchedAt: string, model: string, usage?: ProviderUsage) => providerUsageEntryFromAttempt({
        profileId: this.options.profileId, context, routes: [route(model)], providerAttemptIndex: index,
        attempt: { state: 'dispatched', dispatchedAt, provider: 'typesafe', model, routeIndex: 0, routeRole: 'primary', ok: usage !== undefined, content: '', usage },
      });
      // Validate ledger attribution before spending or reading credentials.
      makeEntry(0, new Date().toISOString(), current.config.jev.id);
      if (!batches.length) return this.result(current, answers, models, entries);
      let environment: Record<string, string>;
      try { environment = await abortable(() => profileHeaderEnvironment(this.options), controller.signal); }
      catch (error) { if (error instanceof Failure) throw error; throw new Failure({ code: 'credentials-unavailable' }); }
      check();
      const resolved = await resolveRuntimeCredential({ providerId: 'typesafe', route: { apiKeyEnv: current.config.jev.apiKeyEnv }, environment, readOnly: true });
      const key = resolved.credential?.kind === 'bearer' ? resolved.credential.value : undefined;
      if (!key?.trim() || key.length > 8192 || /[\r\n\0]/.test(key)) throw new Failure({ code: 'credentials-unavailable' });
      batches = redactJevBatches(batches, Object.values(environment));
      batchEvidence.push(...batches.map((batch, index) => ({ index, questionIds: Object.keys(batch.questions), state: 'not-dispatched' as const })));
      for (const [index, batch] of batches.entries()) {
        check();
        const evidence = batchEvidence[index];
        let usage: ProviderUsage | undefined, model = current.config.jev.id, dispatched = false;
        const dispatchedAt = new Date().toISOString();
        try {
          const response = await abortable(async () => {
            check();
            dispatched = true;
            const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: batch.body });
            if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); controller.signal.throwIfAborted(); }
            return response;
          }, controller.signal);
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Failure(httpFailure(response)); }
          const raw = await readJson(response, controller.signal);
          if (!object(raw)) throw new Failure({ code: 'invalid-response' });
          usage = readJevUsage(raw.usage);
          const actual = resolvedJevModel(raw.model, current.config.jev.id);
          if (!actual) throw new Failure({ code: 'invalid-response' });
          model = actual;
          const decoded = readJevAnswers(raw.answers, batch.questions, policy);
          if (!decoded) throw new Failure({ code: 'invalid-response' });
          check();
          if (!models.includes(model)) models.push(model);
          answers.push(...decoded);
          evidence.state = 'responded';
        } catch (error) {
          evidence.state = dispatched ? 'failed' : 'not-dispatched';
          const interrupted = controller.signal.aborted ? controller.signal.reason : error;
          evidence.failure = interrupted instanceof Failure ? interrupted.failure : { code: 'network-error' };
          if (error instanceof Failure) throw error;
          throw new Failure({ code: 'network-error' });
        } finally {
          // A dispatched failure can still incur usage. Missing usage stays explicitly incomplete.
          if (dispatched) {
            const entry = makeEntry(index, dispatchedAt, model, usage);
            entries.push(entry);
            try { await this.options.recordUsage([entry]); }
            catch { throw new Failure({ code: 'accounting-failed' }); }
          }
        }
      }
      check();
      return { ...this.result(current, answers, models, entries), batches: batchEvidence };
    } catch (error) {
      let failure = error instanceof Failure ? error.failure : { code: 'invalid-request' as const };
      if (failure.code !== 'accounting-failed') { try { check(); } catch (interrupted) { failure = interrupted instanceof Failure ? interrupted.failure : { code: 'stale' }; } }
      const discard = ['stale', 'cancelled', 'timeout', 'accounting-failed'].includes(failure.code);
      return { ...this.result(current, discard ? [] : answers, models, entries, failure), batches: batchEvidence };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private result(snapshot: JevSnapshot | undefined, answers: JevAnswer[], models: string[], usageEntries: ProviderUsageEntry[], failure?: JevFailure, status?: 'disabled'): JevDecisionResult {
    return { schemaVersion: ROUTING_DECISION_VERSION, configurationRevision: snapshot?.configurationRevision ?? '', catalogRevision: snapshot?.catalogRevision ?? '',
      status: status ?? (failure ? answers.length ? 'partial' : 'failed' : answers.some(a => ['invalid', 'missing', 'uncertain'].includes(a.status)) ? 'partial' : 'ok'),
      models, answers, ...(failure ? { failure } : {}), usage: providerUsageTotals(usageEntries, { emptyUsageIsComplete: true }), usageEntries };
  }
}
