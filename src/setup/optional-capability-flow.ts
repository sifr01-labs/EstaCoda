import type { BrowserBackendKind, BrowserCloudProviderKind } from "../contracts/browser.js";
import type { ProviderId } from "../contracts/provider.js";
import type {
  EstaCodaConfig,
  BrowserEngineKind,
  ImageGenerationProvider,
  SttProvider,
  TtsProvider,
} from "../config/runtime-config.js";
import { hasSavedEnvSecret } from "../config/env-secret-store.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { DDGS_CAPABILITY_ID } from "../python-env/capability-registry.js";
import { checkManagedPythonCapabilityStatus } from "../python-env/capability-manager.js";
import type { Prompt } from "../cli/readline-prompt.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { SetupCopyLocale } from "./setup-copy.js";
import { formatSetupCopy, setupCopyText, setupOutputLine, setupTechnicalToken } from "./setup-prompts.js";
import type { SetupDeferredSecretWrite } from "./setup-apply-plan.js";
import type { SetupDraft, SetupDraftBundle } from "./setup-drafts.js";
import { BROWSERBASE_CREDENTIAL_ENV_VARS } from "./browser-diagnostics.js";
import {
  browserSetupModule,
  discordSetupModule,
  telegramSetupModule,
  visionSetupModule,
  voiceSetupModule,
  webSearchSetupModule,
  whatsappSetupModule,
  type SetupModuleContext,
} from "./setup-modules.js";
import type { SetupRouteDecision } from "./setup-router.js";
import {
  promptBrowserCapability,
  promptedBrowserCapabilityMode,
  promptDiscordCapability,
  promptIncompleteChannelCapabilityAction,
  promptIncompleteTelegramCapabilityAction,
  promptSttCapability,
  promptTelegramCapability,
  promptTtsCapability,
  promptVisionCapability,
  promptWebSearchCapability,
  promptWhatsAppCapability,
  type BrowserCapabilityResult,
  type OptionalCapabilityPromptId,
  type SttCapabilityResult,
  type TtsCapabilityResult,
  type VisionCapabilityResult,
  type VoiceCapabilityPromptId,
  type WebSearchCapabilityResult,
} from "./config-editor/prompts.js";

export type OptionalCapabilityModule =
  | typeof telegramSetupModule
  | typeof discordSetupModule
  | typeof whatsappSetupModule
  | typeof voiceSetupModule
  | typeof visionSetupModule
  | typeof webSearchSetupModule
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
      readonly pendingCredentialWrites?: readonly SetupDeferredSecretWrite[];
    }
  | {
      readonly kind: "skip" | "unchanged";
    };

export type OptionalCapabilityCollectionBackResult = {
  readonly kind: "back";
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
  const web = recordValue(config.web);
  const brave = recordValue(web?.brave);
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
          engine: browserEngineValue(browser.engine),
          hybridRouting: booleanValue(browser.hybridRouting),
          cloudFallback: booleanValue(browser.cloudFallback),
          cloudSpendApproved: booleanValue(browser.cloudSpendApproved),
        },
    voice,
    vision,
    web: web === undefined
      ? undefined
      : {
          searchBackend: stringValue(web.searchBackend ?? web.search_backend),
          extractBackend: stringValue(web.extractBackend ?? web.extract_backend),
          crawlBackend: stringValue(web.crawlBackend ?? web.crawl_backend),
          braveApiKeyEnv: stringValue(brave?.apiKeyEnv ?? brave?.api_key_env),
        },
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
    case "configure-web-search":
      return webSearchSetupModule;
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

