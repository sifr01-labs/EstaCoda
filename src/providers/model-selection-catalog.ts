import type {
  ModelProfile,
  ProviderId,
  ProviderSetupMode,
  ProviderUxKind,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";
import { ProviderRegistry } from "./provider-registry.js";
import {
  fallbackKnownModelProfiles,
  buildProfileResolutionContext,
  resolveModelProfile,
  type ProfileResolutionContext
} from "./model-catalog.js";
import {
  getProviderMetadata,
  isProviderRunnable as metadataIsProviderRunnable
} from "./provider-metadata.js";
import { readCodexOAuthStatus } from "./oauth/codex-setup.js";
import { isOAuthAuthMethod } from "./oauth/oauth-types.js";
import type {
  ModelInfo,
  ModelsDevRegistryOptions,
  ModelsDevSnapshot,
  ProviderInfo
} from "../model-catalog/models-dev-registry.js";
import {
  modelsDevSnapshotToProfiles,
  refreshModelsDevSnapshot,
  resolveModelsDevSnapshot,
  resetModelsDevRegistryForTest
} from "../model-catalog/models-dev-registry.js";
import type {
  ModelCatalogEntryReport,
  ModelRefreshReport
} from "../reports/model-reports.js";
import {
  buildModelLifecycleWarnings,
  classifyModelForCatalog,
  loadBundledModelCatalogOverrides,
  type ModelCatalogOverrideRegistry
} from "../model-catalog/model-catalog-policy.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Opaque route identity string. Never parse by splitting on punctuation. */
export function routeKey(provider: ProviderId, id: string, baseUrl?: string): string {
  return JSON.stringify([provider, id, baseUrl ?? ""]);
}

export type SelectableModel = ModelCatalogEntryReport;

type SelectableModelDraft =
  Omit<SelectableModel, "lifecycle" | "usageClass" | "lifecycleNote"> &
  Partial<Pick<SelectableModel, "lifecycle" | "usageClass" | "lifecycleNote">>;

type SelectableModelSource = SelectableModel["source"] | "current";

export type CatalogProvider = {
  id: ProviderId;
  name: string;
  uxKind: ProviderUxKind;
  setupMode: ProviderSetupMode;
  configured: boolean;
  executable: boolean;
  catalogOnly: boolean;
  modelsCount: number;
  credentialReady: boolean;
  endpointReady: boolean;
};

export type CatalogListOptions = {
  includeCatalogOnly?: boolean;
  includeDeprecated?: boolean;
  includeAlpha?: boolean;
  includeBeta?: boolean;
  includeRetired?: boolean;
  provider?: ProviderId;
  requireTools?: boolean;
  requireVision?: boolean;
  requireStructuredOutput?: boolean;
  requireReasoning?: boolean;
  configuredOnly?: boolean;
  executableOnly?: boolean;
  includeNonChat?: boolean;
};

export type CreateModelSelectionCatalogOptions = {
  config: EstaCodaConfig;
  providerRegistry: ProviderRegistry;
  homeDir?: string;
  profileId?: string;
  modelsDevOptions?: ModelsDevRegistryOptions;
  modelCatalogOverrides?: ModelCatalogOverrideRegistry;
  allowNetwork?: boolean;
};

export type ModelSelectionCatalog = {
  listProviders(options?: { includeCatalogOnly?: boolean }): Promise<CatalogProvider[]>;
  listModels(options?: CatalogListOptions): Promise<SelectableModel[]>;
  searchModels(query: string, options?: CatalogListOptions): Promise<SelectableModel[]>;
  resolveModel(provider: ProviderId, id: string, baseUrl?: string): Promise<SelectableModel | undefined>;
  refresh(): Promise<ModelRefreshReport>;
};

export async function createModelSelectionCatalog(
  options: CreateModelSelectionCatalogOptions
): Promise<ModelSelectionCatalog> {
  const snapshot = await resolveModelsDevSnapshot({
    homeDir: options.homeDir,
    ...options.modelsDevOptions,
    allowNetwork: options.allowNetwork ?? options.modelsDevOptions?.allowNetwork ?? false,
  });

  const snapshotProfiles = modelsDevSnapshotToProfiles(snapshot, {
    includeAlpha: true,
    includeBeta: true,
    includeDeprecated: true
  });

  const snapshotModelMap = new Map<string, ModelProfile>();
  for (const profile of snapshotProfiles) {
    snapshotModelMap.set(routeKey(profile.provider, profile.id), profile);
  }

  const snapshotInfoMap = new Map<string, ModelInfo>();
  for (const model of snapshot.models) {
    snapshotInfoMap.set(routeKey(model.providerId as ProviderId, model.id), model);
  }

  const snapshotProviderMap = new Map<string, ProviderInfo>();
  for (const provider of snapshot.providers) {
    snapshotProviderMap.set(provider.id, provider);
  }

  const profileContext = buildProfileResolutionContext(snapshot);
  const modelCatalogOverrides = options.modelCatalogOverrides ?? await loadBundledModelCatalogOverrides();

  return {
    listProviders: async (listOpts) => listProvidersImpl(options, snapshot, listOpts),
    listModels: async (listOpts) => listModelsImpl(options, snapshot, snapshotModelMap, snapshotInfoMap, snapshotProviderMap, profileContext, modelCatalogOverrides, listOpts),
    searchModels: async (query, listOpts) => {
      const all = await listModelsImpl(options, snapshot, snapshotModelMap, snapshotInfoMap, snapshotProviderMap, profileContext, modelCatalogOverrides, listOpts);
      const normalized = normalizeLookupKey(query);
      return all.filter((model) =>
        normalizeLookupKey(model.id).includes(normalized) ||
        normalizeLookupKey(model.provider).includes(normalized) ||
        (model.profile.status !== undefined && normalizeLookupKey(model.profile.status).includes(normalized))
      );
    },
    resolveModel: async (provider, id, baseUrl) => {
      const all = await listModelsImpl(options, snapshot, snapshotModelMap, snapshotInfoMap, snapshotProviderMap, profileContext, modelCatalogOverrides);
      const key = routeKey(provider, id, baseUrl);
      return all.find((model) => model.routeKey === key);
    },
    refresh: async () => refreshImpl(options)
  };
}

async function listProvidersImpl(
  options: CreateModelSelectionCatalogOptions,
  snapshot: ModelsDevSnapshot,
  listOpts?: { includeCatalogOnly?: boolean }
): Promise<CatalogProvider[]> {
  const config = options.config;
  const registry = options.providerRegistry;
  const seen = new Map<ProviderId, CatalogProvider>();
  const modelCounts = buildProviderModelCounts(config, snapshot);
  const credentialReady = createCredentialReadyResolver(options);

  // Configured providers always appear
  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    const id = providerId as ProviderId;
    const baseUrl = providerConfig.baseUrl;
    const apiKeyEnv = providerConfig.apiKeyEnv;
    const executable = isExecutable(id, registry);
    const catalogOnly = !executable;

    if (catalogOnly && listOpts?.includeCatalogOnly === false) {
      continue;
    }

    const modelsCount = modelCounts.get(id) ?? 0;

    seen.set(id, {
      id,
      name: providerDisplayName(id, snapshot),
      uxKind: inferProviderUxKind(id, baseUrl),
      setupMode: inferProviderSetupMode(id, baseUrl, apiKeyEnv),
      configured: true,
      executable,
      catalogOnly,
      modelsCount,
      credentialReady: await credentialReady(id, apiKeyEnv),
      endpointReady: isEndpointReady(baseUrl)
    });
  }

  // Snapshot providers (not already configured)
  for (const provider of snapshot.providers) {
    const id = provider.id as ProviderId;
    if (seen.has(id)) continue;

    const executable = isExecutable(id, registry);
    const catalogOnly = !executable;
    if (catalogOnly && listOpts?.includeCatalogOnly === false) {
      continue;
    }

    const modelsCount = modelCounts.get(id) ?? 0;

    seen.set(id, {
      id,
      name: provider.name || id,
      uxKind: inferProviderUxKind(id),
      setupMode: inferProviderSetupMode(id),
      configured: false,
      executable,
      catalogOnly,
      modelsCount,
      credentialReady: await credentialReady(id),
      endpointReady: false
    });
  }

  // Fallback-known providers (not already seen)
  for (const profile of fallbackKnownModelProfiles) {
    const id = profile.provider;
    if (seen.has(id)) continue;

    const executable = isExecutable(id, registry);
    const catalogOnly = !executable;
    if (catalogOnly && listOpts?.includeCatalogOnly === false) {
      continue;
    }

    seen.set(id, {
      id,
      name: providerDisplayName(id, snapshot),
      uxKind: inferProviderUxKind(id),
      setupMode: inferProviderSetupMode(id),
      configured: false,
      executable,
      catalogOnly,
      modelsCount: modelCounts.get(id) ?? 0,
      credentialReady: await credentialReady(id),
      endpointReady: false
    });
  }

  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildProviderModelCounts(
  config: EstaCodaConfig,
  snapshot: ModelsDevSnapshot
): Map<ProviderId, number> {
  const modelIdsByProvider = new Map<ProviderId, Set<string>>();
  const add = (provider: ProviderId | undefined, modelId: string | undefined) => {
    if (provider === undefined || modelId === undefined || modelId.length === 0) {
      return;
    }
    let modelIds = modelIdsByProvider.get(provider);
    if (modelIds === undefined) {
      modelIds = new Set<string>();
      modelIdsByProvider.set(provider, modelIds);
    }
    modelIds.add(modelId);
  };

  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    for (const modelId of providerConfig.models ?? []) {
      add(providerId as ProviderId, modelId);
    }
  }

  for (const model of snapshot.models) {
    add(model.providerId as ProviderId, model.id);
  }

  for (const profile of fallbackKnownModelProfiles) {
    add(profile.provider, profile.id);
  }

  add(config.model?.provider, config.model?.id);
  for (const fallback of config.model?.fallbacks ?? []) {
    add(fallback.provider, fallback.id);
  }

  return new Map([...modelIdsByProvider].map(([provider, modelIds]) => [provider, modelIds.size]));
}

