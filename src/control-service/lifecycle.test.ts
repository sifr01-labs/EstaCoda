import { spawn } from 'node:child_process';
import type { Duplex, Readable, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CONTROL_EVENTS, CONTROL_METHODS } from '../contracts/desktop-control/index.js';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { probePrivateControl, startPrivateControl } from '../gateway/private-control.js';

function launch(homeDir: string, profileId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'desktop-service', '--stdio', '--profile', profileId, '--credential-fd=3'],
    { env: { ...process.env, ESTACODA_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let ordinary = '';
  child.stdout!.on('data', (chunk) => { ordinary += chunk; }); child.stderr!.on('data', (chunk) => { ordinary += chunk; });
  function channel(input: Writable, output: Readable) {
    let sequence = 0, buffer = '';
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    output.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
      }
    });
    input.on('error', () => {});
    child.once('exit', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Bridge exited')); } pending.clear(); });
    return (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = 'r' + ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Bridge reply timed out')); }, 8_000);
      pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const rpc = channel(child.stdin!, child.stdout!), pipe = child.stdio[3] as Duplex;
  return { rpc, credential: channel(pipe, pipe), output: () => ordinary,
    initialize: (selected = profileId) => rpc('control.initialize', { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: selected, capabilities: { methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS] } }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try { return await exit; } finally { clearTimeout(timer); }
    },
  };
}
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
    expect(boot.runtime.state).toBe('ready'); expect(boot.capabilities.methods).not.toContain('sessions.send');
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
