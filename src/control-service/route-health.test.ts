import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {expect, it} from 'vitest';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {captureCredentialPresence} from './route-health.js';
import {captureModelCatalog} from './model-catalog.js';

it('reads profile-local key presence without importing it into the bridge environment', async () => {
  const homeDir = await mkdtemp('/tmp/ec-route-health-');
  const paths = resolveProfileStateHome({homeDir, profileId: 'one'});
  try {
    await mkdir(paths.profileRoot, {recursive: true});
    await writeFile(paths.envPath, 'EC_HEALTH_TEST_KEY="synthetic-presence-canary"\n');
    await writeFile(paths.configPath, JSON.stringify({model: {provider: 'kimi', id: 'kimi-k2', apiKeyEnv: 'EC_HEALTH_TEST_KEY'}, providers: {kimi: {apiKeyEnv: 'EC_HEALTH_TEST_KEY', baseUrl: 'https://api.moonshot.ai/v1', models: ['kimi-k2']}}}));
    const loaded = await loadRuntimeConfig({homeDir, profileId: 'one', workspaceRoot: homeDir, configurationInspection: true});
    const presence = await captureCredentialPresence(loaded);
    expect(presence('kimi')).toBe('present');
    const foreign = await loadRuntimeConfig({homeDir, profileId: 'two', workspaceRoot: homeDir, configurationInspection: true});
    expect((await captureCredentialPresence(foreign))('kimi', {apiKeyEnv: 'EC_HEALTH_TEST_KEY'})).toBe('missing');
    expect(process.env.EC_HEALTH_TEST_KEY).toBeUndefined();
    const catalog = await captureModelCatalog({homeDir, profileId: 'one'});
    expect(catalog.models.find(m => m.providerId === 'kimi' && m.role === 'primary')).toMatchObject({credentialState: 'present'});
    expect(JSON.stringify(catalog.models)).not.toContain('synthetic-presence-canary');
  } finally {await rm(homeDir, {recursive: true, force: true});}
});

it('distinguishes expired OAuth and no-auth routes and rejects linked credential files', async () => {
  const homeDir = await mkdtemp('/tmp/ec-route-health-');
  const paths = resolveProfileStateHome({homeDir, profileId: 'one'});
  try {
    await mkdir(paths.profileRoot, {recursive: true});
    await writeFile(paths.authJsonPath, JSON.stringify({version: 1, providers: {codex: {authMethod: 'oauth_device_pkce', accessToken: 'synthetic-token', expiresAt: '2020-01-01T00:00:00.000Z'}}}));
    const loaded = await loadRuntimeConfig({homeDir, profileId: 'one', workspaceRoot: homeDir, configurationInspection: true});
    const presence = await captureCredentialPresence(loaded);
    expect(presence('codex')).toBe('expired');
    expect(presence('local', {authMethod: 'none'})).toBe('not_required');
    await symlink(paths.authJsonPath, paths.envPath);
    await expect(captureCredentialPresence(loaded)).rejects.toThrow();
  } finally {await rm(homeDir, {recursive: true, force: true});}
});
