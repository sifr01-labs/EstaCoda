import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { BrowserBackendKind, BrowserCloudProviderKind } from "../contracts/browser.js";
import type {
  AuxiliaryModelConfig,
  AuxiliaryModelSlotConfig,
  AuxiliaryModelSlotInput,
  AuxiliaryModelTask,
  ModelProfile,
  ProviderEndpoint,
  ProviderApiMode,
  ProviderAuthMethod,
  ProviderId,
  ResolvedModelRoute
} from "../contracts/provider.js";
import { loadDotEnvSecrets, writeEnvSecret } from "./env-secret-store.js";
import {
  enrichModelProfiles,
  inferModelProfile,
  resolveModelProfileFromCatalog,
  resolveModelProfilesFromCatalog
} from "../providers/model-catalog.js";
import { createCatalogProvider } from "../providers/catalog-provider.js";
import { createOpenAICompatibleProvider, type FetchLike as ProviderFetchLike } from "../providers/openai-compatible-provider.js";
import { createOpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import {
  getDefaultApiKeyEnv,
  getProviderMetadata,
  buildResolvedModelRoute
} from "../providers/provider-metadata.js";
import type { MCPServerTransport } from "../mcp/mcp-client.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { normalizeSecurityApprovalMode } from "../security/security-policy-factory.js";
import type { SecurityApprovalMode, SecurityAssessorConfig } from "../contracts/security.js";
import {
  defaultImageApiKeyEnv,
  defaultImageBaseUrl,
  defaultImageModel,
  resolveImageModel
} from "../contracts/image-generation.js";
import type { ModelsDevRegistryOptions } from "../model-catalog/models-dev-registry.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "./profile-home.js";
import { resolveOsHomeDir } from "./home-dir.js";
import { coerceFiniteNumber, coerceNonNegativeInteger, coercePositiveInteger } from "./numeric-coercion.js";
import { redactObject } from "../utils/redaction.js";
import type { WebsitePolicyConfig } from "../browser/website-policy.js";
import { normalizeMemoryConfig, type MemoryConfig, type MemoryConfigInput } from "./memory-config.js";
import type { DelegationConfig } from "../contracts/delegation.js";
import { DEFAULT_DELEGATION_CONFIG } from "./delegation-defaults.js";
import {
  WHATSAPP_DEFAULT_REPLY_PREFIX,
  normalizeWhatsAppAllowlist,
  normalizeWhatsAppGroupAllowlist,
  normalizeWhatsAppUserId,
} from "../channels/whatsapp-identity.js";

export type MCPServerTrust = "conservative" | "read-only-network" | "read-only-local";
export type UiLanguage = "en" | "ar";
export type UiFlavor = "standard" | "arabic-light" | "kemet-full";
export type ActivityLabelsLocale = "en" | "ar";
export type AgentProfileMode = "focused" | "operator" | "builder" | "research";
export type AgentResponseLanguage = "en" | "ar" | "match-user";
export type ChannelBusyPolicy = "reject" | "queue" | "interrupt";
export type WhatsAppChannelMode = "bot" | "self-chat";
export type WhatsAppDmPolicy = "disabled" | "allowlist" | "pairing" | "open";
export type WhatsAppGroupPolicy = "disabled" | "allowlist" | "open";
export type TtsProvider = "edge" | "elevenlabs" | "openai" | "minimax" | "mistral" | "gemini" | "xai" | "neutts" | "kittentts";
export type SttProvider = "local" | "groq" | "openai" | "mistral" | "xai";
export type ImageGenerationProvider = "fal" | "byteplus";
export type BrowserEngineKind = "cdp" | "agent-browser" | "auto";
export type BrowserCloudSpendApproval = "pending" | boolean;
export type BrowserSnapshotSummarizeMode = "auto" | boolean;

export type SessionCompressionConfig = {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  protectFirstN: number;
  protectLastN: number;
  summaryModelContextLength?: number;
  experimental?: boolean;
};

export type ExternalMemoryConfig = {
  enabled: boolean;
  provider?: string;
  timeoutMs: number;
  maxResults: number;
  maxChars: number;
  mirrorWrites: boolean;
  credentials?: Record<string, unknown>;
  file?: {
    path?: string;
    maxEntries: number;
  };
};

export type DelegationConfigInput = Partial<Omit<DelegationConfig, "diagnostics" | "childRuntime">> & {
  diagnostics?: Partial<DelegationConfig["diagnostics"]>;
  childRuntime?: Partial<DelegationConfig["childRuntime"]>;
};

export function shouldPersistProviderBaseUrl(
  provider: ProviderId,
  baseUrl: string | undefined
): boolean {
  if (baseUrl === undefined) return false;
  const metadata = getProviderMetadata(provider);
  return baseUrl !== metadata.defaultBaseUrl;
}

export type TtsConfig = {
  provider?: TtsProvider;
  enabled?: boolean;
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
    speed?: number;
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

export type FasterWhisperConfig = {
  enabled?: boolean;
  model?: string;
  device?: string;
  computeType?: string;
  compute_type?: string;
  hfHome?: string;
  hf_home?: string;
  allowModelDownload?: boolean;
  allow_model_download?: boolean;
  gatewayAllowModelDownload?: boolean;
  gateway_allow_model_download?: boolean;
  queueDepth?: number;
  queue_depth?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  modelCached?: boolean;
  model_cached?: boolean;
};

export type SttConfig = {
  provider?: SttProvider;
  enabled?: boolean;
  local?: {
    model?: string;
    command?: string;
    engine?: "command" | "faster-whisper";
    pythonBinary?: string;
    python_binary?: string;
    normalizeWithFfmpeg?: boolean;
    normalize_with_ffmpeg?: boolean;
    ffmpegPath?: string;
    ffmpeg_path?: string;
    fasterWhisper?: FasterWhisperConfig;
    faster_whisper?: FasterWhisperConfig;
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
  xai?: {
    baseUrl?: string;
    base_url?: string;
    apiKeyEnv?: string;
    api_key_env?: string;
    language?: string;
    format?: string;
    diarize?: boolean;
    diarization?: boolean;
    keyterms?: string[];
    key_terms?: string[];
    fillerWords?: boolean;
    filler_words?: boolean;
    rawAudioHints?: boolean;
    raw_audio_hints?: boolean;
  };
};

export type VoiceConfig = {
  autoTts?: boolean;
  autoTtsMaxCharsPerReply?: number;
  autoTtsMaxCharsPerHourPerChat?: number;
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

export type ModelFallbackConfig = {
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
  timeoutMs?: number;
  staleTimeoutMs?: number;
};

export type ModelAliasDefinition = {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiMode?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
};

export type EstaCodaConfig = {
  model?: {
    provider?: ProviderId;
    id?: string;
    contextWindowTokens?: number;
    maxTokens?: number;
    timeoutMs?: number;
    staleTimeoutMs?: number;
    fallbacks?: ModelFallbackConfig[];
  };
  modelAliases?: Record<string, ModelAliasDefinition>;
  model_aliases?: Record<string, ModelAliasDefinition>;
  providers?: Record<string, {
    kind?: "openai-compatible" | "catalog";
    baseUrl?: string;
    apiKeyEnv?: string;
    apiMode?: ProviderApiMode;
    authMethod?: ProviderAuthMethod;
    models?: string[];
    enableNetwork?: boolean;
    timeoutMs?: number;
    staleTimeoutMs?: number;
    headers?: Record<string, string>;
  }>;
  auxiliaryModels?: AuxiliaryModelConfig;
  web?: {
    enableNetwork?: boolean;
    maxContentChars?: number;
    backend?: string;
    searchBackend?: string;
    extractBackend?: string;
    crawlBackend?: string;
  };
  memory?: MemoryConfigInput;
  compression?: Partial<SessionCompressionConfig>;
  externalMemory?: Partial<ExternalMemoryConfig>;
  external_memory?: Partial<ExternalMemoryConfig>;
  delegation?: DelegationConfigInput;
  browser?: {
    backend?: BrowserBackendKind;
    cloudProvider?: BrowserCloudProviderKind;
    cdpUrl?: string;
    /** @deprecated Use launchExecutable and launchArgs. This value is preserved as raw data and is never shell-parsed. */
    launchCommand?: string;
    launchExecutable?: string;
    launchArgs?: string[];
    autoLaunch?: boolean;
    supervised?: boolean;
    chromeFlags?: string[];
    engine?: BrowserEngineKind;
    commandTimeout?: number;
    inactivityTimeout?: number;
    recordSessions?: boolean;
    hybridRouting?: boolean;
    cloudFallback?: boolean;
    cloudSpendApproved?: BrowserCloudSpendApproval;
    summarizeSnapshots?: BrowserSnapshotSummarizeMode;
    snapshotSummarizeThreshold?: number;
    allowPrivateUrls?: boolean | string;
  };
  imageGen?: ImageGenerationConfig;
  image_gen?: ImageGenerationConfig;
  tts?: TtsConfig;
  stt?: SttConfig;
  voice?: VoiceConfig;
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
    showResponseProgress?: boolean;
  };
  profile?: {
    mode?: AgentProfileMode;
    responseLanguage?: AgentResponseLanguage;
  };
  security?: {
    approvalMode?: SecurityApprovalMode | "manual" | "smart" | "off";
    allowPrivateUrls?: boolean | string;
    websiteBlocklist?: WebsitePolicyConfig;
    assessor?: SecurityAssessorConfig;
    approvals?: {
      mode?: SecurityApprovalMode | "manual" | "smart" | "off";
    };
  };
  channels?: {
    telegram?: TelegramChannelConfig;
    discord?: DiscordChannelConfig;
    email?: EmailChannelConfig;
    whatsapp?: WhatsAppChannelConfig;
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
  busyPolicy?: ChannelBusyPolicy;
  queueDepth?: number;
  pairing?: {
    code?: string;
    createdAt?: string;
    expiresAt?: string;
  };
};

export type DiscordChannelConfig = {
  enabled?: boolean;
  botTokenEnv?: string;
  allowedUsers?: string[];
  allowedGuilds?: string[];
  allowedChannels?: string[];
  freeResponseChannels?: string[];
  voiceChannel?: {
    enabled?: boolean;
    autoJoinOnCommand?: boolean;
  };
  busyPolicy?: ChannelBusyPolicy;
  queueDepth?: number;
};

export type EmailChannelConfig = {
  enabled?: boolean;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  username?: string;
  passwordEnv?: string;
  ownAddress?: string;
  homeAddress?: string;
  allowedSenders?: string[];
  allowAllUsers?: boolean;
  pollIntervalSeconds?: number;
  maxAttachmentBytes?: number;
  busyPolicy?: ChannelBusyPolicy;
  queueDepth?: number;
};

export type WhatsAppChannelConfig = {
  enabled?: boolean;
  experimental?: boolean;
  authDir?: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
  mode?: WhatsAppChannelMode;
  dmPolicy?: WhatsAppDmPolicy;
  groupPolicy?: WhatsAppGroupPolicy;
  requireMention?: boolean;
  mentionPatterns?: string[];
  freeResponseChats?: string[];
  replyPrefix?: string;
  pairingMode?: "qr";
  busyPolicy?: ChannelBusyPolicy;
  queueDepth?: number;
};

export type LoadedRuntimeConfig = {
  config: EstaCodaConfig;
  sources: string[];
  model: ModelProfile;
  primaryModelRoute: ResolvedModelRoute;
  modelFallbackRoutes: ResolvedModelRoute[];
  providerRegistry: ProviderRegistry;
  auxiliaryModels: AuxiliaryModelConfig;
  web: {
    enableNetwork: boolean;
    maxContentChars?: number;
    backend?: string;
    searchBackend?: string;
    extractBackend?: string;
    crawlBackend?: string;
  };
  compression: SessionCompressionConfig;
  memory: MemoryConfig;
  externalMemory: ExternalMemoryConfig;
  delegation: DelegationConfig;
  browser: {
    backend: BrowserBackendKind;
    cloudProvider?: BrowserCloudProviderKind;
    cdpUrl?: string;
    /** @deprecated Use launchExecutable and launchArgs. This value is preserved as raw data and is never shell-parsed. */
    launchCommand?: string;
    launchExecutable?: string;
    launchArgs?: string[];
    autoLaunch: boolean;
    supervised: boolean;
    chromeFlags?: string[];
    engine?: BrowserEngineKind;
    commandTimeout?: number;
    inactivityTimeout?: number;
    recordSessions?: boolean;
    hybridRouting?: boolean;
    cloudFallback?: boolean;
    cloudSpendApproved?: BrowserCloudSpendApproval;
    summarizeSnapshots?: BrowserSnapshotSummarizeMode;
    snapshotSummarizeThreshold?: number;
  };
  imageGen: Required<Pick<ImageGenerationConfig, "provider" | "model" | "useGateway">> & ImageGenerationConfig;
  tts: Required<Pick<TtsConfig, "provider" | "speed">> & TtsConfig;
  stt: Required<Pick<SttConfig, "provider">> & SttConfig;
  voice: Required<Pick<VoiceConfig, "autoTts">> & VoiceConfig;
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
    showResponseProgress: boolean;
  };
  profile: {
    mode: AgentProfileMode;
    responseLanguage: AgentResponseLanguage;
  };
  security: {
    approvalMode: SecurityApprovalMode;
    allowPrivateUrls: boolean;
    websiteBlocklist: WebsitePolicyConfig;
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
    discord: DiscordChannelConfig & {
      ready: boolean;
      missing?: string[];
    };
    email: EmailChannelConfig & {
      ready: boolean;
      missing?: string[];
    };
    whatsapp: WhatsAppChannelConfig & {
      ready: boolean;
      missing?: string[];
    };
  };
};

export type ProviderSetupInput = {
  provider: ProviderId;
  model: string;
  models?: string[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  enableNetwork?: boolean;
  primary?: boolean;
  contextWindowTokens?: number;
  requiresCredential?: boolean;
};

export type WebSetupInput = {
  enableNetwork?: boolean;
  maxContentChars?: number;
};

export type BrowserSetupInput = {
  backend?: BrowserBackendKind;
  cloudProvider?: BrowserCloudProviderKind;
  cdpUrl?: string;
  /** @deprecated Use launchExecutable and launchArgs. This value is preserved as raw data and is never shell-parsed. */
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  autoLaunch?: boolean;
  supervised?: boolean;
  chromeFlags?: string[];
  engine?: BrowserEngineKind;
  commandTimeout?: number;
  inactivityTimeout?: number;
  recordSessions?: boolean;
  hybridRouting?: boolean;
  cloudFallback?: boolean;
  cloudSpendApproved?: BrowserCloudSpendApproval;
  summarizeSnapshots?: BrowserSnapshotSummarizeMode;
  snapshotSummarizeThreshold?: number;
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
  pythonBinary?: string;
};

export type ImageGenerationSetupInput = {
  provider?: ImageGenerationProvider;
  model?: string;
  modelVersion?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
  useGateway?: boolean;
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
};

export type TelegramSetupInput = {
  botTokenEnv?: string;
  botToken?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  pollTimeoutSeconds?: number;
  enabled?: boolean;
};

export type DiscordSetupInput = {
  botTokenEnv?: string;
  botToken?: string;
  allowedUsers?: string[];
  allowedGuilds?: string[];
  allowedChannels?: string[];
  enabled?: boolean;
};

export type WhatsAppSetupInput = {
  experimental?: boolean;
  authDir?: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
  mode?: WhatsAppChannelMode;
  dmPolicy?: WhatsAppDmPolicy;
  groupPolicy?: WhatsAppGroupPolicy;
  requireMention?: boolean;
  mentionPatterns?: string[];
  freeResponseChats?: string[];
  replyPrefix?: string;
  pairingMode?: "qr";
  enabled?: boolean;
};

export type TelegramPairingInput = {
  code?: string;
  ttlMinutes?: number;
};

export type SecuritySetupInput = {
  mode?: SecurityApprovalMode | "manual" | "smart" | "off";
  assessorEnabled?: boolean;
  assessorProvider?: ProviderId;
  assessorModel?: string;
  assessorTimeoutMs?: number;
};

export type ModelFallbackSetupInput = {
  fallbacks: ModelFallbackConfig[];
};

export type AuxiliaryModelRouteSetupInput = {
  task: AuxiliaryModelTask;
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
};

export type SkillSetupInput = {
  autonomy?: SkillAutonomy;
};

export type UiSetupInput = {
  language?: UiLanguage;
  flavor?: UiFlavor;
  activityLabels?: ActivityLabelsLocale;
};

export type ProfileSetupInput = {
  mode?: AgentProfileMode;
  responseLanguage?: AgentResponseLanguage;
};

export type LoadRuntimeConfigOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  providerFetch?: ProviderFetchLike;
  modelsDevOptions?: ModelsDevRegistryOptions;
};

export async function loadRuntimeConfig(options: LoadRuntimeConfigOptions): Promise<LoadedRuntimeConfig> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir })?.profileId ?? defaultProfileId();
  await loadDotEnvSecrets({ homeDir: options.homeDir, profileId });
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const loadedConfig = await readConfig(profilePaths.configPath);
  const config = patchConfig(loadedConfig.config);
  const catalogProfiles = await resolveModelProfilesFromCatalog({
    homeDir: options.homeDir,
    allowNetwork: false,
    ...options.modelsDevOptions
  });
  const model = await resolveModelProfileFromCatalog({
    provider: config.model?.provider ?? "unconfigured",
    model: config.model?.id ?? "unconfigured",
    contextWindowTokens: config.model?.contextWindowTokens,
    homeDir: options.homeDir,
    allowNetwork: false,
    ...options.modelsDevOptions
  });
  const providerRegistry = buildProviderRegistry(config, {
    fetch: options.providerFetch,
    catalogProfiles
  });
  const telegram = config.channels?.telegram ?? {};
  const telegramMissing = telegram.enabled === true && telegram.botTokenEnv !== undefined && process.env[telegram.botTokenEnv] === undefined
    ? [telegram.botTokenEnv]
    : [];
  const discord = config.channels?.discord ?? {};
  const discordMissing: string[] = [];
  if (discord.enabled === true) {
    if (discord.botTokenEnv === undefined) discordMissing.push("botTokenEnv");
    if ((discord.allowedUsers?.length ?? 0) === 0 && (discord.allowedChannels?.length ?? 0) === 0) {
      discordMissing.push("allowedUsersOrChannels");
    }
  }

  const email = config.channels?.email ?? {};
  const emailMissing: string[] = [];
  if (email.enabled === true) {
    if (email.imapHost === undefined) emailMissing.push("imapHost");
    if (email.smtpHost === undefined) emailMissing.push("smtpHost");
    if (email.username === undefined) emailMissing.push("username");
    if (email.passwordEnv === undefined) emailMissing.push("passwordEnv");
    if (email.ownAddress === undefined) emailMissing.push("ownAddress");
  }

  const whatsapp = config.channels?.whatsapp ?? {};
  const whatsappDmPolicy = whatsapp.dmPolicy ?? "allowlist";
  const whatsappGroupPolicy = whatsapp.groupPolicy ?? "disabled";
  const defaultWhatsAppAuthDir = join(profilePaths.gatewayStatePath, "whatsapp-auth");
  const whatsappAuthDirProfileLocal = whatsapp.authDir === undefined
    ? false
    : resolve(whatsapp.authDir) === resolve(defaultWhatsAppAuthDir);
  const whatsappMissing: string[] = [];
  if (whatsapp.enabled === true) {
    if (whatsapp.experimental !== true) whatsappMissing.push("experimental");
    if (whatsapp.authDir === undefined) whatsappMissing.push("authDir");
    if (whatsapp.authDir !== undefined && !whatsappAuthDirProfileLocal) whatsappMissing.push("authDirProfileLocal");
    if (whatsappDmPolicy === "allowlist" && (whatsapp.allowedUsers?.length ?? 0) === 0) {
      whatsappMissing.push("allowedUsers");
    }
    if (whatsappDmPolicy === "pairing" && (whatsapp.allowedUsers?.length ?? 0) === 0) {
      whatsappMissing.push("pairingPending");
    }
    if (whatsappGroupPolicy === "allowlist" && (whatsapp.allowedGroups?.length ?? 0) === 0) {
      whatsappMissing.push("allowedGroups");
    }
  }
  const warnedInvalidBusyPolicies = new Set<string>();
  const normalizedFallbacks = normalizeModelFallbacks(config);
  if (normalizedFallbacks.warnings.length > 0) {
    for (const warning of normalizedFallbacks.warnings) {
      console.warn(`[config] ${warning}`);
    }
  }
  const providerTimeouts = normalizeProviderTimeouts(config.providers);
  const primaryProviderId = config.model?.provider ?? "unconfigured";
  const primaryProviderConfig = config.providers?.[primaryProviderId];
  const primaryProviderTimeouts = providerTimeouts[primaryProviderId];
  const primaryProviderMetadata = getProviderMetadata(primaryProviderId);
  const primaryMaxTokens = normalizeOptionalPositiveIntegerStrict(config.model?.maxTokens, "model.maxTokens");
  const primaryTimeoutMs = normalizeOptionalPositiveIntegerStrict(config.model?.timeoutMs, "model.timeoutMs");
  const primaryStaleTimeoutMs = normalizeOptionalPositiveIntegerStrict(config.model?.staleTimeoutMs, "model.staleTimeoutMs");
  const primaryModelRoute = buildResolvedModelRoute({
    provider: primaryProviderId,
    model: config.model?.id ?? "unconfigured",
    profile: model,
    baseUrl: primaryProviderConfig?.baseUrl ?? primaryProviderMetadata.defaultBaseUrl,
    apiKeyEnv: primaryProviderConfig?.apiKeyEnv,
    apiMode: primaryProviderConfig?.apiMode,
    contextWindowTokens: config.model?.contextWindowTokens,
    maxTokens: primaryMaxTokens,
    timeoutMs: primaryTimeoutMs ?? primaryProviderTimeouts?.timeoutMs,
    staleTimeoutMs: primaryStaleTimeoutMs ?? primaryProviderTimeouts?.staleTimeoutMs
  });

  const modelFallbackRoutes: ResolvedModelRoute[] = [];
  for (const fallback of normalizedFallbacks.fallbacks) {
    const fallbackProfile = await resolveModelProfileFromCatalog({
      provider: fallback.provider,
      model: fallback.id,
      contextWindowTokens: fallback.contextWindowTokens,
      homeDir: options.homeDir,
      allowNetwork: false,
      ...options.modelsDevOptions
    });
    const fallbackProviderConfig = config.providers?.[fallback.provider];
    const fallbackProviderTimeouts = providerTimeouts[fallback.provider];
    modelFallbackRoutes.push(buildResolvedModelRoute({
      provider: fallback.provider,
      model: fallback.id,
      profile: fallbackProfile,
      baseUrl: fallback.baseUrl ?? fallbackProviderConfig?.baseUrl,
      apiKeyEnv: fallback.apiKeyEnv ?? fallbackProviderConfig?.apiKeyEnv,
      apiMode: fallbackProviderConfig?.apiMode,
      contextWindowTokens: fallback.contextWindowTokens,
      maxTokens: fallback.maxTokens,
      timeoutMs: fallback.timeoutMs ?? fallbackProviderTimeouts?.timeoutMs,
      staleTimeoutMs: fallback.staleTimeoutMs ?? fallbackProviderTimeouts?.staleTimeoutMs
    }));
  }

  return {
    config,
    sources: loadedConfig.loaded ? [loadedConfig.path] : [],
    model,
    primaryModelRoute,
    modelFallbackRoutes,
    providerRegistry,
    auxiliaryModels: normalizeAuxiliaryModels(config.auxiliaryModels),
    web: {
      enableNetwork: config.web?.enableNetwork ?? false,
      maxContentChars: config.web?.maxContentChars,
      backend: config.web?.backend,
      searchBackend: config.web?.searchBackend,
      extractBackend: config.web?.extractBackend,
      crawlBackend: config.web?.crawlBackend
    },
    compression: normalizeSessionCompressionConfig(config.compression),
    memory: normalizeMemoryConfig(config.memory),
    externalMemory: normalizeExternalMemoryConfig(config.externalMemory ?? config.external_memory),
    delegation: normalizeDelegationConfig(config.delegation),
    browser: normalizeBrowserConfig(config.browser),
    imageGen: normalizeImageGenerationConfig(config.imageGen ?? config.image_gen),
    tts: normalizeTtsConfig(config.tts),
    stt: normalizeSttConfig(config.stt),
    voice: normalizeVoiceConfig(config.voice),
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
      allowPrivateUrls: normalizeAllowPrivateUrls(config),
      websiteBlocklist: config.security?.websiteBlocklist ?? {},
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
        missing: telegramMissing.length === 0 ? undefined : telegramMissing,
        busyPolicy: normalizeChannelBusyPolicy(telegram.busyPolicy, "telegram", warnedInvalidBusyPolicies),
        queueDepth: normalizeQueueDepth(telegram.queueDepth)
      },
      discord: {
        ...discord,
        voiceChannel: {
          enabled: discord.voiceChannel?.enabled === true,
          autoJoinOnCommand: discord.voiceChannel?.autoJoinOnCommand ?? true,
        },
        ready: discord.enabled === true && discordMissing.length === 0,
        missing: discordMissing.length === 0 ? undefined : discordMissing,
        busyPolicy: normalizeChannelBusyPolicy(discord.busyPolicy, "discord", warnedInvalidBusyPolicies),
        queueDepth: normalizeQueueDepth(discord.queueDepth)
      },
      email: {
        ...email,
        ready: email.enabled === true && emailMissing.length === 0,
        missing: emailMissing.length === 0 ? undefined : emailMissing,
        busyPolicy: normalizeChannelBusyPolicy(email.busyPolicy, "email", warnedInvalidBusyPolicies),
        queueDepth: normalizeQueueDepth(email.queueDepth)
      },
      whatsapp: {
        ...whatsapp,
        mode: whatsapp.mode ?? "bot",
        dmPolicy: whatsappDmPolicy,
        groupPolicy: whatsappGroupPolicy,
        allowedUsers: normalizeWhatsAppAllowlist(whatsapp.allowedUsers),
        allowedGroups: normalizeWhatsAppGroupAllowlist(whatsapp.allowedGroups),
        freeResponseChats: normalizeWhatsAppGroupAllowlist(whatsapp.freeResponseChats),
        replyPrefix: whatsapp.replyPrefix ?? WHATSAPP_DEFAULT_REPLY_PREFIX,
        ready: whatsapp.enabled === true && whatsappMissing.length === 0,
        missing: whatsappMissing.length === 0 ? undefined : whatsappMissing,
        busyPolicy: normalizeChannelBusyPolicy(whatsapp.busyPolicy, "whatsapp", warnedInvalidBusyPolicies),
        queueDepth: normalizeQueueDepth(whatsapp.queueDepth)
      }
    }
  };
}

