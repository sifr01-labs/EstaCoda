import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import type { BrowserBackendKind } from "../contracts/browser.js";
import type {
  AuxiliaryProviderConfig,
  CredentialPoolEntry,
  CredentialRotationStrategy,
  ModelProfile,
  ProviderEndpoint,
  ProviderId
} from "../contracts/provider.js";
import { CredentialPool, CredentialPoolRegistry } from "../providers/credential-pool.js";
import { loadDotEnvSecrets, writeEnvSecret } from "./env-secret-store.js";
import {
  enrichModelProfiles,
  inferModelProfile,
  resolveModelProfileFromCatalog,
  resolveModelProfilesFromCatalog
} from "../providers/model-catalog.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { createOpenAICompatibleProvider, type FetchLike as ProviderFetchLike } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { MCPServerTransport } from "../mcp/mcp-client.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { normalizeSecurityApprovalMode } from "../security/security-policy-factory.js";
import type { SecurityApprovalMode, SecurityAssessorConfig } from "../contracts/security.js";
import {
  defaultImageApiKeyEnv,
  defaultImageBaseUrl,
  defaultImageModel,
  resolveImageModel
} from "../contracts/image-generation.js";

export type MCPServerTrust = "conservative" | "read-only-network" | "read-only-local";
export type UiLanguage = "en" | "ar";
export type UiFlavor = "standard" | "arabic-light" | "kemet-full";
export type ActivityLabelsLocale = "en" | "ar";
export type AgentProfileMode = "focused" | "operator" | "builder" | "research";
export type AgentResponseLanguage = "en" | "ar" | "match-user";
export type TtsProvider = "edge" | "elevenlabs" | "openai" | "minimax" | "mistral" | "gemini" | "xai" | "neutts" | "kittentts";
export type SttProvider = "local" | "groq" | "openai" | "mistral";
export type ImageGenerationProvider = "fal" | "byteplus";

