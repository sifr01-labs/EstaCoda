import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { resolveGlobalStateHome } from '../config/profile-home.js';
import { captureWork, WorkSnapshot } from './work-snapshot.js';
import { taskActions, constrainActions } from './action-projections.js';
import { SQLiteTaskStore } from '../tasks/sqlite-task-store.js';
import { TaskOperatorService } from '../tasks/task-operator-service.js';
import { appendTaskWork, taskWork } from './task-projections.js';

async function fixture() {
  const homeDir = await mkdtemp('/tmp/ec-review-fix-'), input = { homeDir, profileId: 'p' };
  const path = resolveGlobalStateHome(input).sessionsSqlitePath;
  await mkdir(join(path, '..'), { recursive: true });
  const db = new SQLiteSessionDB({ path, now: () => new Date('2026-01-01T00:00:00Z') });
  return { input, db, capture: () => captureWork(input, new AbortController().signal),
    close: async () => { db.close(); await rm(homeDir, { recursive: true, force: true }); } };
}
const outcome = { kind: 'execution-final-outcome-recorded', status: 'completed', terminationCause: 'normal', completionFloor: 'none' } as const;
it('binds same-timestamp completion to its canonical user turn, and puts blocked Sessions in Inbox', async () => {
  const f = await fixture();
  try {
    await f.db.createSession({ id: 's', profileId: 'p' });
    await f.db.appendMessage({ sessionId: 's', role: 'user', content: 'First' });
    await f.db.appendEvent('s', outcome);
    expect((await f.capture()).work[0]?.status).toBe('completed');
    await f.db.appendMessage({ sessionId: 's', role: 'user', content: 'Next' });
    expect((await f.capture()).work[0]?.status).toBe('needs_attention');
    await f.db.appendEvent('s', { ...outcome, status: 'blocked' });
    const state = await f.capture();
    expect(state.inbox).toContainEqual(expect.objectContaining({ workId: 'session:s', kind: 'input', actions: expect.arrayContaining([{ id: 'open_work', enabled: true }]) }));
    await f.db.appendEvent('s', outcome);
    expect((await f.capture()).inbox?.some(item => item.workId === 'session:s' && item.kind === 'input')).toBe(false);
    await f.db.rewriteTranscript({ sessionId: 's', messages: [{ role: 'user', content: 'Compressed history' }] });
    expect((await f.capture()).work[0]?.status).toBe('completed');
    // Legacy records without turn references remain uncertain when timestamps tie.
    f.db.db.query("update session_events set event_json=json_remove(event_json,'$.turnMessageId') where session_id=?").run('s');
    expect((await f.capture()).work[0]?.status).toBe('needs_attention');
  } finally { await f.close(); }
});
it('pages long transcripts and tool history without blocking profile bootstrap or changing an existing epoch', async () => {
  const f = await fixture();
  try {
    await f.db.createSession({ id: 's', profileId: 'p' });
    for (let i = 0; i < 1002; i++) {
      await f.db.appendMessage({ sessionId: 's', role: 'user', content: 'x'.repeat(8192) });
      await f.db.appendEvent('s', { kind: 'tool-called', tool: 'files.read', input: { secret: 'not-exported' } });
    }
    await f.db.appendEvent('s', outcome);
    const state = await f.capture(), snapshot = new WorkSnapshot(state, f.input);
    expect(state.work[0]?.status).toBe('completed');
    expect(Buffer.byteLength(JSON.stringify(state.activity))).toBeLessThan(1_048_576);
    const first = await snapshot.activity('session:s', { limit: 100 });
    expect(first.nextCursor).not.toBeNull();
    expect(await snapshot.activity('session:s', { limit: 100 })).toEqual(first);
    await f.db.appendMessage({ sessionId: 's', role: 'user', content: 'After capture' });
    const items = [...first.items]; let cursor = first.nextCursor;
    while (cursor) {
      const page = await snapshot.activity('session:s', { limit: 100, cursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(100_000);
      items.push(...page.items); cursor = page.nextCursor;
    }
    expect(items).toHaveLength(2005);
    expect(new Set(items.map(item => item.id)).size).toBe(2005);
    expect(JSON.stringify(items)).not.toContain('After capture');
    expect(JSON.stringify(items)).not.toContain('not-exported');
    await expect(snapshot.activity('session:s', { limit: 99, cursor: first.nextCursor! })).rejects.toThrow();
    await expect(new WorkSnapshot(state, { ...f.input, profileId: 'q' }).activity('session:s', { limit: 1 })).rejects.toThrow();
    await f.db.rewriteTranscript({ sessionId: 's', messages: [{ role: 'user', content: 'Compacted' }] });
    await expect(snapshot.activity('session:s', { limit: 100, cursor: first.nextCursor! })).rejects.toThrow('snapshot');
    expect((await new WorkSnapshot(await f.capture(), f.input).activity('session:s', { limit: 100 })).items.length).toBeGreaterThan(0);
  } finally { await f.close(); }
}, 30_000);
it('keeps navigation and Inbox available beyond 1,000 Sessions and Tasks', async () => {
  const f = await fixture();
  try {
    const store = new SQLiteTaskStore({ db: f.db.db, profileId: 'p' }), service = new TaskOperatorService({ store });
    await f.db.createSession({ id: 'origin', profileId: 'p' });
    for (let i = 0; i < 1001; i++) {
      await f.db.createSession({ id: 's-' + i, profileId: 'p' });
      service.begin({ objective: 'Task ' + i, creatorSessionId: 'origin', workspace: { canonicalPath: '/tmp', identityHash: 'x' } });
    }
    await f.db.appendMessage({ sessionId: 's-1000', role: 'user', content: 'Needs help' });
    await f.db.appendEvent('s-1000', { ...outcome, status: 'blocked' });
    const state = await f.capture();
    expect(state.work.filter(work => work.kind === 'session')).toHaveLength(1002);
    expect(state.work.filter(work => work.kind === 'task')).toHaveLength(1001);
    expect(state.inbox).toContainEqual(expect.objectContaining({ workId: 'session:s-1000', kind: 'input' }));
    const snapshot = new WorkSnapshot(state); let cursor: string | undefined, count = 0;
    do { const page = snapshot.page('work', state.work, { limit: 100, cursor }); count += page.items.length; cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(count).toBe(state.work.length);
  } finally { await f.close(); }
}, 30_000);
it('computes Task lifecycle and retry budget hints in the backend and preserves stop after trust loss', async () => {
  const f = await fixture();
  try {
    const store = new SQLiteTaskStore({ db: f.db.db, profileId: 'p' }), service = new TaskOperatorService({ store });
    await f.db.createSession({ id: 's', profileId: 'p' });
    const { taskId } = service.begin({ objective: 'Task', creatorSessionId: 's', workspace: { canonicalPath: '/tmp', identityHash: 'x' } });
    const task = store.getTask(taskId)!;
    // Availability requires an exact target; final dispatch still validates the real record.
    task.executionTarget = { schemaVersion: 1, targetId: 't', targetGeneration: 1, workspace: task.workspace };
    let actions = taskActions(task, store);
    expect(actions.find(a => a.id === 'tasks.resume')?.enabled).toBe(false);
    expect(actions.find(a => a.id === 'tasks.retry')?.reason).toBeTruthy();
    const step = store.listSteps(taskId, task.activePlanRevisionId!)[0]!;
    store.updateStep({ ...step, status: 'ready' });
    store.updateStep({ ...step, status: 'running' });
    store.updateStep({ ...step, status: 'waiting_for_input' });
    task.status = 'waiting_for_input';
    const exhausted = new Proxy(store, { get(target, key) {
      if (key === 'listAttempts') return () => Array.from({ length: step.retryPolicy.maxAttempts }, () => ({}));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    actions = taskActions(task, exhausted);
    expect(actions.find(a => a.id === 'tasks.retry')).toMatchObject({ enabled: false, stepId: step.id });
    store.updateStep({ ...step, status: 'waiting_for_input' });
    actions = taskActions(task, store);
    expect(actions.find(a => a.id === 'tasks.retry')).toMatchObject({ enabled: true, stepId: step.id });
    const work = { ...taskWork(task, new Set()), actions };
    constrainActions(work, false, true);
    expect(work.actions?.find(a => a.id === 'tasks.retry')).toMatchObject({ enabled: false, reason: expect.any(String) });
    expect(work.actions?.find(a => a.id === 'tasks.cancel')?.enabled).toBe(true);
    expect(taskActions({ ...task, status: 'completed' }, store).filter(a => a.enabled).map(a => a.id)).toEqual(['inspect_result']);
  } finally { await f.close(); }
});

it('authenticates unlimited forward continuations without exhausting a cursor cache', () => {
  const snapshot = new WorkSnapshot({ work: [], activity: {} });
  const values = Array.from({ length: 4200 }, (_, i) => i);
  let cursor: string | undefined;
  for (let i = 0; i < values.length; i++) {
    const page = snapshot.page('history', values, { limit: 1, cursor });
    expect(page.items).toEqual([i]); cursor = page.nextCursor ?? undefined;
  }
  const page = snapshot.page('history', values, { limit: 1 });
  const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
  decoded[0] = 4000;
  expect(() => snapshot.page('history', values, { limit: 1, cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') })).toThrow();
});

it('derives live action hints from read-only target validation and current trust', async () => {
  const { ExecutionTargetStore, targetBinding } = await import('../workspaces/execution-target.js');
  const { WorkspaceTrustStore } = await import('../security/workspace-trust-store.js');
  const { resolveProfileStateHome } = await import('../config/profile-home.js');
  const { writeFile, stat } = await import('node:fs/promises');
  const f = await fixture();
  try {
    const targets = new ExecutionTargetStore(f.input);
    const target = await targets.acquireLocal(f.input.homeDir); targets.close();
    const paths = resolveProfileStateHome(f.input), registryPath = join(paths.profileRoot, 'workspaces.sqlite');
    await writeFile(paths.configPath, JSON.stringify({ model: { provider: 'ollama', id: 'llama3' }, providers: { ollama: { authMethod: 'none' } } }));
    const trust = new WorkspaceTrustStore(f.input); await trust.grant(f.input.homeDir);
    await f.db.createSession({ id: 's', profileId: 'p', executionTarget: targetBinding(target) });
    await f.db.appendMessage({ sessionId: 's', role: 'user', content: 'Continue' });
    const before = await stat(registryPath);
    let state = await f.capture();
    expect(state.work[0]?.actions).toContainEqual({ id: 'sessions.send', enabled: true, sessionId: 's' });
    const after = await stat(registryPath);
    expect(after.mode).toBe(before.mode); expect(after.mtimeMs).toBe(before.mtimeMs);
    const reader = new ExecutionTargetStore({ ...f.input, readonly: true });
    try { await expect(reader.add('forbidden', f.input.homeDir)).rejects.toThrow(); }
    finally { reader.close(); }
    await trust.revoke(f.input.homeDir);
    state = await f.capture();
    expect(state.work[0]?.actions?.find(a => a.id === 'sessions.send')).toMatchObject({ enabled: false, reason: expect.any(String), sessionId: 's' });
    expect(state.work[0]?.actions?.find(a => a.id === 'sessions.cancelTurn')?.enabled).toBe(false);
    const { SessionExecutionOwnership } = await import('../session/execution-ownership.js');
    const ownership = new SessionExecutionOwnership(f.db.db);
    const claim = ownership.claim({ sessionId: 's', profileId: 'p', targetId: target.id });
    expect((await f.capture()).work[0]?.actions?.find(a => a.id === 'sessions.cancelTurn')?.enabled).toBe(true);
    ownership.release(claim);
    await trust.grant(f.input.homeDir);
    const stale = { ...targetBinding(target), targetGeneration: target.generation + 1 };
    await f.db.createSession({ id: 'stale', profileId: 'p', executionTarget: stale });
    expect((await f.capture()).work.find(work => work.canonicalId === 'stale')?.actions?.find(a => a.id === 'sessions.send')?.enabled).toBe(false);
  } finally { await f.close(); }
});

it('projects the latest delegated request consistently and keeps standalone Tasks separate', async () => {
 const f=await fixture();try{
  await f.db.createSession({id:'origin',profileId:'p'});
  const store=new SQLiteTaskStore({db:f.db.db,profileId:'p'}), service=new TaskOperatorService({store});
  const created=service.begin({objective:'Research and deliver',creatorSessionId:'origin',workspace:{canonicalPath:'/tmp',identityHash:'x'}});
  const task={...store.getTask(created.taskId)!,source:'delegation' as const,originTurnId:'turn'};
  const projectedStore=new Proxy(store,{get(target,key){if(key==='listTasks')return()=>[task];const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const origin={id:'session:origin',canonicalId:'origin',profileId:'p',kind:'session' as const,title:'Chat',status:'completed' as const,updatedAt:0,target:null,actions:[{id:'sessions.cancelTurn' as const,enabled:true}]};
  const state={requestTurns:{origin:'turn'},work:[origin] as import('../contracts/desktop-control/index.js').WorkProjection[],activity:{}};
  await appendTaskWork(state,projectedStore);
  const child=state.work.find(work=>work.kind==='task')!;
  expect(child.parentWorkId).toBe(origin.id);expect(origin.status).toBe(child.status);
  expect(origin.actions[0]?.enabled).toBe(true); // A foreground owner may still be settling its handoff.
  expect(child.taskProgress?.steps.length).toBeGreaterThan(0);expect(child.taskProgress?.fileVerified).toBe(false);
  expect(taskWork({...task,source:'cli'},new Set()).parentWorkId).toBeUndefined();
  const next={...origin,status:'completed' as const};
  await appendTaskWork({requestTurns:{origin:'new-turn'},work:[next],activity:{}},projectedStore);
  expect(next.status).toBe('completed');
 }finally{await f.close();}
});
