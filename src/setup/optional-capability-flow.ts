import type { BrowserBackendKind, BrowserCloudProviderKind } from "../contracts/browser.js";
import type { ProviderId } from "../contracts/provider.js";
import type {
  EstaCodaConfig,
  ImageGenerationProvider,
  SttProvider,
  TtsProvider,
} from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import type { Prompt } from "../cli/readline-prompt.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { SetupCopyLocale } from "./setup-copy.js";
import { setupCopyText } from "./setup-prompts.js";
import type { SetupDeferredSecretWrite } from "./setup-apply-plan.js";
import type { SetupDraft, SetupDraftBundle } from "./setup-drafts.js";
import {
  browserSetupModule,
  discordSetupModule,
  telegramSetupModule,
  visionSetupModule,
  voiceSetupModule,
  whatsappSetupModule,
  type SetupModuleContext,
} from "./setup-modules.js";
import type { SetupRouteDecision } from "./setup-router.js";
import {
  promptBrowserCapability,
  promptDiscordCapability,
  promptIncompleteChannelCapabilityAction,
  promptIncompleteTelegramCapabilityAction,
  promptSttCapability,
  promptTelegramCapability,
  promptTtsCapability,
  promptVisionCapability,
  promptWhatsAppCapability,
  type OptionalCapabilityPromptId,
  type VoiceCapabilityPromptId,
} from "./config-editor/prompts.js";

export type OptionalCapabilityModule =
  | typeof telegramSetupModule
  | typeof discordSetupModule
  | typeof whatsappSetupModule
  | typeof voiceSetupModule
  | typeof visionSetupModule
  | typeof browserSetupModule;

export type OptionalCapabilityPromptContext = {
  readonly module: OptionalCapabilityModule;
  readonly title: string;
  readonly configured: boolean;
};

export type OptionalCapabilityCollectionResult =
  | {
      readonly kind: "configured";
      readonly context: SetupModuleContext;
      readonly pendingCredentialWrite?: SetupDeferredSecretWrite;
    }
  | {
      readonly kind: "skip" | "unchanged";
    };

export type OptionalCapabilityContextOptions = {
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly workspaceRoot: string;
  readonly trustStorePath?: string;
  readonly configPath?: string;
};

export type OptionalCapabilityRouteContext = {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly workspaceTrusted?: boolean;
  readonly securityMode?: SecurityApprovalMode;
  readonly workflowLearning?: SkillAutonomy;
};

export function setupModuleContextFromConfig(
  options: OptionalCapabilityContextOptions,
  config: EstaCodaConfig,
  routeContext: OptionalCapabilityRouteContext = {}
): SetupModuleContext {
  const telegram = recordValue(recordValue(config.channels)?.telegram);
  const discord = recordValue(recordValue(config.channels)?.discord);
  const whatsapp = recordValue(recordValue(config.channels)?.whatsapp);
  const browser = recordValue(config.browser);
  const voice = voiceContext(config);
  const vision = visionContext(config);

  return {
    configPath: options.configPath ?? activeProfileConfigPath(options),
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath,
    provider: {
      id: routeContext.provider,
      model: routeContext.model,
    },
    workspaceTrust: {
      trusted: routeContext.workspaceTrusted === true,
    },
    securityMode: routeContext.securityMode,
    workflowLearning: routeContext.workflowLearning,
    telegram: telegram === undefined
      ? undefined
      : {
          enabled: booleanValue(telegram.enabled),
          botTokenEnv: stringValue(telegram.botTokenEnv),
          allowedUserIds: stringArrayValue(telegram.allowedUserIds),
          allowedChatIds: stringArrayValue(telegram.allowedChatIds),
        },
    discord: discord === undefined
      ? undefined
      : {
          enabled: booleanValue(discord.enabled),
          botTokenEnv: stringValue(discord.botTokenEnv),
          allowedUsers: stringArrayValue(discord.allowedUsers),
          allowedGuilds: stringArrayValue(discord.allowedGuilds),
          allowedChannels: stringArrayValue(discord.allowedChannels),
        },
    whatsapp: whatsapp === undefined
      ? undefined
      : {
          enabled: booleanValue(whatsapp.enabled),
          experimental: booleanValue(whatsapp.experimental),
          authDir: stringValue(whatsapp.authDir),
          allowedUsers: stringArrayValue(whatsapp.allowedUsers),
        },
    browser: browser === undefined
      ? undefined
      : {
          backend: browserBackendValue(browser.backend),
          cloudProvider: browserCloudProviderValue(browser.cloudProvider),
          cdpUrl: stringValue(browser.cdpUrl),
          launchCommand: stringValue(browser.launchCommand),
          launchExecutable: stringValue(browser.launchExecutable),
          launchArgs: stringArrayValue(browser.launchArgs),
          chromeFlags: stringArrayValue(browser.chromeFlags),
          autoLaunch: booleanValue(browser.autoLaunch),
          supervised: booleanValue(browser.supervised),
          hybridRouting: booleanValue(browser.hybridRouting),
          cloudFallback: booleanValue(browser.cloudFallback),
          cloudSpendApproved: booleanValue(browser.cloudSpendApproved),
        },
    voice,
    vision,
  };
}