async function listModelsImpl(
  options: CreateModelSelectionCatalogOptions,
  snapshot: ModelsDevSnapshot,
  snapshotModelMap: Map<string, ModelProfile>,
  snapshotInfoMap: Map<string, ModelInfo>,
  snapshotProviderMap: Map<string, ProviderInfo>,
  profileContext: ProfileResolutionContext,
  modelCatalogOverrides: ModelCatalogOverrideRegistry,
  listOpts?: CatalogListOptions
): Promise<SelectableModel[]> {
  const config = options.config;
  const registry = options.providerRegistry;
  const includeCatalogOnly = listOpts?.includeCatalogOnly ?? true;
  const includeDeprecated = listOpts?.includeDeprecated ?? false;
  const includeAlpha = listOpts?.includeAlpha ?? false;
  const includeBeta = listOpts?.includeBeta ?? false;
  const includeRetired = listOpts?.includeRetired ?? false;
  const includeNonChat = listOpts?.includeNonChat ?? false;

  const entries = new Map<string, SelectableModelDraft>();
  const sourceKinds = new Map<string, Set<SelectableModelSource>>();
  const credentialReady = createCredentialReadyResolver(options);

  // 1. Snapshot models
  for (const model of snapshot.models) {
    const provider = model.providerId as ProviderId;
    const id = model.id;
    const baseUrl = config.providers?.[provider]?.baseUrl;
    const key = routeKey(provider, id, baseUrl);

    if (!shouldIncludeStatus(model.status, { includeAlpha, includeBeta })) {
      continue;
    }

    const { profile } = resolveModelProfile(provider, id, profileContext);
    const apiKeyEnv = config.providers?.[provider]?.apiKeyEnv;
    const executable = isExecutable(provider, registry);

    if (!executable && !includeCatalogOnly) {
      continue;
    }

    entries.set(key, await buildSelectableModel({
      key,
      provider,
      id,
      baseUrl,
      profile,
      source: "models-dev",
      configured: config.providers?.[provider]?.models?.includes(id) ?? false,
      executable,
      apiKeyEnv,
      providerInfo: snapshotProviderMap.get(provider),
      credentialReady
    }));
    addSourceKind(sourceKinds, key, "models-dev");
  }

  // 2. Fallback-known models not in snapshot
  for (const profile of fallbackKnownModelProfiles) {
    const provider = profile.provider;
    const id = profile.id;
    const baseUrl = config.providers?.[provider]?.baseUrl;
    const key = routeKey(provider, id, baseUrl);

    if (entries.has(key)) continue;

    if (!shouldIncludeStatus(profile.status ?? "", { includeAlpha, includeBeta })) {
      continue;
    }

    const apiKeyEnv = config.providers?.[provider]?.apiKeyEnv;
    const executable = isExecutable(provider, registry);

    if (!executable && !includeCatalogOnly) {
      continue;
    }

    entries.set(key, await buildSelectableModel({
      key,
      provider,
      id,
      baseUrl,
      profile,
      source: "fallback-known",
      configured: config.providers?.[provider]?.models?.includes(id) ?? false,
      executable,
      apiKeyEnv,
      providerInfo: snapshotProviderMap.get(provider),
      credentialReady
    }));
    addSourceKind(sourceKinds, key, "fallback-known");
  }

  // 3. Configured models (explicit in config.providers[*].models)
  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    const provider = providerId as ProviderId;
    const baseUrl = providerConfig.baseUrl;
    const apiKeyEnv = providerConfig.apiKeyEnv;
    const executable = isExecutable(provider, registry);

    for (const modelId of providerConfig.models ?? []) {
      const key = routeKey(provider, modelId, baseUrl);

      if (entries.has(key)) {
        // Upgrade existing entry to configured
        const existing = entries.get(key)!;
        existing.configured = true;
        existing.source = "configured";
        addSourceKind(sourceKinds, key, "configured");
        continue;
      }

      const { profile } = resolveModelProfile(provider, modelId, profileContext);

      if (!shouldIncludeStatus(profile.status ?? "", { includeAlpha, includeBeta })) {
        continue;
      }

      if (!executable && !includeCatalogOnly) {
        continue;
      }

      entries.set(key, await buildSelectableModel({
        key,
        provider,
        id: modelId,
        baseUrl,
        profile,
        source: "configured",
        configured: true,
        executable,
        apiKeyEnv,
        providerInfo: snapshotProviderMap.get(provider),
        credentialReady
      }));
      addSourceKind(sourceKinds, key, "configured");
    }
  }

  // 4. Manual models: primary model and fallbacks
  const manualRoutes: Array<{ provider: ProviderId; id: string; baseUrl?: string; apiKeyEnv?: string; current?: boolean }> = [];
  if (config.model?.provider && config.model?.id) {
    manualRoutes.push({
      provider: config.model.provider,
      id: config.model.id,
      baseUrl: config.providers?.[config.model.provider]?.baseUrl,
      apiKeyEnv: config.providers?.[config.model.provider]?.apiKeyEnv,
      current: true
    });
  }
  for (const fallback of config.model?.fallbacks ?? []) {
    manualRoutes.push({
      provider: fallback.provider,
      id: fallback.id,
      baseUrl: fallback.baseUrl ?? config.providers?.[fallback.provider]?.baseUrl,
      apiKeyEnv: fallback.apiKeyEnv ?? config.providers?.[fallback.provider]?.apiKeyEnv
    });
  }

  for (const route of manualRoutes) {
    const key = routeKey(route.provider, route.id, route.baseUrl);

    if (entries.has(key)) {
      const existing = entries.get(key)!;
      if (!existing.configured) {
        existing.source = "manual";
      }
      addSourceKind(sourceKinds, key, "manual");
      if (route.current) {
        addSourceKind(sourceKinds, key, "current");
      }
      continue;
    }

    const { profile } = resolveModelProfile(route.provider, route.id, profileContext);
    const executable = isExecutable(route.provider, registry);

    if (!shouldIncludeStatus(profile.status ?? "", { includeAlpha, includeBeta })) {
      continue;
    }

    if (!executable && !includeCatalogOnly) {
      continue;
    }

    entries.set(key, await buildSelectableModel({
      key,
      provider: route.provider,
      id: route.id,
      baseUrl: route.baseUrl,
      profile,
      source: "manual",
      configured: false,
      executable,
      apiKeyEnv: route.apiKeyEnv,
      providerInfo: snapshotProviderMap.get(route.provider),
      credentialReady
    }));
    addSourceKind(sourceKinds, key, "manual");
    if (route.current) {
      addSourceKind(sourceKinds, key, "current");
    }
  }

  let result = applyLifecyclePolicy({
    entries: [...entries.values()],
    sourceKinds,
    snapshotInfoMap,
    overrides: modelCatalogOverrides,
    includeDeprecated,
    includeRetired,
    includeNonChat
  });

  if (listOpts?.provider) {
    result = result.filter((m) => m.provider === listOpts.provider);
  }
  if (listOpts?.requireTools) {
    result = result.filter((m) => m.profile.supportsTools);
  }
  if (listOpts?.requireVision) {
    result = result.filter((m) => m.executable && m.profile.supportsVision);
  }
  if (listOpts?.requireStructuredOutput) {
    result = result.filter((m) => m.profile.supportsStructuredOutput);
  }
  if (listOpts?.requireReasoning) {
    result = result.filter((m) => m.profile.supportsReasoning === true);
  }
  if (listOpts?.configuredOnly) {
    result = result.filter((m) => m.configured);
  }
  if (listOpts?.executableOnly) {
    result = result.filter((m) => m.executable);
  }

  return result.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
  );
}