export type TtsConfig = {
  provider?: TtsProvider;
  speed?: number;
  edge?: {
    voice?: string;
    speed?: number;
  };
  elevenlabs?: {
    voiceId?: string;
    voice_id?: string;
    modelId?: string;
    model_id?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  openai?: {
    model?: string;
    voice?: string;
    baseUrl?: string;
    base_url?: string;
    speed?: number;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  minimax?: {
    model?: string;
    voiceId?: string;
    voice_id?: string;
    speed?: number;
    vol?: number;
    pitch?: number;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  mistral?: {
    model?: string;
    voiceId?: string;
    voice_id?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  gemini?: {
    model?: string;
    voice?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  xai?: {
    voiceId?: string;
    voice_id?: string;
    language?: string;
    sampleRate?: number;
    sample_rate?: number;
    bitRate?: number;
    bit_rate?: number;
    baseUrl?: string;
    base_url?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  neutts?: {
    refAudio?: string;
    ref_audio?: string;
    refText?: string;
    ref_text?: string;
    model?: string;
    device?: string;
  };
  kittentts?: {
    model?: string;
    voice?: string;
    speed?: number;
    cleanText?: boolean;
    clean_text?: boolean;
  };
};

export type SttConfig = {
  provider?: SttProvider;
  local?: {
    model?: string;
    command?: string;
  };
  groq?: {
    model?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  openai?: {
    model?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
  mistral?: {
    model?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
  };
};

export type ImageGenerationConfig = {
  provider?: ImageGenerationProvider;
  model?: string;
  useGateway?: boolean;
  use_gateway?: boolean;
  apiKeyEnv?: string;
  api_key_env?: string;
  baseUrl?: string;
  base_url?: string;
  fal?: {
    model?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
    baseUrl?: string;
    base_url?: string;
  };
  byteplus?: {
    model?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
    baseUrl?: string;
    base_url?: string;
  };
};

export type MCPServerToolsConfig = {
  include?: string[];
  exclude?: string[];
  resources?: boolean;
  prompts?: boolean;
  prefix?: string | boolean;
};

export type MCPServerConfig = {
  enabled?: boolean;
  transport?: MCPServerTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: MCPServerToolsConfig;
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  exposePrompts?: boolean;
  toolPrefix?: string | boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  trust?: MCPServerTrust;
  toolRiskClass?: ToolRiskClass;
  resourceReadRiskClass?: ToolRiskClass;
  promptGetRiskClass?: ToolRiskClass;
};

export type EstaCodaConfig = {
  model?: {
    provider?: ProviderId;
    id?: string;
    contextWindowTokens?: number;
  };
  providers?: Record<string, {
    kind?: "openai-compatible" | "catalog";
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: string[];
    enableNetwork?: boolean;
    headers?: Record<string, string>;
  }>;
  credentialPools?: Record<string, {
    strategy?: CredentialRotationStrategy;
    entries?: CredentialPoolEntry[];
  }>;
  auxiliaryProviders?: AuxiliaryProviderConfig;
  web?: {
    enableNetwork?: boolean;
    maxContentChars?: number;
  };
  browser?: {
    backend?: BrowserBackendKind;
    cdpUrl?: string;
    launchCommand?: string;
    autoLaunch?: boolean;
  };
  imageGen?: ImageGenerationConfig;
  image_gen?: ImageGenerationConfig;
  tts?: TtsConfig;
  stt?: SttConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  mcp_servers?: Record<string, MCPServerConfig>;
  skills?: {
    externalDirs?: string[];
    autonomy?: SkillAutonomy;
    config?: Record<string, Record<string, unknown>>;
  };
  ui?: {
    language?: UiLanguage;
    flavor?: UiFlavor;
    activityLabels?: ActivityLabelsLocale;
  };
  profile?: {
    mode?: AgentProfileMode;
    responseLanguage?: AgentResponseLanguage;
  };
  security?: {
    approvalMode?: SecurityApprovalMode | "manual" | "smart" | "off";
    assessor?: SecurityAssessorConfig;
    approvals?: {
      mode?: SecurityApprovalMode | "manual" | "smart" | "off";
    };
  };
  channels?: {
    telegram?: TelegramChannelConfig;
  };
};

export type TelegramChannelConfig = {
  enabled?: boolean;
  botTokenEnv?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  groupSessionsPerUser?: boolean;
  threadSessionsPerUser?: boolean;
  sessionResetPolicy?: "none" | "idle" | "daily" | "both";
  sessionIdleResetMinutes?: number;
  pollTimeoutSeconds?: number;
  maxAttachmentBytes?: number;
  pairing?: {
    code?: string;
    createdAt?: string;
    expiresAt?: string;
  };
};

export type LoadedRuntimeConfig = {
  config: EstaCodaConfig;
  sources: string[];
  model: ModelProfile;
  providerRegistry: ProviderRegistry;
  credentialPools: CredentialPoolRegistry;
  auxiliaryProviders?: AuxiliaryProviderConfig;
  web: {
    enableNetwork: boolean;
    maxContentChars?: number;
  };
  browser: {
    backend: BrowserBackendKind;
    cdpUrl?: string;
    launchCommand?: string;
    autoLaunch: boolean;
  };
  imageGen: Required<Pick<ImageGenerationConfig, "provider" | "model" | "useGateway">> & ImageGenerationConfig;
  tts: Required<Pick<TtsConfig, "provider" | "speed">> & TtsConfig;
  stt: Required<Pick<SttConfig, "provider">> & SttConfig;
  mcp: {
    servers: Record<string, MCPServerConfig>;
  };
  skills: {
    externalDirs: string[];
    autonomy: SkillAutonomy;
    config: Record<string, Record<string, unknown>>;
  };
  ui: {
    language: UiLanguage;
    flavor: UiFlavor;
    activityLabels: ActivityLabelsLocale;
  };
  profile: {
    mode: AgentProfileMode;
    responseLanguage: AgentResponseLanguage;
  };
  security: {
    approvalMode: SecurityApprovalMode;
    assessor: {
      enabled: boolean;
      provider?: ProviderId;
      model?: string;
      timeoutMs: number;
    };
  };
  channels: {
    telegram: TelegramChannelConfig & {
      ready: boolean;
      missing?: string[];
    };
  };
};

export type ProviderSetupInput = {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  enableNetwork?: boolean;
  scope?: "user" | "project";
  credentialPoolStrategy?: CredentialRotationStrategy;
  primary?: boolean;
  backupForMain?: boolean;
};

export type WebSetupInput = {
  enableNetwork?: boolean;
  maxContentChars?: number;
  scope?: "user" | "project";
};

export type BrowserSetupInput = {
  backend?: BrowserBackendKind;
  cdpUrl?: string;
  launchCommand?: string;
  autoLaunch?: boolean;
  scope?: "user" | "project";
};

export type VoiceSetupInput = {
  ttsProvider?: TtsProvider;
  ttsSpeed?: number;
  ttsVoice?: string;
  ttsModel?: string;
  ttsApiKeyEnv?: string;
  ttsApiKey?: string;
  sttProvider?: SttProvider;
  sttModel?: string;
  sttCommand?: string;
  sttApiKeyEnv?: string;
  sttApiKey?: string;
  scope?: "user" | "project";
};

export type ImageGenerationSetupInput = {
  provider?: ImageGenerationProvider;
  model?: string;
  modelVersion?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
  useGateway?: boolean;
  scope?: "user" | "project";
};

export type MCPSetupInput = {
  name: string;
  enabled?: boolean;
  transport?: MCPServerTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: MCPServerToolsConfig;
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  exposePrompts?: boolean;
  toolPrefix?: string | boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  trust?: MCPServerTrust;
  toolRiskClass?: ToolRiskClass;
  resourceReadRiskClass?: ToolRiskClass;
  promptGetRiskClass?: ToolRiskClass;
  scope?: "user" | "project";
};

export type TelegramSetupInput = {
  botTokenEnv?: string;
  botToken?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  pollTimeoutSeconds?: number;
  enabled?: boolean;
  scope?: "user" | "project";
};

export type TelegramPairingInput = {
  code?: string;
  ttlMinutes?: number;
  scope?: "user" | "project";
};

export type SecuritySetupInput = {
  mode?: SecurityApprovalMode | "manual" | "smart" | "off";
  assessorEnabled?: boolean;
  assessorProvider?: ProviderId;
  assessorModel?: string;
  assessorTimeoutMs?: number;
  scope?: "user" | "project";
};

export type SkillSetupInput = {
  autonomy?: SkillAutonomy;
  scope?: "user" | "project";
};

export type UiSetupInput = {
  language?: UiLanguage;
  flavor?: UiFlavor;
  activityLabels?: ActivityLabelsLocale;
  scope?: "user" | "project";
};

export type ProfileSetupInput = {
  mode?: AgentProfileMode;
  responseLanguage?: AgentResponseLanguage;
  scope?: "user" | "project";
};

export async function loadRuntimeConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  providerFetch?: ProviderFetchLike;
}): Promise<LoadedRuntimeConfig> {
  await loadDotEnvSecrets({ homeDir: options.homeDir });
  const sources = [
    options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json"),
    options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
  ];
  const loaded = await Promise.all(sources.map((path) => readConfig(path)));
  const config = mergeConfig(...loaded.map((entry) => entry.config));
  const catalogProfiles = await resolveModelProfilesFromCatalog({
    homeDir: options.homeDir,
    allowNetwork: false
  });
  const model = await resolveModelProfileFromCatalog({
    provider: config.model?.provider ?? "unconfigured",
    model: config.model?.id ?? "unconfigured",
    contextWindowTokens: config.model?.contextWindowTokens,
    homeDir: options.homeDir,
    allowNetwork: false
  });
  const providerRegistry = buildProviderRegistry(config, {
    fetch: options.providerFetch,
    catalogProfiles
  });
  const credentialPools = buildCredentialPools(config);
  const telegram = config.channels?.telegram ?? {};
  const telegramMissing = telegram.enabled === true && telegram.botTokenEnv !== undefined && process.env[telegram.botTokenEnv] === undefined
    ? [telegram.botTokenEnv]
    : [];

  return {
    config,
    sources: loaded.filter((entry) => entry.loaded).map((entry) => entry.path),
    model,
    providerRegistry,
    credentialPools,
    auxiliaryProviders: config.auxiliaryProviders,
    web: {
      enableNetwork: config.web?.enableNetwork ?? false,
      maxContentChars: config.web?.maxContentChars
    },
    browser: {
      backend: config.browser?.backend ?? "unconfigured",
      cdpUrl: config.browser?.cdpUrl,
      launchCommand: config.browser?.launchCommand,
      autoLaunch: config.browser?.autoLaunch ?? false
    },
    imageGen: normalizeImageGenerationConfig(config.imageGen ?? config.image_gen),
    tts: normalizeTtsConfig(config.tts),
    stt: normalizeSttConfig(config.stt),
    mcp: {
      servers: normalizeMcpServers(config.mcpServers ?? config.mcp_servers, options.homeDir)
    },
    skills: {
      externalDirs: expandConfiguredPaths(config.skills?.externalDirs ?? [], options.homeDir),
      autonomy: config.skills?.autonomy ?? "suggest",
      config: normalizeSkillConfig(config.skills?.config)
    },
    ui: normalizeUiConfig(config.ui),
    profile: normalizeProfileConfig(config.profile),
    security: {
      approvalMode: normalizeSecurityApprovalMode(config.security?.approvalMode ?? config.security?.approvals?.mode),
      assessor: {
        enabled: config.security?.assessor?.enabled === true,
        provider: config.security?.assessor?.provider,
        model: config.security?.assessor?.model,
        timeoutMs: config.security?.assessor?.timeoutMs ?? 8_000
      }
    },
    channels: {
      telegram: {
        ...telegram,
        ready: telegram.enabled === true && telegram.botTokenEnv !== undefined && telegramMissing.length === 0,
        missing: telegramMissing.length === 0 ? undefined : telegramMissing
      }
    }
  };
}

export function mergeConfig(...configs: EstaCodaConfig[]): EstaCodaConfig {
  return compactConfig(configs.reduce<EstaCodaConfig>((merged, config) => ({
    model: {
      ...(merged.model ?? {}),
      ...(config.model ?? {})
    },
    providers: mergeRecordEntries(merged.providers, config.providers),
    credentialPools: mergeRecordEntries(merged.credentialPools, config.credentialPools),
    auxiliaryProviders: mergeRecordEntries(merged.auxiliaryProviders, config.auxiliaryProviders),
    web: {
      ...(merged.web ?? {}),
      ...(config.web ?? {})
    },
    browser: {
      ...(merged.browser ?? {}),
      ...(config.browser ?? {})
    },
    imageGen: mergeImageGenerationConfig(merged.imageGen ?? merged.image_gen, config.imageGen ?? config.image_gen),
    tts: mergeTtsConfig(merged.tts, config.tts),
    stt: mergeSttConfig(merged.stt, config.stt),
    mcpServers: mergeRecordEntries(
      mergeRecordEntries(merged.mcpServers, merged.mcp_servers),
      mergeRecordEntries(config.mcpServers, config.mcp_servers)
    ),
    skills: {
      ...(merged.skills ?? {}),
      externalDirs: config.skills?.externalDirs ?? merged.skills?.externalDirs,
      autonomy: config.skills?.autonomy ?? merged.skills?.autonomy,
      config: {
        ...(merged.skills?.config ?? {}),
        ...(config.skills?.config ?? {})
      }
    },
    ui: {
      ...(merged.ui ?? {}),
      ...(config.ui ?? {})
    },
    profile: {
      ...(merged.profile ?? {}),
      ...(config.profile ?? {})
    },
    security: {
      ...(merged.security ?? {}),
      approvalMode: config.security?.approvalMode ?? merged.security?.approvalMode,
      assessor: {
        ...(merged.security?.assessor ?? {}),
        ...(config.security?.assessor ?? {})
      },
      approvals: {
        ...(merged.security?.approvals ?? {}),
        ...(config.security?.approvals ?? {})
      }
    },
    channels: {
      ...(merged.channels ?? {}),
      ...(config.channels ?? {}),
      telegram: {
        ...(merged.channels?.telegram ?? {}),
        ...(config.channels?.telegram ?? {})
      }
    }
  }), {}));
}

function mergeRecordEntries<T extends Record<string, unknown> | undefined>(
  left: T,
  right: T
): T {
  if (left === undefined && right === undefined) {
    return undefined as T;
  }
  const merged: Record<string, unknown> = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) {
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(value)
      ? deepMergeRecord(existing, value)
      : value;
  }
  return merged as T;
}

function deepMergeRecord(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(value)
      ? deepMergeRecord(existing, value)
      : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactConfig(config: EstaCodaConfig): EstaCodaConfig {
  return (compactValue(config) ?? {}) as EstaCodaConfig;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactValue).filter((item) => item !== undefined);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const compacted = Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, compactValue(child)] as const)
      .filter(([, child]) => child !== undefined && !(isPlainRecord(child) && Object.keys(child).length === 0))
  );

  return Object.keys(compacted).length === 0 ? undefined : compacted;
}

function normalizeSkillConfig(value: unknown): Record<string, Record<string, unknown>> {
  if (value === undefined || typeof value !== "object" || value === null) {
    return {};
  }

  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [skillName, entry] of Object.entries(value)) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      normalized[skillName] = { ...entry };
    }
  }
  return normalized;
}