export function setupModuleContextFromDecision(
  options: OptionalCapabilityContextOptions,
  decision: SetupRouteDecision,
  config: EstaCodaConfig
): SetupModuleContext {
  return setupModuleContextFromConfig(options, config, {
    provider: decision.state.model?.provider,
    model: decision.state.model?.id,
    workspaceTrusted: decision.state.workspaceTrust === "trusted",
    securityMode: securityModeValue(decision.state.setupVerification.securityModeValue),
    workflowLearning: skillAutonomyValue(decision.state.setupVerification.skillAutonomyValue),
  });
}

export function optionalCapabilityPromptContext(
  context: SetupModuleContext,
  module: OptionalCapabilityModule,
  locale: SetupCopyLocale
): OptionalCapabilityPromptContext {
  const detection = module.detect(context);
  return {
    module,
    title: optionalCapabilityTitle(module.id, locale),
    configured: detection.status === "configured",
  };
}

export function optionalCapabilityModuleForAction(actionId: string): OptionalCapabilityModule {
  switch (actionId) {
    case "configure-channels":
      throw new Error("Configure channels must select a channel capability before module resolution.");
    case "configure-voice":
      return voiceSetupModule;
    case "configure-image-generation":
      return visionSetupModule;
    case "configure-browser":
      return browserSetupModule;
    default:
      throw new Error(`Unsupported optional capability action: ${actionId}`);
  }
}

export function channelCapabilityModule(moduleId: "telegram" | "whatsapp" | "discord"): OptionalCapabilityModule {
  switch (moduleId) {
    case "telegram":
      return telegramSetupModule;
    case "whatsapp":
      return whatsappSetupModule;
    case "discord":
      return discordSetupModule;
  }
}