function patchConfig(...configs: EstaCodaConfig[]): EstaCodaConfig {
  return compactConfig(configs.reduce<EstaCodaConfig>((merged, config) => ({
    model: {
      ...(merged.model ?? {}),
      ...(config.model ?? {})
    },
    providers: mergeRecordEntries(merged.providers, config.providers),
    modelAliases: mergeRecordEntries(
      mergeRecordEntries(merged.modelAliases, merged.model_aliases),
      mergeRecordEntries(config.modelAliases, config.model_aliases)
    ),
    auxiliaryModels: mergeAuxiliaryModels(merged.auxiliaryModels, config.auxiliaryModels),
    web: {
      ...(merged.web ?? {}),
      ...(config.web ?? {})
    },
    compression: {
      ...(merged.compression ?? {}),
      ...(config.compression ?? {})
    },
    memory: {
      ...(merged.memory ?? {}),
      ...(config.memory ?? {})
    },
    externalMemory: {
      ...(merged.externalMemory ?? merged.external_memory ?? {}),
      ...(config.externalMemory ?? config.external_memory ?? {})
    },
    delegation: {
      ...(merged.delegation ?? {}),
      ...(config.delegation ?? {})
    },
    browser: {
      ...(merged.browser ?? {}),
      ...(config.browser ?? {})
    },
    imageGen: mergeImageGenerationConfig(merged.imageGen ?? merged.image_gen, config.imageGen ?? config.image_gen),
    tts: mergeTtsConfig(merged.tts, config.tts),
    stt: mergeSttConfig(merged.stt, config.stt),
    voice: {
      ...(merged.voice ?? {}),
      ...(config.voice ?? {})
    },
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
      allowPrivateUrls: config.security?.allowPrivateUrls ?? merged.security?.allowPrivateUrls,
      websiteBlocklist: {
        ...(merged.security?.websiteBlocklist ?? {}),
        ...(config.security?.websiteBlocklist ?? {})
      },
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
      },
      discord: {
        ...(merged.channels?.discord ?? {}),
        ...(config.channels?.discord ?? {})
      },
      email: {
        ...(merged.channels?.email ?? {}),
        ...(config.channels?.email ?? {})
      },
      whatsapp: {
        ...(merged.channels?.whatsapp ?? {}),
        ...(config.channels?.whatsapp ?? {})
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
  const compacted = (compactValue(config) ?? {}) as EstaCodaConfig;
  if (compacted.modelAliases !== undefined) {
    compacted.modelAliases = normalizeModelAliases(compacted.modelAliases);
  }
  if (compacted.auxiliaryModels !== undefined) {
    const stripped = stripDefaultAuxiliarySlots(compacted.auxiliaryModels);
    if (Object.keys(stripped).length === 0) {
      delete (compacted as Record<string, unknown>).auxiliaryModels;
    } else {
      compacted.auxiliaryModels = stripped;
    }
  }
  /**
   * Legacy config cleanup for the old `auxiliaryProviders` key.
   *
   * This key is not a supported write target. Keep stripping it so stale configs
   * do not preserve deprecated auxiliary-provider shape.
   *
   * TODO(config-cleanup): remove only after the migration window is explicitly
   * closed and tests/docs no longer need compatibility coverage.
   */
  // Strip deprecated auxiliaryProviders so it is never serialized
  if ("auxiliaryProviders" in compacted) {
    delete (compacted as Record<string, unknown>).auxiliaryProviders;
  }
  return compacted;
}

function stripDefaultAuxiliarySlots(
  config: AuxiliaryModelConfig
): AuxiliaryModelConfig {
  const stripped: AuxiliaryModelConfig = {};
  for (const [task, slotInput] of Object.entries(config)) {
    const slot = normalizeAuxiliarySlotInput(slotInput as AuxiliaryModelSlotInput, `auxiliaryModels.${task}`);
    if (slot === undefined) continue;
    const isDefault =
      slot.provider === "auto" &&
      slot.enabled === true &&
      slot.id === undefined &&
      slot.baseUrl === undefined &&
      slot.apiKeyEnv === undefined &&
      slot.contextWindowTokens === undefined &&
      slot.timeoutMs === undefined &&
      slot.maxConcurrency === undefined &&
      slot.extraBody === undefined &&
      slot.fallbackToMain === undefined;
    if (!isDefault) {
      stripped[task as AuxiliaryModelTask | "default"] = slot;
    }
  }
  return stripped;
}

function mergeAuxiliaryModels(
  left: AuxiliaryModelConfig | undefined,
  right: AuxiliaryModelConfig | undefined
): AuxiliaryModelConfig | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  const merged: AuxiliaryModelConfig = { ...(left ?? {}) };
  for (const [task, slot] of Object.entries(right ?? {})) {
    const key = task as AuxiliaryModelTask | "default";
    const existing = merged[key];
    merged[key] = isPlainRecord(existing) && isPlainRecord(slot)
      ? { ...existing, ...slot }
      : slot;
  }
  return merged;
}

export const ALL_AUXILIARY_MODEL_TASKS: AuxiliaryModelTask[] = [
  "vision",
  "compression",
  "assessor",
  "web_extract",
  "session_search",
  "mcp",
  "memory_flush",
  "delegation",
  "skills_library",
  "title_generation",
  "curator",
  "memory_compaction",
  "profile_context"
];

export function normalizeAuxiliaryModels(
  value: AuxiliaryModelConfig | undefined
): AuxiliaryModelConfig {
  const normalized: AuxiliaryModelConfig = {};
  const defaultSlot = normalizeAuxiliarySlotInput(value?.default, "auxiliaryModels.default");
  if (value?.default !== undefined) {
    normalized.default = defaultSlot;
  }

  for (const key of Object.keys(value ?? {})) {
    if (key !== "default" && !(ALL_AUXILIARY_MODEL_TASKS as string[]).includes(key)) {
      throw new Error(`Unsupported auxiliary model task '${key}' in auxiliaryModels`);
    }
  }

  for (const task of ALL_AUXILIARY_MODEL_TASKS) {
    const taskSlot = normalizeAuxiliarySlotInput(value?.[task], `auxiliaryModels.${task}`);
    const slot = {
      ...(defaultSlot ?? {}),
      ...(taskSlot ?? {})
    };
    normalized[task] = {
      provider: slot?.provider ?? "auto",
      enabled: slot?.enabled ?? true,
      ...(slot?.id !== undefined ? { id: slot.id } : {}),
      ...(slot?.baseUrl !== undefined ? { baseUrl: slot.baseUrl } : {}),
      ...(slot?.apiKeyEnv !== undefined ? { apiKeyEnv: slot.apiKeyEnv } : {}),
      ...(slot?.contextWindowTokens !== undefined ? { contextWindowTokens: slot.contextWindowTokens } : {}),
      ...(slot?.timeoutMs !== undefined ? { timeoutMs: slot.timeoutMs } : {}),
      ...(slot?.maxConcurrency !== undefined ? { maxConcurrency: slot.maxConcurrency } : {}),
      ...(slot?.extraBody !== undefined ? { extraBody: slot.extraBody } : {}),
      ...(slot?.fallbackToMain !== undefined ? { fallbackToMain: slot.fallbackToMain } : {})
    };
  }
  return normalized;
}

function normalizeAuxiliarySlotInput(
  slot: AuxiliaryModelSlotInput | undefined,
  path: string
): AuxiliaryModelSlotConfig | undefined {
  if (slot === undefined) return undefined;
  if (typeof slot === "string") {
    return parseAuxiliaryModelShorthand(slot, path);
  }
  return slot;
}

function parseAuxiliaryModelShorthand(value: string, path: string): AuxiliaryModelSlotConfig {
  const slashIndex = value.indexOf("/");
  if (slashIndex < 0) {
    throw new Error(`${path} shorthand must be provider/model`);
  }
  const provider = value.slice(0, slashIndex);
  const id = value.slice(slashIndex + 1);
  if (provider.length === 0) {
    throw new Error(`${path} shorthand is missing provider before /`);
  }
  if (id.length === 0) {
    throw new Error(`${path} shorthand is missing model id after /`);
  }
  return { provider: provider as ProviderId, id };
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
  const showResponseProgress = value?.showResponseProgress === true;

  return {
    language,
    flavor,
    activityLabels,
    showResponseProgress
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

function normalizeBrowserConfig(value: EstaCodaConfig["browser"]): LoadedRuntimeConfig["browser"] {
  const backend = normalizeBrowserBackend(value?.backend);
  const cloudProvider = normalizeOptionalBrowserCloudProvider(value?.cloudProvider);
  const launchExecutable = normalizeOptionalNonEmptyString(value?.launchExecutable, "browser.launchExecutable");
  const launchCommand = normalizeDeprecatedLaunchCommand(value?.launchCommand);
  const launchArgs = normalizeBrowserStringArray(value?.launchArgs, "browser.launchArgs");
  const chromeFlags = normalizeBrowserStringArray(value?.chromeFlags, "browser.chromeFlags");
  const engine = normalizeBrowserEngine(value?.engine);
  const commandTimeout = normalizeBrowserPositiveInteger(value?.commandTimeout, "browser.commandTimeout");
  const inactivityTimeout = normalizeBrowserPositiveInteger(value?.inactivityTimeout, "browser.inactivityTimeout");
  const recordSessions = normalizeOptionalBoolean(value?.recordSessions, "browser.recordSessions");
  const hybridRouting = normalizeOptionalBoolean(value?.hybridRouting, "browser.hybridRouting") ?? (cloudProvider !== undefined);
  const cloudFallback = normalizeOptionalBoolean(value?.cloudFallback, "browser.cloudFallback") ?? true;
  const cloudSpendApproved = normalizeCloudSpendApproved(value?.cloudSpendApproved);
  const summarizeSnapshots = normalizeSnapshotSummarizeMode(value?.summarizeSnapshots);
  const snapshotSummarizeThreshold = normalizeSnapshotSummarizeThreshold(value?.snapshotSummarizeThreshold);

  return {
    backend,
    cloudProvider,
    cdpUrl: value?.cdpUrl,
    launchCommand,
    launchExecutable,
    launchArgs,
    autoLaunch: normalizeOptionalBoolean(value?.autoLaunch, "browser.autoLaunch") ?? false,
    supervised: normalizeOptionalBoolean(value?.supervised, "browser.supervised") ?? backend === "local-cdp",
    chromeFlags,
    engine,
    commandTimeout,
    inactivityTimeout,
    recordSessions,
    hybridRouting,
    cloudFallback,
    cloudSpendApproved,
    summarizeSnapshots,
    snapshotSummarizeThreshold
  };
}

function normalizeBrowserBackend(value: BrowserBackendKind | undefined): BrowserBackendKind {
  if (value === undefined) {
    return "unconfigured";
  }
  if (isBrowserBackend(value)) {
    return value;
  }
  throw new Error("browser.backend must be local-cdp, browserbase, firecrawl, camofox, mock, or unconfigured");
}

function normalizeOptionalBrowserCloudProvider(value: BrowserCloudProviderKind | undefined): BrowserCloudProviderKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("browser.cloudProvider must be a non-empty string");
  }
  return value;
}

function normalizeDeprecatedLaunchCommand(value: string | undefined): string | undefined {
  return normalizeOptionalNonEmptyString(value, "browser.launchCommand");
}

function normalizeBrowserStringArray(value: string[] | undefined, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${path}[${index}] must be a string`);
    }
    const normalized = entry.trim();
    if (normalized.length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty string`);
    }
    if (hasShellSyntax(normalized) || /\s/.test(normalized)) {
      throw new Error(`${path}[${index}] must not contain shell syntax or embedded whitespace; pass each argument as a separate array entry`);
    }
    return normalized;
  });
}

