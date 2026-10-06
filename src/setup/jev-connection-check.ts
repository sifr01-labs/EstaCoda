import {routingSnapshotReader} from '../runtime/jev/routing-snapshot.js';
import {IntentRouter} from '../runtime/intent-router.js';
import {SkillRegistry} from '../skills/skill-registry.js';
import { resolveGlobalStateHome } from '../config/profile-home.js';
import { captureProfileApplySnapshot } from './review/profile-apply.js';
import { normalizeRoutingConfig } from '../config/routing-config.js';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { JevDecisionClient } from '../runtime/jev/decision-client.js';
import type { RoutingCheckResult } from '../contracts/routing.js';

/** Explicit saved-profile check: fixed synthetic text, fixed endpoint, no mode change or user history. */
export async function checkJevConnection(input: { homeDir: string; profileId: string; spendApproved: true; signal?: AbortSignal; fetch?: typeof fetch }): Promise<RoutingCheckResult> {
  if (input.spendApproved !== true) throw new Error('Connection check requires explicit approval');
  let db: SQLiteSessionDB | undefined;
  try {
    const before = await captureProfileApplySnapshot(input);
    const config = normalizeRoutingConfig(JSON.parse(before.files['config.json'] ?? '{}').routing);
    if (config.mode === 'standard') return { state: 'disabled' };
    input.signal?.throwIfAborted();
    const snapshot=routingSnapshotReader({...input,router:new IntentRouter({skillRegistry:new SkillRegistry()})});
    db = new SQLiteSessionDB({ path: resolveGlobalStateHome(input).sessionsSqlitePath });
    const client = new JevDecisionClient({ ...input, snapshot,
      recordUsage: entries => db!.recordProviderUsageEntries([...entries]) });
    const result = await client.evaluate({ signal: input.signal, context: { userRequest: 'Say hello.' }, questions: [{ id: 'connection', type: 'noul', description: 'A friendly greeting.', instructions: 'Is this request a greeting?' }],
      thresholds: { acceptAt: .8, rejectAt: .2, minConfidence: .8 }, usage: { requestKey: 'jev-connection-check' } });
    const after = await captureProfileApplySnapshot(input);
    if (input.signal?.aborted) return { state: 'failed', reason: 'cancelled' };
    if (JSON.stringify(before.files) !== JSON.stringify(after.files)) return { state: 'failed', reason: 'stale' };
    if (result.status === 'ok') return { state: 'ready', ...(result.models[0] ? { model: result.models[0] } : {}) };
    const code = result.failure?.code;
    const reason: RoutingCheckResult['reason'] = code === 'credentials-unavailable' || code === 'authentication' || code === 'timeout' || code === 'cancelled' || code === 'stale' || code === 'rate-limited' ? code : code === 'invalid-response' || result.status === 'partial' ? 'invalid-response' : 'service-error';
    return { state: 'failed', reason };
  } catch { return { state: 'failed', reason: input.signal?.aborted ? 'cancelled' : 'configuration-unavailable' }; }
  finally { await db?.close(); }
}
