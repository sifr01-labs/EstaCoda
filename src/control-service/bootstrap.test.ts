import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { profileConfiguration } from './bootstrap.js';
import { DesktopBridge, type BootstrapState } from './bridge.js';
import { CONTROL_METHODS } from '../contracts/desktop-control/index.js';
it('loads selected-profile configuration read-only and reports missing, broken and foreign symlink state', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'desktop-bootstrap-'));
  const input = { homeDir, profileId: 'p' };
  const paths = resolveProfileStateHome(input);
  vi.stubEnv('DESKTOP_INSPECTION_SECRET', undefined);
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await profileConfiguration(input)).toBe('unconfigured'); expect(await readdir(homeDir)).toEqual([]);
    await mkdir(paths.profileRoot, { recursive: true });
    await writeFile(paths.configPath, '{'); expect(await profileConfiguration(input)).toBe('repair_required');
    await writeFile(paths.configPath, JSON.stringify({ model: { provider: 'local', id: 'test' }, channels: { telegram: { busyPolicy: 'config-warning-canary' } } }));
    await writeFile(paths.envPath, 'DESKTOP_INSPECTION_SECRET=credential-canary\n');
    expect(await profileConfiguration(input)).toBe('ready');
    expect(process.env.DESKTOP_INSPECTION_SECRET).toBeUndefined(); expect(warnings).not.toHaveBeenCalled();
    expect(await readdir(join(homeDir, '.estacoda'))).toEqual(['profiles']);
    await writeFile(paths.configPath, ' '.repeat(1_048_577)); expect(await profileConfiguration(input)).toBe('repair_required');
    await writeFile(paths.configPath, '[]'); expect(await profileConfiguration(input)).toBe('repair_required');
    expect(await profileConfiguration({ ...input, profileId: 'other' })).toBe('unconfigured');
    await rm(paths.configPath); await symlink(join(homeDir, 'foreign.json'), paths.configPath);
    expect(await profileConfiguration(input)).toBe('repair_required');
  } finally { warnings.mockRestore(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); }
});
it('captures one immutable profile snapshot and invalidates overlapping bootstrap epochs', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const pending: ((value: BootstrapState) => void)[] = [];
  const bridge = new DesktopBridge({ input, output, homeDir: '/unused', profileId: 'p', version: 'test',
    readState: () => new Promise((resolve) => { pending.push(resolve); }) });
  const state: BootstrapState = { profile: { id: 'p', label: 'P', configuration: 'unconfigured' }, runtime: { state: 'stopped' } };
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'control.initialize', params: { protocolVersion: { major: 1, minor: 0 }, clientVersion: 'test', profileId: 'p', capabilities: { methods: [...CONTROL_METHODS], events: [] } } }) + '\n');
  await setImmediate();
  const first = bridge.bootstrap(new AbortController().signal); const rejection = expect(first).rejects.toThrow();
  const second = bridge.bootstrap(new AbortController().signal);
  pending[1]!(state); const snapshot = await second;
  pending[0]!(state); await rejection;
  expect(snapshot.cursor.instanceId).toBe(bridge.server.instanceId); expect(snapshot.cursor.sequence).toBe(0);
  snapshot.profile.label = 'changed'; expect(bridge.snapshot?.profile.label).toBe('P');
  expect(bridge.server.context?.capabilities.methods).not.toContain('sessions.send');
  bridge.server.close(); await bridge.server.done; expect(bridge.snapshot).toBeUndefined();
});