function normalizeBrowserEngine(value: BrowserEngineKind | undefined): BrowserEngineKind {
  if (value === undefined) {
    return "cdp";
  }
  if (value === "cdp" || value === "agent-browser" || value === "auto") {
    return value;
  }
  throw new Error("browser.engine must be cdp, agent-browser, or auto");
}

function normalizeOptionalBoolean(value: boolean | undefined, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean value`);
  }
  return value;
}

function normalizeCloudSpendApproved(value: BrowserCloudSpendApproval | undefined): BrowserCloudSpendApproval {
  if (value === undefined) {
    return "pending";
  }
  if (value === "pending" || typeof value === "boolean") {
    return value;
  }
  throw new Error("browser.cloudSpendApproved must be pending, true, or false");
}

function normalizeSnapshotSummarizeMode(value: BrowserSnapshotSummarizeMode | undefined): BrowserSnapshotSummarizeMode {
  if (value === undefined) {
    return "auto";
  }
  if (value === "auto" || typeof value === "boolean") {
    return value;
  }
  throw new Error("browser.summarizeSnapshots must be auto, true, or false");
}

function normalizeSnapshotSummarizeThreshold(value: number | undefined): number {
  if (value === undefined) {
    return 8_000;
  }
  return normalizeBrowserPositiveInteger(value, "browser.snapshotSummarizeThreshold") ?? 8_000;
}

function normalizeBrowserPositiveInteger(value: number | undefined, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function normalizeOptionalNonEmptyString(value: string | undefined, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function hasShellSyntax(value: string): boolean {
  return /[;&|<>`$\\\r\n]/.test(value);
}

