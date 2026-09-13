import {launchDesktopBridge as launch} from '../test/desktop-bridge-client.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { probePrivateControl, startPrivateControl } from '../gateway/private-control.js';

it.skipIf(process.platform === 'win32')('reconnects independent bridges to the same owner, fences profiles and forgets credentials across restart', async () => {
  const homeDir = await mkdtemp('/tmp/ec-lifecycle-');
  const directory = resolveProfileStateHome({ homeDir, profileId: 'p' }).gatewayStatePath;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pointer = join(homeDir, '.estacoda', 'active-profile.json'); await writeFile(pointer, '{"profileId":"untouched"}');
  const handle = vi.fn(async () => { throw new Error('Readiness must not dispatch execution'); });
  const { getPackageVersion } = await import('../cli/version-command.js'); const version = await getPackageVersion();
  let host = await startPrivateControl({ directory, profileId: 'p', instanceId: 'owner1', version, handle });
  const bridges: ReturnType<typeof launch>[] = [];
  const start = (profile: string) => { const bridge = launch(homeDir, profile); bridges.push(bridge); return bridge; };
  try {
    const a = start('p'), b = start('p'), foreign = start('q');
    const [ai, bi] = await Promise.all([a.initialize(), b.initialize()]);
    expect(ai.result.instanceId).not.toBe(bi.result.instanceId);
    expect((await foreign.initialize('p')).error.code).toBe(-32003); await foreign.initialize();
    const boot = (await a.rpc('control.bootstrap', {})).result;
    expect(boot.runtime.state).toBe('ready'); expect(boot.capabilities.methods).toContain('sessions.send');
    expect((await foreign.rpc('control.bootstrap', {})).result.runtime.state).toBe('stopped');
    const scope = { windowId: 'w', generation: 1, purpose: 'provider', providerId: 'local', authMethod: 'api_key', endpoint: 'http://localhost:8000' };
    expect((await a.rpc('credentials.stage', { scope, value: 'restart-credential-canary' })).error.code).toBe(-32601);
    const candidateId = (await a.credential('credentials.stage', { scope, value: 'restart-credential-canary' })).result.candidateId;
    expect((await foreign.credential('credentials.discard', { scope, candidateId })).error.code).toBe(-32003);
    expect(await a.stop()).toBe(0);
    expect(await probePrivateControl({ directory, profileId: 'p', version })).toEqual({ instanceId: 'owner1', targetGeneration: false });
    const restarted = start('p'); const ri = await restarted.initialize(); expect(ri.result.instanceId).not.toBe(ai.result.instanceId);
    expect((await restarted.rpc('control.subscribe', { after: boot.cursor, events: boot.capabilities.events })).error.code).toBe(-32007);
    expect((await restarted.credential('credentials.discard', { scope, candidateId })).error.code).toBe(-32003);
    expect((await restarted.rpc('control.bootstrap', {})).result.runtime.state).toBe('ready');
    await host.close(); expect((await b.rpc('control.bootstrap', {})).result.runtime.state).toBe('stopped');
    host = await startPrivateControl({ directory, profileId: 'p', instanceId: 'owner2', version, handle });
    expect((await b.rpc('control.bootstrap', {})).result.runtime.state).toBe('ready');
    expect(await readFile(pointer, 'utf8')).toBe('{"profileId":"untouched"}'); expect(handle).not.toHaveBeenCalled();
    expect(bridges.every((bridge) => !bridge.output().includes('restart-credential-canary'))).toBe(true);
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.stop()));
    await host.close(); await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