export async function collectOptionalCapabilityContext(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  baseContext: SetupModuleContext,
  module: OptionalCapabilityModule,
  voiceMode?: VoiceCapabilityPromptId
): Promise<OptionalCapabilityCollectionResult> {
  switch (module.id) {
    case "telegram": {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const values = await promptTelegramCapability(options.prompt, {
          botTokenEnv: baseContext.telegram?.botTokenEnv,
          allowedUserIds: baseContext.telegram?.allowedUserIds,
          allowedChatIds: baseContext.telegram?.allowedChatIds,
        }, options.locale);

        if (hasTelegramAllowedIdentity(values)) {
          const pendingCredentialWrite = values.botToken === undefined
            ? undefined
            : { envVarName: values.botTokenEnv, value: values.botToken };
          return {
            kind: "configured",
            context: {
              ...baseContext,
              telegram: {
                enabled: true,
                ...values,
              },
            },
            pendingCredentialWrite,
          };
        }

        const next = await promptIncompleteTelegramCapabilityAction(options.prompt, options.locale);
        if (next !== "retry") {
          return { kind: next };
        }
      }

      return { kind: "skip" };
    }
    case "discord": {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const values = await promptDiscordCapability(options.prompt, {
          botTokenEnv: baseContext.discord?.botTokenEnv,
          allowedUsers: baseContext.discord?.allowedUsers,
          allowedGuilds: baseContext.discord?.allowedGuilds,
          allowedChannels: baseContext.discord?.allowedChannels,
        }, options.locale);

        if (hasDiscordAllowedIdentity(values)) {
          const pendingCredentialWrite = values.botToken === undefined
            ? undefined
            : { envVarName: values.botTokenEnv, value: values.botToken };
          return {
            kind: "configured",
            context: {
              ...baseContext,
              discord: {
                enabled: true,
                ...values,
              },
            },
            pendingCredentialWrite,
          };
        }

        const next = await promptIncompleteChannelCapabilityAction(options.prompt, {
          title: optionalCapabilityTitle("discord", options.locale),
          bodyKey: "setupEditor.prompt.discord.incomplete.body",
        }, options.locale);
        if (next !== "retry") {
          return { kind: next };
        }
      }

      return { kind: "skip" };
    }
    case "whatsapp": {
      const defaultAuthDir = defaultWhatsAppAuthDir(options);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const values = await promptWhatsAppCapability(options.prompt, {
          authDir: baseContext.whatsapp?.authDir ?? defaultAuthDir,
          allowedUsers: baseContext.whatsapp?.allowedUsers,
        }, options.locale);

        if (values.allowedUsers.length > 0) {
          return {
            kind: "configured",
            context: {
              ...baseContext,
              whatsapp: {
                enabled: true,
                ...values,
                authDir: values.authDir.trim().length > 0 ? values.authDir : defaultAuthDir,
              },
            },
          };
        }

        const next = await promptIncompleteChannelCapabilityAction(options.prompt, {
          title: optionalCapabilityTitle("whatsapp", options.locale),
          bodyKey: "setupEditor.prompt.whatsapp.incomplete.body",
        }, options.locale);
        if (next !== "retry") {
          return { kind: next };
        }
      }

      return { kind: "skip" };
    }
    case "voice": {
      if (voiceMode === undefined) {
        throw new Error("Configure voice must select STT or TTS before collecting provider settings.");
      }
      const values = voiceMode === "stt"
        ? await promptSttCapability(options.prompt, baseContext.voice ?? {}, options.locale)
        : await promptTtsCapability(options.prompt, baseContext.voice ?? {}, options.locale);
      return {
        kind: "configured",
        context: {
          ...baseContext,
          voice: values,
        },
      };
    }
    case "vision": {
      const values = await promptVisionCapability(options.prompt, baseContext.vision ?? {}, options.locale);
      return {
        kind: "configured",
        context: {
          ...baseContext,
          vision: values,
        },
      };
    }
    case "browser": {
      const values = await promptBrowserCapability(options.prompt, baseContext.browser ?? {}, options.locale);
      return {
        kind: "configured",
        context: {
          ...baseContext,
          browser: values,
        },
      };
    }
    default:
      throw new Error(`Unsupported optional capability module: ${module.id}`);
  }
}

export function buildOptionalCapabilityDraftBundle(
  sourceId: string,
  selectedDrafts: readonly SetupDraft[]
): SetupDraftBundle {
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId,
    drafts: selectedDrafts,
    blockers: [...new Set(selectedDrafts.flatMap((draft) => draft.blockers))].sort(),
    warnings: [...new Set(selectedDrafts.flatMap((draft) => draft.warnings))].sort(),
    safeToApplyLater: selectedDrafts.every((draft) => draft.blockers.length === 0),
    metadata: {
      draftCount: selectedDrafts.length,
      requiresReviewCount: selectedDrafts.filter((draft) => draft.requiresReview).length,
      readOnlyCount: selectedDrafts.filter((draft) => draft.readOnly).length,
    },
  };
}

export function optionalPromptId(moduleId: string): OptionalCapabilityPromptId {
  if (moduleId === "telegram" || moduleId === "discord" || moduleId === "whatsapp" || moduleId === "voice" || moduleId === "vision" || moduleId === "browser") {
    return moduleId;
  }
  throw new Error(`Unsupported optional capability module: ${moduleId}`);
}

export function optionalCapabilityTitle(moduleId: string, locale: SetupCopyLocale): string {
  if (locale === "en") {
    switch (moduleId) {
      case "telegram":
        return "Telegram/channels";
      case "discord":
        return "Discord beta";
      case "whatsapp":
        return "WhatsApp beta";
      case "voice":
        return "Voice";
      case "vision":
        return "Vision and image generation";
      case "browser":
        return "Browser";
      default:
        return moduleId;
    }
  }

  switch (moduleId) {
    case "telegram":
      return setupCopyText(locale, "setupModules.telegram.title");
    case "discord":
      return setupCopyText(locale, "setupModules.discord.title");
    case "whatsapp":
      return setupCopyText(locale, "setupModules.whatsapp.title");
    case "voice":
      return setupCopyText(locale, "setupModules.voice.title");
    case "vision":
      return setupCopyText(locale, "setupModules.vision.title");
    case "browser":
      return setupCopyText(locale, "setupModules.browser.title");
    default:
      return moduleId;
  }
}

