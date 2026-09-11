import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { profileAttention } from './profile-attention.js';
import { WorkMonitor } from './work-monitor.js';
import type { WorkState } from './work-snapshot.js';
import type { SafeNotification } from './subscriptions.js';
it('projects setup, missing credentials, schedules and Evolution without secrets or profile escape', async () => {
  const homeDir = await mkdtemp('/tmp/ec-attention-'); const input = { homeDir, profileId: 'p' };
  const paths = resolveProfileStateHome(input);
  try {
    expect((await profileAttention(input)).inbox.map((item) => item.id)).toContain('setup:model');
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ model: { provider: 'kimi', id: 'kimi-k2' }, providers: { kimi: { apiKeyEnv: 'EC_TEST_INBOX_KEY' } } }));
    expect((await profileAttention(input)).inbox.map((item) => item.id)).toContain('setup:credential');
    await writeFile(paths.envPath, 'EC_TEST_INBOX_KEY=inbox-secret-canary\n');
    await mkdir(join(paths.skillsPath, '.evolution'), { recursive: true });
    await writeFile(join(paths.skillsPath, '.evolution', 'proposed-patches.jsonl'), JSON.stringify({ id: 'proposal', status: 'proposed', createdAt: '2026-01-01', reason: 'Review an improvement', patch: 'private-patch-canary' }) + '\n');
    await mkdir(paths.cronPath, { recursive: true });
    await writeFile(join(paths.cronPath, 'jobs.json'), JSON.stringify({ jobs: [{ id: 'job', name: 'Schedule', updatedAt: '2026-01-01', status: 'active', lastStatus: 'failed' }] }));
    const state = await profileAttention(input);
    expect(state.inbox.map((item) => item.id)).not.toContain('setup:credential');
    expect(state.inbox.map((item) => item.kind)).toContain('evolution');
    expect(state.jobs[0]?.id).toBe('job');
    expect(JSON.stringify(state.inbox)).not.toContain('private-patch-canary');
    expect(JSON.stringify(state)).not.toContain('inbox-secret-canary');
    expect(process.env.EC_TEST_INBOX_KEY).toBeUndefined();
    const foreign = resolveProfileStateHome({ homeDir, profileId: 'q' });
    await symlink(paths.profileRoot, foreign.profileRoot);
    const rejected = await profileAttention({ homeDir, profileId: 'q' });
    expect(rejected.inbox.map((item) => item.id)).toContain('setup:repair');
    expect(rejected.inbox.some((item) => item.kind === 'evolution')).toBe(false);
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
it('publishes canonical changes once and requests resync for rewritten history', async () => {
  let state: WorkState = { work: [], activity: {}, inbox: [] }; const events: SafeNotification[] = [];
  const monitor = new WorkMonitor(state, async () => state, (event) => events.push(event));
  try {
    state = { work: [{ id: 'session:s', canonicalId: 's', profileId: 'p', kind: 'session', title: 'Work', status: 'running', updatedAt: 1, target: null }],
      activity: { 'session:s': [{ id: 'm', workId: 'session:s', profileId: 'p', kind: 'message', role: 'assistant', text: 'Hello', sequence: 0, timestamp: 1 }] },
      inbox: [{ id: 'attention', profileId: 'p', workId: 'session:s', kind: 'input', title: 'Input', summary: '', createdAt: 1, approval: null }] };
    await monitor.tick(); expect(events.map((e) => e.type)).toEqual(['work.changed', 'attention.changed', 'activity.appended']);
    await monitor.tick(); expect(events).toHaveLength(3);
    state.activity = {}; state.work = []; state.inbox = [];
    await monitor.tick(); expect(events).toContainEqual({ type: 'attention.changed', payload: { itemId: 'attention', item: null } });
    expect(events).toContainEqual({ type: 'service.warning', payload: { reason: 'resync_required' } });
  } finally { monitor.dispose(); }
});

it('requests resync when history outside the preview budget changes or is rewritten', async () => {
  let state: WorkState = { work: [], activity: {}, history: { 'session:s': { messages: 1, events: 1, count: 1, revision: 0 } } };
  const events: SafeNotification[] = [];
  const monitor = new WorkMonitor(state, async () => state, event => events.push(event));
  try {
    state = { ...state, history: { 'session:s': { messages: 2, events: 1, count: 2, revision: 0 } } };
    await monitor.tick();
    expect(events).toEqual([{ type: 'service.warning', payload: { reason: 'resync_required' } }]);
    events.length = 0; await monitor.tick(); expect(events).toEqual([]);
    state = { ...state, history: { 'session:s': { messages: 2, events: 1, count: 2, revision: 1 } } };
    await monitor.tick(); expect(events).toHaveLength(1);
  } finally { monitor.dispose(); }
});
