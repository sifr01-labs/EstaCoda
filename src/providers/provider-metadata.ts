import type {
  ProviderId,
  ProviderAuthMethod,
  ProviderApiMode,
  ResolvedModelRoute,
  ModelProfile
} from "../contracts/provider.js";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STALE_TIMEOUT_MS
} from "../contracts/provider.js";

export type ChatMaxTokenParam = "max_tokens" | "max_completion_tokens";

export type ReasoningEchoField = "reasoning_content";

export type ReasoningEchoProviderFamily = "deepseek" | "kimi" | "mimo";

export type ProviderVisibility = {
  modelPicker: boolean;
  setup: boolean;
  catalogExplore: boolean;
};

export type ProviderMetadata = {
  id: ProviderId;
  displayName: string;
  catalogKnown: boolean;
  configurable: boolean;
  runnable: boolean;
  visibility: ProviderVisibility;
  apiMode: ProviderApiMode;
  defaultBaseUrl?: string;
  defaultApiKeyEnv?: string;
  authMethods: ProviderAuthMethod[];
  defaultAuthMethod: ProviderAuthMethod;
  allowsCustomBaseUrl: boolean;
  requiresModelSelection: boolean;
  chatMaxTokenParam?: ChatMaxTokenParam;
  supportsNativeToolHistory?: boolean;
  requiresReasoningEcho?: boolean;
  reasoningEchoField?: ReasoningEchoField;
  reasoningEchoRequiredForToolCalls?: boolean;
  reasoningEchoProviderFamily?: ReasoningEchoProviderFamily;
  allowReasoningEchoPlaceholder?: boolean;
};

