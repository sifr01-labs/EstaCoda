import {mkdtemp, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {ensureProfileSkeleton} from '../cli/profile-state.js';
import {detectOnboarding} from './onboarding-detection.js';
import {expect, it, vi} from 'vitest';
import {captureModelCatalog} from './model-catalog.js';
import {CONTROL_METHODS, CONTROL_EVENTS, validateControlResponse, type MethodRequest, type ModelProjection, type ProviderProjection} from '../contracts/desktop-control/index.js';

it.each(['new', 'legacy'] as const)('opens the model catalog for a %s blank profile created by setup', async format => {
  const homeDir = await mkdtemp('/tmp/ec-created-profile-catalog-');
  const input = {homeDir, profileId: 'personal'};
  try {
    const paths = await ensureProfileSkeleton({...input, blank: true});
    expect(JSON.parse(await readFile(paths.authJsonPath, 'utf8'))).toEqual({version: 1, providers: {}});
    if (format === 'legacy') await writeFile(paths.authJsonPath, '{}\n');
    const before = await readFile(paths.authJsonPath, 'utf8');
    expect((await detectOnboarding(input)).mode).toBe('first-run');
    const catalog = await captureModelCatalog(input);
    expect(catalog.providers.find(p => p.id === 'kimi')?.metadata?.configurable).toBe(true);
    expect(catalog.models.every(m => !m.runnable)).toBe(true);
    expect(await readFile(paths.authJsonPath, 'utf8')).toBe(before);
  } finally {await rm(homeDir, {recursive: true, force: true});}
});

it('projects the offline catalog without network calls, profile writes, or usable-route claims', async () => {
  const homeDir = await mkdtemp('/tmp/ec-desktop-catalog-');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  try {
    const catalog = await captureModelCatalog({homeDir, profileId: 'catalog-test'});
    expect(catalog.providers.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
    for(const id of ['kimi','local','codex'])expect(catalog.providers.find(p=>p.id===id)?.metadata).toMatchObject({configurable:true,catalogOnly:false});
    expect(catalog.models.some(m => m.catalog?.tools)).toBe(true);
    expect(catalog.models.every(m => !m.runnable)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(homeDir)).toEqual([]);
    const context = {profileId: 'catalog-test', instanceId: 'bridge', capabilities: {methods: [...CONTROL_METHODS], events: [...CONTROL_EVENTS]}};
    for (const method of ['models.list', 'providers.list'] as const) {
      let cursor: string | null = null;
      do {
        const request: MethodRequest<typeof method> = {jsonrpc: '2.0', id: 'r', method, params: {limit: 100, ...(cursor ? {cursor} : {})}};
        const result: {items: (ModelProjection | ProviderProjection)[]; nextCursor: string | null} = method === 'models.list' ? catalog.pages.page(method, catalog.models, request.params) : catalog.pages.page(method, catalog.providers, request.params);
        expect(() => validateControlResponse({jsonrpc: '2.0', id: 'r', result}, request, context)).not.toThrow();
        cursor = result.nextCursor;
      } while (cursor);
    }
  } finally {fetch.mockRestore(); await rm(homeDir, {recursive: true, force: true});}
});
