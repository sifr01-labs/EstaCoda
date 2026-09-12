import {captureCredentialPresence} from './route-health.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {getProviderMetadata, isProviderMediaOnly} from '../providers/provider-metadata.js';
import {createModelSelectionCatalog} from '../providers/model-selection-catalog.js';
import {isControlId, type ModelProjection, type ProviderProjection} from '../contracts/desktop-control/index.js';
import {WorkSnapshot} from './work-snapshot.js';

/** Offline metadata only: catalog visibility is never proof of a usable route. */
export async function captureModelCatalog(input: {homeDir: string; profileId: string}) {
  const loaded = await loadRuntimeConfig({...input, workspaceRoot: input.homeDir, configurationInspection: true});
  const presence = await captureCredentialPresence(loaded);
  const catalog = await createModelSelectionCatalog({...input, config: loaded.config, providerRegistry: loaded.providerRegistry, allowNetwork: false, credentialReady: async (provider, apiKeyEnv) => ['present', 'not_required'].includes(presence(provider, {apiKeyEnv}))});
  const providerRows = await catalog.listProviders({includeCatalogOnly: true});
  const models: ModelProjection[] = (await catalog.listModels({includeCatalogOnly: true, includeRetired: true, includeDeprecated: true, includeAlpha: true, includeBeta: true}))
    .filter(row => isControlId(row.provider) && row.id.length > 0 && row.id.length <= 200 && row.usageClass === 'primary-chat')
    .map(row => {
      const metadata = getProviderMetadata(row.provider);
      const cost = row.profile.cost;
      const sameRoute = (route: typeof loaded.primaryModelRoute) => route.provider === row.provider && route.id === row.id && (route.baseUrl ?? metadata.defaultBaseUrl) === (row.baseUrl ?? metadata.defaultBaseUrl);
      const primary = sameRoute(loaded.primaryModelRoute);
      const fallback = loaded.modelFallbackRoutes.find(sameRoute);
      const credentialState = presence(row.provider, primary ? loaded.primaryModelRoute : fallback);
      const health: ModelProjection['health'] = row.catalogOnly ? 'catalog_only' : !metadata.runnable ? 'unsupported' :
        row.lifecycle === 'retired' ? 'model_unavailable' : !row.configured ? 'not_configured' :
        credentialState === 'missing' ? 'credential_required' : credentialState === 'expired' ? 'authorization_expired' :
        !loaded.config.providers?.[row.provider]?.enableNetwork ? 'network_disabled' : !(row.endpointReady || metadata.defaultBaseUrl) ? 'not_configured' : 'configured';
      return {id: row.id, providerId: row.provider, label: row.id, runnable: health === 'configured',
        credentialState, role: primary ? 'primary' : fallback ? 'fallback' : null, health,
        catalog: {configured: row.configured, catalogOnly: row.catalogOnly, contextTokens: row.profile.contextWindowTokens || null,
          outputTokens: row.profile.maxOutputTokens ?? null, tools: row.profile.supportsTools, vision: row.profile.supportsVision,
          lifecycle: row.lifecycle, source: row.source, price: cost ? {inputPerMillion: cost.inputPerMillionTokens ?? null, outputPerMillion: cost.outputPerMillionTokens ?? null} : null}};
    });
  const providers: ProviderProjection[] = providerRows.filter(row => isControlId(row.id) && row.id !== 'unconfigured' && !isProviderMediaOnly(row.id)).map(row => {
    const metadata = getProviderMetadata(row.id);
    return {id: row.id, label: metadata.displayName.slice(0,240), authMethods: [...new Set(metadata.authMethods.map(method => method === 'none' || method === 'api_key' ? method : 'oauth' as const))], state: !row.configured ? 'unconfigured' : models.some(model => model.providerId === row.id && ['credential_required','authorization_expired','unsupported'].includes(model.health ?? '')) ? 'repair_required' : 'unknown',
      metadata: {configurable: metadata.configurable && (metadata.catalogKnown || row.configured), runnable: metadata.runnable,
        catalogOnly: row.catalogOnly, apiMode: metadata.apiMode, defaultEndpoint: metadata.defaultBaseUrl ?? null}};
  });
  return {providers, models, pages: new WorkSnapshot({work: [], activity: {}})};
}
