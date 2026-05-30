import type { EstaCodaConfig, ModelAliasDefinition } from "../config/runtime-config.js";
import {
  applyRegisterProviderConfig,
  applyRegisterProviderModel,
  applySetPreferredModelRoute
} from "../config/provider-config-mutations.js";
import type { ModelsDevRegistryOptions } from "../model-catalog/models-dev-registry.js";
import type { ProviderApiMode, ProviderId, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionModelOverride } from "../contracts/session.js";
import { createModelSelectionCatalog } from "./model-selection-catalog.js";
import { normalizeModelInput } from "./model-normalization.js";
import {
  buildResolvedModelRoute,
  getProviderMetadata,
  validateResolvedRouteForModelSwitch
} from "./provider-metadata.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { createProviderModelSelectionFlow } from "./provider-model-selection-flow.js";

export type ModelSwitchRejection =
  | "unknown"
  | "ambiguous"
  | "invalid-route"
  | "missing-credentials"
  | "selection-failed";

export type ModelSwitchContext = {
  config: EstaCodaConfig;
  providerRegistry: ProviderRegistry;
  homeDir?: string;
  modelsDevOptions?: ModelsDevRegistryOptions;
};

export type ModelSwitchResolution =
  | {
      ok: true;
      route: ResolvedModelRoute;
      displayName: string;
      override: SessionModelOverride;
    }
  | {
      ok: false;
      reason: ModelSwitchRejection;
      message: string;
      guidance: string;
    };

export type EffectiveSessionModelRoute =
  | {
      ok: true;
      route: ResolvedModelRoute;
      override: SessionModelOverride;
    }
  | {
      ok: false;
      override: SessionModelOverride;
      message: string;
    };

export async function resolveModelSwitchRequest(
  input: { modelInput: string; source: SessionModelOverride["source"]; now?: () => Date },
  context: ModelSwitchContext
): Promise<ModelSwitchResolution> {
  const catalog = await createModelSelectionCatalog({
    config: context.config,
    providerRegistry: context.providerRegistry,
    homeDir: context.homeDir,
    modelsDevOptions: context.modelsDevOptions,
    allowNetwork: false
  });
  const normalized = await normalizeModelInput(input.modelInput, {
    config: context.config,
    catalog
  });

  if (normalized.kind === "unknown") {
    return reject("unknown", normalized.reason);
  }

  if (normalized.kind === "ambiguous") {
    return reject(
      "ambiguous",
      `${normalized.reason}\nCandidates:\n${normalized.candidates.map((c) => `  ${c.provider}/${c.model}`).join("\n")}`
    );
  }

  const gate = validateResolvedRouteForModelSwitch(normalized.route);
  if (!gate.ok) {
    return reject("invalid-route", gate.reason);
  }

  const selected = await resolveExecutableRoute(normalized.route, context, {
    routeMetadataIsAuthoritative: normalized.resolvedViaAlias !== undefined
  });
  if (!selected.ok) {
    return selected;
  }

  const route = selected.route;
  const override: SessionModelOverride = {
    route: {
      provider: route.provider,
      id: route.id,
      baseUrl: route.baseUrl,
      apiKeyEnv: route.apiKeyEnv,
      apiMode: route.apiMode,
      authMethod: route.authMethod,
      contextWindowTokens: route.contextWindowTokens,
      maxTokens: route.maxTokens,
      routeId: route.baseUrl === undefined ? `${route.provider}/${route.id}` : `${route.provider}/${route.id}@${route.baseUrl}`
    },
    modelProfile: route.profile,
    setAt: (input.now ?? (() => new Date()))().toISOString(),
    source: input.source
  };

  return {
    ok: true,
    route,
    displayName: `${route.provider}/${route.id}`,
    override
  };
}