function normalizeUiConfig(value: EstaCodaConfig["ui"]): LoadedRuntimeConfig["ui"] {
  const language = value?.language === "ar" ? "ar" : "en";
  const flavor = value?.flavor === "standard" || value?.flavor === "arabic-light" || value?.flavor === "kemet-full"
    ? value.flavor
    : language === "ar" ? "arabic-light" : "standard";
  const activityLabels = value?.activityLabels === "ar" || value?.activityLabels === "en"
    ? value.activityLabels
    : language;

  return {
    language,
    flavor,
    activityLabels
  };
}

function normalizeProfileConfig(value: EstaCodaConfig["profile"]): LoadedRuntimeConfig["profile"] {
  return {
    mode: value?.mode === "focused" || value?.mode === "operator" || value?.mode === "builder" || value?.mode === "research"
      ? value.mode
      : "builder",
    responseLanguage: value?.responseLanguage === "en" || value?.responseLanguage === "ar" || value?.responseLanguage === "match-user"
      ? value.responseLanguage
      : "match-user"
  };
}

function normalizeTtsConfig(value: EstaCodaConfig["tts"]): LoadedRuntimeConfig["tts"] {
  const provider = isTtsProvider(value?.provider) ? value.provider : "edge";
  return {
    ...value,
    provider,
    speed: boundedNumber(value?.speed, 1, 0.25, 4),
    edge: {
      voice: value?.edge?.voice ?? "en-US-AriaNeural",
      speed: boundedNumber(value?.edge?.speed, value?.speed ?? 1, 0.25, 4)
    },
    elevenlabs: {
      voiceId: value?.elevenlabs?.voiceId ?? value?.elevenlabs?.voice_id ?? "pNInz6obpgDQGcFmaJgB",
      modelId: value?.elevenlabs?.modelId ?? value?.elevenlabs?.model_id ?? "eleven_multilingual_v2",
      apiKeyEnv: value?.elevenlabs?.apiKeyEnv ?? value?.elevenlabs?.api_key_env ?? "ELEVENLABS_API_KEY"
    },
    openai: {
      model: value?.openai?.model ?? "gpt-4o-mini-tts",
      voice: value?.openai?.voice ?? "alloy",
      baseUrl: value?.openai?.baseUrl ?? value?.openai?.base_url ?? "https://api.openai.com/v1",
      speed: boundedNumber(value?.openai?.speed, value?.speed ?? 1, 0.25, 4),
      apiKeyEnv: value?.openai?.apiKeyEnv ?? value?.openai?.api_key_env ?? "VOICE_TOOLS_OPENAI_KEY"
    },
    minimax: {
      model: value?.minimax?.model ?? "speech-2.8-hd",
      voiceId: value?.minimax?.voiceId ?? value?.minimax?.voice_id ?? "English_Graceful_Lady",
      speed: boundedNumber(value?.minimax?.speed, 1, 0.5, 2),
      vol: boundedNumber(value?.minimax?.vol, 1, 0, 10),
      pitch: boundedNumber(value?.minimax?.pitch, 0, -12, 12),
      apiKeyEnv: value?.minimax?.apiKeyEnv ?? value?.minimax?.api_key_env ?? "MINIMAX_API_KEY"
    },
    mistral: {
      model: value?.mistral?.model ?? "voxtral-mini-tts-2603",
      voiceId: value?.mistral?.voiceId ?? value?.mistral?.voice_id ?? "c69964a6-ab8b-4f8a-9465-ec0925096ec8",
      apiKeyEnv: value?.mistral?.apiKeyEnv ?? value?.mistral?.api_key_env ?? "MISTRAL_API_KEY"
    },
    gemini: {
      model: value?.gemini?.model ?? "gemini-2.5-flash-preview-tts",
      voice: value?.gemini?.voice ?? "Kore",
      apiKeyEnv: value?.gemini?.apiKeyEnv ?? value?.gemini?.api_key_env ?? "GEMINI_API_KEY"
    },
    xai: {
      voiceId: value?.xai?.voiceId ?? value?.xai?.voice_id ?? "eve",
      language: value?.xai?.language ?? "en",
      sampleRate: value?.xai?.sampleRate ?? value?.xai?.sample_rate ?? 24_000,
      bitRate: value?.xai?.bitRate ?? value?.xai?.bit_rate ?? 128_000,
      baseUrl: value?.xai?.baseUrl ?? value?.xai?.base_url ?? "https://api.x.ai/v1",
      apiKeyEnv: value?.xai?.apiKeyEnv ?? value?.xai?.api_key_env ?? "XAI_API_KEY"
    },
    neutts: {
      refAudio: value?.neutts?.refAudio ?? value?.neutts?.ref_audio ?? "",
      refText: value?.neutts?.refText ?? value?.neutts?.ref_text ?? "",
      model: value?.neutts?.model ?? "neuphonic/neutts-air-q4-gguf",
      device: value?.neutts?.device ?? "cpu"
    },
    kittentts: {
      model: value?.kittentts?.model ?? "KittenML/kitten-tts-nano-0.8-int8",
      voice: value?.kittentts?.voice ?? "Jasper",
      speed: boundedNumber(value?.kittentts?.speed, 1, 0.5, 2),
      cleanText: value?.kittentts?.cleanText ?? value?.kittentts?.clean_text ?? true
    }
  };
}

