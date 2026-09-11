import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { probePrivateControl, startPrivateControl } from '../gateway/private-control.js';
import { supervisorReadiness } from './supervisor-client.js';
it.skipIf(process.platform === 'win32')('probes the bound supervisor without a Session, dispatch or ownership transfer', async () => {
  // Unix socket paths must stay below the platform bound, even in long temporary homes.
  const homeDir = await mkdtemp('/tmp/ec-probe-');
  const directory = resolveProfileStateHome({ homeDir, profileId: 'p' }).gatewayStatePath;
  const handle = vi.fn(async () => ({}));
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const host = await startPrivateControl({ directory, profileId: 'p', instanceId: 'host', version: 'test', handle });
  try {
    expect(await supervisorReadiness({ homeDir, profileId: 'p', version: 'test' })).toEqual({ state: 'ready' });
    expect(await probePrivateControl({ directory, profileId: 'p', version: 'test' })).toEqual({ instanceId: 'host', targetGeneration: false });
    expect(await supervisorReadiness({ homeDir, profileId: 'p', version: 'other' })).toEqual({ state: 'incompatible' });
    expect(await supervisorReadiness({ homeDir, profileId: 'other', version: 'test' })).toEqual({ state: 'stopped' });
    await expect(probePrivateControl({ directory, profileId: 'other', version: 'test' })).rejects.toThrow('mismatch');
    await expect(supervisorReadiness({ homeDir, profileId: 'p', version: 'test', signal: AbortSignal.abort() })).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
    await chmod(join(directory, 'control.json'), 0o644);
    expect(await supervisorReadiness({ homeDir, profileId: 'p', version: 'test' })).toEqual({ state: 'disconnected' });
    await chmod(join(directory, 'control.json'), 0o600);
  } finally { await host.close(); await rm(homeDir, { recursive: true, force: true }); }
});
it('reports a missing supervisor without creating state', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'desktop-probe-'));
  try { expect(await supervisorReadiness({ homeDir, profileId: 'p', version: 'test' })).toEqual({ state: 'stopped' }); }
  finally { await rm(homeDir, { recursive: true, force: true }); }
});