async function refreshImpl(
  options: CreateModelSelectionCatalogOptions
): Promise<ModelRefreshReport> {
  const cachePath = options.modelsDevOptions?.cachePath
    ?? join(resolveHomeDir(options.homeDir), ".estacoda", "models_dev_cache.json");

  let previousRaw: string | undefined;
  try {
    previousRaw = await readFile(cachePath, "utf8");
  } catch {
    previousRaw = undefined;
  }

  const snapshot = await refreshModelsDevSnapshot({
    homeDir: options.homeDir,
    allowNetwork: true,
    ...options.modelsDevOptions
  });

  const empty: ModelsDevSnapshot = {
    providers: [],
    models: [],
    fetchedAt: new Date().toISOString(),
    source: "empty"
  };

  const resolved = snapshot ?? empty;
  const currentRaw = JSON.stringify(resolved);
  const cacheChanged = previousRaw === undefined || previousRaw.trim() !== currentRaw.trim();

  return {
    sourceDomain: "models.dev",
    cachePath,
    snapshotTimestamp: resolved.fetchedAt,
    cacheChanged,
    modelsCount: resolved.models.length,
    providersCount: resolved.providers.length,
    warnings: []
  };
}

type CredentialReadyResolver = (providerId: ProviderId, apiKeyEnv?: string) => Promise<boolean>;

