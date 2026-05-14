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
  getProviderMetadata,
  isProviderMediaOnly,
  isProviderRunnable,
  type ProviderMetadata
} from "./provider-metadata.js";
import { resolveRuntimeCredential } from "./runtime-credential-resolver.js";

export type ProviderModelSelectionFlowMode =
  | "normal"
  | "setup"
  | "catalog-explore";

export type ProviderModelSelectionFlowOptions = {
  config: EstaCodaConfig;
  providerRegistry: ProviderRegistry;
  homeDir?: string;
  modelsDevOptions?: CreateModelSelectionCatalogOptions["modelsDevOptions"];
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
};

export type CredentialAction =
  | { kind: "none" }
  | { kind: "reuse"; reference: `env:${string}` }
  | { kind: "collect"; envVarName: string };

export type ProviderModelSelectionResult = {
  kind: "selected";
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiMode: ProviderApiMode;
  authMethod: ProviderAuthMethod;
  credentialAction: CredentialAction;
  profile: ModelProfile;
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
  ): ProviderModelSelectionResult | ProviderSelectionDiagnostic;
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
  await loadDotEnvSecrets({ homeDir: options.homeDir });

  const catalog = await createModelSelectionCatalog({
    config: options.config,
    providerRegistry: options.providerRegistry,
    homeDir: options.homeDir,
    modelsDevOptions: options.modelsDevOptions,
    allowNetwork: options.allowNetwork ?? false
  });

  return {
    listProviderCandidates: () => listProviderCandidatesImpl(options, catalog, mode),
    listModelCandidates: (providerId) => listModelCandidatesImpl(options, catalog, providerId, mode),
    resolveSelection: (providerId, modelId) =>
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
    includeCatalogOnly: mode === "catalog-explore"
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
  const models = await catalog.listModels({
    provider: providerId,
    includeCatalogOnly: mode === "catalog-explore",
    executableOnly: mode === "normal"
  });

  return models.map((m) => ({
    id: m.id,
    provider: m.provider,
    profile: m.profile,
    configured: m.configured,
    executable: m.executable,
    catalogOnly: m.catalogOnly,
    supportsVision: m.profile.supportsVision ?? false
  }));
}

// ── Selection resolution ─────────────────────────────────────────────────────

function resolveSelectionImpl(
  options: ProviderModelSelectionFlowOptions,
  _catalog: ModelSelectionCatalog,
  mode: ProviderModelSelectionFlowMode,
  providerId: ProviderId,
  modelId: string
): ProviderModelSelectionResult | ProviderSelectionDiagnostic {
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

  // Build profile (minimal; callers may enrich from catalog)
  const profile: ModelProfile = {
    id: modelId,
    provider: providerId,
    contextWindowTokens: config.model?.contextWindowTokens ?? 128_000,
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: false
  };

  const apiKeyEnv = config.providers?.[providerId]?.apiKeyEnv ?? meta.defaultApiKeyEnv;

  // Check credential readiness without exposing secret values
  const credentialAction = determineCredentialAction(providerId, apiKeyEnv, meta);

  return {
    kind: "selected",
    provider: providerId,
    model: modelId,
    baseUrl,
    apiMode: meta.apiMode,
    authMethod: meta.defaultAuthMethod,
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
function determineCredentialAction(
  providerId: ProviderId,
  apiKeyEnv: string | undefined,
  meta: ProviderMetadata
): CredentialAction {
  // No-auth providers never need credentials
  if (meta.authMethods.includes("none") && meta.defaultAuthMethod === "none") {
    return { kind: "none" };
  }

  const envVarName = apiKeyEnv ?? meta.defaultApiKeyEnv ?? `${providerId.toUpperCase()}_API_KEY`;

  // Check readiness via resolver, then discard the credential value
  const resolution = resolveRuntimeCredential({
    providerId,
    route: apiKeyEnv ? { apiKeyEnv } : undefined,
    providerConfig: apiKeyEnv ? { apiKeyEnv } : undefined,
    metadata: meta
  });

  // Explicitly drop the credential object so the value is not accessible
  // beyond this scope. Only the diagnostic is used.
  if (resolution.diagnostic.ok) {
    return { kind: "reuse", reference: `env:${envVarName}` };
  }

  return { kind: "collect", envVarName };
}