function normalizeAllowPrivateUrls(config: EstaCodaConfig): boolean {
  const envValue = process.env.ESTACODA_ALLOW_PRIVATE_URLS;
  if (envValue !== undefined) {
    return parseBooleanFlag(envValue, "ESTACODA_ALLOW_PRIVATE_URLS");
  }

  if (config.security?.allowPrivateUrls !== undefined) {
    return parseBooleanFlag(config.security.allowPrivateUrls, "security.allowPrivateUrls");
  }

  if (config.browser?.allowPrivateUrls !== undefined) {
    return parseBooleanFlag(config.browser.allowPrivateUrls, "browser.allowPrivateUrls");
  }

  return false;
}

function parseBooleanFlag(value: boolean | string, path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${path} must be a boolean value: 1, true, yes, on, 0, false, no, or off`);
}

export function normalizeSessionCompressionConfig(
  value: Partial<SessionCompressionConfig> | undefined
): SessionCompressionConfig {
  const experimental = value?.experimental === true;
  const summaryModelContextLength = normalizeOptionalPositiveInteger(value?.summaryModelContextLength);
  return {
    enabled: value?.enabled === true && experimental,
    threshold: coerceFiniteNumber(value?.threshold, { default: 0.50, min: 0.10, max: 0.95 }),
    targetRatio: coerceFiniteNumber(value?.targetRatio, { default: 0.20, min: 0.10, max: 0.80 }),
    protectFirstN: coerceNonNegativeInteger(value?.protectFirstN, { default: 3 }),
    protectLastN: coercePositiveInteger(value?.protectLastN, { default: 20 }),
    ...(summaryModelContextLength === undefined ? {} : { summaryModelContextLength }),
    experimental
  };
}

const DELEGATION_RISK_CLASSES = new Set<ToolRiskClass>([
  "read-only-local",
  "read-only-network",
  "workspace-write",
  "external-side-effect",
  "credential-access",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);

export function normalizeDelegationConfig(
  value: DelegationConfigInput | undefined
): DelegationConfig {
  const defaults = DEFAULT_DELEGATION_CONFIG;
  const diagnostics = isPlainRecord(value?.diagnostics) ? value.diagnostics : {};
  const childRuntime = isPlainRecord(value?.childRuntime) ? value.childRuntime : {};

  return {
    maxSpawnDepth: coercePositiveInteger(value?.maxSpawnDepth, { default: defaults.maxSpawnDepth }),
    maxConcurrentChildren: coercePositiveInteger(value?.maxConcurrentChildren, { default: defaults.maxConcurrentChildren }),
    maxDelegateCallsPerTurn: coercePositiveInteger(value?.maxDelegateCallsPerTurn, { default: defaults.maxDelegateCallsPerTurn }),
    maxBatchTasks: coercePositiveInteger(value?.maxBatchTasks, { default: defaults.maxBatchTasks }),
    childTimeoutSeconds: coerceNonNegativeInteger(value?.childTimeoutSeconds, {
      default: defaults.childTimeoutSeconds,
      min: 30
    }),
    heartbeatSeconds: coerceNonNegativeInteger(value?.heartbeatSeconds, {
      default: defaults.heartbeatSeconds,
      min: 5
    }),
    heartbeatStaleCyclesIdle: coercePositiveInteger(value?.heartbeatStaleCyclesIdle, {
      default: defaults.heartbeatStaleCyclesIdle
    }),
    heartbeatStaleCyclesInTool: coercePositiveInteger(value?.heartbeatStaleCyclesInTool, {
      default: defaults.heartbeatStaleCyclesInTool
    }),
    recoverJsonStringTasks: value?.recoverJsonStringTasks !== false,
    diagnostics: {
      enabled: diagnostics.enabled === undefined ? defaults.diagnostics.enabled : diagnostics.enabled === true,
      includePromptPreview: diagnostics.includePromptPreview === true
    },
    defaultAllowedRiskClasses: normalizeRiskClassArray(
      value?.defaultAllowedRiskClasses,
      defaults.defaultAllowedRiskClasses
    ),
    defaultExcludedToolsets: normalizeToolsetArray(
      value?.defaultExcludedToolsets,
      defaults.defaultExcludedToolsets
    ),
    defaultAllowedToolsets: normalizeToolsetArray(
      value?.defaultAllowedToolsets,
      defaults.defaultAllowedToolsets
    ),
    blockedToolNames: normalizeStringArray(value?.blockedToolNames, defaults.blockedToolNames),
    blockedToolPrefixes: normalizeStringArray(value?.blockedToolPrefixes, defaults.blockedToolPrefixes),
    childRuntime: {
      memoryRecall: childRuntime.memoryRecall === "bounded" ? "bounded" : defaults.childRuntime.memoryRecall,
      skillLearning: defaults.childRuntime.skillLearning,
      sessionCompression: childRuntime.sessionCompression === "enabled" ? "enabled" : defaults.childRuntime.sessionCompression,
      projectContext: childRuntime.projectContext === "disabled" ? "disabled" : defaults.childRuntime.projectContext
    }
  };
}

function normalizeRiskClassArray(
  value: readonly unknown[] | undefined,
  fallback: readonly ToolRiskClass[]
): ToolRiskClass[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value.filter((item): item is ToolRiskClass =>
    typeof item === "string" && DELEGATION_RISK_CLASSES.has(item as ToolRiskClass)
  );
  return normalized.length === 0 ? [...fallback] : [...new Set(normalized)];
}

function normalizeToolsetArray(
  value: readonly unknown[] | undefined,
  fallback: readonly ToolsetName[]
): ToolsetName[] {
  return normalizeStringArray(value, fallback) as ToolsetName[];
}

function normalizeStringArray(
  value: readonly unknown[] | undefined,
  fallback: readonly string[]
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(normalized)];
}

export function normalizeExternalMemoryConfig(
  value: Partial<ExternalMemoryConfig> | undefined
): ExternalMemoryConfig {
  const provider = typeof value?.provider === "string" && value.provider.trim().length > 0
    ? value.provider.trim()
    : undefined;
  const credentials = value?.credentials !== undefined && isPlainRecord(value.credentials)
    ? value.credentials
    : undefined;
  const fileConfig = normalizeExternalMemoryFileConfig(value?.file);
  return {
    enabled: value?.enabled === true && provider !== undefined,
    ...(provider === undefined ? {} : { provider }),
    timeoutMs: coercePositiveInteger(value?.timeoutMs, { default: 750, max: 5_000 }),
    maxResults: coercePositiveInteger(value?.maxResults, { default: 3, max: 10 }),
    maxChars: coercePositiveInteger(value?.maxChars, { default: 2_500, max: 20_000 }),
    mirrorWrites: value?.mirrorWrites === true,
    ...(credentials === undefined ? {} : { credentials }),
    ...(provider === "file" || value?.file !== undefined ? { file: fileConfig } : {})
  };
}

function normalizeExternalMemoryFileConfig(value: unknown): ExternalMemoryConfig["file"] {
  const record = isPlainRecord(value) ? value : {};
  const path = typeof record.path === "string" && record.path.trim().length > 0
    ? record.path.trim()
    : undefined;
  return {
    ...(path === undefined ? {} : { path }),
    maxEntries: coercePositiveInteger(record.maxEntries, { default: 1_000, max: 10_000 })
  };
}

export function redactExternalMemoryConfig(config: ExternalMemoryConfig): ExternalMemoryConfig {
  const redacted = redactObject(config, { strict: true }) as ExternalMemoryConfig;
  return {
    ...redacted,
    ...(config.credentials === undefined ? {} : { credentials: redacted.credentials })
  };
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  return coercePositiveInteger(value, { default: 1 });
}

export function normalizeOptionalPositiveIntegerStrict(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }

  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(`${path} must be a positive integer when set.`);
  }

  return parsed;
}

function normalizeProviderTimeouts(providers: EstaCodaConfig["providers"]): Record<string, {
  timeoutMs?: number;
  staleTimeoutMs?: number;
}> {
  const normalized: Record<string, { timeoutMs?: number; staleTimeoutMs?: number }> = {};
  for (const [provider, config] of Object.entries(providers ?? {})) {
    const timeoutMs = normalizeOptionalPositiveIntegerStrict(config.timeoutMs, `providers.${provider}.timeoutMs`);
    const staleTimeoutMs = normalizeOptionalPositiveIntegerStrict(config.staleTimeoutMs, `providers.${provider}.staleTimeoutMs`);
    if (timeoutMs !== undefined || staleTimeoutMs !== undefined) {
      normalized[provider] = {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(staleTimeoutMs !== undefined ? { staleTimeoutMs } : {})
      };
    }
  }
  return normalized;
}

function normalizeModelAliases(
  aliases: Record<string, ModelAliasDefinition>
): Record<string, ModelAliasDefinition> {
  const normalized: Record<string, ModelAliasDefinition> = {};
  for (const [name, alias] of Object.entries(aliases)) {
    const { maxTokens: _maxTokens, ...rest } = alias as ModelAliasDefinition & {
      maxTokens?: unknown;
    };
    const maxTokens = normalizeOptionalPositiveIntegerStrict(
      _maxTokens,
      `modelAliases.${name}.maxTokens`
    );
    normalized[name] = {
      ...rest,
      ...(maxTokens !== undefined ? { maxTokens } : {})
    };
  }
  return normalized;
}

function normalizeTtsConfig(value: EstaCodaConfig["tts"]): LoadedRuntimeConfig["tts"] {
  const provider = isTtsProvider(value?.provider) ? value.provider : "openai";
  return {
    ...value,
    provider,
    enabled: value?.enabled ?? true,
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
      speed: boundedNumber(value?.xai?.speed, 1, 0.5, 2),
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
  const fasterWhisper = value?.local?.fasterWhisper ?? value?.local?.faster_whisper;
  const engine = value?.local?.engine ?? "faster-whisper";
  const allowModelDownload = fasterWhisper?.allowModelDownload ?? fasterWhisper?.allow_model_download ?? true;
  const gatewayAllowModelDownload =
    fasterWhisper?.gatewayAllowModelDownload ?? fasterWhisper?.gateway_allow_model_download ?? allowModelDownload;
  return {
    ...value,
    provider,
    enabled: value?.enabled ?? true,
    local: {
      model: value?.local?.model ?? "base",
      command: value?.local?.command ?? process.env.HERMES_LOCAL_STT_COMMAND,
      engine,
      pythonBinary: value?.local?.pythonBinary ?? value?.local?.python_binary,
      normalizeWithFfmpeg: value?.local?.normalizeWithFfmpeg ?? value?.local?.normalize_with_ffmpeg ?? true,
      ffmpegPath: value?.local?.ffmpegPath ?? value?.local?.ffmpeg_path ?? "ffmpeg",
      fasterWhisper: {
        enabled: fasterWhisper?.enabled ?? engine === "faster-whisper",
        model: fasterWhisper?.model ?? "base",
        device: fasterWhisper?.device ?? "auto",
        computeType: fasterWhisper?.computeType ?? fasterWhisper?.compute_type ?? "default",
        hfHome: fasterWhisper?.hfHome ?? fasterWhisper?.hf_home,
        allowModelDownload,
        gatewayAllowModelDownload,
        queueDepth: normalizeOptionalPositiveInteger(fasterWhisper?.queueDepth ?? fasterWhisper?.queue_depth) ?? undefined,
        timeoutMs: normalizeOptionalPositiveInteger(fasterWhisper?.timeoutMs ?? fasterWhisper?.timeout_ms) ?? undefined,
        modelCached: fasterWhisper?.modelCached ?? fasterWhisper?.model_cached
      }
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
    },
    xai: {
      baseUrl: value?.xai?.baseUrl ?? value?.xai?.base_url ?? "https://api.x.ai/v1",
      apiKeyEnv: value?.xai?.apiKeyEnv ?? value?.xai?.api_key_env ?? "XAI_API_KEY",
      language: value?.xai?.language,
      format: value?.xai?.format ?? "json",
      diarize: value?.xai?.diarize ?? value?.xai?.diarization,
      keyterms: value?.xai?.keyterms ?? value?.xai?.key_terms ?? [],
      fillerWords: value?.xai?.fillerWords ?? value?.xai?.filler_words,
      rawAudioHints: value?.xai?.rawAudioHints ?? value?.xai?.raw_audio_hints
    }
  };
}

function normalizeVoiceConfig(value: EstaCodaConfig["voice"]): LoadedRuntimeConfig["voice"] {
  return {
    ...value,
    autoTts: value?.autoTts ?? false,
    autoTtsMaxCharsPerReply: normalizeOptionalPositiveInteger(value?.autoTtsMaxCharsPerReply),
    autoTtsMaxCharsPerHourPerChat: normalizeOptionalPositiveInteger(value?.autoTtsMaxCharsPerHourPerChat)
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
    mistral: { ...(left?.mistral ?? {}), ...(right?.mistral ?? {}) },
    xai: { ...(left?.xai ?? {}), ...(right?.xai ?? {}) }
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
  return value === "local" || value === "groq" || value === "openai" || value === "mistral" || value === "xai";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return coerceFiniteNumber(value, { default: fallback, min, max });
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
      const metadata = getProviderMetadata(providerId);
      const resolvedBaseUrl = providerConfig.baseUrl ?? metadata.defaultBaseUrl;
      if (resolvedBaseUrl === undefined) {
        // Skip registering an executable adapter for custom providers
        // missing an explicit base URL.
        continue;
      }

      if (metadata.apiMode === "openai_responses") {
        registry.register(createOpenAIResponsesProvider({
          id: providerId,
          endpoint: {
            baseUrl: resolvedBaseUrl,
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

      registry.register(createOpenAICompatibleProvider({
        id: providerId,
        endpoint: {
          baseUrl: resolvedBaseUrl,
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

export async function saveRuntimeConfig(path: string, config: EstaCodaConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function resolveSelectedProfileId(options: { homeDir?: string; profileId?: string }): string {
  return options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
}

function resolveConfigMutationPath(options: { homeDir?: string; profileId?: string }): string {
  const profileId = resolveSelectedProfileId(options);
  return resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
}

/**
 * Compatibility wrapper for direct setup/model setup/config-tool paths.
 *
 * Do not use for new first-run onboarding, guided setup repair,
 * bare `estacoda model`, `/model` session switching, gateway model cards,
 * or runtime route mutation.
 *
 * New flows should use the smaller provider config mutation helpers and
 * reviewed setup apply paths.
 *
 * TODO(provider-cleanup): migrate remaining direct setup/model setup/config-tool
 * callers to the smaller helpers in a dedicated compatibility migration PR,
 * then remove this wrapper.
 */
export async function setupProviderConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  input: ProviderSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateProviderSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const explicitlyProvidesCredential = options.input.apiKeyEnv !== undefined || options.input.apiKey !== undefined;
  const forceCredential = options.input.requiresCredential !== false && options.input.provider !== "local";
  const requiresCredential = explicitlyProvidesCredential || forceCredential;
  const envName = requiresCredential ? options.input.apiKeyEnv ?? getDefaultApiKeyEnv(options.input.provider) : undefined;
  const profileId = resolveSelectedProfileId(options);

  // Write raw secret to .env boundary, never into config JSON
  let secretPath: string | undefined;
  if (options.input.apiKey !== undefined && options.input.apiKey.trim().length > 0 && envName !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId,
      key: envName,
      value: options.input.apiKey
    });
    process.env[secret.key] = options.input.apiKey;
    secretPath = secret.path;
  }

  // Preserve unrelated provider fields by spreading the existing block first
  const existingProvider = existing.config.providers?.[options.input.provider] ?? {};
  const previousModels = existingProvider.models ?? [];
  const nextModels = uniqueStrings([
    ...previousModels,
    ...(options.input.models ?? []),
    options.input.model
  ]);
  const providerConfig: Record<string, unknown> = {
    ...existingProvider,
    kind: "openai-compatible" as const,
    apiKeyEnv: envName,
    models: nextModels,
    enableNetwork: options.input.enableNetwork ?? true
  };
  if (options.input.baseUrl !== undefined) {
    if (shouldPersistProviderBaseUrl(options.input.provider, options.input.baseUrl)) {
      providerConfig.baseUrl = options.input.baseUrl;
    } else {
      providerConfig.baseUrl = undefined;
    }
  }

  const contextWindowPatch = options.input.contextWindowTokens !== undefined
    ? { contextWindowTokens: options.input.contextWindowTokens }
    : {};
  const primaryModelPatch = options.input.primary === false
    ? {}
    : {
      model: {
        provider: options.input.provider,
        id: options.input.model,
        ...contextWindowPatch
      }
    };

  // Single read, single merge, single save — no multi-write partial states
  const config = patchConfig(existing.config, {
    ...primaryModelPatch,
    providers: {
      [options.input.provider]: providerConfig
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    secretPath
  };
}

export async function setupModelFallbackConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  input: ModelFallbackSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateModelFallbackSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const merged = patchConfig(existing.config, {
    model: {
      fallbacks: options.input.fallbacks
    }
  });
  const normalized = normalizeModelFallbacks(merged);
  const config: EstaCodaConfig = {
    ...merged,
    model: {
      ...merged.model,
      fallbacks: normalized.fallbacks
    }
  };

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupAuxiliaryModelConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  input: AuxiliaryModelRouteSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateAuxiliaryModelRouteSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const mergedAuxiliaryModels: AuxiliaryModelConfig = {
    ...(existing.config.auxiliaryModels ?? {}),
    [options.input.task]: {
      provider: options.input.provider,
      id: options.input.id,
      ...(options.input.baseUrl !== undefined ? { baseUrl: options.input.baseUrl } : {}),
      ...(options.input.apiKeyEnv !== undefined ? { apiKeyEnv: options.input.apiKeyEnv } : {}),
      ...(options.input.contextWindowTokens !== undefined ? { contextWindowTokens: options.input.contextWindowTokens } : {}),
      enabled: true
    }
  };
  const normalized = normalizeAuxiliaryModels(mergedAuxiliaryModels);
  const config = patchConfig(existing.config, {
    auxiliaryModels: {
      ...(existing.config.auxiliaryModels ?? {}),
      [options.input.task]: normalized[options.input.task]
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function removeModelFallbackConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  input: {
    provider: ProviderId;
    id: string;
    baseUrl?: string;
  };
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const targetKey = `${options.input.provider}/${options.input.id}/${options.input.baseUrl ?? ""}`;
  const remaining = (existing.config.model?.fallbacks ?? []).filter((fb) => {
    return `${fb.provider}/${fb.id}/${fb.baseUrl ?? ""}` !== targetKey;
  });
  const config = patchConfig(existing.config, {
    model: {
      fallbacks: remaining.length === 0 ? undefined : remaining
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function reorderModelFallbackConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  input: {
    order: Array<{ provider: ProviderId; id: string; baseUrl?: string }>;
  };
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const current = existing.config.model?.fallbacks ?? [];
  const orderKeys = new Set(options.input.order.map((o) => `${o.provider}/${o.id}/${o.baseUrl ?? ""}`));
  const ordered = options.input.order.map((o) => {
    return current.find((fb) => `${fb.provider}/${fb.id}/${fb.baseUrl ?? ""}` === `${o.provider}/${o.id}/${o.baseUrl ?? ""}`);
  }).filter((fb): fb is ModelFallbackConfig => fb !== undefined);
  const tail = current.filter((fb) => !orderKeys.has(`${fb.provider}/${fb.id}/${fb.baseUrl ?? ""}`));
  const config = patchConfig(existing.config, {
    model: {
      fallbacks: [...ordered, ...tail]
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function clearModelFallbackConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const config = patchConfig(existing.config, {
    model: {
      fallbacks: undefined
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupWebConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  input: WebSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateWebSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const config = patchConfig(existing.config, {
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
  input: BrowserSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateBrowserSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const config = patchConfig(existing.config, {
    browser: {
      backend: options.input.backend ?? "local-cdp",
      cloudProvider: options.input.cloudProvider,
      cdpUrl: options.input.cdpUrl,
      launchCommand: options.input.launchCommand,
      launchExecutable: options.input.launchExecutable,
      launchArgs: options.input.launchArgs,
      autoLaunch: options.input.autoLaunch ?? false,
      supervised: options.input.supervised,
      chromeFlags: options.input.chromeFlags,
      engine: options.input.engine,
      commandTimeout: options.input.commandTimeout,
      inactivityTimeout: options.input.inactivityTimeout,
      recordSessions: options.input.recordSessions,
      hybridRouting: options.input.hybridRouting,
      cloudFallback: options.input.cloudFallback,
      cloudSpendApproved: options.input.cloudSpendApproved,
      summarizeSnapshots: options.input.summarizeSnapshots,
      snapshotSummarizeThreshold: options.input.snapshotSummarizeThreshold
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupBrowserCloudSpendApproval(options: {
  workspaceRoot: string;
  homeDir?: string;
  approved: boolean;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const config = patchConfig(existing.config, {
    browser: {
      cloudSpendApproved: options.approved
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
  input: VoiceSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPaths: string[];
}> {
  validateVoiceSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
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
  const hasTtsInput = options.input.ttsProvider !== undefined ||
    options.input.ttsSpeed !== undefined ||
    options.input.ttsVoice !== undefined ||
    options.input.ttsModel !== undefined ||
    options.input.ttsApiKeyEnv !== undefined ||
    options.input.ttsApiKey !== undefined;
  const hasSttInput = options.input.sttProvider !== undefined ||
    options.input.sttModel !== undefined ||
    options.input.sttCommand !== undefined ||
    options.input.sttApiKeyEnv !== undefined ||
    options.input.sttApiKey !== undefined ||
    options.input.pythonBinary !== undefined;

  if (options.input.ttsApiKey !== undefined && options.input.ttsApiKey.trim().length > 0 && ttsApiKeyEnv !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId: resolveSelectedProfileId(options),
      key: ttsApiKeyEnv,
      value: options.input.ttsApiKey
    });
    process.env[secret.key] = options.input.ttsApiKey;
    secretPaths.push(secret.path);
  }
  if (options.input.sttApiKey !== undefined && options.input.sttApiKey.trim().length > 0 && sttApiKeyEnv !== undefined) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId: resolveSelectedProfileId(options),
      key: sttApiKeyEnv,
      value: options.input.sttApiKey
    });
    process.env[secret.key] = options.input.sttApiKey;
    secretPaths.push(secret.path);
  }

  const sttModel = options.input.sttModel ?? previousStt.local?.model ?? "base";
  const sttConfigPatch: EstaCodaConfig["stt"] | undefined = !hasSttInput
    ? undefined
    : sttProvider === "local"
    ? {
        provider: sttProvider,
        local: {
          model: sttModel,
          engine: "faster-whisper" as const,
          pythonBinary: options.input.pythonBinary,
          fasterWhisper: {
            enabled: true,
            model: sttModel,
            allowModelDownload: true
          }
        }
      }
    : {
        provider: sttProvider,
        [sttProvider]: {
          model: options.input.sttModel,
          apiKeyEnv: sttApiKeyEnv
        }
      };

  const ttsConfigPatch: EstaCodaConfig["tts"] | undefined = !hasTtsInput
    ? undefined
    : {
        provider: ttsProvider,
        speed: options.input.ttsSpeed ?? previousTts.speed,
        [ttsProvider]: {
          model: options.input.ttsModel,
          voice: options.input.ttsVoice,
          voiceId: options.input.ttsVoice,
          apiKeyEnv: ttsApiKeyEnv
        }
      };

  const config = patchConfig(existing.config, {
    tts: ttsConfigPatch,
    stt: sttConfigPatch
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
  input: ImageGenerationSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateImageGenerationSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const previous = normalizeImageGenerationConfig(existing.config.imageGen ?? existing.config.image_gen);
  const provider = options.input.provider ?? previous.provider;
  const providerExplicit = options.input.provider !== undefined;
  const apiKeyEnv = options.input.apiKeyEnv ?? previous[provider]?.apiKeyEnv ?? defaultImageApiKeyEnv(provider);
  let secretPath: string | undefined;
  if (options.input.apiKey !== undefined && options.input.apiKey.trim().length > 0) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId: resolveSelectedProfileId(options),
      key: apiKeyEnv,
      value: options.input.apiKey
    });
    process.env[secret.key] = options.input.apiKey;
    secretPath = secret.path;
  }
  const requestedModel = options.input.model ?? resolveImageModel(provider, options.input.modelVersion);
  const model = requestedModel ?? (providerExplicit ? defaultImageModel(provider) : previous[provider]?.model ?? previous.model ?? defaultImageModel(provider));
  const baseUrl = options.input.baseUrl ?? previous[provider]?.baseUrl;
  const config = patchConfig(existing.config, {
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
  input: MCPSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateMcpSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
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
  const config = patchConfig(existing.config, {
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
  input: SecuritySetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateSecuritySetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
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
  const config = patchConfig(existing.config, {
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
  input: SkillSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateSkillSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const config = patchConfig(existing.config, {
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
  input: UiSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateUiSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const previous = normalizeUiConfig(existing.config.ui);
  const nextLanguage = options.input.language ?? previous.language;
  const languageChangedTo = options.input.language;
  const config = patchConfig(existing.config, {
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
  input: ProfileSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateProfileSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const previous = normalizeProfileConfig(existing.config.profile);
  const config = patchConfig(existing.config, {
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
  profileId?: string;
  input: TelegramSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateTelegramSetupInput(options.input);
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const envName = options.input.botTokenEnv ?? "ESTACODA_TELEGRAM_BOT_TOKEN";
  let secretPath: string | undefined;
  if (options.input.botToken !== undefined && options.input.botToken.trim().length > 0) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId: resolveSelectedProfileId(options),
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

  const config = patchConfig(existing.config, {
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

export async function setupDiscordConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  input: DiscordSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  secretPath?: string;
}> {
  validateDiscordSetupInput(options.input);
  const allowedUsers = uniqueStrings(options.input.allowedUsers ?? []);
  const allowedGuilds = uniqueStrings(options.input.allowedGuilds ?? []);
  const allowedChannels = uniqueStrings(options.input.allowedChannels ?? []);
  if ((options.input.enabled ?? true) && allowedUsers.length === 0 && allowedChannels.length === 0) {
    throw new Error("Discord setup requires at least one allowed user or channel.");
  }
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const envName = options.input.botTokenEnv ?? "ESTACODA_DISCORD_BOT_TOKEN";
  let secretPath: string | undefined;
  if (options.input.botToken !== undefined && options.input.botToken.trim().length > 0) {
    const secret = await writeEnvSecret({
      homeDir: options.homeDir,
      profileId: resolveSelectedProfileId(options),
      key: envName,
      value: options.input.botToken
    });
    process.env[secret.key] = options.input.botToken;
    secretPath = secret.path;
  }

  const discordPatch: DiscordChannelConfig = {
    ...(existing.config.channels?.discord ?? {}),
    enabled: options.input.enabled ?? true,
    botTokenEnv: envName,
    allowedUsers,
    allowedGuilds,
    allowedChannels
  };
  const config = patchConfig(existing.config, {
    channels: {
      discord: discordPatch
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config,
    secretPath
  };
}

export async function setupWhatsAppConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  input: WhatsAppSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  validateWhatsAppSetupInput(options.input);
  const allowedUsers = normalizeWhatsAppAllowlist(options.input.allowedUsers);
  const allowedGroups = normalizeWhatsAppGroupAllowlist(options.input.allowedGroups);
  const dmPolicy = options.input.dmPolicy ?? (allowedUsers.length > 0 ? "allowlist" : "pairing");
  if ((options.input.enabled ?? true) && allowedUsers.length === 0 && dmPolicy === "allowlist") {
    throw new Error("WhatsApp setup requires allowed user numbers.");
  }
  const groupPolicy = options.input.groupPolicy ?? (allowedGroups.length > 0 ? "allowlist" : "disabled");
  if ((options.input.enabled ?? true) && allowedGroups.length === 0 && groupPolicy === "allowlist") {
    throw new Error("WhatsApp setup requires allowed group JIDs.");
  }
  const enabled = options.input.enabled ?? true;
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const profileId = resolveSelectedProfileId(options);
  const gatewayStatePath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).gatewayStatePath;
  const defaultAuthDir = join(gatewayStatePath, "whatsapp-auth");
  const authDir = options.input.authDir ?? defaultAuthDir;
  if (resolve(authDir) !== resolve(defaultAuthDir)) {
    throw new Error("WhatsApp authDir must be the selected profile WhatsApp auth directory.");
  }
  const whatsappPatch: WhatsAppChannelConfig = {
    enabled,
    experimental: enabled ? true : options.input.experimental ?? false,
    authDir,
    allowedUsers,
    allowedGroups,
    mode: options.input.mode ?? existing.config.channels?.whatsapp?.mode ?? "bot",
    dmPolicy,
    groupPolicy,
    requireMention: options.input.requireMention,
    mentionPatterns: uniqueStrings(options.input.mentionPatterns ?? []),
    freeResponseChats: normalizeWhatsAppGroupAllowlist(options.input.freeResponseChats),
    replyPrefix: options.input.replyPrefix ?? existing.config.channels?.whatsapp?.replyPrefix ?? WHATSAPP_DEFAULT_REPLY_PREFIX,
    pairingMode: options.input.pairingMode ?? "qr"
  };
  const config: EstaCodaConfig = {
    ...existing.config,
    channels: {
      ...(existing.config.channels ?? {}),
      whatsapp: whatsappPatch
    }
  };

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function addWhatsAppAllowedUser(options: {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  userId: string;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  added: boolean;
}> {
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const whatsapp = existing.config.channels?.whatsapp ?? {};
  const normalizedUserId = normalizeWhatsAppUserId(options.userId);
  const allowedUsers = uniqueStrings([...(whatsapp.allowedUsers ?? []), normalizedUserId]);
  const whatsappPatch: WhatsAppChannelConfig = {
    enabled: whatsapp.enabled,
    experimental: whatsapp.experimental,
    authDir: whatsapp.authDir,
    allowedUsers: normalizeWhatsAppAllowlist(allowedUsers),
    allowedGroups: normalizeWhatsAppGroupAllowlist(whatsapp.allowedGroups),
    mode: whatsapp.mode,
    dmPolicy: allowedUsers.length > 0 && whatsapp.dmPolicy === "pairing" ? "allowlist" : whatsapp.dmPolicy
  };
  if (whatsapp.groupPolicy !== undefined) whatsappPatch.groupPolicy = whatsapp.groupPolicy;
  if (whatsapp.requireMention !== undefined) whatsappPatch.requireMention = whatsapp.requireMention;
  if (whatsapp.mentionPatterns !== undefined) whatsappPatch.mentionPatterns = uniqueStrings(whatsapp.mentionPatterns);
  if (whatsapp.freeResponseChats !== undefined) whatsappPatch.freeResponseChats = normalizeWhatsAppGroupAllowlist(whatsapp.freeResponseChats);
  if (whatsapp.replyPrefix !== undefined) whatsappPatch.replyPrefix = whatsapp.replyPrefix;
  if (whatsapp.pairingMode === "qr") whatsappPatch.pairingMode = "qr";
  if (whatsapp.busyPolicy !== undefined) whatsappPatch.busyPolicy = whatsapp.busyPolicy;
  if (whatsapp.queueDepth !== undefined) whatsappPatch.queueDepth = whatsapp.queueDepth;
  const config: EstaCodaConfig = {
    ...existing.config,
    channels: {
      ...(existing.config.channels ?? {}),
      whatsapp: whatsappPatch
    }
  };

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config,
    added: !(whatsapp.allowedUsers ?? []).includes(normalizedUserId)
  };
}

export async function createTelegramPairingCode(options: {
  workspaceRoot: string;
  homeDir?: string;
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
  const targetPath = resolveConfigMutationPath(options);
  const existing = await readConfig(targetPath);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 10;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const code = input.code ?? options.code?.() ?? randomPairingCode();
  const config = patchConfig(existing.config, {
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
  const targetPath = resolveConfigMutationPath(options);
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
  const config = patchConfig(existing.config, {
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

export async function readConfig(path: string): Promise<{ path: string; loaded: boolean; config: EstaCodaConfig }> {
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
  validateOptionalUrl(input.baseUrl, "baseUrl");
  validateOptionalEnvName(input.apiKeyEnv, "apiKeyEnv");
}

function validateModelFallbackSetupInput(input: ModelFallbackSetupInput): void {
  if (!Array.isArray(input.fallbacks)) {
    throw new Error("Expected fallbacks to be an array");
  }
  for (const fb of input.fallbacks) {
    requireNonEmpty(fb.provider, "fallback provider");
    requireNonEmpty(fb.id, "fallback id");
    if (fb.baseUrl !== undefined) {
      validateOptionalUrl(fb.baseUrl, "fallback baseUrl");
    }
    if (fb.apiKeyEnv !== undefined) {
      validateOptionalEnvName(fb.apiKeyEnv, "fallback apiKeyEnv");
    }
  }
}

function validateAuxiliaryModelRouteSetupInput(input: AuxiliaryModelRouteSetupInput): void {
  requireNonEmpty(input.task, "auxiliary task");
  requireNonEmpty(input.provider, "auxiliary provider");
  requireNonEmpty(input.id, "auxiliary model id");
  validateOptionalUrl(input.baseUrl, "auxiliary baseUrl");
  validateOptionalEnvName(input.apiKeyEnv, "auxiliary apiKeyEnv");
  if (input.contextWindowTokens !== undefined && (!Number.isInteger(input.contextWindowTokens) || input.contextWindowTokens <= 0)) {
    throw new Error("Expected auxiliary contextWindowTokens to be a positive integer");
  }
}

function validateWebSetupInput(input: WebSetupInput): void {
  if (input.maxContentChars !== undefined && (!Number.isInteger(input.maxContentChars) || input.maxContentChars <= 0)) {
    throw new Error("Expected maxContentChars to be a positive integer");
  }
}

function validateBrowserSetupInput(input: BrowserSetupInput): void {
  if (input.backend !== undefined && !isBrowserBackend(input.backend)) {
    throw new Error("Expected browser backend local-cdp, browserbase, firecrawl, camofox, mock, or unconfigured");
  }
  validateOptionalUrl(input.cdpUrl, "cdpUrl");
  normalizeBrowserConfig({
    backend: input.backend,
    cloudProvider: input.cloudProvider,
    cdpUrl: input.cdpUrl,
    launchExecutable: input.launchExecutable,
    launchArgs: input.launchArgs,
    autoLaunch: input.autoLaunch,
    supervised: input.supervised,
    chromeFlags: input.chromeFlags,
    engine: input.engine,
    commandTimeout: input.commandTimeout,
    inactivityTimeout: input.inactivityTimeout,
    recordSessions: input.recordSessions,
    hybridRouting: input.hybridRouting,
    cloudFallback: input.cloudFallback,
    cloudSpendApproved: input.cloudSpendApproved,
    summarizeSnapshots: input.summarizeSnapshots,
    snapshotSummarizeThreshold: input.snapshotSummarizeThreshold
  });
}

function validateVoiceSetupInput(input: VoiceSetupInput): void {
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
  if (input.autonomy !== undefined && input.autonomy !== "none" && input.autonomy !== "suggest" && input.autonomy !== "proactive" && input.autonomy !== "autonomous") {
    throw new Error("Expected skill autonomy none, suggest, proactive, or autonomous");
  }
}

function validateUiSetupInput(input: UiSetupInput): void {
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
  if (input.mode !== undefined && input.mode !== "focused" && input.mode !== "operator" && input.mode !== "builder" && input.mode !== "research") {
    throw new Error("Expected profile mode focused, operator, builder, or research");
  }
  if (input.responseLanguage !== undefined && input.responseLanguage !== "en" && input.responseLanguage !== "ar" && input.responseLanguage !== "match-user") {
    throw new Error("Expected responseLanguage en, ar, or match-user");
  }
}

function validateTelegramSetupInput(input: TelegramSetupInput): void {
  validateOptionalEnvName(input.botTokenEnv, "botTokenEnv");
  if (input.pollTimeoutSeconds !== undefined && (!Number.isInteger(input.pollTimeoutSeconds) || input.pollTimeoutSeconds <= 0)) {
    throw new Error("Expected pollTimeoutSeconds to be a positive integer");
  }
}

function validateDiscordSetupInput(input: DiscordSetupInput): void {
  validateOptionalEnvName(input.botTokenEnv, "botTokenEnv");
  for (const value of [
    ...(input.allowedUsers ?? []),
    ...(input.allowedGuilds ?? []),
    ...(input.allowedChannels ?? [])
  ]) {
    requireNonEmpty(value, "Discord allowlist entry");
  }
}

function validateWhatsAppSetupInput(input: WhatsAppSetupInput): void {
  requireOptionalNonEmpty(input.authDir, "authDir");
  if (input.mode !== undefined && input.mode !== "bot" && input.mode !== "self-chat") {
    throw new Error("WhatsApp mode must be bot or self-chat.");
  }
  if (input.dmPolicy !== undefined && input.dmPolicy !== "disabled" && input.dmPolicy !== "allowlist" && input.dmPolicy !== "pairing" && input.dmPolicy !== "open") {
    throw new Error("WhatsApp dmPolicy must be disabled, allowlist, pairing, or open.");
  }
  if (input.groupPolicy !== undefined && input.groupPolicy !== "disabled" && input.groupPolicy !== "allowlist" && input.groupPolicy !== "open") {
    throw new Error("WhatsApp groupPolicy must be disabled, allowlist, or open.");
  }
  if (input.pairingMode !== undefined && input.pairingMode !== "qr") {
    throw new Error("WhatsApp pairingMode must be qr.");
  }
  for (const value of input.allowedUsers ?? []) {
    requireNonEmpty(value, "WhatsApp allowed user");
  }
  for (const value of input.allowedGroups ?? []) {
    requireNonEmpty(value, "WhatsApp allowed group");
  }
  for (const value of input.mentionPatterns ?? []) {
    requireNonEmpty(value, "WhatsApp mention pattern");
  }
  for (const value of input.freeResponseChats ?? []) {
    requireNonEmpty(value, "WhatsApp free response chat");
  }
  requireOptionalNonEmpty(input.replyPrefix, "WhatsApp replyPrefix");
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
    case "xai":
      return "XAI_API_KEY";
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
    case "xai":
      return config.xai?.apiKeyEnv ?? config.xai?.api_key_env;
  }
}

function expandConfiguredPaths(paths: string[], homeDir?: string): string[] {
  return [...new Set(
    paths
      .map((path) => expandConfiguredPath(path, homeDir))
      .filter((path) => path.length > 0)
  )];
}

function expandConfiguredPath(path: string, _homeDir?: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const envExpanded = trimmed.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => process.env[name] ?? match);

  if (envExpanded === "~") {
    return resolveOsHomeDir();
  }

  if (envExpanded.startsWith("~/")) {
    return join(resolveOsHomeDir(), envExpanded.slice(2));
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

function fallbackRouteKey(fallback: ModelFallbackConfig): string {
  return `${fallback.provider}/${fallback.id}/${fallback.baseUrl ?? ""}`;
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function normalizeModelFallbacks(
  config: EstaCodaConfig
): { fallbacks: ModelFallbackConfig[]; warnings: string[] } {
  const raw = config.model?.fallbacks;
  const warnings: string[] = [];

  if (raw === undefined || !Array.isArray(raw)) {
    return { fallbacks: [], warnings };
  }

  const seen = new Set<string>();
  const fallbacks: ModelFallbackConfig[] = [];
  const primaryProvider = config.model?.provider;
  const primaryId = config.model?.id;
  const primaryBaseUrl = config.providers?.[primaryProvider ?? ""]?.baseUrl;

  for (const [index, entry] of raw.entries()) {
    if (entry === undefined || entry === null || typeof entry !== "object") {
      warnings.push("Ignored non-object fallback entry.");
      continue;
    }

    const provider = (entry as Record<string, unknown>).provider;
    const id = (entry as Record<string, unknown>).id;

    if (typeof provider !== "string" || provider.length === 0) {
      warnings.push("Ignored fallback entry missing required 'provider'.");
      continue;
    }
    if (typeof id !== "string" || id.length === 0) {
      warnings.push("Ignored fallback entry missing required 'id'.");
      continue;
    }

    const baseUrl = (entry as Record<string, unknown>).baseUrl;
    if (baseUrl !== undefined && (typeof baseUrl !== "string" || !isValidUrl(baseUrl))) {
      warnings.push(`Ignored fallback entry for ${provider}/${id} with invalid baseUrl."`);
      continue;
    }

    const apiKeyEnv = (entry as Record<string, unknown>).apiKeyEnv;
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || !isValidEnvName(apiKeyEnv))) {
      warnings.push(`Ignored fallback entry for ${provider}/${id} with invalid apiKeyEnv.`);
      continue;
    }

    const contextWindowTokens = (entry as Record<string, unknown>).contextWindowTokens;
    const maxTokens = normalizeOptionalPositiveIntegerStrict(
      (entry as Record<string, unknown>).maxTokens,
      `model.fallbacks[${index}].maxTokens`
    );
    const timeoutMs = normalizeOptionalPositiveIntegerStrict(
      (entry as Record<string, unknown>).timeoutMs,
      `model.fallbacks[${index}].timeoutMs`
    );
    const staleTimeoutMs = normalizeOptionalPositiveIntegerStrict(
      (entry as Record<string, unknown>).staleTimeoutMs,
      `model.fallbacks[${index}].staleTimeoutMs`
    );
    const normalized: ModelFallbackConfig = {
      provider: provider as ProviderId,
      id,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
      ...(typeof contextWindowTokens === "number" && Number.isFinite(contextWindowTokens)
        ? { contextWindowTokens }
        : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(staleTimeoutMs !== undefined ? { staleTimeoutMs } : {})
    };

    const key = fallbackRouteKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (
      normalized.provider === primaryProvider &&
      normalized.id === primaryId &&
      (normalized.baseUrl ?? "") === (primaryBaseUrl ?? "")
    ) {
      warnings.push(`Ignored fallback entry that duplicates the primary route ${primaryProvider}/${primaryId}.`);
      continue;
    }

    fallbacks.push(normalized);
  }

  return { fallbacks, warnings };
}

function normalizeChannelBusyPolicy(
  value: unknown,
  channelName: string,
  warned: Set<string>
): ChannelBusyPolicy {
  if (value === "reject" || value === "queue" || value === "interrupt") {
    return value;
  }
  if (value !== undefined && !warned.has(`${channelName}:${String(value)}`)) {
    warned.add(`${channelName}:${String(value)}`);
    console.warn(`Invalid busyPolicy "${String(value)}" for ${channelName}; falling back to "reject"`);
  }
  return "reject";
}

function normalizeQueueDepth(value: unknown): number {
  return coercePositiveInteger(value, { default: 3, max: 10 });
}
