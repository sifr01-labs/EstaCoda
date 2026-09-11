import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { resolveGlobalStateHome } from '../config/profile-home.js';
import { mkdir } from 'node:fs/promises';
import { captureWork, WorkSnapshot } from './work-snapshot.js';
import { sessionWork } from './work-projections.js';
it('captures only the selected profile without migrating or exposing raw event payloads', async () => {
  const homeDir = await mkdtemp('/tmp/ec-work-');
  const path = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
  await mkdir(join(path, '..'), { recursive: true });
  const db = new SQLiteSessionDB({ path });
  try {
    const session = await db.createSession({ profileId: 'p', id: 's', title: 'Review' });
    await db.createSession({ profileId: 'q', id: 'foreign' });
    await db.appendMessage({ sessionId: 's', role: 'user', content: 'Hello' });
    await db.appendEvent('s', { kind: 'tool-called', tool: 'files.read', input: { secret: 'private-event-canary' } });
    const state = await captureWork({ homeDir, profileId: 'p' }, new AbortController().signal);
    expect(state.work.map((w) => w.canonicalId)).toEqual(['s']);
    expect(state.work[0]?.status).toBe('draft');
    expect(JSON.stringify(state)).not.toContain('private-event-canary');
    expect(state.activity['session:s']?.[0]).toMatchObject({ text: 'Hello', role: 'user' });
    expect(sessionWork(session, [{ kind: 'execution-final-outcome-recorded', status: 'partially_completed', terminationCause: 'normal', completionFloor: 'partial' } as never], false).status).toBe('partial');
  } finally { db.close(); await rm(homeDir, { recursive: true, force: true }); }
});
it('fences paging to the query, page size and capture epoch', () => {
  const one = new WorkSnapshot({ work: [], activity: {} }), two = new WorkSnapshot({ work: [], activity: {} });
  const page = one.page('work', [1, 2, 3], { limit: 1 });
  expect(one.page('work', [1, 2, 3], { limit: 1, cursor: page.nextCursor! }).items).toEqual([2]);
  expect(() => one.page('activity', [], { limit: 1, cursor: page.nextCursor! })).toThrow();
  expect(() => one.page('work', [], { limit: 2, cursor: page.nextCursor! })).toThrow();
  expect(() => two.page('work', [], { limit: 1, cursor: page.nextCursor! })).toThrow();
});