function hasTelegramAllowedIdentity(values: {
  readonly allowedUserIds?: readonly string[];
  readonly allowedChatIds?: readonly string[];
}): boolean {
  return (values.allowedUserIds?.length ?? 0) > 0 || (values.allowedChatIds?.length ?? 0) > 0;
}

function hasDiscordAllowedIdentity(values: {
  readonly allowedUsers?: readonly string[];
  readonly allowedChannels?: readonly string[];
}): boolean {
  return (values.allowedUsers?.length ?? 0) > 0 || (values.allowedChannels?.length ?? 0) > 0;
}

function defaultWhatsAppAuthDir(options: Pick<OptionalCapabilityContextOptions, "homeDir" | "profileId">): string {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  return `${resolveProfileStateHome({ homeDir: options.homeDir, profileId }).gatewayStatePath}/whatsapp-auth`;
}

function activeProfileConfigPath(options: Pick<OptionalCapabilityContextOptions, "homeDir" | "profileId">): string {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  return resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
}

function securityModeValue(value: unknown): SecurityApprovalMode {
  return value === "strict" || value === "adaptive" || value === "open" ? value : "adaptive";
}

function skillAutonomyValue(value: unknown): SkillAutonomy {
  return value === "none" || value === "suggest" || value === "proactive" || value === "autonomous"
    ? value
    : "suggest";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function voiceContext(config: EstaCodaConfig): SetupModuleContext["voice"] {
  const tts = recordValue(config.tts);
  const stt = recordValue(config.stt);
  const ttsProvider = ttsProviderValue(tts?.provider);
  const sttProvider = sttProviderValue(stt?.provider);
  const ttsProviderConfig = ttsProvider === undefined ? undefined : recordValue(tts?.[ttsProvider]);
  const sttProviderConfig = sttProvider === undefined ? undefined : recordValue(stt?.[sttProvider]);
  if (ttsProvider === undefined && sttProvider === undefined && ttsProviderConfig === undefined && sttProviderConfig === undefined) {
    return undefined;
  }

  return {
    ttsProvider,
    ttsModel: stringValue(ttsProviderConfig?.model),
    ttsApiKeyEnv: stringValue(ttsProviderConfig?.apiKeyEnv ?? ttsProviderConfig?.api_key_env),
    sttProvider,
    sttModel: stringValue(sttProviderConfig?.model),
    sttApiKeyEnv: stringValue(sttProviderConfig?.apiKeyEnv ?? sttProviderConfig?.api_key_env),
  };
}

function visionContext(config: EstaCodaConfig): SetupModuleContext["vision"] {
  const imageGen = recordValue(config.imageGen ?? config.image_gen);
  if (imageGen === undefined) return undefined;
  const provider = imageProviderValue(imageGen.provider);
  const providerConfig = provider === undefined ? undefined : recordValue(imageGen[provider]);

  return {
    provider,
    model: stringValue(imageGen.model ?? providerConfig?.model),
    apiKeyEnv: stringValue(imageGen.apiKeyEnv ?? imageGen.api_key_env ?? providerConfig?.apiKeyEnv ?? providerConfig?.api_key_env),
    useGateway: booleanValue(imageGen.useGateway ?? imageGen.use_gateway),
  };
}

function ttsProviderValue(value: unknown): TtsProvider | undefined {
  return value === "edge" ||
    value === "elevenlabs" ||
    value === "openai" ||
    value === "minimax" ||
    value === "mistral" ||
    value === "gemini" ||
    value === "xai" ||
    value === "neutts" ||
    value === "kittentts"
    ? value
    : undefined;
}

function sttProviderValue(value: unknown): SttProvider | undefined {
  return value === "local" || value === "groq" || value === "openai" || value === "mistral"
    ? value
    : undefined;
}

function imageProviderValue(value: unknown): ImageGenerationProvider | undefined {
  return value === "fal" || value === "byteplus" ? value : undefined;
}

function browserBackendValue(value: unknown): BrowserBackendKind | undefined {
  return value === "local-cdp" ||
    value === "browserbase" ||
    value === "firecrawl" ||
    value === "camofox" ||
    value === "mock" ||
    value === "unconfigured"
    ? value
    : undefined;
}

function browserCloudProviderValue(value: unknown): BrowserCloudProviderKind | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value as BrowserCloudProviderKind : undefined;
}