async function buildSelectableModel(params: {
  key: string;
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  profile: ModelProfile;
  source: "models-dev" | "configured" | "manual" | "fallback-known";
  configured: boolean;
  executable: boolean;
  apiKeyEnv?: string;
  providerInfo?: ProviderInfo;
  credentialReady: CredentialReadyResolver;
}): Promise<SelectableModelDraft> {
  const credentialReady = await params.credentialReady(params.provider, params.apiKeyEnv);
  const endpointReady = isEndpointReady(params.baseUrl);
  return {
    routeKey: params.key,
    provider: params.provider,
    id: params.id,
    baseUrl: params.baseUrl,
    profile: params.profile,
    configured: params.configured,
    executable: params.executable,
    catalogOnly: !params.executable,
    source: params.source,
    credentialReady,
    endpointReady,
    warnings: [],
    live: params.executable && credentialReady && endpointReady,
    endpointType: inferEndpointType(params.provider, params.baseUrl),
    cost: params.profile.cost?.inputPerMillionTokens !== undefined || params.profile.cost?.outputPerMillionTokens !== undefined
      ? {
          inputPer1k: params.profile.cost?.inputPerMillionTokens !== undefined ? params.profile.cost.inputPerMillionTokens / 1000 : undefined,
          outputPer1k: params.profile.cost?.outputPerMillionTokens !== undefined ? params.profile.cost.outputPerMillionTokens / 1000 : undefined
        }
      : undefined,
    documentationUrl: params.providerInfo?.documentationUrl,
    logoUrl: params.providerInfo?.logoUrl,
    diagnosticFields: {
      baseUrl: params.baseUrl,
      apiKeyEnv: params.apiKeyEnv
    }
  };
}