function normalizeImageGenerationConfig(value: EstaCodaConfig["imageGen"]): LoadedRuntimeConfig["imageGen"] {
  const provider = value?.provider === "byteplus" ? "byteplus" : "fal";
  const model = value?.model ?? value?.[provider]?.model ?? defaultImageModel(provider);
  const baseUrl = value?.baseUrl
    ?? value?.base_url
    ?? value?.[provider]?.baseUrl
    ?? value?.[provider]?.base_url
    ?? defaultImageBaseUrl(provider);
  return {
    ...value,
    provider,
    model,
    useGateway: value?.useGateway ?? value?.use_gateway ?? false,
    apiKeyEnv: value?.apiKeyEnv ?? value?.api_key_env ?? defaultImageApiKeyEnv(provider),
    baseUrl,
    fal: {
      model: value?.fal?.model ?? (provider === "fal" ? model : defaultImageModel("fal")),
      apiKeyEnv: value?.fal?.apiKeyEnv ?? value?.fal?.api_key_env ?? defaultImageApiKeyEnv("fal"),
      baseUrl: value?.fal?.baseUrl ?? value?.fal?.base_url ?? defaultImageBaseUrl("fal")
    },
    byteplus: {
      model: value?.byteplus?.model ?? (provider === "byteplus" ? model : defaultImageModel("byteplus")),
      apiKeyEnv: value?.byteplus?.apiKeyEnv ?? value?.byteplus?.api_key_env ?? defaultImageApiKeyEnv("byteplus"),
      baseUrl: value?.byteplus?.baseUrl ?? value?.byteplus?.base_url ?? defaultImageBaseUrl("byteplus")
    }
  };
}

function mergeImageGenerationConfig(left: EstaCodaConfig["imageGen"], right: EstaCodaConfig["imageGen"]): EstaCodaConfig["imageGen"] {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {}),
    fal: { ...(left?.fal ?? {}), ...(right?.fal ?? {}) },
    byteplus: { ...(left?.byteplus ?? {}), ...(right?.byteplus ?? {}) }
  };
}

function normalizeSttConfig(value: EstaCodaConfig["stt"]): LoadedRuntimeConfig["stt"] {
  const provider = isSttProvider(value?.provider) ? value.provider : "local";
  return {
    ...value,
    provider,
    local: {
      model: value?.local?.model ?? "base",
      command: value?.local?.command ?? process.env.HERMES_LOCAL_STT_COMMAND
    },
    groq: {
      model: value?.groq?.model ?? "whisper-large-v3",
      apiKeyEnv: value?.groq?.apiKeyEnv ?? value?.groq?.api_key_env ?? "GROQ_API_KEY"
    },
    openai: {
      model: value?.openai?.model ?? "whisper-1",
      apiKeyEnv: value?.openai?.apiKeyEnv ?? value?.openai?.api_key_env ?? "VOICE_TOOLS_OPENAI_KEY"
    },
    mistral: {
      model: value?.mistral?.model ?? "voxtral-mini-latest",
      apiKeyEnv: value?.mistral?.apiKeyEnv ?? value?.mistral?.api_key_env ?? "MISTRAL_API_KEY"
    }
  };
}

function mergeTtsConfig(left: TtsConfig | undefined, right: TtsConfig | undefined): TtsConfig | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {}),
    edge: { ...(left?.edge ?? {}), ...(right?.edge ?? {}) },
    elevenlabs: { ...(left?.elevenlabs ?? {}), ...(right?.elevenlabs ?? {}) },
    openai: { ...(left?.openai ?? {}), ...(right?.openai ?? {}) },
    minimax: { ...(left?.minimax ?? {}), ...(right?.minimax ?? {}) },
    mistral: { ...(left?.mistral ?? {}), ...(right?.mistral ?? {}) },
    gemini: { ...(left?.gemini ?? {}), ...(right?.gemini ?? {}) },
    xai: { ...(left?.xai ?? {}), ...(right?.xai ?? {}) },
    neutts: { ...(left?.neutts ?? {}), ...(right?.neutts ?? {}) },
    kittentts: { ...(left?.kittentts ?? {}), ...(right?.kittentts ?? {}) }
  };
}

function mergeSttConfig(left: SttConfig | undefined, right: SttConfig | undefined): SttConfig | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return {
    ...(left ?? {}),
    ...(right ?? {}),
    local: { ...(left?.local ?? {}), ...(right?.local ?? {}) },
    groq: { ...(left?.groq ?? {}), ...(right?.groq ?? {}) },
    openai: { ...(left?.openai ?? {}), ...(right?.openai ?? {}) },
    mistral: { ...(left?.mistral ?? {}), ...(right?.mistral ?? {}) }
  };
}

function isTtsProvider(value: unknown): value is TtsProvider {
  return value === "edge" ||
    value === "elevenlabs" ||
    value === "openai" ||
    value === "minimax" ||
    value === "mistral" ||
    value === "gemini" ||
    value === "xai" ||
    value === "neutts" ||
    value === "kittentts";
}

