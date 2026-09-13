import {inboxActions} from './action-projections.js';
import { supervisorReadiness } from './supervisor-client.js';
import { isOAuthAuthMethod } from '../providers/oauth/oauth-types.js';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { resolveProfileStateHome } from '../config/profile-home.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { getProviderMetadata } from '../providers/provider-metadata.js';
import { validateOAuthStore } from '../providers/oauth/oauth-store.js';
import { envContentHasSecret } from '../config/env-secret-store.js';
import { isControlId, type InboxProjection } from '../contracts/desktop-control/index.js';
import { safeText, timestamp } from './work-projections.js';
import type { CronJob } from '../cron/cron-store.js';
export const PROFILE_FILE_MAX_BYTES=1_048_576;
/** Backend-selected profile files only, bounded on the same descriptor used for reading. */
export async function readProfileFile(root: string, path: string): Promise<string | undefined> {
  if (relative(root, path).startsWith('..')) throw new Error('Invalid profile path');
  try {
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid profile state');
      if (directory === root) break;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > PROFILE_FILE_MAX_BYTES) throw new Error('Profile state exceeds bound');
      const buffer = Buffer.alloc(PROFILE_FILE_MAX_BYTES+1); let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead;
      }
      if (bytesRead > PROFILE_FILE_MAX_BYTES) throw new Error('Profile state exceeds bound');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function profileAttention(input: { homeDir: string; profileId: string; version?: string }): Promise<{ inbox: InboxProjection[]; jobs: CronJob[] }> {
  const paths = resolveProfileStateHome(input), inbox: InboxProjection[] = [];
  const add = (id: string, title: string, summary: string, kind: InboxProjection['kind'] = 'setup', createdAt = 0) =>
    inbox.push({ id, profileId: input.profileId, workId: null, kind, title, summary, createdAt, approval: null });
  try {
    await readProfileFile(paths.profileRoot, paths.configPath);
    const config = await loadRuntimeConfig({ ...input, workspaceRoot: input.homeDir, configurationInspection: true });
    if (config.model.provider === 'unconfigured' || config.model.id === 'unconfigured') add('setup:model', 'Choose a model', 'Configure a model route before starting Work.');
    else {
      const metadata = getProviderMetadata(config.model.provider);
      const provider = config.config.providers?.[config.model.provider];
      const method = config.primaryModelRoute.authMethod ?? provider?.authMethod ?? metadata.defaultAuthMethod;
      if (method !== undefined && isOAuthAuthMethod(method)) {
        const raw = await readProfileFile(paths.profileRoot, paths.authJsonPath);
        const record = raw ? validateOAuthStore(JSON.parse(raw)).store.providers[config.model.provider] : undefined;
        if (!record) add('setup:credential', 'Sign in to your provider', 'The selected route requires provider authorization.');
        else if (record.expiresAt && timestamp(record.expiresAt) <= Date.now()) add('setup:authorization', 'Provider authorization expired', 'Review the provider connection before continuing.');
      } else if (method !== 'none') {
        const key = config.primaryModelRoute.apiKeyEnv ?? provider?.apiKeyEnv ?? metadata.defaultApiKeyEnv;
        const env = await readProfileFile(paths.profileRoot, paths.envPath);
        if (key && !envContentHasSecret(env ?? '', key) && !process.env[key]) add('setup:credential', 'Add a provider credential', 'The selected model route has no configured credential.');
      }
    }
  } catch { add('setup:repair', 'Review profile setup', 'Saved provider or profile state needs repair.'); }
  let jobs: CronJob[] = [];
  try {
    const raw = await readProfileFile(paths.profileRoot, join(paths.cronPath, 'jobs.json'));
    if (raw) {
      const value = JSON.parse(raw); if (!Array.isArray(value.jobs) || value.jobs.length > 1000) throw new Error('Invalid schedules');
      jobs = value.jobs.filter((job: CronJob) => isControlId(job.id) && typeof job.name === 'string' && typeof job.updatedAt === 'string');
    }
  } catch { add('setup:schedules', 'Review schedules', 'Saved schedule state needs repair.'); }
  try {
    const raw = await readProfileFile(paths.profileRoot, join(paths.skillsPath, '.evolution', 'proposed-patches.jsonl'));
    for (const line of raw?.split('\n').filter(Boolean) ?? []) {
      const proposal = JSON.parse(line);
      if (isControlId(proposal.id) && proposal.status === 'proposed') add(`evolution:${proposal.id}`, 'Review Agent Evolution proposal',
        safeText(typeof proposal.reason === 'string' ? proposal.reason : 'A proposed change is ready for review.'), 'evolution', timestamp(proposal.createdAt));
    }
  } catch { add('setup:evolution', 'Review Agent Evolution state', 'Saved proposal state needs repair.'); }
  if (input.version) {
    const runtime = await supervisorReadiness({ ...input, version: input.version });
    if (runtime.state === 'disconnected' || runtime.state === 'incompatible') add('setup:supervisor', 'Shared execution needs attention', 'Review the shared supervisor connection before continuing.');
  }
  for(const item of inbox)item.actions=inboxActions(item);
  return { inbox, jobs };
}