function addSourceKind(
  sourceKinds: Map<string, Set<SelectableModelSource>>,
  key: string,
  source: SelectableModelSource
): void {
  const existing = sourceKinds.get(key);
  if (existing !== undefined) {
    existing.add(source);
    return;
  }
  sourceKinds.set(key, new Set([source]));
}

function applyLifecyclePolicy(params: {
  entries: SelectableModelDraft[];
  sourceKinds: Map<string, Set<SelectableModelSource>>;
  snapshotInfoMap: Map<string, ModelInfo>;
  overrides: ModelCatalogOverrideRegistry;
  includeDeprecated: boolean;
  includeRetired: boolean;
  includeNonChat: boolean;
}): SelectableModel[] {
  return params.entries
    .map((entry) => annotateLifecyclePolicy(entry, params.snapshotInfoMap, params.overrides))
    .filter((entry) => shouldIncludeLifecyclePolicyEntry(entry, params.sourceKinds.get(entry.routeKey), params));
}

function annotateLifecyclePolicy(
  entry: SelectableModelDraft,
  snapshotInfoMap: Map<string, ModelInfo>,
  overrides: ModelCatalogOverrideRegistry
): SelectableModel {
  const policy = classifyModelForCatalog({
    provider: entry.provider,
    model: entry.id,
    profile: entry.profile,
    modelInfo: snapshotInfoMap.get(routeKey(entry.provider, entry.id)),
    overrides
  });
  const lifecycleWarnings = buildModelLifecycleWarnings({
    policy,
    context: "primary-selection"
  });

  return {
    ...entry,
    lifecycle: policy.lifecycle,
    usageClass: policy.usageClass,
    ...(policy.note === undefined ? {} : { lifecycleNote: policy.note }),
    warnings: [...entry.warnings, ...lifecycleWarnings]
  };
}

