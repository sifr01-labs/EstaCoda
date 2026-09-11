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
    await host.handle({ ...base, method: 'approval', approvalId: pending!.id, decision: 'approved' });
    await expect(host.handle({ ...base, method: 'approval', approvalId: pending!.id, decision: 'approved' })).rejects.toThrow();
    await turn; expect(decision).toBe('approved'); expect(grantApproval).toHaveBeenCalledOnce();
    expect(await queue.listPending({ profileId: 'p' })).toEqual([]);
  } finally { await host?.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});
