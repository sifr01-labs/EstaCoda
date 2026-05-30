import type {
  AuxiliaryModelTask,
  ProviderId,
  ProviderApiMode,
  ProviderAuthMethod
} from "../contracts/provider.js";
import {
  normalizeAuxiliaryModels,
  normalizeModelFallbacks,
  readConfig,
  saveRuntimeConfig,
  shouldPersistProviderBaseUrl,
  type AuxiliaryModelRouteSetupInput,
  type EstaCodaConfig,
  type ModelFallbackConfig
} from "./runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "./profile-home.js";

// ── Input types ──────────────────────────────────────────────────────────────

export type RegisterProviderConfigInput = {
  provider: ProviderId;
  kind?: "openai-compatible" | "catalog";
  baseUrl?: string;
  apiKeyEnv?: string;
  apiMode?: ProviderApiMode;
  authMethod?: ProviderAuthMethod;
  enableNetwork?: boolean;
  headers?: Record<string, string>;
};

export type StoreProviderCredentialInput = {
  provider: ProviderId;
  apiKeyEnv: string;
  apiKey?: string;
};

export type RegisterProviderModelInput = {
  provider: ProviderId;
  models: string[];
};

export type SetPreferredModelRouteInput = {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
};

export type AddFallbackRouteInput = {
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
};

export type SetAuxiliaryModelRouteInput = {
  task: AuxiliaryModelTask;
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
};

// ── Pure config mutators (no I/O) ────────────────────────────────────────────

/**
 * Register or update provider base config without touching model lists,
 * preferred model, or credential pools.
 * Preserves unrelated provider fields unless explicitly changed.
 */
export function applyRegisterProviderConfig(
  existing: EstaCodaConfig,
  input: RegisterProviderConfigInput
): EstaCodaConfig {
  const providers = existing.providers;
  const existingProvider = providers !== undefined ? providers[input.provider] ?? {} : {};
  const providerConfig: Record<string, unknown> = { ...existingProvider };

  if (input.kind !== undefined) providerConfig.kind = input.kind;
  if (input.baseUrl !== undefined) {
    if (shouldPersistProviderBaseUrl(input.provider, input.baseUrl)) {
      providerConfig.baseUrl = input.baseUrl;
    } else {
      delete providerConfig.baseUrl;
    }
  }
  if (input.apiKeyEnv !== undefined) providerConfig.apiKeyEnv = input.apiKeyEnv;
  if (input.apiMode !== undefined) providerConfig.apiMode = input.apiMode;
  if (input.authMethod !== undefined) providerConfig.authMethod = input.authMethod;
  if (input.enableNetwork !== undefined) providerConfig.enableNetwork = input.enableNetwork;
  if (input.headers !== undefined) providerConfig.headers = input.headers;

  const patch: EstaCodaConfig = {
    providers: {
      [input.provider]: providerConfig as NonNullable<EstaCodaConfig["providers"]>[string]
    }
  };
  return patchConfig(existing, patch);
}

/**
 * Store a credential reference on the provider block.
 * Never stores the raw apiKey value in config.
 */
export function applyStoreProviderCredential(
  existing: EstaCodaConfig,
  input: StoreProviderCredentialInput
): EstaCodaConfig {
  const providers = existing.providers;
  const existingProvider = providers !== undefined ? providers[input.provider] ?? {} : {};
  const providerConfig = {
    ...existingProvider,
    apiKeyEnv: input.apiKeyEnv
  };

  return patchConfig(existing, {
    providers: {
      [input.provider]: providerConfig
    }
  } as EstaCodaConfig);
}

/**
 * Append model(s) to a provider's models array.
 * Does not switch the preferred model.
 * Dedupes model IDs.
 */
export function applyRegisterProviderModel(
  existing: EstaCodaConfig,
  input: RegisterProviderModelInput
): EstaCodaConfig {
  const providers = existing.providers;
  const previousModels = providers !== undefined ? providers[input.provider]?.models ?? [] : [];
  const nextModels = uniqueStrings([...previousModels, ...input.models]);
  const existingProvider = providers !== undefined ? providers[input.provider] ?? {} : {};

  return patchConfig(existing, {
    providers: {
      [input.provider]: {
        ...existingProvider,
        models: nextModels
      }
    }
  } as EstaCodaConfig);
}

/**
 * Set the preferred model route.
 * This switches the primary model.
 * Custom baseUrl overrides and apiKeyEnv are stored on the provider block so
 * that the runtime config loader can resolve a complete ResolvedModelRoute.
 */