export function collectOptionalCapabilityContext(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  baseContext: SetupModuleContext,
  module: OptionalCapabilityModule,
  voiceMode: VoiceCapabilityPromptId | undefined,
  navigation: { readonly allowBack: true }
): Promise<OptionalCapabilityCollectionResult | OptionalCapabilityCollectionBackResult>;
export function collectOptionalCapabilityContext(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  baseContext: SetupModuleContext,
  module: OptionalCapabilityModule,
  voiceMode?: VoiceCapabilityPromptId,
  navigation?: { readonly allowBack?: false }
): Promise<OptionalCapabilityCollectionResult>;
export async function collectOptionalCapabilityContext(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  baseContext: SetupModuleContext,
  module: OptionalCapabilityModule,
  voiceMode?: VoiceCapabilityPromptId,
  navigation: { readonly allowBack?: boolean } = {}
): Promise<OptionalCapabilityCollectionResult | OptionalCapabilityCollectionBackResult> {
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
            pendingCredentialWrites: pendingCredentialWrite === undefined ? [] : [pendingCredentialWrite],
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
            pendingCredentialWrites: pendingCredentialWrite === undefined ? [] : [pendingCredentialWrite],
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
        ? await promptSttCapabilityWithOptionalBack(options, baseContext.voice ?? {}, navigation)
        : await promptTtsCapabilityWithOptionalBack(options, baseContext.voice ?? {}, navigation);
      if (isOptionalCapabilityBack(values)) {
        return values;
      }
      return {
        kind: "configured",
        context: {
          ...baseContext,
          voice: values,
        },
      };
    }
    case "vision": {
      const values = await promptVisionCapabilityWithOptionalBack(options, baseContext.vision ?? {}, navigation);
      if (isOptionalCapabilityBack(values)) {
        return values;
      }
      return {
        kind: "configured",
        context: {
          ...baseContext,
          vision: values,
        },
      };
    }
    case "web-search": {
      const ddgsCapabilityStatus = await detectDdgsCapabilityStatus(options);
      const values = await promptWebSearchCapabilityWithOptionalBack(options, {
        ...baseContext.web,
        ddgsCapabilityStatus,
      }, navigation);
      if (isOptionalCapabilityBack(values)) {
        return values;
      }

      if (values.provider === "none") {
        return { kind: "skip" };
      }

      if (values.provider === "brave") {
        const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
        const hasCredentialSource = await hasExistingEnvCredentialSource({
          homeDir: options.homeDir,
          profileId,
          envVarName: values.braveApiKeyEnv,
        });
        const pendingCredentialWrites: SetupDeferredSecretWrite[] = [];
        if (!hasCredentialSource) {
          const entered = await options.prompt(braveSearchCredentialQuestion(options.locale, values.braveApiKeyEnv), { secret: true });
          if (entered.trim().length > 0) {
            pendingCredentialWrites.push({ envVarName: values.braveApiKeyEnv, value: entered });
          }
        }

        return {
          kind: "configured",
          context: {
            ...baseContext,
            web: {
              ...baseContext.web,
              searchBackend: "brave",
              braveApiKeyEnv: values.braveApiKeyEnv,
              braveCredentialReady: hasCredentialSource || pendingCredentialWrites.length > 0,
              braveCredentialValuesIncluded: false,
            },
          },
          pendingCredentialWrites,
        };
      }

      if (ddgsCapabilityStatus !== "ready" && !values.ddgsSetupConfirmed) {
        return { kind: "skip" };
      }

      return {
        kind: "configured",
        context: {
          ...baseContext,
          web: {
            ...baseContext.web,
            searchBackend: "ddgs",
            ddgsCapabilityId: DDGS_CAPABILITY_ID,
            ddgsCapabilityStatus,
            ddgsSetupConfirmed: values.ddgsSetupConfirmed,
          },
        },
      };
    }
    case "browser": {
      const values = await promptBrowserCapabilityWithOptionalBack(options, baseContext.browser ?? {}, navigation);
      if (isOptionalCapabilityBack(values)) {
        return values;
      }
      const browserbaseCredentials = values.backend === "browserbase"
        ? await collectBrowserbaseCredentials(options)
        : undefined;
      return {
        kind: "configured",
        context: {
          ...baseContext,
          browser: {
            ...values,
            browserMode: promptedBrowserCapabilityMode(values),
            ...(browserbaseCredentials === undefined
              ? {}
              : {
                  credentialSurface: "browserbase",
                  credentialEnvVars: browserbaseCredentials.envVars,
                  credentialReady: browserbaseCredentials.blockers.length === 0,
                  credentialValuesIncluded: false,
                  credentialBlockers: browserbaseCredentials.blockers,
                }),
          },
        },
        pendingCredentialWrites: browserbaseCredentials?.pendingCredentialWrites ?? [],
      };
    }
    default:
      throw new Error(`Unsupported optional capability module: ${module.id}`);
  }
}

function isOptionalCapabilityBack(value: unknown): value is OptionalCapabilityCollectionBackResult {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "back";
}

async function promptTtsCapabilityWithOptionalBack(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  current: NonNullable<SetupModuleContext["voice"]> | Record<string, never>,
  navigation: { readonly allowBack?: boolean }
): Promise<TtsCapabilityResult | OptionalCapabilityCollectionBackResult> {
  if (navigation.allowBack === true) {
    return promptTtsCapability(options.prompt, current, options.locale, { allowBack: true });
  }
  return promptTtsCapability(options.prompt, current, options.locale);
}

async function promptSttCapabilityWithOptionalBack(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  current: NonNullable<SetupModuleContext["voice"]> | Record<string, never>,
  navigation: { readonly allowBack?: boolean }
): Promise<SttCapabilityResult | OptionalCapabilityCollectionBackResult> {
  if (navigation.allowBack === true) {
    return promptSttCapability(options.prompt, current, options.locale, { allowBack: true });
  }
  return promptSttCapability(options.prompt, current, options.locale);
}

async function promptVisionCapabilityWithOptionalBack(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  current: NonNullable<SetupModuleContext["vision"]> | Record<string, never>,
  navigation: { readonly allowBack?: boolean }
): Promise<VisionCapabilityResult | OptionalCapabilityCollectionBackResult> {
  if (navigation.allowBack === true) {
    return promptVisionCapability(options.prompt, current, options.locale, { allowBack: true });
  }
  return promptVisionCapability(options.prompt, current, options.locale);
}

