import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { PrivateControlCompatibilityError, probePrivateControl } from '../gateway/private-control.js';
import type { BootstrapResult } from '../contracts/desktop-control/index.js';
/** A client of the existing authenticated endpoint. No startup, service install or executor ownership. */
export async function supervisorReadiness(input: { homeDir: string; profileId: string; version: string; signal?: AbortSignal }): Promise<BootstrapResult['runtime']> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000);
  try {
    await probePrivateControl({ directory: resolveProfileStateHome(input).gatewayStatePath, profileId: input.profileId, version: input.version, signal });
    return { state: 'ready' };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof PrivateControlCompatibilityError) return { state: 'incompatible' };
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (error as NodeJS.ErrnoException).syscall !== 'connect') {
      try { await lstat(join(resolveProfileStateHome(input).gatewayStatePath, 'gateway.lock')); }
      catch (lockError) { if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'stopped' }; }
    }
    return { state: 'disconnected' };
  }
}
