import type { EstaCodaConfig } from "../config/runtime-config.js";
import {
  applyRegisterProviderConfig,
  applyRegisterProviderModel
} from "../config/provider-config-mutations.js";
import type { ModelsDevRegistryOptions } from "../model-catalog/models-dev-registry.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionModelOverride } from "../contracts/session.js";
import { createModelSelectionCatalog } from "./model-selection-catalog.js";
import { normalizeModelInput } from "./model-normalization.js";
import {
  buildResolvedModelRoute,
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

  const storedRoute = sessionOverrideToResolvedRoute(override);
  const gate = validateResolvedRouteForModelSwitch(storedRoute);
  if (!gate.ok) {
    return { ok: false, override, message: gate.reason };
  }

  const selected = await resolveExecutableRoute(storedRoute, context, {
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

export function sessionOverrideToResolvedRoute(override: SessionModelOverride): ResolvedModelRoute {
  return buildResolvedModelRoute({
    provider: override.route.provider,
    model: override.route.id,
    profile: override.modelProfile,
    baseUrl: override.route.baseUrl,
    apiKeyEnv: override.route.apiKeyEnv,
    contextWindowTokens: override.route.contextWindowTokens ?? override.modelProfile.contextWindowTokens,
    apiMode: override.route.apiMode,
    authMethod: override.route.authMethod
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