function isSttProvider(value: unknown): value is SttProvider {
  return value === "local" || value === "groq" || value === "openai" || value === "mistral";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalizeMcpServers(
  value: unknown,
  homeDir?: string
): Record<string, MCPServerConfig> {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const toolConfig = typeof record.tools === "object" && record.tools !== null && !Array.isArray(record.tools)
      ? record.tools as Record<string, unknown>
      : undefined;
    normalized[name] = {
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      transport: record.transport === "http" || record.transport === "stdio" ? record.transport : undefined,
      command: typeof record.command === "string" ? record.command : undefined,
      args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : undefined,
      cwd: typeof record.cwd === "string" ? expandConfiguredPath(record.cwd, homeDir) : undefined,
      env: typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)
        ? Object.fromEntries(Object.entries(record.env).filter(([, envValue]) => typeof envValue === "string") as Array<[string, string]>)
        : undefined,
      url: typeof record.url === "string" ? record.url : undefined,
      headers: typeof record.headers === "object" && record.headers !== null && !Array.isArray(record.headers)
        ? Object.fromEntries(Object.entries(record.headers).filter(([, headerValue]) => typeof headerValue === "string") as Array<[string, string]>)
        : undefined,
      tools: toolConfig === undefined ? undefined : {
        include: Array.isArray(toolConfig.include) ? toolConfig.include.filter((item): item is string => typeof item === "string") : undefined,
        exclude: Array.isArray(toolConfig.exclude) ? toolConfig.exclude.filter((item): item is string => typeof item === "string") : undefined,
        resources: typeof toolConfig.resources === "boolean" ? toolConfig.resources : undefined,
        prompts: typeof toolConfig.prompts === "boolean" ? toolConfig.prompts : undefined,
        prefix: typeof toolConfig.prefix === "string" || typeof toolConfig.prefix === "boolean" ? toolConfig.prefix : undefined
      },
      includeTools: Array.isArray(record.includeTools)
        ? record.includeTools.filter((item): item is string => typeof item === "string")
        : (toolConfig !== undefined && Array.isArray(toolConfig.include)
            ? toolConfig.include.filter((item): item is string => typeof item === "string")
            : undefined),
      excludeTools: Array.isArray(record.excludeTools)
        ? record.excludeTools.filter((item): item is string => typeof item === "string")
        : (toolConfig !== undefined && Array.isArray(toolConfig.exclude)
            ? toolConfig.exclude.filter((item): item is string => typeof item === "string")
            : undefined),
      exposeResources: typeof record.exposeResources === "boolean"
        ? record.exposeResources
        : (toolConfig !== undefined && typeof toolConfig.resources === "boolean" ? toolConfig.resources : undefined),
      exposePrompts: typeof record.exposePrompts === "boolean"
        ? record.exposePrompts
        : (toolConfig !== undefined && typeof toolConfig.prompts === "boolean" ? toolConfig.prompts : undefined),
      toolPrefix: typeof record.toolPrefix === "string" || typeof record.toolPrefix === "boolean"
        ? record.toolPrefix
        : (toolConfig !== undefined && (typeof toolConfig.prefix === "string" || typeof toolConfig.prefix === "boolean") ? toolConfig.prefix : undefined),
      timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
      connectTimeoutMs: typeof record.connectTimeoutMs === "number" ? record.connectTimeoutMs : undefined,
      trust: record.trust === "conservative" || record.trust === "read-only-network" || record.trust === "read-only-local"
        ? record.trust
        : undefined,
      toolRiskClass: isToolRiskClass(record.toolRiskClass) ? record.toolRiskClass : undefined,
      resourceReadRiskClass: isToolRiskClass(record.resourceReadRiskClass) ? record.resourceReadRiskClass : undefined,
      promptGetRiskClass: isToolRiskClass(record.promptGetRiskClass) ? record.promptGetRiskClass : undefined
    };
  }
  return normalized;
}

export function buildProviderRegistry(config: EstaCodaConfig, options: {
  fetch?: ProviderFetchLike;
  catalogProfiles?: readonly ModelProfile[];
} = {}): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    const providerId = provider as ProviderId;
    const models = providerConfig.models ?? [];

    const kind = providerConfig.kind ?? "openai-compatible";
    if (kind === "openai-compatible") {
      registry.register(createOpenAICompatibleProvider({
        id: providerId,
        endpoint: {
          baseUrl: providerConfig.baseUrl ?? defaultBaseUrl(providerId),
          apiKey: providerConfig.apiKeyEnv === undefined
            ? { kind: "none" }
            : { kind: "env", name: providerConfig.apiKeyEnv },
          headers: providerConfig.headers
        } satisfies ProviderEndpoint,
        models: enrichModelProfiles({
          provider: providerId,
          models,
          catalogProfiles: options.catalogProfiles
        }),
        enableNetwork: providerConfig.enableNetwork ?? false,
        fetch: options.fetch
      }));
      continue;
    }

    if (kind === "catalog") {
      const catalogModels = models.length > 0
        ? enrichModelProfiles({
            provider: providerId,
            models,
            catalogProfiles: options.catalogProfiles
          })
        : options.catalogProfiles?.filter((model) =>
            model.provider === providerId &&
            model.status !== "deprecated" &&
            model.status !== "alpha" &&
            model.status !== "beta"
          ) ?? [];
      registry.register(createCatalogProvider({
        id: providerId,
        models: catalogModels.length > 0 ? catalogModels : models.map((model) => inferModelProfile({ provider: providerId, model }))
      }));
      continue;
    }

    throw new Error(`Unsupported provider kind ${String(kind)} for ${provider}`);
  }

  return registry;
}

export function buildCredentialPools(config: EstaCodaConfig): CredentialPoolRegistry {
  const registry = new CredentialPoolRegistry();

  for (const [provider, poolConfig] of Object.entries(config.credentialPools ?? {})) {
    registry.register(new CredentialPool({
      provider: provider as ProviderId,
      strategy: poolConfig.strategy,
      entries: poolConfig.entries ?? []
    }));
  }

  return registry;
}

export async function saveRuntimeConfig(path: string, config: EstaCodaConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function setupProviderConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: ProviderSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateProviderSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const requiresCredential = options.input.provider !== "local" || options.input.apiKeyEnv !== undefined || options.input.apiKey !== undefined;
  const envName = requiresCredential ? options.input.apiKeyEnv ?? defaultEnvKey(options.input.provider) : undefined;
  let secretPath: string | undefined;
  if (options.input.apiKey !== undefined && options.input.apiKey.trim().length > 0 && envName !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      key: envName,
      value: options.input.apiKey
    });
    process.env[secret.key] = options.input.apiKey;
    secretPath = secret.path;
  }
  const providerConfig = {
    kind: "openai-compatible" as const,
    baseUrl: options.input.baseUrl ?? defaultBaseUrl(options.input.provider),
    apiKeyEnv: envName,
    models: [options.input.model],
    enableNetwork: options.input.enableNetwork ?? true
  };
  const primaryModelPatch = options.input.primary === false
    ? {}
    : {
      model: {
        provider: options.input.provider,
        id: options.input.model
      }
    };
  const mainProviderOrder = options.input.backupForMain === true
    ? [
      existing.config.model?.provider,
      options.input.provider
    ].filter((provider, index, providers): provider is ProviderId => provider !== undefined && providers.indexOf(provider) === index)
    : undefined;
  const config = mergeConfig(existing.config, {
    ...primaryModelPatch,
    providers: {
      [options.input.provider]: providerConfig
    },
    credentialPools: envName === undefined
      ? {}
      : {
          [options.input.provider]: {
            strategy: options.input.credentialPoolStrategy ?? "fill_first",
            entries: [
              {
                id: `${options.input.provider}-${envName}`,
                source: { kind: "env", name: envName },
                priority: 1
              }
            ]
          }
        },
    auxiliaryProviders: mainProviderOrder === undefined
      ? undefined
      : {
          main: {
            providerOrder: mainProviderOrder
          }
        }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    secretPath
  };
}

