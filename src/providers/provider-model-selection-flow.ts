import type {
  ProviderId,
  ProviderApiMode,
  ProviderAuthMethod,
  ModelProfile
} from "../contracts/provider.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";
import { loadDotEnvSecrets } from "../config/env-secret-store.js";
import { ProviderRegistry } from "./provider-registry.js";
import {
  createModelSelectionCatalog,
  type ModelSelectionCatalog,
  type CreateModelSelectionCatalogOptions
} from "./model-selection-catalog.js";
import {
  getDefaultApiKeyEnv,
  getProviderMetadata,
  isProviderMediaOnly,
  isProviderRunnable,
  type ProviderMetadata
} from "./provider-metadata.js";
import { inferModelProfile } from "./model-catalog.js";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";
import { readCodexOAuthStatus, type CodexOAuthStatusValue } from "./oauth/codex-setup.js";
import { isOAuthAuthMethod } from "./oauth/oauth-types.js";
import type {
  ModelLifecycle,
  ModelUsageClass
} from "../model-catalog/model-catalog-policy.js";

export type ProviderModelSelectionFlowMode =
  | "normal"
  | "setup"
  | "catalog-explore";

export type ProviderModelSelectionFlowOptions = {
  config: EstaCodaConfig;
  providerRegistry: ProviderRegistry;
  homeDir?: string;
  profileId?: string;
  modelsDevOptions?: CreateModelSelectionCatalogOptions["modelsDevOptions"];
  modelCatalogOverrides?: CreateModelSelectionCatalogOptions["modelCatalogOverrides"];
  allowNetwork?: boolean;
  mode?: ProviderModelSelectionFlowMode;
};

export type ProviderCandidate = {
  id: ProviderId;
  displayName: string;
  catalogOnly: boolean;
  configurable: boolean;
  runnable: boolean;
  modelsCount: number;
  credentialReady: boolean;
  baseUrl?: string;
};

export type ModelCandidate = {
  id: string;
  provider: ProviderId;
  profile: ModelProfile;
  configured: boolean;
  executable: boolean;
  catalogOnly: boolean;
  supportsVision: boolean;
  lifecycle: ModelLifecycle;
  usageClass: ModelUsageClass;
  lifecycleNote?: string;
  warnings?: string[];
};

export type CredentialAction =
  | { kind: "none" }
  | { kind: "reuse"; reference: `env:${string}` }
  | { kind: "collect"; envVarName: string }
  | { kind: "endpoint"; baseUrl?: string; apiKeyEnv: string }
  | {
      kind: "oauth";
      providerId: ProviderId;
      authMethod: ProviderAuthMethod;
      status: CodexOAuthStatusValue;
    };

export type ProviderModelSelectionResult = {
  kind: "selected";
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiMode: ProviderApiMode;
  authMethod: ProviderAuthMethod;
  credentialAction: CredentialAction;
  profile: ModelProfile;
  resolvedViaAlias?: string;
};

export type ProviderSelectionDiagnostic = {
  kind: "diagnostic";
  provider: ProviderId;
  model: string;
  reason: string;
};

export type FlowEngine = {
  listProviderCandidates(): Promise<ProviderCandidate[]>;
  listModelCandidates(providerId: ProviderId): Promise<ModelCandidate[]>;
  resolveSelection(
    providerId: ProviderId,
    modelId: string
  ): Promise<ProviderModelSelectionResult | ProviderSelectionDiagnostic>;
};

/**
 * Create a read-only provider/model selection decision engine.
 *
 * This engine does NOT:
 * - collect or store credentials
 * - write config
 * - render UI or prompt cards
 * - perform OAuth flows
 *
 * It returns structured decisions that callers (first-run, estacoda model,
 * /model) can consume and act upon.
 */
export async function createProviderModelSelectionFlow(
  options: ProviderModelSelectionFlowOptions
): Promise<FlowEngine> {
  const mode = options.mode ?? "normal";

  // Load the protected .env boundary so credential readiness checks
  // reflect secrets stored in ~/.estacoda/.env, not just shell env.
  await loadDotEnvSecrets({ homeDir: options.homeDir, profileId: options.profileId });

  const catalog = await createModelSelectionCatalog({
    config: options.config,
    providerRegistry: options.providerRegistry,
    homeDir: options.homeDir,
    profileId: options.profileId,
    modelsDevOptions: options.modelsDevOptions,
    modelCatalogOverrides: options.modelCatalogOverrides,
    allowNetwork: options.allowNetwork ?? false
  });

  return {
    listProviderCandidates: () => listProviderCandidatesImpl(options, catalog, mode),
    listModelCandidates: (providerId) => listModelCandidatesImpl(options, catalog, providerId, mode),
    resolveSelection: async (providerId, modelId) =>
      resolveSelectionImpl(options, catalog, mode, providerId, modelId)
  };
}