async function promptWebSearchCapabilityWithOptionalBack(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  current: NonNullable<SetupModuleContext["web"]>,
  navigation: { readonly allowBack?: boolean }
): Promise<WebSearchCapabilityResult | OptionalCapabilityCollectionBackResult> {
  if (navigation.allowBack === true) {
    return promptWebSearchCapability(options.prompt, current, options.locale, { allowBack: true });
  }
  return promptWebSearchCapability(options.prompt, current, options.locale);
}

async function promptBrowserCapabilityWithOptionalBack(
  options: OptionalCapabilityContextOptions & {
    readonly prompt: Prompt;
    readonly locale: SetupCopyLocale;
  },
  current: NonNullable<SetupModuleContext["browser"]> | Record<string, never>,
  navigation: { readonly allowBack?: boolean }
): Promise<BrowserCapabilityResult | OptionalCapabilityCollectionBackResult> {
  if (navigation.allowBack === true) {
    return promptBrowserCapability(options.prompt, current, options.locale, { allowBack: true });
  }
  return promptBrowserCapability(options.prompt, current, options.locale);
}

async function collectBrowserbaseCredentials(options: OptionalCapabilityContextOptions & {
  readonly prompt: Prompt;
  readonly locale: SetupCopyLocale;
}): Promise<{
  readonly envVars: readonly string[];
  readonly pendingCredentialWrites: readonly SetupDeferredSecretWrite[];
  readonly blockers: readonly string[];
}> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const pendingCredentialWrites: SetupDeferredSecretWrite[] = [];
  const blockers: string[] = [];

  for (const envVarName of BROWSERBASE_CREDENTIAL_ENV_VARS) {
    if (await hasExistingBrowserbaseCredentialSource({
      homeDir: options.homeDir,
      profileId,
      envVarName,
    })) {
      continue;
    }

    const entered = await options.prompt(browserbaseCredentialQuestion(options.locale, envVarName), { secret: true });
    if (entered.trim().length > 0) {
      pendingCredentialWrites.push({ envVarName, value: entered });
      continue;
    }

    blockers.push(`Browserbase requires ${envVarName} from the environment, profile secret store, or reviewed setup entry.`);
  }

  return {
    envVars: [...BROWSERBASE_CREDENTIAL_ENV_VARS],
    pendingCredentialWrites,
    blockers,
  };
}

async function detectDdgsCapabilityStatus(options: Pick<OptionalCapabilityContextOptions, "homeDir">): Promise<NonNullable<SetupModuleContext["web"]>["ddgsCapabilityStatus"]> {
  const stateRoot = resolveGlobalStateHome({ homeDir: options.homeDir }).stateRoot;
  try {
    const status = await checkManagedPythonCapabilityStatus({
      stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
    });
    if (status.ok) return "ready";
    return status.reason === "install_required" || status.reason === "upgrade_required" ? "missing" : "failed";
  } catch {
    return "unknown";
  }
}

async function hasExistingBrowserbaseCredentialSource(input: {
  readonly homeDir?: string;
  readonly profileId: string;
  readonly envVarName: string;
}): Promise<boolean> {
  return hasExistingEnvCredentialSource(input);
}

async function hasExistingEnvCredentialSource(input: {
  readonly homeDir?: string;
  readonly profileId: string;
  readonly envVarName: string;
}): Promise<boolean> {
  if ((process.env[input.envVarName] ?? "").trim().length > 0) {
    return true;
  }
  const saved = await hasSavedEnvSecret({
    homeDir: input.homeDir,
    profileId: input.profileId,
    key: input.envVarName,
  });
  return saved.exists;
}

function browserbaseCredentialQuestion(locale: SetupCopyLocale, envVarName: string): string {
  return setupOutputLine(locale, `${formatSetupCopy(locale, "setupEditor.prompt.browser.browserbaseCredential", {
    envVar: setupTechnicalToken(locale, envVarName),
    serviceName: setupTechnicalToken(locale, "Browserbase"),
  })} `);
}

function braveSearchCredentialQuestion(locale: SetupCopyLocale, envVarName: string): string {
  return setupOutputLine(locale, `${formatSetupCopy(locale, "setupEditor.prompt.webSearch.brave.secretValue", {
    envVar: setupTechnicalToken(locale, envVarName),
    serviceName: setupTechnicalToken(locale, "Brave Search"),
  })} `);
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
  if (moduleId === "telegram" || moduleId === "discord" || moduleId === "whatsapp" || moduleId === "voice" || moduleId === "vision" || moduleId === "web-search" || moduleId === "browser") {
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
      case "web-search":
        return "Search";
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
    case "web-search":
      return setupCopyText(locale, "setupModules.webSearch.title");
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

function browserEngineValue(value: unknown): BrowserEngineKind | undefined {
  return value === "cdp" || value === "agent-browser" || value === "auto" ? value : undefined;
}
