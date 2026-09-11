import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { it, expect, vi } from 'vitest';
import { CONTROL_EVENTS, CONTROL_METHODS } from '../contracts/desktop-control/index.js';
import { resolveGlobalStateHome, resolveProfileStateHome } from '../config/profile-home.js';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { ensureRuntimeSession, validateSessionWorkspaceOwnership } from '../session/session-workspace-ownership.js';
import { WorkspaceTrustStore } from '../security/workspace-trust-store.js';
import { WorkspaceApprovalController } from '../security/workspace-approval-controller.js';
import { acquireGatewayLock, releaseGatewayLock } from '../gateway/gateway-lock.js';
import { startPrivateControl } from '../gateway/private-control.js';
import { SharedSessionHost } from '../gateway/shared-session-host.js';
import { ControlReceipts, createControlOperationId } from '../gateway/control-receipts.js';
import { GatewayApprovalQueue } from '../gateway/approval-queue.js';
import { getPackageVersion } from '../cli/version-command.js';
import type { Runtime } from '../runtime/create-runtime.js';
import type { ToolApprovalRequest } from '../contracts/tool.js';
function client(homeDir: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'desktop-service', '--stdio', '--profile', 'p'], {
    env: { ...process.env, ESTACODA_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', serial = 0, diagnostics = '';
  const pending = new Map<string, (value: any) => void>();
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(value.id)?.(value); pending.delete(value.id); }
  });
  const ended = new Promise((resolve) => child.once('exit', resolve));
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = `r${++serial}`; const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Desktop response timeout')); }, 8000);
    pending.set(id, (value) => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { rpc, diagnostics: () => diagnostics,
    initialize: () => rpc('control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: 'p', capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } }),
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); try { await ended; } finally { clearTimeout(timer); } },
  };
}
it.skipIf(process.platform === 'win32')('starts and controls Work through a real bridge process, reconnects to approval, and rejects forged resolutions', async () => {
  const homeDir = await mkdtemp('/tmp/ec-live-work-'); const paths = resolveProfileStateHome({ homeDir, profileId: 'p' });
  const lock = await acquireGatewayLock(paths); const db = new SQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir }).sessionsSqlitePath });
  const clients: ReturnType<typeof client>[] = []; let transport: Awaited<ReturnType<typeof startPrivateControl>> | undefined, host: SharedSessionHost | undefined;
  try {
    await ensureRuntimeSession({ sessionDb: db, sessionId: 'existing', profileId: 'p', workspaceRoot: homeDir, homeDir, durable: true });
    const target = (await db.getSession('existing'))!.executionTarget!;
    await new WorkspaceTrustStore({ homeDir }).grant(homeDir);
    const queue = new GatewayApprovalQueue({ db: db.db, controller: new WorkspaceApprovalController(), pollIntervalMs: 1 });
    const grantApproval = vi.fn(async () => undefined);
    const receipts = new ControlReceipts(db.db, 'p', lock.instanceId!);
    host = new SharedSessionHost({ profileId: 'p', sessionDb: db, receipts, approvalQueue: queue,
      validateTarget: async (request) => {
        const session = (await db.getSessionForProfile(request.sessionId, 'p'))!;
        await validateSessionWorkspaceOwnership({ homeDir, profileId: 'p', session, workspaceRoot: homeDir });
      }, channelApproval: async () => { throw new Error('No matching channel approval'); },
      acquire: async (sessionId) => ({ sessionId, grantApproval, dispose: async () => undefined,
        handle: async (input: { text: string; onApprovalRequest: (request: ToolApprovalRequest) => Promise<string> }) => {
          await db.appendMessage({ sessionId, role: 'user', content: input.text });
          const decision = await input.onApprovalRequest({ tool: { name: 'files.read' } as ToolApprovalRequest['tool'], input: {}, riskClass: 'read-only-local', targetSummary: 'Read workspace file',
            pendingApproval: { schemaVersion: 1, id: 'action', actionKey: 'a'.repeat(64), authorizationRevision: 0, expiresAt: Date.now() + 60_000,
              executionScope: { schemaVersion: 1, profileId: 'p', sessionId, workspaceIdentityHash: target.workspace.identityHash, authorityFingerprint: 'b'.repeat(64), environmentInstanceId: 'fake-runtime', surfaceKey: 'local' } } });
          await db.appendMessage({ sessionId, role: 'agent', content: decision === 'approved' ? 'Finished' : 'Denied' });
          return { text: 'Finished' };
        } }) as unknown as Runtime });
    transport = await startPrivateControl({ directory: paths.gatewayStatePath, profileId: 'p', instanceId: lock.instanceId!, version: await getPackageVersion(), targetGeneration: true, handle: (request) => host!.handle(request) });
    const first = client(homeDir); clients.push(first); await first.initialize();
    const binding = { sessionId: 'new-session', target: { targetId: target.targetId, targetGeneration: target.targetGeneration } };
    const started = await first.rpc('sessions.start', { ...binding, operationId: createControlOperationId() }); expect(started.result?.state).toBe('accepted');
    const sendId = createControlOperationId();
    expect((await first.rpc('sessions.send', { ...binding, operationId: sendId, text: 'Read a file' })).result?.state).toBe('accepted');
    await first.close();
    const next = client(homeDir); clients.push(next); await next.initialize(); await next.rpc('control.bootstrap', {});
    const inbox = await next.rpc('inbox.list', { limit: 100 });
    const approval = inbox.result?.items.find((item: any) => item.kind === 'approval')?.approval;
    expect(approval).toMatchObject({ sessionId: binding.sessionId, target: binding.target, scope: 'once' });
    for (const forged of [{ approvalId: 'forged' }, { sessionId: 'existing' }, { target: { ...binding.target, targetGeneration: 99 } }]) {
      const rejected = await next.rpc('approvals.resolve', { ...binding, operationId: createControlOperationId(), approvalId: approval.id, decision: 'approved', ...forged });
      expect(rejected.error).toBeDefined(); expect(grantApproval).not.toHaveBeenCalled();
    }
    const resolveId = createControlOperationId();
    expect((await next.rpc('approvals.resolve', { ...binding, operationId: resolveId, approvalId: approval.id, decision: 'approved' })).result?.state).toBe('accepted');
    while (host.hasPendingWork()) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(grantApproval).toHaveBeenCalledOnce();
    expect((await next.rpc('operations.inspect', { ...binding, operationId: sendId, method: 'sessions.send' })).result?.state).toBe('completed');
    expect((await next.rpc('sessions.send', { ...binding, operationId: sendId, text: 'Read a file' })).result?.state).toBe('completed');
    expect((await next.rpc('approvals.resolve', { ...binding, operationId: createControlOperationId(), approvalId: approval.id, decision: 'approved' })).error).toBeDefined();
    expect(grantApproval).toHaveBeenCalledOnce();
    expect(clients.map((c) => c.diagnostics()).join('')).toBe('');
  } finally { for (const c of clients) await c.close(); await host?.close(); await transport?.close(); await releaseGatewayLock(paths, lock.instanceId); db.close(); await rm(homeDir, { recursive: true, force: true }); }
}, 20_000);