function shouldIncludeLifecyclePolicyEntry(
  entry: SelectableModel,
  sources: ReadonlySet<SelectableModelSource> | undefined,
  options: {
    includeDeprecated: boolean;
    includeRetired: boolean;
    includeNonChat: boolean;
  }
): boolean {
  if (sources?.has("configured") === true || sources?.has("manual") === true || sources?.has("current") === true) {
    return true;
  }

  if (entry.lifecycle === "retired" && !options.includeRetired) {
    return false;
  }

  if (entry.lifecycle === "deprecated" && !options.includeDeprecated) {
    return false;
  }

  if (entry.usageClass !== "primary-chat" && !options.includeNonChat) {
    return false;
  }

  return true;
}

function inferEndpointType(provider: ProviderId, baseUrl?: string): "openai" | "anthropic" | "custom" | undefined {
  const meta = getProviderMetadata(provider);
  if (meta.apiMode === "anthropic_messages") return "anthropic";
  if (baseUrl !== undefined) {
    // Local is always custom when a base URL is explicitly configured
    if (provider === "local") return "custom";
    if (meta.defaultBaseUrl === baseUrl) {
      return "openai";
    }
    return "custom";
  }
  return "openai";
}

function isExecutable(providerId: ProviderId, registry: ProviderRegistry): boolean {
  const meta = getProviderMetadata(providerId);
  // Metadata runnable is the primary gate. A provider marked non-runnable
  // must never be treated as executable, regardless of registry state.
  if (!meta.runnable) return false;

  const adapter = registry.get(providerId);
  return adapter !== undefined && adapter.executable !== false;
}

