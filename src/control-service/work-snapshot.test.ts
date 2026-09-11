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
    expect(state.work[0]?.status).toBe('needs_attention');
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
it('reconstructs Tasks under user Sessions and keeps operator-only origins out of navigation', async () => {
  const { SQLiteTaskStore } = await import('../tasks/sqlite-task-store.js');
  const { TaskOperatorService } = await import('../tasks/task-operator-service.js');
  const homeDir = await mkdtemp('/tmp/ec-task-work-');
  const path = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
  await mkdir(join(path, '..'), { recursive: true }); const db = new SQLiteSessionDB({ path });
  try {
    await db.createSession({ profileId: 'p', id: 'interactive' });
    await db.createSession({ profileId: 'p', id: 'operator', metadata: { kind: 'task-operator-origin' } });
    const service = new TaskOperatorService({ store: new SQLiteTaskStore({ db: db.db, profileId: 'p' }) });
    const a = service.begin({ objective: 'Interactive Task', workspace: { canonicalPath: '/tmp', identityHash: 'x' }, creatorSessionId: 'interactive' });
    const b = service.begin({ objective: 'Independent Task', workspace: { canonicalPath: '/tmp', identityHash: 'x' }, creatorSessionId: 'operator' });
    const state = await captureWork({ homeDir, profileId: 'p' }, new AbortController().signal);
    expect(state.work.find((w) => w.canonicalId === a.taskId)?.parentWorkId).toBe('session:interactive');
    expect(state.work.find((w) => w.canonicalId === b.taskId)?.parentWorkId).toBeUndefined();
    expect(state.work.some((w) => w.canonicalId === 'operator')).toBe(false);
    expect(state.activity[`task:${a.taskId}`]?.[0]?.kind).toBe('plan');
  } finally { db.close(); await rm(homeDir, { recursive: true, force: true }); }
});
it('does not reuse an earlier turn success for a new turn, and projects safe tool activity', async () => {
  const homeDir = await mkdtemp('/tmp/ec-work-outcome-');
  const path = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath; await mkdir(join(path, '..'), { recursive: true });
  let time = Date.parse('2026-01-01');
  const db = new SQLiteSessionDB({ path, now: () => new Date(time++) });
  try {
    await db.createSession({ id: 's', profileId: 'p' });
    await db.appendMessage({ sessionId: 's', role: 'user', content: 'First turn' });
    await db.appendEvent('s', { kind: 'execution-final-outcome-recorded', status: 'completed', terminationCause: 'normal', completionFloor: 'none' });
    expect((await captureWork({ homeDir, profileId: 'p' }, new AbortController().signal)).work[0]?.status).toBe('completed');
    await db.appendMessage({ sessionId: 's', role: 'user', content: 'New turn' });
    await db.appendEvent('s', { kind: 'tool-called', tool: 'files.read', input: { private: 'not-for-desktop' } });
    const capture = await captureWork({ homeDir, profileId: 'p' }, new AbortController().signal);
    expect(capture.work[0]?.status).toBe('needs_attention');
    expect(capture.activity['session:s']).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'files.read', state: 'running' }));
    expect(capture.activity['session:s']).toContainEqual(expect.objectContaining({ kind: 'result', status: 'completed', evidence: expect.objectContaining({ state: 'unverified' }) }));
    expect(JSON.stringify(capture)).not.toContain('not-for-desktop');
  } finally { db.close(); await rm(homeDir, { recursive: true, force: true }); }
});
it('binds schedule runs through owned Sessions even when another profile has a colliding job handle', async () => {
  const { CronExecutionStore } = await import('../cron/cron-execution-store.js');
  const { resolveProfileStateHome } = await import('../config/profile-home.js');
  const { writeFile } = await import('node:fs/promises');
  const homeDir = await mkdtemp('/tmp/ec-schedule-work-'); const path = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
  const paths = resolveProfileStateHome({ homeDir, profileId: 'p' }); await mkdir(paths.cronPath, { recursive: true });
  await writeFile(join(paths.cronPath, 'jobs.json'), JSON.stringify({ jobs: [{ id: 'shared-job-handle', name: 'Schedule', updatedAt: '2026-01-01', status: 'active', lastStatus: 'failed' }] }));
  const db = new SQLiteSessionDB({ path });
  try {
    await db.createSession({ id: 'p-session', profileId: 'p' }); await db.createSession({ id: 'q-session', profileId: 'q' });
    const runs = new CronExecutionStore({ db: db.db });
    const own = await runs.create({ jobId: 'shared-job-handle' }); const foreign = await runs.create({ jobId: 'shared-job-handle' });
    db.db.query('update cron_executions set session_id=? where id=?').run('p-session', own.id);
    db.db.query('update cron_executions set session_id=? where id=?').run('q-session', foreign.id);
    const state = await captureWork({ homeDir, profileId: 'p' }, new AbortController().signal);
    expect(state.work.find((w) => w.canonicalId === own.id)?.parentWorkId).toBe('schedule:shared-job-handle');
    expect(state.work.some((w) => w.canonicalId === foreign.id)).toBe(false);
    expect(state.inbox).toContainEqual(expect.objectContaining({ kind: 'failure', workId: 'schedule:shared-job-handle' }));
  } finally { db.close(); await rm(homeDir, { recursive: true, force: true }); }
});
