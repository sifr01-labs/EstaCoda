import {loadRuntimeConfig} from '../config/runtime-config.js';
import {getProviderMetadata, isProviderMediaOnly} from '../providers/provider-metadata.js';
import {createModelSelectionCatalog} from '../providers/model-selection-catalog.js';
import {isControlId, type ModelProjection, type ProviderProjection} from '../contracts/desktop-control/index.js';
import {WorkSnapshot} from './work-snapshot.js';

/** Offline metadata only: catalog visibility is never proof of a usable route. */
export async function captureModelCatalog(input: {homeDir: string; profileId: string}) {
  const loaded = await loadRuntimeConfig({...input, workspaceRoot: input.homeDir, configurationInspection: true});
  const catalog = await createModelSelectionCatalog({...input, config: loaded.config, providerRegistry: loaded.providerRegistry, allowNetwork: false});
  const providerRows = await catalog.listProviders({includeCatalogOnly: true});
  const models: ModelProjection[] = (await catalog.listModels({includeCatalogOnly: true, includeRetired: true, includeDeprecated: true, includeAlpha: true, includeBeta: true}))
    .filter(row => isControlId(row.provider) && row.id.length > 0 && row.id.length <= 200 && row.usageClass === 'primary-chat')
    .map(row => {
      const metadata = getProviderMetadata(row.provider);
      const cost = row.profile.cost;
      return {id: row.id, providerId: row.provider, label: row.id, runnable: false,
        credentialState: metadata.defaultAuthMethod === 'none' ? 'not_required' : 'missing', role: null,
        catalog: {configured: row.configured, catalogOnly: row.catalogOnly, contextTokens: row.profile.contextWindowTokens || null,
          outputTokens: row.profile.maxOutputTokens ?? null, tools: row.profile.supportsTools, vision: row.profile.supportsVision,
          lifecycle: row.lifecycle, source: row.source, price: cost ? {inputPerMillion: cost.inputPerMillionTokens ?? null, outputPerMillion: cost.outputPerMillionTokens ?? null} : null}};
    });
  const providers: ProviderProjection[] = providerRows.filter(row => isControlId(row.id) && row.id !== 'unconfigured' && !isProviderMediaOnly(row.id)).map(row => {
    const metadata = getProviderMetadata(row.id);
    return {id: row.id, label: metadata.displayName.slice(0,240), authMethods: [...new Set(metadata.authMethods.map(method => method === 'none' || method === 'api_key' ? method : 'oauth' as const))], state: 'unknown',
      metadata: {configurable: metadata.configurable && (metadata.catalogKnown || row.configured), runnable: metadata.runnable,
        catalogOnly: row.catalogOnly, apiMode: metadata.apiMode, defaultEndpoint: metadata.defaultBaseUrl ?? null}};
  });
  return {providers, models, pages: new WorkSnapshot({work: [], activity: {}})};
}
