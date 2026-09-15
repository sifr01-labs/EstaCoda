import { randomUUID } from 'node:crypto';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { callPrivateControl } from '../gateway/private-control.js';
import type { ConnectorStatus, WorkProjection } from '../contracts/desktop-control/index.js';
import { browserOwner } from './browser-view.js';
import { safeText } from './work-projections.js';

type Input = { homeDir: string; profileId: string; version: string };
/** Forward to the existing session owner; never replace its browser or replay a turn. */
export async function connectorControl(input: Input, work: WorkProjection | undefined, action: 'inspect' | 'reconnect', signal: AbortSignal): Promise<ConnectorStatus> {
  const config = await loadRuntimeConfig({ ...input, workspaceRoot: input.homeDir, configurationInspection: true });
  const entries = Object.entries(config.mcp.servers);
  if (entries.length > 128) throw new Error('Connector inventory exceeds the display limit.');
  const base: ConnectorStatus = { state: 'not_loaded', items: entries.map(([id, server]) => ({
    id: safeText(id, 160), state: server.enabled === false ? 'disabled' : 'not_loaded', toolCount: 0
  })) };
  if (!work) { if (action === 'reconnect') throw new Error('Select a chat to reconnect its connectors.'); return base; }
  if (work.kind !== 'session') throw new Error('Select a conversation to reconnect connectors.');
  const session = await browserOwner(input, work, signal);
  try {
    const response = await callPrivateControl({
      directory: resolveProfileStateHome(input).gatewayStatePath, profileId: input.profileId, version: input.version,
      requireTargetGeneration: true, signal,
      ...(action === 'reconnect' ? { startIfNeeded: { homeDir: input.homeDir } } : {}),
      request: { method: 'mcp.control', connectorAction: action, sessionId: session.id,
        targetId: session.executionTarget!.targetId, targetGeneration: session.executionTarget!.targetGeneration, operationId: randomUUID() }
    }) as { state: string; servers: import('../mcp/mcp-tools.js').MCPServerSnapshot[] | null };
    if (!['ready', 'reconnecting', 'failed', 'busy'].includes(response.state)) throw new Error('Invalid connector state.');
    base.state = response.state as ConnectorStatus['state'];
    if (response.servers === null && base.state === 'ready') base.state = 'not_loaded';
    for (const item of base.items) {
      const server = response.servers?.find(server => safeText(server.name, 160) === item.id);
      if (server) { item.state = !server.enabled ? 'disabled' : server.connected && server.available ? 'ready' : 'needs_attention'; item.toolCount = server.available ? server.toolCount : 0; }
    }
    return base;
  } catch (error) {
    signal.throwIfAborted();
    if (action === 'reconnect') throw error;
    return { ...base, state: 'unavailable' };
  }
}
