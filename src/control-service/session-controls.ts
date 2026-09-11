import { resolveGlobalStateHome, resolveProfileStateHome } from '../config/profile-home.js';
import { ControlProtocolError, type MethodRequest, type OperationReceipt } from '../contracts/desktop-control/index.js';
import { callPrivateControl, type PrivateControlRequest } from '../gateway/private-control.js';
import type { ControlReceipt } from '../gateway/control-receipts.js';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { ExecutionTargetStore, targetBinding } from '../workspaces/execution-target.js';
import { WorkspaceTrustStore } from '../security/workspace-trust-store.js';

export type SessionMutationRequest = Extract<MethodRequest, { method: 'sessions.start' | 'sessions.resume' | 'sessions.send' | 'sessions.cancelTurn' | 'operations.inspect' }>;
const methods = { 'sessions.start': 'start', 'sessions.resume': 'resume', 'sessions.send': 'send', 'sessions.cancelTurn': 'cancel', 'approvals.resolve': 'approval' } as const;
/** Creates only a canonical Session reference. Provider/tool construction stays in the supervisor. */
async function prepareStart(input: { homeDir: string; profileId: string }, request: SessionMutationRequest): Promise<void> {
  const targets = new ExecutionTargetStore(input);
  try {
    const target = targets.getTarget(request.params.target.targetId);
    if (!target || target.generation !== request.params.target.targetGeneration) throw new ControlProtocolError('-32003');
    await targets.validate(targetBinding(target), target.workspace.canonicalPath);
    if (!await new WorkspaceTrustStore(input).isTrusted(target.workspace.canonicalPath)) throw new ControlProtocolError('-32003');
    const db = new SQLiteSessionDB({ path: resolveGlobalStateHome(input).sessionsSqlitePath });
    try {
      const existing = await db.getSession(request.params.sessionId);
      if (existing) {
        if (existing.profileId !== input.profileId || existing.metadata?.desktopStartOperationId !== request.params.operationId ||
          JSON.stringify(existing.executionTarget) !== JSON.stringify(targetBinding(target))) throw new ControlProtocolError('-32003');
      } else {
        const issuedAt = Number(request.params.operationId.split(':')[0]);
        if (Math.abs(Date.now() - issuedAt) > 300_000) throw new ControlProtocolError('-32003');
        await db.createSession({ id: request.params.sessionId, profileId: input.profileId, executionTarget: targetBinding(target),
          metadata: { originSurface: 'desktop', desktopStartOperationId: request.params.operationId } });
      }
    } finally { db.close(); }
  } finally { targets.close(); }
}
export async function sessionControl(input: { homeDir: string; profileId: string; version: string }, request: SessionMutationRequest, signal: AbortSignal): Promise<OperationReceipt> {
  signal.throwIfAborted();
  if (request.method === 'sessions.start') await prepareStart(input, request);
  const method = request.method === 'operations.inspect' ? request.params.method : request.method;
  const control: PrivateControlRequest = { method: request.method === 'operations.inspect' ? 'inspect' : methods[method],
    sessionId: request.params.sessionId, targetId: request.params.target.targetId, targetGeneration: request.params.target.targetGeneration,
    operationId: request.params.operationId, ...(request.method === 'sessions.send' ? { text: request.params.text } : {}) };
  const response = await callPrivateControl({ ...input, directory: resolveProfileStateHome(input).gatewayStatePath, request: control,
    requireTargetGeneration: true, signal, ...(request.method === 'operations.inspect' ? {} : { startIfNeeded: { homeDir: input.homeDir } }) });
  const receipt = request.method === 'operations.inspect'
    ? (response as { receipts: ControlReceipt[] }).receipts.find((receipt) => receipt.method === methods[method]) : response as ControlReceipt;
  if (receipt && (receipt.operationId !== control.operationId || receipt.sessionId !== control.sessionId || receipt.method !== methods[method] ||
    receipt.targetId !== control.targetId || receipt.targetGeneration !== control.targetGeneration)) throw new ControlProtocolError('-32003');
  const state = receipt?.status ?? (Date.now() - Number(control.operationId.split(':')[0]) > 30 * 86_400_000 ? 'expired' : 'unknown');
  if (!['accepted', 'dispatched', 'completed', 'uncertain', 'unknown', 'expired'].includes(state)) throw new ControlProtocolError('-32603');
  return { profileId: input.profileId, operationId: control.operationId, sessionId: control.sessionId,
    target: { targetId: receipt?.targetId ?? control.targetId, targetGeneration: receipt?.targetGeneration ?? control.targetGeneration! },
    method, state: state as OperationReceipt['state'], cancellation: method === 'sessions.cancelTurn' && receipt ? 'requested' : 'not_requested' };
}