// ── Provider candidates ──────────────────────────────────────────────────────

async function listProviderCandidatesImpl(
  options: ProviderModelSelectionFlowOptions,
  catalog: ModelSelectionCatalog,
  mode: ProviderModelSelectionFlowMode
): Promise<ProviderCandidate[]> {
  const config = options.config;
  const catalogProviders = await catalog.listProviders({
    includeCatalogOnly: mode === "catalog-explore" || mode === "setup"
  });

  const candidates: ProviderCandidate[] = [];

  for (const cp of catalogProviders) {
    const meta = getProviderMetadata(cp.id);

    // Media-only providers are never LLM picker candidates
    if (isProviderMediaOnly(cp.id)) {
      continue;
    }

    // Apply visibility and capability filters per mode
    if (!passesModeFilter(meta, cp, mode)) {
      continue;
    }

    // Normal mode: only ready/usable providers
    if (mode === "normal" && !cp.credentialReady) {
      continue;
    }

    // Custom providers without required base URL are not usable
    const baseUrl = config.providers?.[cp.id]?.baseUrl ?? meta.defaultBaseUrl;
    if (!meta.catalogKnown && meta.allowsCustomBaseUrl && !baseUrl) {
      continue;
    }

    // In catalog-explore mode, non-runnable catalog-known providers are intentionally included.
    // In normal and setup modes, only runnable providers are usable.
    if (mode !== "catalog-explore" && !isProviderRunnable(cp.id, baseUrl)) {
      continue;
    }

    candidates.push({
      id: cp.id,
      displayName: meta.displayName,
      catalogOnly: cp.catalogOnly,
      configurable: meta.configurable,
      runnable: meta.runnable,
      modelsCount: cp.modelsCount,
      credentialReady: cp.credentialReady,
      baseUrl
    });
  }

  return candidates.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function passesModeFilter(
  meta: ProviderMetadata,
  cp: { catalogOnly: boolean; executable: boolean },
  mode: ProviderModelSelectionFlowMode
): boolean {
  switch (mode) {
    case "normal":
      return meta.visibility.modelPicker === true && meta.runnable === true;
    case "setup":
      return (
        meta.visibility.setup === true &&
        meta.configurable === true &&
        meta.runnable === true
      );
    case "catalog-explore":
      return meta.visibility.catalogExplore === true && meta.catalogKnown === true;
    default:
      return false;
  }
}

// ── Model candidates ─────────────────────────────────────────────────────────

async function listModelCandidatesImpl(
  options: ProviderModelSelectionFlowOptions,
  catalog: ModelSelectionCatalog,
  providerId: ProviderId,
  mode: ProviderModelSelectionFlowMode
): Promise<ModelCandidate[]> {
  const meta = getProviderMetadata(providerId);
  if (!providerSupportsModelListingInMode(meta, mode)) {
    return [];
  }

  const includeCatalogOnly = mode === "catalog-explore" || mode === "setup";
  const models = await catalog.listModels({
    provider: providerId,
    includeCatalogOnly,
    executableOnly: mode === "normal"
  });

  return models.map((m) => ({
    id: m.id,
    provider: m.provider,
    profile: m.profile,
    configured: m.configured,
    executable: m.executable,
    catalogOnly: m.catalogOnly,
    supportsVision: m.profile.supportsVision ?? false,
    lifecycle: m.lifecycle,
    usageClass: m.usageClass,
    lifecycleNote: m.lifecycleNote,
    warnings: m.warnings
  }));
}

function providerSupportsModelListingInMode(
  meta: ProviderMetadata,
  mode: ProviderModelSelectionFlowMode
): boolean {
  switch (mode) {
    case "normal":
      return meta.visibility.modelPicker === true && meta.runnable === true;
    case "setup":
      return (
        meta.visibility.setup === true &&
        meta.configurable === true &&
        meta.runnable === true
      );
    case "catalog-explore":
      return meta.visibility.catalogExplore === true && meta.catalogKnown === true;
    default:
      return false;
  }
}

// ── Selection resolution ─────────────────────────────────────────────────────

async function resolveSelectionImpl(
  options: ProviderModelSelectionFlowOptions,
  catalog: ModelSelectionCatalog,
  mode: ProviderModelSelectionFlowMode,
  providerId: ProviderId,
  modelId: string
): Promise<ProviderModelSelectionResult | ProviderSelectionDiagnostic> {
  const config = options.config;
  const meta = getProviderMetadata(providerId);

  // Non-runnable/catalog-only providers cannot be selected for execution in any mode
  if (!meta.runnable) {
    return {
      kind: "diagnostic",
      provider: providerId,
      model: modelId,
      reason: `Provider ${meta.displayName} is not runnable.`
    };
  }

  // Media-only providers are never selectable as LLM routes
  if (isProviderMediaOnly(providerId)) {
    return {
      kind: "diagnostic",
      provider: providerId,
      model: modelId,
      reason: `Provider ${providerId} is not a runnable LLM provider.`
    };
  }

  const baseUrl = config.providers?.[providerId]?.baseUrl ?? meta.defaultBaseUrl;

  // Custom providers need an explicit base URL
  if (!meta.catalogKnown && meta.allowsCustomBaseUrl && !baseUrl) {
    return {
      kind: "diagnostic",
      provider: providerId,
      model: modelId,
      reason: `Provider ${providerId} requires an explicit base URL.`
    };
  }

  // In normal mode, catalog-only/non-executable models return a diagnostic
  if (mode === "normal") {
    const models = await listModelCandidatesImpl(options, catalog, providerId, mode);
    const selected = models.find((m) => m.id === modelId);
    if (selected !== undefined && !selected.executable) {
      return {
        kind: "diagnostic",
        provider: providerId,
        model: modelId,
        reason: `Model ${modelId} on provider ${meta.displayName} is not executable.`
      };
    }
  }

  // Preserve real catalog profile when available
  const models = await listModelCandidatesImpl(options, catalog, providerId, mode);
  const selected = models.find((m) => m.id === modelId);
  const profile =
    selected?.profile ??
    inferModelProfile({
      provider: providerId,
      model: modelId,
      contextWindowTokens: config.model?.contextWindowTokens
    });

  const providerConfig = config.providers?.[providerId];
  const apiKeyEnv = providerConfig?.apiKeyEnv ?? meta.defaultApiKeyEnv;
  const apiMode = providerConfig?.apiMode ?? meta.apiMode;
  const authMethod = providerConfig?.authMethod ?? meta.defaultAuthMethod;

  // Check credential readiness without exposing secret values
  const credentialAction = await determineCredentialAction(providerId, apiKeyEnv, {
    ...meta,
    defaultAuthMethod: authMethod,
  }, options.homeDir, options.profileId);

  return {
    kind: "selected",
    provider: providerId,
    model: modelId,
    baseUrl,
    apiMode,
    authMethod,
    credentialAction,
    profile
  };
}

/**
 * Determine the credential action for a provider without ever returning
 * or exposing raw secret values.
 *
 * Calls resolveRuntimeCredential to check readiness, then immediately
 * discards any credential object so the value never escapes.
 */
async function determineCredentialAction(
  providerId: ProviderId,
  apiKeyEnv: string | undefined,
  meta: ProviderMetadata,
  homeDir?: string,
  profileId?: string
): Promise<CredentialAction> {
  if (isOAuthAuthMethod(meta.defaultAuthMethod)) {
    if (providerId === "codex") {
      const status = await readCodexOAuthStatus({ homeDir, profileId });
      return {
        kind: "oauth",
        providerId,
        authMethod: status.authMethod,
        status: status.status
      };
    }
    return {
      kind: "oauth",
      providerId,
      authMethod: meta.defaultAuthMethod,
      status: "required"
    };
  }

  if (providerId === "local") {
    return {
      kind: "endpoint",
      baseUrl: meta.defaultBaseUrl,
      apiKeyEnv: apiKeyEnv ?? getDefaultApiKeyEnv(providerId)
    };
  }

  // No-auth providers never need credentials
  if (meta.authMethods.includes("none") && meta.defaultAuthMethod === "none") {
    return { kind: "none" };
  }

  const envVarName = apiKeyEnv ?? meta.defaultApiKeyEnv ?? `${providerId.toUpperCase()}_API_KEY`;

  // Check readiness via resolver, then discard the credential value
  const resolution = await resolveRuntimeCredential({
    providerId,
    route: apiKeyEnv ? { apiKeyEnv } : undefined,
    providerConfig: apiKeyEnv ? { apiKeyEnv } : undefined,
    metadata: meta,
    homeDir,
    profileId
  });

  // Explicitly drop the credential object so the value is not accessible
  // beyond this scope. Only the diagnostic is used.
  if (resolution.diagnostic.ok) {
    return { kind: "reuse", reference: `env:${envVarName}` };
  }

  return { kind: "collect", envVarName };
}