export async function resolveEffectiveSessionModelOverride(
  override: SessionModelOverride | undefined,
  context: ModelSwitchContext
): Promise<EffectiveSessionModelRoute | undefined> {
  if (override === undefined) {
    return undefined;
  }

  const configuredRoute = findCurrentConfiguredOverrideRoute(override, context.config);
  if (configuredRoute === undefined) {
    return { ok: false, override, message: "Stored model override is no longer present in the active provider config." };
  }

  const gate = validateResolvedRouteForModelSwitch(configuredRoute);
  if (!gate.ok) {
    return { ok: false, override, message: gate.reason };
  }

  const selected = await resolveExecutableRoute(configuredRoute, context, {
    routeMetadataIsAuthoritative: true
  });
  if (!selected.ok) {
    return { ok: false, override, message: selected.message };
  }

  return {
    ok: true,
    override,
    route: selected.route
  };
}

function findCurrentConfiguredOverrideRoute(
  override: SessionModelOverride,
  config: EstaCodaConfig
): ResolvedModelRoute | undefined {
  const stored = override.route;
  const alias = findMatchingAliasRoute(override, config);
  if (alias !== undefined) {
    return alias;
  }

  const providerConfig = config.providers?.[stored.provider];
  if (providerConfig === undefined) {
    return undefined;
  }

  const primaryMatches = config.model?.provider === stored.provider && config.model?.id === stored.id;
  const fallback = (config.model?.fallbacks ?? []).find((route) =>
    route.provider === stored.provider &&
    route.id === stored.id &&
    (route.baseUrl === undefined || route.baseUrl === stored.baseUrl)
  );
  const providerModelMatches = providerConfig.models?.includes(stored.id) ?? false;
  if (!primaryMatches && fallback === undefined && !providerModelMatches) {
    return undefined;
  }

  return buildResolvedModelRoute({
    provider: stored.provider,
    model: stored.id,
    profile: override.modelProfile,
    baseUrl: fallback?.baseUrl ?? providerConfig.baseUrl,
    apiKeyEnv: fallback?.apiKeyEnv ?? providerConfig.apiKeyEnv,
    contextWindowTokens: fallback?.contextWindowTokens ?? stored.contextWindowTokens ?? override.modelProfile.contextWindowTokens,
    maxTokens: fallback?.maxTokens ?? (primaryMatches ? config.model?.maxTokens : undefined) ?? stored.maxTokens,
    apiMode: providerConfig.apiMode,
    authMethod: providerConfig.authMethod
  });
}

function findMatchingAliasRoute(
  override: SessionModelOverride,
  config: EstaCodaConfig
): ResolvedModelRoute | undefined {
  const aliases = {
    ...(config.model_aliases ?? {}),
    ...(config.modelAliases ?? {})
  };
  for (const alias of Object.values(aliases)) {
    if (!aliasMatchesOverride(alias, override)) {
      continue;
    }
    const providerConfig = config.providers?.[alias.provider];
    const meta = getProviderMetadata(alias.provider);
    return buildResolvedModelRoute({
      provider: alias.provider,
      model: alias.model,
      profile: override.modelProfile,
      baseUrl: alias.baseUrl ?? providerConfig?.baseUrl ?? meta.defaultBaseUrl,
      apiKeyEnv: alias.apiKeyEnv ?? providerConfig?.apiKeyEnv ?? meta.defaultApiKeyEnv,
      contextWindowTokens: override.route.contextWindowTokens ?? override.modelProfile.contextWindowTokens,
      maxTokens: alias.maxTokens ?? override.route.maxTokens,
      apiMode: (alias.apiMode as ProviderApiMode | undefined) ?? providerConfig?.apiMode ?? meta.apiMode,
      authMethod: providerConfig?.authMethod ?? meta.defaultAuthMethod
    });
  }
  return undefined;
}

function aliasMatchesOverride(alias: ModelAliasDefinition, override: SessionModelOverride): alias is ModelAliasDefinition & {
  provider: ProviderId;
  model: string;
} {
  return alias.provider === override.route.provider &&
    alias.model === override.route.id &&
    (alias.baseUrl === undefined || alias.baseUrl === override.route.baseUrl) &&
    (alias.apiKeyEnv === undefined || alias.apiKeyEnv === override.route.apiKeyEnv) &&
    (alias.apiMode === undefined || alias.apiMode === override.route.apiMode);
}