export function applySetPreferredModelRoute(
  existing: EstaCodaConfig,
  input: SetPreferredModelRouteInput
): EstaCodaConfig {
  const providers = existing.providers;
  const existingProvider = providers !== undefined ? providers[input.provider] ?? {} : {};
  const providerPatch: Record<string, unknown> = { ...existingProvider };

  if (input.baseUrl !== undefined) {
    if (shouldPersistProviderBaseUrl(input.provider, input.baseUrl)) {
      providerPatch.baseUrl = input.baseUrl;
    } else {
      delete providerPatch.baseUrl;
    }
  }
  if (input.apiKeyEnv !== undefined) providerPatch.apiKeyEnv = input.apiKeyEnv;

  const modelPatch: Record<string, unknown> = {
    provider: input.provider,
    id: input.model
  };
  if (input.contextWindowTokens !== undefined) {
    modelPatch.contextWindowTokens = input.contextWindowTokens;
  }
  if (input.maxTokens !== undefined) {
    modelPatch.maxTokens = input.maxTokens;
  }

  const patch: EstaCodaConfig = {
    model: modelPatch as EstaCodaConfig["model"],
    providers: {
      [input.provider]: providerPatch as NonNullable<EstaCodaConfig["providers"]>[string]
    }
  };
  return patchConfig(existing, patch);
}

/**
 * Append one fallback route and normalize.
 * Preserves fallback order and dedupes against primary / duplicates.
 * Identity key is provider/id/baseUrl, so routes that differ only by
 * apiKeyEnv or contextWindowTokens on the same endpoint are deduped
 * (first one wins).
 */
export function applyAddFallbackRoute(
  existing: EstaCodaConfig,
  input: AddFallbackRouteInput
): EstaCodaConfig {
  const existingFallbacks = existing.model?.fallbacks ?? [];
  const newFallback: ModelFallbackConfig = {
    provider: input.provider,
    id: input.id,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKeyEnv !== undefined ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(input.contextWindowTokens !== undefined
      ? { contextWindowTokens: input.contextWindowTokens }
      : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {})
  };

  const merged = patchConfig(existing, {
    model: {
      fallbacks: [...existingFallbacks, newFallback]
    }
  });

  const normalized = normalizeModelFallbacks(merged);
  return {
    ...merged,
    model: {
      ...merged.model,
      fallbacks: normalized.fallbacks
    }
  };
}

/**
 * Set one auxiliary model route without touching primary or fallback routes.
 */
export function applySetAuxiliaryModelRoute(
  existing: EstaCodaConfig,
  input: SetAuxiliaryModelRouteInput
): EstaCodaConfig {
  const mergedAuxiliaryModels = {
    ...(existing.auxiliaryModels ?? {}),
    [input.task]: {
      provider: input.provider,
      id: input.id,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKeyEnv !== undefined ? { apiKeyEnv: input.apiKeyEnv } : {}),
      ...(input.contextWindowTokens !== undefined ? { contextWindowTokens: input.contextWindowTokens } : {}),
      enabled: true
    }
  };
  const normalized = normalizeAuxiliaryModels(mergedAuxiliaryModels);

  return patchConfig(existing, {
    auxiliaryModels: {
      ...(existing.auxiliaryModels ?? {}),
      [input.task]: normalized[input.task]
    }
  });
}

// ── Load/save wrappers ───────────────────────────────────────────────────────

export type MutationOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
};

async function resolveTargetPath(options: MutationOptions): Promise<string> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir })?.profileId ?? defaultProfileId();
  return resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
}

export async function registerProviderConfig(
  options: MutationOptions & { input: RegisterProviderConfigInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applyRegisterProviderConfig(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

export async function storeProviderCredential(
  options: MutationOptions & { input: StoreProviderCredentialInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applyStoreProviderCredential(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

export async function registerProviderModel(
  options: MutationOptions & { input: RegisterProviderModelInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applyRegisterProviderModel(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

export async function setPreferredModelRoute(
  options: MutationOptions & { input: SetPreferredModelRouteInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applySetPreferredModelRoute(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

export async function addFallbackRoute(
  options: MutationOptions & { input: AddFallbackRouteInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applyAddFallbackRoute(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

export async function setAuxiliaryModelRoute(
  options: MutationOptions & { input: AuxiliaryModelRouteSetupInput }
): Promise<{ path: string; config: EstaCodaConfig }> {
  const targetPath = await resolveTargetPath(options);
  const existing = await readConfig(targetPath);
  const config = applySetAuxiliaryModelRoute(existing.config, options.input);
  await saveRuntimeConfig(targetPath, config);
  return { path: targetPath, config };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function patchConfig(existing: EstaCodaConfig, patch: EstaCodaConfig): EstaCodaConfig {
  return {
    ...existing,
    ...patch,
    model: patch.model === undefined
      ? existing.model
      : {
        ...(existing.model ?? {}),
        ...patch.model
      },
    providers: patch.providers === undefined
      ? existing.providers
      : {
        ...(existing.providers ?? {}),
        ...patch.providers
      },
    auxiliaryModels: patch.auxiliaryModels === undefined
      ? existing.auxiliaryModels
      : {
        ...(existing.auxiliaryModels ?? {}),
        ...patch.auxiliaryModels
      }
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}