export async function setupWebConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: WebSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateWebSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const config = mergeConfig(existing.config, {
    web: {
      enableNetwork: options.input.enableNetwork ?? true,
      maxContentChars: options.input.maxContentChars
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupBrowserConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: BrowserSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateBrowserSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const config = mergeConfig(existing.config, {
    browser: {
      backend: options.input.backend ?? "local-cdp",
      cdpUrl: options.input.cdpUrl,
      launchCommand: options.input.launchCommand,
      autoLaunch: options.input.autoLaunch ?? false
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupVoiceConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: VoiceSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPaths: string[];
}> {
  validateVoiceSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const previousTts = normalizeTtsConfig(existing.config.tts);
  const previousStt = normalizeSttConfig(existing.config.stt);
  const ttsProvider = options.input.ttsProvider ?? previousTts.provider;
  const sttProvider = options.input.sttProvider ?? previousStt.provider;
  const ttsApiKeyEnv = options.input.ttsApiKeyEnv ??
    ttsProviderApiKeyEnv(previousTts, ttsProvider) ??
    ttsDefaultApiKeyEnv(ttsProvider);
  const sttApiKeyEnv = options.input.sttApiKeyEnv ??
    sttProviderApiKeyEnv(previousStt, sttProvider) ??
    sttDefaultApiKeyEnv(sttProvider);
  const secretPaths: string[] = [];

  if (options.input.ttsApiKey !== undefined && options.input.ttsApiKey.trim().length > 0 && ttsApiKeyEnv !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      key: ttsApiKeyEnv,
      value: options.input.ttsApiKey
    });
    process.env[secret.key] = options.input.ttsApiKey;
    secretPaths.push(secret.path);
  }
  if (options.input.sttApiKey !== undefined && options.input.sttApiKey.trim().length > 0 && sttApiKeyEnv !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      key: sttApiKeyEnv,
      value: options.input.sttApiKey
    });
    process.env[secret.key] = options.input.sttApiKey;
    secretPaths.push(secret.path);
  }

  const config = mergeConfig(existing.config, {
    tts: {
      provider: ttsProvider,
      speed: options.input.ttsSpeed ?? previousTts.speed,
      [ttsProvider]: {
        model: options.input.ttsModel,
        voice: options.input.ttsVoice,
        voiceId: options.input.ttsVoice,
        apiKeyEnv: ttsApiKeyEnv
      }
    },
    stt: {
      provider: sttProvider,
      [sttProvider]: {
        model: options.input.sttModel,
        command: options.input.sttCommand,
        apiKeyEnv: sttApiKeyEnv
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    secretPaths: [...new Set(secretPaths)]
  };
}

export async function setupImageGenerationConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: ImageGenerationSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateImageGenerationSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const previous = normalizeImageGenerationConfig(existing.config.imageGen ?? existing.config.image_gen);
  const provider = options.input.provider ?? previous.provider;
  const providerExplicit = options.input.provider !== undefined;
  const apiKeyEnv = options.input.apiKeyEnv ?? previous[provider]?.apiKeyEnv ?? defaultImageApiKeyEnv(provider);
  let secretPath: string | undefined;
  if (options.input.apiKey !== undefined && options.input.apiKey.trim().length > 0) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      key: apiKeyEnv,
      value: options.input.apiKey
    });
    process.env[secret.key] = options.input.apiKey;
    secretPath = secret.path;
  }
  const requestedModel = options.input.model ?? resolveImageModel(provider, options.input.modelVersion);
  const model = requestedModel ?? (providerExplicit ? defaultImageModel(provider) : previous[provider]?.model ?? previous.model ?? defaultImageModel(provider));
  const baseUrl = options.input.baseUrl ?? previous[provider]?.baseUrl;
  const config = mergeConfig(existing.config, {
    imageGen: {
      provider,
      model,
      useGateway: options.input.useGateway ?? previous.useGateway,
      apiKeyEnv,
      baseUrl,
      [provider]: {
        model,
        apiKeyEnv,
        baseUrl
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    secretPath
  };
}

export async function setupMcpConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: MCPSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateMcpSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const serverName = options.input.name.trim();
  const servers = normalizeMcpServers(existing.config.mcpServers ?? existing.config.mcp_servers, options.homeDir);
  servers[serverName] = {
    enabled: options.input.enabled ?? true,
    transport: options.input.transport ?? "stdio",
    command: options.input.command,
    args: options.input.args,
    cwd: options.input.cwd === undefined ? undefined : expandConfiguredPath(options.input.cwd, options.homeDir),
    env: options.input.env,
    url: options.input.url,
    headers: options.input.headers,
    tools: {
      include: options.input.includeTools ?? options.input.tools?.include,
      exclude: options.input.excludeTools ?? options.input.tools?.exclude,
      resources: options.input.exposeResources ?? options.input.tools?.resources,
      prompts: options.input.exposePrompts ?? options.input.tools?.prompts,
      prefix: options.input.toolPrefix ?? options.input.tools?.prefix
    },
    includeTools: options.input.includeTools,
    excludeTools: options.input.excludeTools,
    exposeResources: options.input.exposeResources,
    exposePrompts: options.input.exposePrompts,
    toolPrefix: options.input.toolPrefix,
    timeoutMs: options.input.timeoutMs,
    connectTimeoutMs: options.input.connectTimeoutMs,
    trust: options.input.trust,
    toolRiskClass: options.input.toolRiskClass,
    resourceReadRiskClass: options.input.resourceReadRiskClass,
    promptGetRiskClass: options.input.promptGetRiskClass
  };
  const config = mergeConfig(existing.config, {
    mcpServers: servers
  });
  delete config.mcp_servers;

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function setupSecurityConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: SecuritySetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateSecuritySetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const assessorPatch = options.input.assessorEnabled !== undefined ||
    options.input.assessorProvider !== undefined ||
    options.input.assessorModel !== undefined ||
    options.input.assessorTimeoutMs !== undefined
    ? {
      ...(options.input.assessorEnabled === undefined ? {} : { enabled: options.input.assessorEnabled }),
      ...(options.input.assessorProvider === undefined ? {} : { provider: options.input.assessorProvider }),
      ...(options.input.assessorModel === undefined ? {} : { model: options.input.assessorModel }),
      ...(options.input.assessorTimeoutMs === undefined ? {} : { timeoutMs: options.input.assessorTimeoutMs })
    }
    : undefined;
  const securityPatch: EstaCodaConfig["security"] = {
    assessor: assessorPatch
  };
  if (options.input.mode !== undefined) {
    securityPatch.approvalMode = normalizeSecurityApprovalMode(options.input.mode);
  }
  const config = mergeConfig(existing.config, {
    security: {
      ...securityPatch
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function setupSkillConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: SkillSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateSkillSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const config = mergeConfig(existing.config, {
    skills: {
      autonomy: options.input.autonomy ?? "suggest"
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function setupUiConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: UiSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateUiSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const previous = normalizeUiConfig(existing.config.ui);
  const nextLanguage = options.input.language ?? previous.language;
  const languageChangedTo = options.input.language;
  const config = mergeConfig(existing.config, {
    ui: {
      language: nextLanguage,
      flavor: options.input.flavor ?? (
        languageChangedTo === "ar" ? "arabic-light" :
        languageChangedTo === "en" ? "standard" :
        previous.flavor
      ),
      activityLabels: options.input.activityLabels ?? (
        languageChangedTo === "ar" ? "ar" :
        languageChangedTo === "en" ? "en" :
        previous.activityLabels
      )
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function setupProfileConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: ProfileSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateProfileSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const previous = normalizeProfileConfig(existing.config.profile);
  const config = mergeConfig(existing.config, {
    profile: {
      mode: options.input.mode ?? previous.mode,
      responseLanguage: options.input.responseLanguage ?? previous.responseLanguage
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

function isToolRiskClass(value: unknown): value is ToolRiskClass {
  return value === "read-only-local" ||
    value === "read-only-network" ||
    value === "workspace-write" ||
    value === "external-side-effect" ||
    value === "credential-access" ||
    value === "destructive-local" ||
    value === "shared-state-mutation" ||
    value === "spend-money" ||
    value === "sandbox-escape";
}

export async function setupTelegramConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: TelegramSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateTelegramSetupInput(options.input);
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const envName = options.input.botTokenEnv ?? "ESTACODA_TELEGRAM_BOT_TOKEN";
  let secretPath: string | undefined;
  if (options.input.botToken !== undefined && options.input.botToken.trim().length > 0) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      key: envName,
      value: options.input.botToken
    });
    process.env[secret.key] = options.input.botToken;
    secretPath = secret.path;
  }
  const telegramPatch: TelegramChannelConfig = {
    ...(existing.config.channels?.telegram ?? {}),
    enabled: options.input.enabled ?? true,
    botTokenEnv: envName
  };

  if (options.input.defaultChatId !== undefined) {
    telegramPatch.defaultChatId = options.input.defaultChatId;
  }
  if (options.input.allowedUserIds !== undefined) {
    telegramPatch.allowedUserIds = options.input.allowedUserIds;
  }
  if (options.input.allowedChatIds !== undefined) {
    telegramPatch.allowedChatIds = options.input.allowedChatIds;
  }
  if (options.input.pollTimeoutSeconds !== undefined) {
    telegramPatch.pollTimeoutSeconds = options.input.pollTimeoutSeconds;
  }

  const config = mergeConfig(existing.config, {
    channels: {
      telegram: telegramPatch
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    secretPath
  };
}

export async function createTelegramPairingCode(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input?: TelegramPairingInput;
  now?: () => Date;
  code?: () => string;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  code: string;
  expiresAt: string;
}> {
  const input = options.input ?? {};
  if (input.scope === "project") {
    throw new Error("Telegram pairing codes are user-scoped for MVP.");
  }
  const targetPath = options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 10;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const code = input.code ?? options.code?.() ?? randomPairingCode();
  const config = mergeConfig(existing.config, {
    channels: {
      telegram: {
        ...(existing.config.channels?.telegram ?? {}),
        pairing: {
          code,
          createdAt: now.toISOString(),
          expiresAt
        }
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    code,
    expiresAt
  };
}

export async function consumeTelegramPairingCode(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  code: string;
  userId: string;
  chatId: string;
  now?: () => Date;
}): Promise<{
  paired: boolean;
  reason?: "missing" | "expired" | "mismatch";
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const pairing = existing.config.channels?.telegram?.pairing;
  const now = options.now?.() ?? new Date();

  if (pairing?.code === undefined) {
    return {
      paired: false,
      reason: "missing",
      path: targetPath,
      config: existing.config
    };
  }

  if (pairing.expiresAt !== undefined && new Date(pairing.expiresAt).getTime() < now.getTime()) {
    return {
      paired: false,
      reason: "expired",
      path: targetPath,
      config: existing.config
    };
  }

  if (normalizePairingCode(pairing.code) !== normalizePairingCode(options.code)) {
    return {
      paired: false,
      reason: "mismatch",
      path: targetPath,
      config: existing.config
    };
  }

  const telegram = existing.config.channels?.telegram ?? {};
  const config = mergeConfig(existing.config, {
    channels: {
      telegram: {
        ...telegram,
        allowedUserIds: uniqueStrings([...(telegram.allowedUserIds ?? []), options.userId]),
        allowedChatIds: uniqueStrings([...(telegram.allowedChatIds ?? []), options.chatId]),
        pairing: {}
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    paired: true,
    path: targetPath,
    config
  };
}

async function readConfig(path: string): Promise<{ path: string; loaded: boolean; config: EstaCodaConfig }> {
  try {
    return {
      path,
      loaded: true,
      config: JSON.parse(await readFile(path, "utf8")) as EstaCodaConfig
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        path,
        loaded: false,
        config: {}
      };
    }

    throw error;
  }
}

function validateProviderSetupInput(input: ProviderSetupInput): void {
  requireNonEmpty(input.provider, "provider");
  requireNonEmpty(input.model, "model");
  validateScope(input.scope);
  validateOptionalUrl(input.baseUrl, "baseUrl");
  validateOptionalEnvName(input.apiKeyEnv, "apiKeyEnv");
  if (input.credentialPoolStrategy !== undefined && input.credentialPoolStrategy !== "fill_first" && input.credentialPoolStrategy !== "round_robin") {
    throw new Error("Expected credentialPoolStrategy fill_first or round_robin");
  }
}

function validateWebSetupInput(input: WebSetupInput): void {
  validateScope(input.scope);
  if (input.maxContentChars !== undefined && (!Number.isInteger(input.maxContentChars) || input.maxContentChars <= 0)) {
    throw new Error("Expected maxContentChars to be a positive integer");
  }
}

function validateBrowserSetupInput(input: BrowserSetupInput): void {
  validateScope(input.scope);
  if (input.backend !== undefined && !isBrowserBackend(input.backend)) {
    throw new Error("Expected browser backend local-cdp, browserbase, firecrawl, camofox, mock, or unconfigured");
  }
  validateOptionalUrl(input.cdpUrl, "cdpUrl");
}

function validateVoiceSetupInput(input: VoiceSetupInput): void {
  validateScope(input.scope);
  if (input.ttsProvider !== undefined && !isTtsProvider(input.ttsProvider)) {
    throw new Error("Expected a supported TTS provider");
  }
  if (input.sttProvider !== undefined && !isSttProvider(input.sttProvider)) {
    throw new Error("Expected a supported STT provider");
  }
  if (input.ttsSpeed !== undefined && (!Number.isFinite(input.ttsSpeed) || input.ttsSpeed <= 0)) {
    throw new Error("Expected ttsSpeed to be a positive number");
  }
  validateOptionalEnvName(input.ttsApiKeyEnv, "ttsApiKeyEnv");
  validateOptionalEnvName(input.sttApiKeyEnv, "sttApiKeyEnv");
}

function validateImageGenerationSetupInput(input: ImageGenerationSetupInput): void {
  validateScope(input.scope);
  if (input.provider !== undefined && input.provider !== "fal" && input.provider !== "byteplus") {
    throw new Error("Expected image provider fal or byteplus");
  }
  if (input.model !== undefined) {
    requireNonEmpty(input.model, "model");
  }
  if (input.modelVersion !== undefined) {
    requireNonEmpty(input.modelVersion, "modelVersion");
  }
  validateOptionalEnvName(input.apiKeyEnv, "apiKeyEnv");
  validateOptionalUrl(input.baseUrl, "baseUrl");
}

function validateMcpSetupInput(input: MCPSetupInput): void {
  requireNonEmpty(input.name, "name");
  validateScope(input.scope);
  if (input.transport !== undefined && input.transport !== "stdio" && input.transport !== "http") {
    throw new Error("Expected MCP transport stdio or http");
  }
  if (input.trust !== undefined && input.trust !== "conservative" && input.trust !== "read-only-network" && input.trust !== "read-only-local") {
    throw new Error("Expected MCP trust conservative, read-only-network, or read-only-local");
  }
  validateOptionalUrl(input.url, "url");
  validateRiskClass(input.toolRiskClass, "toolRiskClass");
  validateRiskClass(input.resourceReadRiskClass, "resourceReadRiskClass");
  validateRiskClass(input.promptGetRiskClass, "promptGetRiskClass");
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error("Expected timeoutMs to be a positive integer");
  }
  if (input.connectTimeoutMs !== undefined && (!Number.isInteger(input.connectTimeoutMs) || input.connectTimeoutMs <= 0)) {
    throw new Error("Expected connectTimeoutMs to be a positive integer");
  }
}

function validateSecuritySetupInput(input: SecuritySetupInput): void {
  validateScope(input.scope);
  if (input.mode !== undefined) {
    normalizeSecurityApprovalMode(input.mode);
  }
  requireOptionalNonEmpty(input.assessorProvider, "assessorProvider");
  requireOptionalNonEmpty(input.assessorModel, "assessorModel");
  if (input.assessorTimeoutMs !== undefined && (!Number.isInteger(input.assessorTimeoutMs) || input.assessorTimeoutMs <= 0)) {
    throw new Error("Expected assessorTimeoutMs to be a positive integer");
  }
}

function validateSkillSetupInput(input: SkillSetupInput): void {
  validateScope(input.scope);
  if (input.autonomy !== undefined && input.autonomy !== "none" && input.autonomy !== "suggest" && input.autonomy !== "proactive" && input.autonomy !== "autonomous") {
    throw new Error("Expected skill autonomy none, suggest, proactive, or autonomous");
  }
}

function validateUiSetupInput(input: UiSetupInput): void {
  validateScope(input.scope);
  if (input.language !== undefined && input.language !== "en" && input.language !== "ar") {
    throw new Error("Expected UI language en or ar");
  }
  if (input.flavor !== undefined && input.flavor !== "standard" && input.flavor !== "arabic-light" && input.flavor !== "kemet-full") {
    throw new Error("Expected UI flavor standard, arabic-light, or kemet-full");
  }
  if (input.activityLabels !== undefined && input.activityLabels !== "en" && input.activityLabels !== "ar") {
    throw new Error("Expected activityLabels en or ar");
  }
}

function validateProfileSetupInput(input: ProfileSetupInput): void {
  validateScope(input.scope);
  if (input.mode !== undefined && input.mode !== "focused" && input.mode !== "operator" && input.mode !== "builder" && input.mode !== "research") {
    throw new Error("Expected profile mode focused, operator, builder, or research");
  }
  if (input.responseLanguage !== undefined && input.responseLanguage !== "en" && input.responseLanguage !== "ar" && input.responseLanguage !== "match-user") {
    throw new Error("Expected responseLanguage en, ar, or match-user");
  }
}

function validateTelegramSetupInput(input: TelegramSetupInput): void {
  validateScope(input.scope);
  validateOptionalEnvName(input.botTokenEnv, "botTokenEnv");
  if (input.pollTimeoutSeconds !== undefined && (!Number.isInteger(input.pollTimeoutSeconds) || input.pollTimeoutSeconds <= 0)) {
    throw new Error("Expected pollTimeoutSeconds to be a positive integer");
  }
}

function validateScope(scope: "user" | "project" | undefined): void {
  if (scope !== undefined && scope !== "user" && scope !== "project") {
    throw new Error("Expected scope user or project");
  }
}

function validateRiskClass(value: ToolRiskClass | undefined, field: string): void {
  if (value !== undefined && !isToolRiskClass(value)) {
    throw new Error(`Expected ${field} to be a supported tool risk class`);
  }
}

function validateOptionalUrl(value: string | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  requireNonEmpty(value, field);
  try {
    new URL(value);
  } catch {
    throw new Error(`Expected ${field} to be a valid URL`);
  }
}

function validateOptionalEnvName(value: string | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  requireNonEmpty(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.trim())) {
    throw new Error(`Expected ${field} to be a valid environment variable name`);
  }
}

function requireOptionalNonEmpty(value: string | undefined, field: string): void {
  if (value !== undefined) {
    requireNonEmpty(value, field);
  }
}

function requireNonEmpty(value: string | undefined, field: string): void {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Expected ${field} to be non-empty`);
  }
}

function isBrowserBackend(value: string): value is BrowserBackendKind {
  return value === "local-cdp" ||
    value === "browserbase" ||
    value === "firecrawl" ||
    value === "camofox" ||
    value === "mock" ||
    value === "unconfigured";
}

function ttsDefaultApiKeyEnv(provider: TtsProvider): string | undefined {
  switch (provider) {
    case "edge":
    case "neutts":
    case "kittentts":
      return undefined;
    case "elevenlabs":
      return "ELEVENLABS_API_KEY";
    case "openai":
      return "VOICE_TOOLS_OPENAI_KEY";
    case "minimax":
      return "MINIMAX_API_KEY";
    case "mistral":
      return "MISTRAL_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "xai":
      return "XAI_API_KEY";
  }
}

function ttsProviderApiKeyEnv(config: LoadedRuntimeConfig["tts"], provider: TtsProvider): string | undefined {
  switch (provider) {
    case "edge":
    case "neutts":
    case "kittentts":
      return undefined;
    case "elevenlabs":
      return config.elevenlabs?.apiKeyEnv ?? config.elevenlabs?.api_key_env;
    case "openai":
      return config.openai?.apiKeyEnv ?? config.openai?.api_key_env;
    case "minimax":
      return config.minimax?.apiKeyEnv ?? config.minimax?.api_key_env;
    case "mistral":
      return config.mistral?.apiKeyEnv ?? config.mistral?.api_key_env;
    case "gemini":
      return config.gemini?.apiKeyEnv ?? config.gemini?.api_key_env;
    case "xai":
      return config.xai?.apiKeyEnv ?? config.xai?.api_key_env;
  }
}

function sttDefaultApiKeyEnv(provider: SttProvider): string | undefined {
  switch (provider) {
    case "local":
      return undefined;
    case "groq":
      return "GROQ_API_KEY";
    case "openai":
      return "VOICE_TOOLS_OPENAI_KEY";
    case "mistral":
      return "MISTRAL_API_KEY";
  }
}

function sttProviderApiKeyEnv(config: LoadedRuntimeConfig["stt"], provider: SttProvider): string | undefined {
  switch (provider) {
    case "local":
      return undefined;
    case "groq":
      return config.groq?.apiKeyEnv ?? config.groq?.api_key_env;
    case "openai":
      return config.openai?.apiKeyEnv ?? config.openai?.api_key_env;
    case "mistral":
      return config.mistral?.apiKeyEnv ?? config.mistral?.api_key_env;
  }
}

function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "kimi":
      return "https://api.moonshot.ai/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "local":
      return "http://localhost:11434/v1";
    default:
      return "https://example.invalid/v1";
  }
}

export function defaultEnvKey(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "kimi":
      return "KIMI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return "OPENAI_COMPATIBLE_API_KEY";
  }
}

function expandConfiguredPaths(paths: string[], homeDir?: string): string[] {
  return [...new Set(
    paths
      .map((path) => expandConfiguredPath(path, homeDir))
      .filter((path) => path.length > 0)
  )];
}

function expandConfiguredPath(path: string, homeDir?: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const envExpanded = trimmed.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => process.env[name] ?? match);

  if (envExpanded === "~") {
    return homeDir ?? process.env.HOME ?? envExpanded;
  }

  if (envExpanded.startsWith("~/")) {
    const base = homeDir ?? process.env.HOME;
    return base === undefined ? envExpanded : join(base, envExpanded.slice(2));
  }

  return envExpanded;
}

function randomPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function normalizePairingCode(code: string): string {
  return code.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