export function sessionOverrideToResolvedRoute(override: SessionModelOverride): ResolvedModelRoute {
  return buildResolvedModelRoute({
    provider: override.route.provider,
    model: override.route.id,
    profile: override.modelProfile,
    baseUrl: override.route.baseUrl,
    apiKeyEnv: override.route.apiKeyEnv,
    contextWindowTokens: override.route.contextWindowTokens ?? override.modelProfile.contextWindowTokens,
    maxTokens: override.route.maxTokens,
    apiMode: override.route.apiMode,
    authMethod: override.route.authMethod
  });
}

export function applyModelSwitchPrimaryRoute(
  config: EstaCodaConfig,
  route: ResolvedModelRoute
): EstaCodaConfig {
  let mutated = applyRegisterProviderConfig(config, {
    provider: route.provider,
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    apiMode: route.apiMode,
    authMethod: route.authMethod
  });

  mutated = applyRegisterProviderModel(mutated, {
    provider: route.provider,
    models: [route.id]
  });

  return applySetPreferredModelRoute(mutated, {
    provider: route.provider,
    model: route.id,
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    contextWindowTokens: route.contextWindowTokens ?? route.profile.contextWindowTokens,
    maxTokens: route.maxTokens
  });
}

async function resolveExecutableRoute(
  route: ResolvedModelRoute,
  context: ModelSwitchContext,
  options: { routeMetadataIsAuthoritative?: boolean } = {}
): Promise<{ ok: true; route: ResolvedModelRoute } | Extract<ModelSwitchResolution, { ok: false }>> {
  const providerConfig = context.config.providers?.[route.provider];
  const canonicalRoute = options.routeMetadataIsAuthoritative === true
    ? route
    : buildResolvedModelRoute({
      provider: route.provider,
      model: route.id,
      profile: route.profile,
      baseUrl: route.baseUrl ?? providerConfig?.baseUrl,
      apiKeyEnv: providerConfig?.apiKeyEnv ?? route.apiKeyEnv,
      contextWindowTokens: route.contextWindowTokens,
      maxTokens: route.maxTokens,
      apiMode: route.apiMode ?? providerConfig?.apiMode,
      authMethod: route.authMethod ?? providerConfig?.authMethod
    });
  let seededConfig = context.config;
  seededConfig = applyRegisterProviderConfig(seededConfig, {
    provider: canonicalRoute.provider,
    baseUrl: canonicalRoute.baseUrl,
    apiKeyEnv: canonicalRoute.apiKeyEnv,
    apiMode: canonicalRoute.apiMode,
    authMethod: canonicalRoute.authMethod
  });
  seededConfig = applyRegisterProviderModel(seededConfig, {
    provider: canonicalRoute.provider,
    models: [canonicalRoute.id]
  });

  const flow = await createProviderModelSelectionFlow({
    config: seededConfig,
    providerRegistry: context.providerRegistry,
    homeDir: context.homeDir,
    modelsDevOptions: context.modelsDevOptions,
    allowNetwork: false,
    mode: "normal"
  });

  const resolution = await flow.resolveSelection(canonicalRoute.provider, canonicalRoute.id);
  if (resolution.kind === "diagnostic") {
    return reject("selection-failed", resolution.reason);
  }
  if (resolution.credentialAction.kind === "collect") {
    return reject(
      "missing-credentials",
      `Credentials are not configured for ${resolution.provider}/${resolution.model}.`,
      `Run estacoda model setup ${resolution.provider} from a terminal to configure credentials.`
    );
  }

  const resolvedRoute = buildResolvedModelRoute({
    provider: resolution.provider,
    model: resolution.model,
    profile: resolution.profile,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: canonicalRoute.apiKeyEnv,
    contextWindowTokens: resolution.profile.contextWindowTokens,
    maxTokens: canonicalRoute.maxTokens,
    apiMode: resolution.apiMode,
    authMethod: resolution.authMethod
  });
  const gate = validateResolvedRouteForModelSwitch(resolvedRoute);
  if (!gate.ok) {
    return reject("invalid-route", gate.reason);
  }

  return { ok: true, route: resolvedRoute };
}

function reject(
  reason: ModelSwitchRejection,
  message: string,
  guidance = "Use /model to choose an already configured runnable model, or run estacoda model setup from a terminal."
): Extract<ModelSwitchResolution, { ok: false }> {
  return {
    ok: false,
    reason,
    message,
    guidance
  };
}
