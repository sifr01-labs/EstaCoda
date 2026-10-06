import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { normalizeRoutingConfig } from '../../config/routing-config.js';
import { resolveProfileStateHome } from '../../config/profile-home.js';
import type { RoutingConfig } from '../../contracts/routing.js';
import type { IntentRouter } from '../intent-router.js';
import type { JevSnapshot } from './types.js';

/** Selected profile only. Re-read at each async acceptance boundary, including during a leased runtime. */
export function routingSnapshotReader(input: { homeDir?: string; profileId: string; router: IntentRouter; initial?: RoutingConfig }): () => JevSnapshot {
  const path = resolveProfileStateHome(input).configPath;
  let sawFile = false;
  return () => {
    let routing = input.initial, stamp = '';
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Invalid routing configuration');
      const bytes = Buffer.alloc(1_048_577);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count > 1_048_576) throw new Error('Routing configuration too large');
      const config = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, count)));
      routing = config.routing; stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`; sawFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Routing configuration unavailable');
      if (sawFile) routing = undefined;
    } finally { if (fd !== undefined) closeSync(fd); }
    const config = normalizeRoutingConfig(routing);
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return { config, configurationRevision: hash({ config, stamp }), catalogRevision: hash(input.router.listSkills()) };
  };
}
