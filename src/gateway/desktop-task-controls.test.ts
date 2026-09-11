import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { SQLiteTaskStore } from '../tasks/sqlite-task-store.js';
import { TaskOperatorService } from '../tasks/task-operator-service.js';
import { ensureRuntimeSession } from '../session/session-workspace-ownership.js';
import { desktopTaskControl } from './desktop-task-controls.js';
import { createControlOperationId, ControlReceipts } from './control-receipts.js';
it('uses core lifecycle and guidance while rejecting foreign Sessions and stale targets', async () => {
  const root = await mkdtemp('/tmp/ec-task-control-'); const db = new SQLiteSessionDB({ path: join(root, 'sessions.sqlite') });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: 's', profileId: 'p', workspaceRoot: root, homeDir: root, durable: true });
    const binding = (await db.getSession('s'))!.executionTarget!;
    const store = new SQLiteTaskStore({ db: db.db, profileId: 'p' });
    const created = new TaskOperatorService({ store }).begin({ objective: 'Inspect', workspace: binding.workspace, creatorSessionId: 's' });
    const request = { method: 'task.pause' as const, sessionId: 's', taskId: created.taskId, targetId: binding.targetId, targetGeneration: binding.targetGeneration, operationId: createControlOperationId() };
    expect(() => desktopTaskControl(store, { ...request, sessionId: 'foreign' })).toThrow('binding');
    expect(() => desktopTaskControl(store, { ...request, targetGeneration: 99 })).toThrow('binding');
    expect(() => desktopTaskControl(new SQLiteTaskStore({ db: db.db, profileId: 'q' }), request)).toThrow('binding');
    desktopTaskControl(store, request); expect(store.getTask(created.taskId)?.status).toBe('paused');
    desktopTaskControl(store, { ...request, method: 'task.guide', guidance: 'Focus on the test' });
    expect(store.listGuidance(created.taskId)).toHaveLength(1);
    desktopTaskControl(store, { ...request, method: 'task.resume' }); expect(store.getTask(created.taskId)?.status).toBe('queued');
    expect(() => desktopTaskControl(store, { ...request, method: 'task.retry' })).toThrow('not waiting');
    const receipts = new ControlReceipts(db.db, 'p', 'owner');
    const guide = { ...request, method: 'task.guide' as const, guidance: 'Focus on the test' };
    receipts.accept(guide);
    expect(() => receipts.accept({ ...guide, taskId: 'other-task' })).toThrow('different input');
    expect(() => receipts.accept({ ...guide, guidance: 'Different instruction' })).toThrow('different input');
    desktopTaskControl(store, { ...request, method: 'task.cancel' }); expect(store.getTask(created.taskId)?.status).toBe('cancelled');
    expect(() => desktopTaskControl(store, request)).toThrow('settled');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
it('allows durable Task controls after the originating Session ends without taking its execution lease', async () => {
  const { SharedSessionHost } = await import('./shared-session-host.js');
  const root = await mkdtemp('/tmp/ec-task-ended-'); const db = new SQLiteSessionDB({ path: join(root, 'sessions.sqlite') });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: 's', profileId: 'p', workspaceRoot: root, homeDir: root, durable: true });
    const binding = (await db.getSession('s'))!.executionTarget!;
    const store = new SQLiteTaskStore({ db: db.db, profileId: 'p' });
    const created = new TaskOperatorService({ store }).begin({ objective: 'Continue independently', workspace: binding.workspace, creatorSessionId: 's' });
    await db.endSession('s', 'operator-exit');
    const receipts = new ControlReceipts(db.db, 'p', 'owner');
    const host = new SharedSessionHost({ profileId: 'p', sessionDb: db, receipts, validateTarget: async () => undefined,
      acquire: async () => { throw new Error('Must not acquire a Session runtime'); }, channelApproval: async () => undefined,
      taskControl: (request) => desktopTaskControl(store, request) });
    const request = { method: 'task.pause' as const, sessionId: 's', taskId: created.taskId, targetId: binding.targetId,
      targetGeneration: binding.targetGeneration, operationId: createControlOperationId() };
    expect(await host.handle(request)).toMatchObject({ status: 'accepted' });
    while (host.hasPendingWork()) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(store.getTask(created.taskId)?.status).toBe('paused');
    expect(receipts.inspect({ ...request, method: 'inspect' })).toMatchObject([{ status: 'completed' }]);
    await host.close();
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