function isEndpointReady(baseUrl?: string): boolean {
  if (baseUrl === undefined) return false;
  try {
    new URL(baseUrl);
    return true;
  } catch {
    return false;
  }
}

function inferProviderUxKind(providerId: ProviderId, baseUrl?: string): ProviderUxKind {
  const meta = getProviderMetadata(providerId);
  if (meta.id === "local") return "local";
  if (meta.id === "openrouter") return "aggregator";
  if (baseUrl !== undefined && meta.allowsCustomBaseUrl) return "custom-openai-compatible";
  return "hosted";
}

function inferProviderSetupMode(
  providerId: ProviderId,
  baseUrl?: string,
  apiKeyEnv?: string
): ProviderSetupMode {
  const hasBaseUrl = baseUrl !== undefined;
  const hasApiKey = apiKeyEnv !== undefined;
  const meta = getProviderMetadata(providerId);
  const supportsNone = meta.authMethods.includes("none");

  if (hasBaseUrl && hasApiKey) return "api-key-and-base-url";
  if (hasBaseUrl) return "base-url";
  if (hasApiKey) return "api-key";
  if (supportsNone) return "none";
  return "api-key";
}

function providerDisplayName(providerId: ProviderId, snapshot: ModelsDevSnapshot): string {
  const meta = getProviderMetadata(providerId);
  if (meta.catalogKnown) {
    return meta.displayName;
  }
  const info = snapshot.providers.find((p) => p.id === providerId);
  return info?.name || meta.displayName;
}

function createCredentialReadyResolver(
  options: Pick<CreateModelSelectionCatalogOptions, "homeDir" | "profileId">
): CredentialReadyResolver {
  const cache = new Map<string, Promise<boolean>>();
  return (providerId, apiKeyEnv) => {
    const key = routeKey(providerId, apiKeyEnv ?? "");
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = resolveCredentialReady(providerId, apiKeyEnv, options);
    cache.set(key, resolved);
    return resolved;
  };
}

async function resolveCredentialReady(
  providerId: ProviderId,
  apiKeyEnv: string | undefined,
  options: Pick<CreateModelSelectionCatalogOptions, "homeDir" | "profileId">
): Promise<boolean> {
  const meta = getProviderMetadata(providerId);
  if (isOAuthAuthMethod(meta.defaultAuthMethod)) {
    if (providerId !== "codex") return false;
    const status = await readCodexOAuthStatus({
      homeDir: options.homeDir,
      profileId: options.profileId
    });
    return status.status === "ready";
  }
  if (meta.defaultAuthMethod === "none" && apiKeyEnv === undefined) return true;
  const envKey = apiKeyEnv ?? meta.defaultApiKeyEnv;
  if (envKey !== undefined) return process.env[envKey] !== undefined;
  return false;
}

function shouldIncludeStatus(
  status: string,
  options: { includeAlpha?: boolean; includeBeta?: boolean }
): boolean {
  if (status === "alpha" && options.includeAlpha !== true) return false;
  if (status === "beta" && options.includeBeta !== true) return false;
  return true;
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

export { resetModelsDevRegistryForTest };