const BUILT_IN_METADATA: Record<string, ProviderMetadata> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true,
    supportsNativeToolHistory: true
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultApiKeyEnv: "DEEPSEEK_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true,
    supportsNativeToolHistory: true,
    requiresReasoningEcho: true,
    reasoningEchoField: "reasoning_content",
    reasoningEchoRequiredForToolCalls: true,
    reasoningEchoProviderFamily: "deepseek"
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultApiKeyEnv: "KIMI_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true,
    supportsNativeToolHistory: true,
    requiresReasoningEcho: true,
    reasoningEchoField: "reasoning_content",
    reasoningEchoRequiredForToolCalls: true,
    reasoningEchoProviderFamily: "kimi"
  },
  google: {
    id: "google",
    displayName: "Google",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultApiKeyEnv: "GOOGLE_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultApiKeyEnv: "OPENROUTER_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  zai: {
    id: "zai",
    displayName: "Z.AI",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultApiKeyEnv: "ZAI_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  local: {
    id: "local",
    displayName: "Local",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultApiKeyEnv: undefined,
    authMethods: ["none", "api_key"],
    defaultAuthMethod: "none",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    catalogKnown: true,
    configurable: false,
    runnable: false,
    visibility: {
      modelPicker: false,
      setup: false,
      catalogExplore: true
    },
    apiMode: "anthropic_messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultApiKeyEnv: "ANTHROPIC_API_KEY",
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex",
    catalogKnown: true,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: true
    },
    apiMode: "openai_responses",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
    defaultApiKeyEnv: undefined,
    authMethods: ["oauth_device_pkce"],
    defaultAuthMethod: "oauth_device_pkce",
    allowsCustomBaseUrl: false,
    requiresModelSelection: true
  },
  minimax: {
    id: "minimax",
    displayName: "MiniMax",
    catalogKnown: true,
    configurable: false,
    runnable: false,
    visibility: {
      modelPicker: false,
      setup: false,
      catalogExplore: true
    },
    apiMode: "openai_chat_completions",
    defaultBaseUrl: undefined,
    defaultApiKeyEnv: undefined,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  nous: {
    id: "nous",
    displayName: "Nous",
    catalogKnown: true,
    configurable: false,
    runnable: false,
    visibility: {
      modelPicker: false,
      setup: false,
      catalogExplore: true
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: undefined,
    defaultApiKeyEnv: undefined,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  },
  unconfigured: {
    id: "unconfigured",
    displayName: "Unconfigured",
    catalogKnown: false,
    configurable: false,
    runnable: false,
    visibility: {
      modelPicker: false,
      setup: false,
      catalogExplore: false
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: undefined,
    defaultApiKeyEnv: undefined,
    authMethods: ["none"],
    defaultAuthMethod: "none",
    allowsCustomBaseUrl: false,
    requiresModelSelection: false
  }
};

/**
 * Return canonical metadata for a provider ID.
 * Built-in providers resolve from the static registry.
 * Unknown/custom IDs resolve to a generic openai-compatible fallback
 * that requires an explicit base URL.
 */
export function getProviderMetadata(providerId: ProviderId): ProviderMetadata {
  const builtIn = BUILT_IN_METADATA[providerId];
  if (builtIn) {
    return builtIn;
  }

  // Unknown / arbitrary custom provider: treat as custom-openai-compatible
  // that requires explicit configuration (base URL must be supplied).
  return {
    id: providerId,
    displayName: providerId,
    catalogKnown: false,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: false
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: undefined,
    defaultApiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    authMethods: ["api_key", "none"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  };
}

export function resolveChatMaxTokenParam(
  providerId: ProviderId,
  metadata: Pick<ProviderMetadata, "chatMaxTokenParam"> = getProviderMetadata(providerId)
): ChatMaxTokenParam {
  if (metadata.chatMaxTokenParam !== undefined) {
    return metadata.chatMaxTokenParam;
  }

  return providerId === "openai" ? "max_completion_tokens" : "max_tokens";
}

/**
 * Return the real default base URL for a provider when metadata defines one.
 */
export function getProviderDefaultBaseUrl(providerId: ProviderId): string | undefined {
  return getProviderMetadata(providerId).defaultBaseUrl;
}

/**
 * Return the default API key environment variable name for a provider.
 * Falls back to a generic name for unknown providers.
 */
export function getDefaultApiKeyEnv(providerId: ProviderId): string {
  return getProviderMetadata(providerId).defaultApiKeyEnv ?? "OPENAI_COMPATIBLE_API_KEY";
}

/**
 * Whether the provider is runnable in the current runtime.
 * Custom providers are considered runnable only when a base URL is supplied.
 */
export function isProviderRunnable(providerId: ProviderId, baseUrl?: string): boolean {
  const meta = getProviderMetadata(providerId);
  if (!meta.runnable) {
    return false;
  }
  // Unknown custom providers need an explicit base URL to be truly runnable
  if (!meta.catalogKnown && meta.allowsCustomBaseUrl && baseUrl === undefined) {
    return false;
  }
  return true;
}

/** Whether the provider is configurable by the user. */
export function isProviderConfigurable(providerId: ProviderId): boolean {
  return getProviderMetadata(providerId).configurable;
}

/** Whether the provider requires an explicit base URL to be usable. */
export function providerRequiresBaseUrl(providerId: ProviderId): boolean {
  const meta = getProviderMetadata(providerId);
  return meta.allowsCustomBaseUrl && meta.defaultBaseUrl === undefined;
}

/** Providers visible in the setup flow. */
export function listProvidersVisibleInSetup(): ProviderMetadata[] {
  return Object.values(BUILT_IN_METADATA).filter((m) => m.visibility.setup);
}

/** Providers visible in the model picker. */
export function listProvidersVisibleInModelPicker(): ProviderMetadata[] {
  return Object.values(BUILT_IN_METADATA).filter((m) => m.visibility.modelPicker);
}

/** All catalog-known providers, including hidden/internal ones. */
export function listCatalogKnownProviders(): ProviderMetadata[] {
  return Object.values(BUILT_IN_METADATA).filter((m) => m.catalogKnown);
}

/**
 * Create metadata for a custom provider with an explicit base URL.
 * This is the supported way to handle arbitrary custom provider IDs
 * without polluting the static registry.
 */
export function resolveCustomProviderMetadata(
  providerId: ProviderId,
  baseUrl?: string
): ProviderMetadata {
  return {
    id: providerId,
    displayName: providerId,
    catalogKnown: false,
    configurable: true,
    runnable: true,
    visibility: {
      modelPicker: true,
      setup: true,
      catalogExplore: false
    },
    apiMode: "custom_openai_compatible",
    defaultBaseUrl: baseUrl,
    defaultApiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    authMethods: ["api_key", "none"],
    defaultAuthMethod: "api_key",
    allowsCustomBaseUrl: true,
    requiresModelSelection: true
  };
}

/**
 * Build an explicit ResolvedModelRoute from config or caller-supplied fields,
 * enriching with apiMode from provider metadata when not already provided.
 *
 * This is the single shared helper for constructing normalized runtime routes.
 * Callers should prefer this over hand-rolling route objects in multiple places.
 */
export function buildResolvedModelRoute(options: {
  provider: ProviderId;
  model: string;
  profile: ModelProfile;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
  timeoutMs?: number;
  staleTimeoutMs?: number;
  apiMode?: ProviderApiMode;
  authMethod?: ProviderAuthMethod;
}): ResolvedModelRoute {
  const metadata = getProviderMetadata(options.provider);
  return {
    provider: options.provider,
    id: options.model,
    profile: options.profile,
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
    contextWindowTokens: options.contextWindowTokens,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
    staleTimeoutMs: options.staleTimeoutMs ?? DEFAULT_PROVIDER_STALE_TIMEOUT_MS,
    apiMode: options.apiMode ?? metadata.apiMode,
    authMethod: options.authMethod ?? metadata.defaultAuthMethod,
    supportsNativeToolHistory: metadata.supportsNativeToolHistory,
    requiresReasoningEcho: metadata.requiresReasoningEcho,
    reasoningEchoField: metadata.reasoningEchoField,
    reasoningEchoRequiredForToolCalls: metadata.reasoningEchoRequiredForToolCalls,
    reasoningEchoProviderFamily: metadata.reasoningEchoProviderFamily,
    allowReasoningEchoPlaceholder: metadata.allowReasoningEchoPlaceholder
  } as ResolvedModelRoute;
}

/**
 * Providers that are currently routed through their own native config surfaces
 * (SttProvider, TtsProvider, ImageGenerationProvider) and must not be
 * absorbed into the LLM provider metadata registry in the current codebase.
 *
 * IMPORTANT: This is a CURRENT-STATE registry exclusion list, NOT a permanent
 * capability claim. If a provider listed here (e.g. groq) is later added to the
 * STATIC_REGISTRY as a real LLM provider, remove it from this set. The function
 * is intentionally named as an exclusion guard rather than a capability
 * assertion to avoid implying that these providers can never support LLM
 * routing in the future.
 *
 * Usage: use this only to decide whether a provider ID should be treated as
 * a runnable LLM provider. Do not use it to gate UI features that could
 * legitimately apply to a future LLM-registered instance of the same name.
 */
const MEDIA_ONLY_PROVIDERS = new Set<string>([
  // Image generation (native surfaces: ImageGenerationProvider)
  "fal",
  "byteplus",
  // TTS (native surfaces: TtsProvider)
  "edge",
  "elevenlabs",
  "neutts",
  "kittentts",
  // STT (native surfaces: SttProvider)
  "groq"
]);

/**
 * Returns true if the provider is currently excluded from the LLM provider
 * metadata registry because it is handled by a dedicated native config surface.
 *
 * This is NOT a claim that the provider can never support LLM chat routing.
 * If a provider graduates to the STATIC_REGISTRY, remove it from the
 * MEDIA_ONLY_PROVIDERS set above.
 */
export function isProviderMediaOnly(providerId: ProviderId): boolean {
  return MEDIA_ONLY_PROVIDERS.has(providerId);
}

/**
 * Whether the given API mode is executable by the current build.
 */
export function isExecutableApiMode(apiMode: ProviderApiMode): boolean {
  return apiMode === "openai_chat_completions"
    || apiMode === "custom_openai_compatible"
    || apiMode === "openai_responses";
}

/**
 * Validate a resolved route for model-switching operations.
 * Blocks non-runnable providers, unsupported API modes, missing base URLs,
 * and placeholder endpoints.
 */
export function validateResolvedRouteForModelSwitch(
  route: ResolvedModelRoute
): { ok: true } | { ok: false; reason: string } {
  const meta = getProviderMetadata(route.provider);
  const apiMode = route.apiMode ?? meta.apiMode;
  const baseUrl = route.baseUrl ?? meta.defaultBaseUrl;

  if (!meta.runnable) {
    return { ok: false, reason: `Provider ${meta.displayName} is not runnable in this build.` };
  }
  if (!isExecutableApiMode(apiMode)) {
    return { ok: false, reason: `Provider ${meta.displayName} uses unsupported API mode ${apiMode}.` };
  }
  if (providerRequiresBaseUrl(route.provider) && !baseUrl) {
    return { ok: false, reason: `Provider ${route.provider} requires an explicit base URL.` };
  }
  if (baseUrl === "https://example.invalid/v1") {
    return { ok: false, reason: `Provider ${route.provider} has no valid endpoint.` };
  }
  return { ok: true };
}
