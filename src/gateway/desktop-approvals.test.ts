import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { ensureRuntimeSession } from '../session/session-workspace-ownership.js';
import { WorkspaceApprovalController } from '../security/workspace-approval-controller.js';
import { GatewayApprovalQueue } from './approval-queue.js';
import { SharedSessionHost } from './shared-session-host.js';
import type { Runtime } from '../runtime/create-runtime.js';
import type { ToolApprovalRequest } from '../contracts/tool.js';
import { createControlOperationId } from './control-receipts.js';

it('keeps a durable exact-target approval across client reconnection and resumes once', async () => {
  const root = await mkdtemp('/tmp/ec-desktop-approval-'); const db = new SQLiteSessionDB({ path: join(root, 'sessions.sqlite') });
  let host: SharedSessionHost | undefined;
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: 's', profileId: 'p', workspaceRoot: root, homeDir: root, durable: true });
    const binding = (await db.getSession('s'))!.executionTarget!;
    const queue = new GatewayApprovalQueue({ db: db.db, controller: new WorkspaceApprovalController(), pollIntervalMs: 1 });
    const grantApproval = vi.fn(async () => undefined);
    const approval: ToolApprovalRequest = { tool: { name: 'files.read' } as ToolApprovalRequest['tool'], input: { path: 'test' }, riskClass: 'read-only-local', targetSummary: 'Read selected file',
      pendingApproval: { schemaVersion: 1, id: 'action', actionKey: 'a'.repeat(64), authorizationRevision: 0, expiresAt: Date.now() + 60_000,
        executionScope: { schemaVersion: 1, profileId: 'p', sessionId: 's', workspaceIdentityHash: binding.workspace.identityHash,
          authorityFingerprint: 'b'.repeat(64), environmentInstanceId: 'environment', surfaceKey: 'local' } } };
    let decision: string | undefined;
    host = new SharedSessionHost({ sessionDb: db, profileId: 'p', approvalQueue: queue, validateTarget: async () => undefined, channelApproval: async () => { throw new Error('Not channel-owned'); },
      acquire: async () => ({ sessionId: 's', grantApproval, dispose: async () => undefined,
        handle: async (input: { onApprovalRequest: (request: ToolApprovalRequest) => Promise<string> }) => { decision = await input.onApprovalRequest(approval); return { text: 'finished' }; } }) as unknown as Runtime });
    const base = { sessionId: 's', targetId: binding.targetId, targetGeneration: binding.targetGeneration, operationId: createControlOperationId() };
    const turn = host.handle({ ...base, method: 'send', text: 'Read file' });
    let pending = (await queue.listPending({ profileId: 'p' }))[0];
    for (let i = 0; i < 100 && !pending; i++) { await new Promise((r) => setTimeout(r, 1)); pending = (await queue.listPending({ profileId: 'p' }))[0]; }
    expect(pending?.desktopBinding).toEqual({ targetId: binding.targetId, targetGeneration: binding.targetGeneration, riskClass: 'read-only-local' });
    // A fresh reader represents a restarted Desktop client; the owner remains independent.
    const reconnected = new GatewayApprovalQueue({ db: db.db, controller: new WorkspaceApprovalController() });
    expect((await reconnected.listPending({ profileId: 'p' }))[0]?.id).toBe(pending!.id);
    await expect(queue.resolveApproval(pending!.id, 'approved', 'forged', { profileId: 'q', sessionId: 's' })).rejects.toThrow();
    await expect(queue.resolveApproval(pending!.id, 'approved', 'forged', { profileId: 'p', sessionId: 'other-session' })).rejects.toThrow();
    expect(grantApproval).not.toHaveBeenCalled();
    await host.handle({ ...base, method: 'approval', approvalId: pending!.id, decision: 'approved' });
    await expect(host.handle({ ...base, method: 'approval', approvalId: pending!.id, decision: 'approved' })).rejects.toThrow();
    await turn; expect(decision).toBe('approved'); expect(grantApproval).toHaveBeenCalledOnce();
    expect(await queue.listPending({ profileId: 'p' })).toEqual([]);
  } finally { await host?.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

it('refuses hardline Desktop requests and expired or stale-generation queue resolutions', async () => {
  const root = await mkdtemp('/tmp/ec-desktop-approval-floor-'); const db = new SQLiteSessionDB({ path: join(root, 'sessions.sqlite') });
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: 's', profileId: 'p', workspaceRoot: root, homeDir: root, durable: true });
    const target = (await db.getSession('s'))!.executionTarget!;
    const queue = new GatewayApprovalQueue({ db: db.db, controller: new WorkspaceApprovalController() });
    const request = { profileId: 'p', sessionId: 's', channel: 'desktop' as const, toolName: 'terminal.run', commandPreview: 'Read workspace', commandHash: 'a'.repeat(64),
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      desktopBinding: { targetId: target.targetId, targetGeneration: target.targetGeneration, riskClass: 'read-only-local' as const },
      executionApproval: { schemaVersion: 1 as const, id: 'action', actionKey: 'a'.repeat(64), authorizationRevision: 0, expiresAt: Date.now() + 60_000,
        executionScope: { schemaVersion: 1 as const, profileId: 'p', sessionId: 's', workspaceIdentityHash: target.workspace.identityHash, authorityFingerprint: 'b'.repeat(64), environmentInstanceId: 'env', surfaceKey: 'local' } } };
    const hardline = await queue.createPendingApproval({ ...request, commandPayload: 'rm -rf /' });
    expect(hardline.status).toBe('denied'); expect(await queue.listPending({ profileId: 'p' })).toEqual([]);
    await expect(queue.createPendingApproval({ ...request, desktopBinding: { ...request.desktopBinding, targetGeneration: 99 } })).rejects.toThrow('binding');
    const expired = await queue.createPendingApproval(request);
    db.db.query("update pending_approvals set expires_at='2000-01-01T00:00:00.000Z' where id=?").run(expired.id);
    await expect(queue.resolveApproval(expired.id, 'approved', 'desktop', { profileId: 'p', sessionId: 's' })).rejects.toThrow();
    expect(await queue.listPending({ profileId: 'p' })).toEqual([]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
