import type { Prompt } from "../../cli/readline-prompt.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import type { BrowserBackendKind, BrowserCloudProviderKind } from "../../contracts/browser.js";
import type { AuxiliaryModelTask } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { BrowserEngineKind, ImageGenerationProvider, SttProvider, TtsProvider } from "../../config/runtime-config.js";
import type { ModelFallbackConfig } from "../../config/runtime-config.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import {
  formatSetupCopy,
  promptSetupChoice,
  type SetupChoice,
  promptSetupStringWithDefault,
  setupCsvPromptLabel,
  setupOutputLine,
  setupPromptLabel,
  setupPromptWithDefault,
  setupPromptContext,
  setupTechnicalToken,
  setupChoiceColumns,
  showSetupCard,
  setupTelegramAllowedChatIdsQuestion,
  setupTelegramAllowedUserIdsQuestion,
  setupTelegramBotTokenQuestion,
  setupCopyText,
} from "../setup-prompts.js";
import type { SetupCopyKey, SetupCopyLocale } from "../setup-copy.js";
import type { ConfigEditorRenderedAction } from "./render.js";
import { isolateLtr } from "../../ui/bidi.js";

export type OptionalCapabilityPromptAction = "unchanged" | "skip" | "enable";

export type OptionalCapabilityPromptId = "telegram" | "discord" | "whatsapp" | "voice" | "vision" | "web-search" | "browser";
export type WebSearchProviderChoice = "brave" | "ddgs" | "none";

export type ChannelCapabilityPromptId = "telegram" | "whatsapp" | "discord";

export type VoiceCapabilityPromptId = "stt" | "tts";

export type IncompleteTelegramCapabilityAction = "retry" | "skip" | "unchanged";

export type CredentialReuseChoice = "existing" | "new";

type BrowserSetupModeChoice =
  | "local-supervised"
  | "existing-cdp"
  | "browserbase"
  | "disabled";

export type BrowserModeChoice =
  | "recommended"
  | BrowserSetupModeChoice;

const promptedBrowserModes = new WeakMap<object, BrowserSetupModeChoice>();

export type FallbackRouteChoice =
  | {
      readonly id: "fallback-add";
      readonly fallbackOperation: "add";
    }
  | {
      readonly id: `fallback-${number}`;
      readonly fallbackOperation: "replace";
      readonly fallbackIndex: number;
      readonly fallback: ModelFallbackConfig;
    };

export const SETUP_EDITOR_AUXILIARY_TASKS = [
  "assessor",
  "compression",
  "session_search",
  "memory_compaction",
  "profile_context",
] as const satisfies readonly AuxiliaryModelTask[];

export type SetupEditorAuxiliaryTask = typeof SETUP_EDITOR_AUXILIARY_TASKS[number];

export type ConfigEditorPostApplyActionId =
  | "launch"
  | "accept-limited-mode"
  | "repair-again"
  | "exit";

export async function promptConfigEditorAction(
  prompt: Prompt,
  actions: readonly ConfigEditorRenderedAction[],
  defaultActionId?: string,
  locale: SetupCopyLocale = "en"
): Promise<ConfigEditorRenderedAction | undefined> {
  if (actions.length === 0) {
    return undefined;
  }

  const defaultAction = actions.find((action) => action.id === defaultActionId) ?? actions[0];
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.action.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.action.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: actions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      value: action,
    })),
    defaultValue: defaultAction,
  });
}

export async function promptSecurityMode(
  prompt: Prompt,
  currentValue: SecurityApprovalMode,
  locale: SetupCopyLocale = "en"
): Promise<SecurityApprovalMode> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.security.title"),
    message: `${setupCopyText(locale, "onboarding.security")}\n`,
    choices: [
      {
        id: "strict",
        label: setupCopyText(locale, "onboarding.security.options.strict.label"),
        description: setupCopyText(locale, "onboarding.security.options.strict.description"),
        value: "strict" as const,
      },
      {
        id: "adaptive",
        label: setupCopyText(locale, "onboarding.security.options.adaptive.label"),
        description: setupCopyText(locale, "onboarding.security.options.adaptive.description"),
        value: "adaptive" as const,
      },
      {
        id: "open",
        label: setupCopyText(locale, "onboarding.security.options.open.label"),
        description: setupCopyText(locale, "onboarding.security.options.open.description"),
        value: "open" as const,
      },
    ],
    defaultValue: currentValue,
  });
}

export async function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy,
  locale: SetupCopyLocale = "en"
): Promise<SkillAutonomy> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.workflowLearning.title"),
    message: `${setupCopyText(locale, "onboarding.workflowLearning")}\n`,
    choices: [
      {
        id: "none",
        label: setupCopyText(locale, "onboarding.workflowLearning.options.none.label"),
        description: setupCopyText(locale, "onboarding.workflowLearning.options.none.description"),
        value: "none" as const,
      },
      {
        id: "suggest",
        label: setupCopyText(locale, "onboarding.workflowLearning.options.suggest.label"),
        description: setupCopyText(locale, "onboarding.workflowLearning.options.suggest.description"),
        value: "suggest" as const,
      },
      {
        id: "proactive",
        label: setupCopyText(locale, "onboarding.workflowLearning.options.proactive.label"),
        description: setupCopyText(locale, "onboarding.workflowLearning.options.proactive.description"),
        value: "proactive" as const,
      },
      {
        id: "autonomous",
        label: setupCopyText(locale, "onboarding.workflowLearning.options.autonomous.label"),
        description: setupCopyText(locale, "onboarding.workflowLearning.options.autonomous.description"),
        value: "autonomous" as const,
      },
    ],
    defaultValue: currentValue,
  });
}

export async function promptWorkspaceTrustConfirmation(
  prompt: Prompt,
  input: {
    readonly workspaceRoot: string;
    readonly trustStorePath: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<boolean> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.workspace.trust.title"),
    message: [
      setupCopyText(locale, "onboarding.workspace.trust"),
      `Workspace: ${input.workspaceRoot}`,
      `Trust store: ${input.trustStorePath}`,
      "",
    ].join("\n"),
    choices: [
      {
        id: "trust",
        label: setupCopyText(locale, "onboarding.workspace.trustAction.label"),
        description: setupCopyText(locale, "onboarding.workspace.trustAction.description"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText(locale, "onboarding.review.cancelAction"),
        description: setupCopyText(locale, "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: false,
  });
}

export async function promptConfigEditorReviewApproval(
  prompt: Prompt,
  input: {
    readonly selectedActionId: string;
    readonly reviewManifest: SetupReviewManifest;
  },
  locale: SetupCopyLocale = "en"
): Promise<boolean> {
  const selectedArea = setupEditorReviewSelectedAreaLabel(input.selectedActionId, input.reviewManifest, locale);
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.review.title"),
    message: [
      setupCopyText(locale, "setupEditor.review.body"),
      formatSetupCopy(locale, "setupEditor.review.selectedArea", { selectedArea }),
      "",
    ].join("\n"),
    choices: [
      {
        id: "approve",
        label: setupCopyText(locale, "setupEditor.review.confirm"),
        description: setupCopyText(locale, "setupEditor.review.confirm.description"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText(locale, "setupEditor.review.cancel"),
        description: setupCopyText(locale, "setupEditor.review.cancel.description"),
        value: false,
      },
    ],
    defaultValue: true,
  });
}

export function setupEditorReviewSelectedAreaLabel(
  selectedActionId: string,
  reviewManifest: SetupReviewManifest,
  locale: SetupCopyLocale = "en"
): string {
  if (manifestHasChannel(reviewManifest, "telegram")) return selectedAreaLabel(locale, "Channels", "القنوات", "Telegram");
  if (manifestHasChannel(reviewManifest, "discord")) return selectedAreaLabel(locale, "Channels", "القنوات", "Discord");
  if (manifestHasChannel(reviewManifest, "whatsapp")) return selectedAreaLabel(locale, "Channels", "القنوات", "WhatsApp");

  switch (selectedActionId) {
    case "edit-primary-model-route":
    case "repair-primary-provider":
    case "edit-primary-credential-reference":
    case "repair-missing-credential":
    case "store-provider-credential-reference":
      return selectedAreaLabel(locale, "Model", "النموذج", locale === "ar" ? "الأساسي" : "Primary");
    case "edit-fallback-model-route":
      return selectedAreaLabel(locale, "Model", "النموذج", locale === "ar" ? "الاحتياطي" : "Fallback");
    case "edit-auxiliary-model-route":
      return selectedAreaLabel(locale, "Model", "النموذج", locale === "ar" ? "المساند" : "Auxiliary");
    case "edit-security-mode":
      return locale === "ar" ? "الأمان" : "Security";
    case "configure-voice":
      return locale === "ar" ? "الصوت" : "Voice";
    case "configure-image-generation":
      return locale === "ar" ? "توليد الصور" : "Image Generation";
    case "configure-browser":
      return locale === "ar" ? "المتصفح" : "Browser";
    case "edit-language":
      return locale === "ar" ? "اللغة" : "Language";
    case "edit-workflow-learning":
      return locale === "ar" ? "تطوّر الوكيل" : "Agent Evolution";
    default:
      return selectedAreaLabel(locale, "Model", "النموذج", locale === "ar" ? "الأساسي" : "Primary");
  }
}

function selectedAreaLabel(
  locale: SetupCopyLocale,
  englishCategory: string,
  arabicCategory: string,
  value: string
): string {
  return locale === "ar"
    ? `${arabicCategory} · ${selectedAreaArabicValue(value)}`
    : `${englishCategory} · ${value}`;
}

function selectedAreaArabicValue(value: string): string {
  return /[A-Za-z0-9]/u.test(value) ? isolateLtr(value) : value;
}

function manifestHasChannel(
  reviewManifest: SetupReviewManifest,
  channelId: "telegram" | "discord" | "whatsapp"
): boolean {
  const sourceId = `setup-module.${channelId}.capability`;
  if (reviewManifest.sourceBundleIds.some((bundleId) => bundleId.endsWith(`.${channelId}`))) {
    return true;
  }
  return reviewManifest.lines.some((line) =>
    line.sourceDraftIds.some((sourceDraftId) => sourceDraftId === sourceId) ||
    line.copyKey === `setupModules.${channelId}.review` ||
    line.summaryKey === `setupModules.${channelId}.review`
  );
}

export async function promptChannelCapability(
  prompt: Prompt,
  locale: SetupCopyLocale = "en"
): Promise<ChannelCapabilityPromptId> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.channels.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.channels.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "channel-telegram",
        label: setupCopyText(locale, "setupEditor.prompt.channels.telegram"),
        description: setupCopyText(locale, "setupEditor.prompt.channels.telegram.description"),
        value: "telegram" as const,
      },
      {
        id: "channel-whatsapp",
        label: setupCopyText(locale, "setupEditor.prompt.channels.whatsapp"),
        description: setupCopyText(locale, "setupEditor.prompt.channels.whatsapp.description"),
        value: "whatsapp" as const,
      },
      {
        id: "channel-discord",
        label: setupCopyText(locale, "setupEditor.prompt.channels.discord"),
        description: setupCopyText(locale, "setupEditor.prompt.channels.discord.description"),
        value: "discord" as const,
      },
    ],
    defaultValue: "telegram" as const,
  });
}

export async function promptCredentialReuseChoice(
  prompt: Prompt,
  locale: SetupCopyLocale = "en"
): Promise<CredentialReuseChoice> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.credentialReuse.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.credentialReuse.body")}\n`,
    choices: [
      {
        id: "existing",
        label: setupCopyText(locale, "setupEditor.prompt.credentialReuse.existing"),
        description: setupCopyText(locale, "setupEditor.prompt.credentialReuse.existing.description"),
        value: "existing" as const,
      },
      {
        id: "new",
        label: setupCopyText(locale, "setupEditor.prompt.credentialReuse.new"),
        description: setupCopyText(locale, "setupEditor.prompt.credentialReuse.new.description"),
        value: "new" as const,
      },
    ],
    defaultValue: "existing" as const,
  });
}

export async function promptWebSearchCapability(
  prompt: Prompt,
  current: {
    readonly searchBackend?: string;
    readonly braveApiKeyEnv?: string;
    readonly ddgsCapabilityStatus?: "ready" | "missing" | "failed" | "unknown";
  },
  locale: SetupCopyLocale = "en"
): Promise<
  | {
      readonly provider: "brave";
      readonly braveApiKeyEnv: string;
    }
  | {
      readonly provider: "ddgs";
      readonly ddgsSetupConfirmed: boolean;
    }
  | {
      readonly provider: "none";
    }
> {
  const defaultProvider: WebSearchProviderChoice = current.searchBackend === "brave" || current.searchBackend === "ddgs"
    ? current.searchBackend
    : "none";
  const provider = await promptSetupChoice<WebSearchProviderChoice>(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.webSearch.provider.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "web-search-brave",
        label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.brave"),
        description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.brave.description"),
        value: "brave" as const,
      },
      {
        id: "web-search-ddgs",
        label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.ddgs"),
        description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.ddgs.description"),
        value: "ddgs" as const,
      },
      {
        id: "web-search-none",
        label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.none"),
        description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.none.description"),
        value: "none" as const,
      },
    ],
    defaultValue: defaultProvider,
  });

  if (provider === "none") {
    return { provider };
  }

  if (provider === "brave") {
    return {
      provider,
      braveApiKeyEnv: current.braveApiKeyEnv ?? "BRAVE_SEARCH_API_KEY",
    };
  }

  if (current.ddgsCapabilityStatus === "ready") {
    return {
      provider,
      ddgsSetupConfirmed: false,
    };
  }

  const confirmed = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.install.title"),
    message: [
      setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.status.missing"),
      setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.install.body"),
      formatSetupCopy(locale, "setupEditor.prompt.webSearch.ddgs.command", {
        command: setupTechnicalToken(locale, "estacoda python-env setup ddgs"),
      }),
      "",
    ].join("\n"),
    choices: [
      {
        id: "web-search-ddgs-install-confirm",
        label: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.install.confirm"),
        description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.ddgs.description"),
        value: true,
      },
      {
        id: "web-search-ddgs-install-skip",
        label: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.install.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.notInstalled"),
        value: false,
      },
    ],
    defaultValue: false,
  });

  return {
    provider,
    ddgsSetupConfirmed: confirmed,
  };
}

export async function promptFallbackRouteAction(
  prompt: Prompt,
  fallbacks: readonly ModelFallbackConfig[],
  locale: SetupCopyLocale = "en"
): Promise<FallbackRouteChoice> {
  const editChoices: SetupChoice<FallbackRouteChoice>[] = fallbacks.map((fallback, index) => ({
    id: `fallback-${index}`,
    label: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.edit")
      .replace("{index}", String(index + 1))
      .replace("{providerId}", fallback.provider)
      .replace("{modelId}", fallback.id),
    description: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.edit.description"),
    value: {
      id: `fallback-${index}` as const,
      fallbackOperation: "replace" as const,
      fallbackIndex: index,
      fallback,
    },
  }));
  const addChoice: SetupChoice<FallbackRouteChoice> = {
    id: "fallback-add",
    label: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.add"),
    description: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.add.description"),
    value: {
      id: "fallback-add" as const,
      fallbackOperation: "add" as const,
    },
  };

  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.fallbackRoute.body")}\n`,
    choices: [...editChoices, addChoice],
    defaultValue: editChoices[0]?.value ?? addChoice.value,
  });
}

export async function promptAuxiliaryModelTask(
  prompt: Prompt,
  locale: SetupCopyLocale = "en"
): Promise<SetupEditorAuxiliaryTask> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "assessor",
        label: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.assessor"),
        description: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.assessor.description"),
        value: "assessor" as const,
      },
      {
        id: "compression",
        label: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.compression"),
        description: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.compression.description"),
        value: "compression" as const,
      },
      {
        id: "session_search",
        label: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.sessionSearch"),
        description: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.sessionSearch.description"),
        value: "session_search" as const,
      },
      {
        id: "memory_compaction",
        label: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.memoryCompaction"),
        description: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.memoryCompaction.description"),
        value: "memory_compaction" as const,
      },
      {
        id: "profile_context",
        label: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.profileContext"),
        description: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.profileContext.description"),
        value: "profile_context" as const,
      },
    ],
    defaultValue: "assessor" as const,
  });
}

export async function promptConfigEditorPostApplyAction(
  prompt: Prompt,
  input: {
    readonly state: "ready" | "degraded" | "blocked";
    readonly launchEligible: boolean;
    readonly limitedModeEligible: boolean;
  },
  locale: SetupCopyLocale = "en"
): Promise<ConfigEditorPostApplyActionId> {
  const launchChoices = input.launchEligible
    ? [{
        id: "launch",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.launch"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.launch.description"),
        value: "launch" as const,
      }]
    : [];
  const limitedChoices = input.limitedModeEligible
    ? [{
        id: "accept-limited-mode",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.acceptLimitedMode"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.acceptLimitedMode.description"),
        value: "accept-limited-mode" as const,
      }]
    : [];
  const repairChoices = input.state === "ready"
    ? []
    : [{
        id: "repair-again",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.repairAgain"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.repairAgain.description"),
        value: "repair-again" as const,
      }];

  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.postApply.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.postApply.body")}\n`,
    choices: [
      ...launchChoices,
      ...limitedChoices,
      ...repairChoices,
      {
        id: "exit",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.exit"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.exit.description"),
        value: "exit" as const,
      },
    ],
    defaultValue: "exit" as const,
  });
}

export async function promptOptionalCapabilityAction(
  prompt: Prompt,
  input: {
    readonly id: OptionalCapabilityPromptId;
    readonly title: string;
    readonly configured: boolean;
  },
  locale: SetupCopyLocale = "en"
): Promise<OptionalCapabilityPromptAction> {
  const skipChoice = input.configured
    ? []
    : [{
        id: `${input.id}-skip`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      }];

  return promptSetupChoice(prompt, {
    title: input.title,
    message: `${input.title}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: `${input.id}-enable`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure.description"),
        value: "enable" as const,
      },
      {
        id: `${input.id}-unchanged`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      },
      ...skipChoice,
    ],
    defaultValue: "enable" as const,
  });
}

export async function promptTelegramCapability(
  prompt: Prompt,
  current: {
    readonly botTokenEnv?: string;
    readonly allowedUserIds?: readonly string[];
    readonly allowedChatIds?: readonly string[];
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly botTokenEnv: string;
  readonly botToken?: string;
  readonly allowedUserIds: readonly string[];
  readonly allowedChatIds: readonly string[];
}> {
  const botTokenEnv = current.botTokenEnv ?? "ESTACODA_TELEGRAM_BOT_TOKEN";
  await showTelegramSetupInputCard(prompt, locale, "botToken");
  const botTokenInput = await promptForApiKeyInput({
    prompt,
    providerId: "telegram",
    envVarName: botTokenEnv,
    question: setupTelegramBotTokenQuestion(locale),
  });
  await showTelegramSetupInputCard(prompt, locale, "allowedUserIds");
  const allowedUserIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupTelegramAllowedUserIdsQuestion(locale),
    (current.allowedUserIds ?? []).join(",")
  ));
  await showTelegramSetupInputCard(prompt, locale, "allowedChatIds");
  const allowedChatIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupTelegramAllowedChatIdsQuestion(locale),
    (current.allowedChatIds ?? []).join(",")
  ));

  return {
    botTokenEnv,
    botToken: botTokenInput.kind === "entered" ? botTokenInput.value : undefined,
    allowedUserIds,
    allowedChatIds,
  };
}

type TelegramSetupInputCardKind = "botToken" | "allowedUserIds" | "allowedChatIds";

const TELEGRAM_SETUP_INPUT_CARD_KEYS: Record<TelegramSetupInputCardKind, {
  readonly heading: SetupCopyKey;
  readonly body: SetupCopyKey;
}> = {
  botToken: {
    heading: "setupEditor.prompt.telegram.botToken.heading",
    body: "setupEditor.prompt.telegram.botToken.body",
  },
  allowedUserIds: {
    heading: "setupEditor.prompt.telegram.allowedUserIds.heading",
    body: "setupEditor.prompt.telegram.allowedUserIds.body",
  },
  allowedChatIds: {
    heading: "setupEditor.prompt.telegram.allowedChatIds.heading",
    body: "setupEditor.prompt.telegram.allowedChatIds.body",
  },
};

async function showTelegramSetupInputCard(
  prompt: Prompt,
  locale: SetupCopyLocale,
  kind: TelegramSetupInputCardKind
): Promise<void> {
  const keys = TELEGRAM_SETUP_INPUT_CARD_KEYS[kind];
  const body = setupCopyText(locale, keys.body).split("\n");
  await showSetupCard(setupPromptContext(prompt, locale), {
    title: setupCopyText(locale, "setupEditor.prompt.telegram.card.title"),
    bodyLines: [setupCopyText(locale, keys.heading), "", ...body],
    options: [],
  });
}

export async function promptDiscordCapability(
  prompt: Prompt,
  current: {
    readonly botTokenEnv?: string;
    readonly allowedUsers?: readonly string[];
    readonly allowedGuilds?: readonly string[];
    readonly allowedChannels?: readonly string[];
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly botTokenEnv: string;
  readonly botToken?: string;
  readonly allowedUsers: readonly string[];
  readonly allowedGuilds: readonly string[];
  readonly allowedChannels: readonly string[];
}> {
  const botTokenEnv = await promptSetupStringWithDefault(
    prompt,
    [
      setupCopyText(locale, "setupEditor.prompt.discord.summary"),
      setupCopyText(locale, "setupEditor.prompt.discord.beta"),
      setupCopyText(locale, "setupEditor.prompt.discord.remoteControlRisk"),
      setupPromptWithDefault(
        locale,
        setupCopyText(locale, "setupEditor.prompt.discord.botTokenEnv"),
        "ESTACODA_DISCORD_BOT_TOKEN"
      ),
    ].join("\n"),
    current.botTokenEnv ?? "ESTACODA_DISCORD_BOT_TOKEN"
  );
  const botTokenInput = await promptForApiKeyInput({
    prompt,
    providerId: "discord",
    envVarName: botTokenEnv,
    question: setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.discord.botToken")),
  });
  const allowedUsers = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupCsvPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.discord.allowedUsers")),
    (current.allowedUsers ?? []).join(",")
  ));
  const allowedGuilds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupCsvPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.discord.allowedGuilds")),
    (current.allowedGuilds ?? []).join(",")
  ));
  const allowedChannels = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupCsvPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.discord.allowedChannels")),
    (current.allowedChannels ?? []).join(",")
  ));

  return {
    botTokenEnv,
    botToken: botTokenInput.kind === "entered" ? botTokenInput.value : undefined,
    allowedUsers,
    allowedGuilds,
    allowedChannels,
  };
}

export async function promptWhatsAppCapability(
  prompt: Prompt,
  current: {
    readonly authDir?: string;
    readonly allowedUsers?: readonly string[];
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly experimental: true;
  readonly authDir: string;
  readonly allowedUsers: readonly string[];
}> {
  const authDir = current.authDir ?? "";
  const allowedUsers = splitCsv(await promptSetupStringWithDefault(
    prompt,
    [
      setupCopyText(locale, "setupEditor.prompt.whatsapp.summary"),
      setupCopyText(locale, "setupEditor.prompt.whatsapp.beta"),
      setupCopyText(locale, "setupEditor.prompt.whatsapp.remoteControlRisk"),
      setupOutputLine(
        locale,
        `${setupCopyText(locale, "setupEditor.prompt.whatsapp.authDir")}: ${setupTechnicalToken(locale, authDir)}`
      ),
      setupCsvPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.whatsapp.allowedUsers")),
    ].join("\n"),
    (current.allowedUsers ?? []).join(",")
  ));

  return {
    experimental: true,
    authDir,
    allowedUsers,
  };
}

export async function promptIncompleteChannelCapabilityAction(
  prompt: Prompt,
  input: {
    readonly title: string;
    readonly bodyKey: "setupEditor.prompt.discord.incomplete.body" | "setupEditor.prompt.whatsapp.incomplete.body";
  },
  locale: SetupCopyLocale = "en"
): Promise<IncompleteTelegramCapabilityAction> {
  return promptSetupChoice(prompt, {
    title: input.title,
    message: [
      setupCopyText(locale, input.bodyKey),
      "",
    ].join("\n"),
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "channel-incomplete-retry",
        label: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry"),
        description: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry.description"),
        value: "retry" as const,
      },
      {
        id: "channel-incomplete-skip",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      },
      {
        id: "channel-incomplete-unchanged",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      },
    ],
    defaultValue: "skip" as const,
  });
}

export async function promptIncompleteTelegramCapabilityAction(
  prompt: Prompt,
  locale: SetupCopyLocale = "en"
): Promise<IncompleteTelegramCapabilityAction> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.telegram.title"),
    message: [
      setupCopyText(locale, "setupEditor.prompt.telegram.remoteControlRisk"),
      setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.body"),
      "",
    ].join("\n"),
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "telegram-incomplete-retry",
        label: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry"),
        description: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry.description"),
        value: "retry" as const,
      },
      {
        id: "telegram-incomplete-skip",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      },
      {
        id: "telegram-incomplete-unchanged",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      },
    ],
    defaultValue: "skip" as const,
  });
}

export async function promptVoiceCapability(
  prompt: Prompt,
  locale: SetupCopyLocale = "en"
): Promise<VoiceCapabilityPromptId> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.voice.mode.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.mode.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "voice-stt",
        label: setupCopyText(locale, "setupEditor.prompt.voice.mode.stt"),
        description: setupCopyText(locale, "setupEditor.prompt.voice.mode.stt.description"),
        value: "stt" as const,
      },
      {
        id: "voice-tts",
        label: setupCopyText(locale, "setupEditor.prompt.voice.mode.tts"),
        description: setupCopyText(locale, "setupEditor.prompt.voice.mode.tts.description"),
        value: "tts" as const,
      },
    ],
    defaultValue: "stt" as const,
  });
}

export async function promptTtsCapability(
  prompt: Prompt,
  current: {
    readonly ttsProvider?: TtsProvider;
    readonly ttsModel?: string;
    readonly ttsApiKeyEnv?: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly ttsProvider: TtsProvider;
  readonly ttsModel: string;
  readonly ttsApiKeyEnv: string;
}> {
  const ttsProvider = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.voice.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.summary")}\n${setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider")}\n`,
    columns: setupChoiceColumns(locale),
    choices: ttsProviders.map((provider) => ({
      id: `tts-${provider}`,
      label: provider,
      value: provider,
    })),
    defaultValue: current.ttsProvider ?? "openai",
  });
  const ttsModel = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.voice.ttsModel")),
    current.ttsModel ?? "gpt-4o-mini-tts"
  );
  const ttsApiKeyEnv = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.voice.ttsApiKeyEnv")),
    current.ttsApiKeyEnv ?? "OPENAI_API_KEY"
  );

  return {
    ttsProvider,
    ttsModel,
    ttsApiKeyEnv,
  };
}

export async function promptSttCapability(
  prompt: Prompt,
  current: {
    readonly sttProvider?: SttProvider;
    readonly sttModel?: string;
    readonly sttApiKeyEnv?: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly sttProvider: SttProvider;
  readonly sttModel: string;
  readonly sttApiKeyEnv: string;
}> {
  const sttProvider = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.voice.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.summary")}\n${setupCopyText(locale, "setupEditor.prompt.voice.sttProvider")}\n`,
    columns: setupChoiceColumns(locale),
    choices: sttProviders.map((provider) => ({
      id: `stt-${provider}`,
      label: provider === "local" ? setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.local") : provider,
      value: provider,
    })),
    defaultValue: current.sttProvider ?? "openai",
  });

  let sttModel: string;
  let sttApiKeyEnv: string;

  if (sttProvider === "local") {
    const defaultLocalModel = isSetupLocalSttModel(current.sttModel) ? current.sttModel : "base";
    sttModel = await promptSetupChoice(prompt, {
      title: setupCopyText(locale, "setupEditor.prompt.voice.localModel.title"),
      message: `${setupCopyText(locale, "setupEditor.prompt.voice.localModel")}\n`,
      columns: setupChoiceColumns(locale),
      choices: localSttModelChoices(locale),
      defaultValue: defaultLocalModel,
    });
    sttApiKeyEnv = "";
  } else {
    const defaultSttModel = sttProvider === "groq" ? "whisper-large-v3"
      : sttProvider === "mistral" ? "voxtral-mini-latest"
      : sttProvider === "xai" ? "whisper-1"
      : "gpt-4o-mini-transcribe";
    const defaultSttApiKeyEnv = sttProvider === "groq" ? "GROQ_API_KEY"
      : sttProvider === "mistral" ? "MISTRAL_API_KEY"
      : sttProvider === "xai" ? "XAI_API_KEY"
      : "OPENAI_API_KEY";
    sttModel = await promptSetupStringWithDefault(
      prompt,
      setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.voice.sttModel")),
      current.sttModel ?? defaultSttModel
    );
    sttApiKeyEnv = await promptSetupStringWithDefault(
      prompt,
      setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.voice.sttApiKeyEnv")),
      current.sttApiKeyEnv ?? defaultSttApiKeyEnv
    );
  }

  return {
    sttProvider,
    sttModel,
    sttApiKeyEnv,
  };
}

type SetupLocalSttModel = "base" | "small" | "medium";

function isSetupLocalSttModel(value: string | undefined): value is SetupLocalSttModel {
  return value === "base" || value === "small" || value === "medium";
}

function localSttModelChoices(locale: SetupCopyLocale): readonly SetupChoice<SetupLocalSttModel>[] {
  return [
    {
      id: "local-stt-model-base",
      label: setupCopyText(locale, "setupEditor.prompt.voice.localModel.base"),
      description: setupCopyText(locale, "setupEditor.prompt.voice.localModel.base.description"),
      value: "base",
    },
    {
      id: "local-stt-model-small",
      label: setupCopyText(locale, "setupEditor.prompt.voice.localModel.small"),
      description: setupCopyText(locale, "setupEditor.prompt.voice.localModel.small.description"),
      value: "small",
    },
    {
      id: "local-stt-model-medium",
      label: setupCopyText(locale, "setupEditor.prompt.voice.localModel.medium"),
      description: setupCopyText(locale, "setupEditor.prompt.voice.localModel.medium.description"),
      value: "medium",
    },
  ];
}

export async function promptVisionCapability(
  prompt: Prompt,
  current: {
    readonly provider?: ImageGenerationProvider;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly useGateway?: boolean;
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly provider: ImageGenerationProvider;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly useGateway: boolean;
}> {
  const provider = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.vision.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.vision.summary")}\n${setupCopyText(locale, "setupEditor.prompt.vision.provider")}\n`,
    columns: setupChoiceColumns(locale),
    choices: imageProviders.map((candidate) => ({
      id: candidate,
      label: candidate,
      value: candidate,
    })),
    defaultValue: current.provider ?? "fal",
  });
  const model = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.vision.model")),
    current.model ?? "fal-ai/imagen4/preview"
  );
  const apiKeyEnv = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.vision.apiKeyEnv")),
    current.apiKeyEnv ?? "FAL_KEY"
  );
  const useGateway = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.vision.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.vision.useGateway")}?\n`,
    choices: [
      { id: "gateway-no", label: "No", value: false },
      { id: "gateway-yes", label: "Yes", value: true },
    ],
    defaultValue: current.useGateway ?? false,
  });

  return {
    provider,
    model,
    apiKeyEnv,
    useGateway,
  };
}

export async function promptBrowserCapability(
  prompt: Prompt,
  current: {
    readonly backend?: BrowserBackendKind;
    readonly cloudProvider?: BrowserCloudProviderKind;
    readonly cdpUrl?: string;
    readonly launchExecutable?: string;
    readonly launchArgs?: readonly string[];
    readonly chromeFlags?: readonly string[];
    readonly launchCommand?: string;
    readonly autoLaunch?: boolean;
    readonly supervised?: boolean;
    readonly engine?: BrowserEngineKind;
    readonly hybridRouting?: boolean;
    readonly cloudFallback?: boolean;
    readonly cloudSpendApproved?: boolean;
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly backend: BrowserBackendKind;
  readonly cloudProvider?: BrowserCloudProviderKind;
  readonly cdpUrl?: string;
  readonly launchExecutable?: string;
  readonly launchArgs: string[];
  readonly chromeFlags: string[];
  readonly launchCommand?: string;
  readonly autoLaunch: boolean;
  readonly supervised?: boolean;
  readonly engine?: BrowserEngineKind;
  readonly hybridRouting?: boolean;
  readonly cloudFallback?: boolean;
  readonly cloudSpendApproved?: boolean;
}> {
  const mode = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.browser.mode.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.browser.mode.body")}\n`,
    columns: setupChoiceColumns(locale),
    choices: [
      {
        id: "browser-recommended",
        label: setupCopyText(locale, "setupEditor.prompt.browser.mode.recommended"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.mode.recommended.description"),
        value: "recommended" as const,
      },
      {
        id: "browser-local-supervised",
        label: setupCopyText(locale, "setupEditor.prompt.browser.mode.localSupervised"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.mode.localSupervised.description"),
        value: "local-supervised" as const,
      },
      {
        id: "browser-existing-cdp",
        label: setupCopyText(locale, "setupEditor.prompt.browser.mode.existingCdp"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.mode.existingCdp.description"),
        value: "existing-cdp" as const,
      },
      {
        id: "browser-browserbase",
        label: setupCopyText(locale, "setupEditor.prompt.browser.mode.browserbase"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.mode.browserbase.description"),
        value: "browserbase" as const,
      },
      {
        id: "browser-disabled",
        label: setupCopyText(locale, "setupEditor.prompt.browser.mode.disable"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.mode.disable.description"),
        value: "disabled" as const,
      },
    ],
    defaultValue: isRecommendedBrowserConfig(current) ? "recommended" : browserModeFromCurrent(current),
  });

  if (mode === "recommended") {
    return browserCapabilityWithMode({
      backend: "local-cdp",
      autoLaunch: true,
      supervised: true,
      engine: "cdp",
      launchArgs: [],
      chromeFlags: [],
      hybridRouting: false,
    }, "local-supervised");
  }

  if (mode === "disabled") {
    return browserCapabilityWithMode({
      backend: "unconfigured",
      launchArgs: [],
      chromeFlags: [],
      autoLaunch: false,
      supervised: false,
    }, mode);
  }

  if (mode === "browserbase") {
    await showSetupCard(setupPromptContext(prompt, locale), {
      title: setupCopyText(locale, "setupEditor.prompt.browser.cloud.title"),
      bodyLines: [
        setupCopyText(locale, "setupEditor.prompt.browser.cloud.body"),
        "",
        setupCopyText(locale, "setupEditor.prompt.browser.hybridRouting.description"),
        setupCopyText(locale, "setupEditor.prompt.browser.cloudFallback.description"),
      ],
      options: [],
    });
    return browserCapabilityWithMode({
      backend: "browserbase",
      cloudProvider: "browserbase",
      launchArgs: [],
      chromeFlags: [],
      autoLaunch: false,
      supervised: false,
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: false,
    }, mode);
  }

  if (mode === "existing-cdp") {
    const cdpUrl = await promptSetupStringWithDefault(
      prompt,
      setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.browser.cdpUrl.required")),
      current.cdpUrl ?? ""
    );
    return browserCapabilityWithMode({
      backend: "local-cdp",
      cdpUrl: optionalTrimmedString(cdpUrl),
      launchArgs: [],
      chromeFlags: [],
      launchCommand: current.launchCommand,
      autoLaunch: false,
      supervised: true,
    }, mode);
  }

  const autoLaunch = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.browser.local.title"),
    message: [
      setupCopyText(locale, "setupEditor.prompt.browser.local.body"),
      setupCopyText(locale, "setupEditor.prompt.browser.autoLaunch"),
      "",
    ].join("\n"),
    choices: [
      {
        id: "browser-auto-launch-yes",
        label: setupCopyText(locale, "setupEditor.prompt.browser.autoLaunch.yes"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.autoLaunch.description"),
        value: true,
      },
      {
        id: "browser-auto-launch-no",
        label: setupCopyText(locale, "setupEditor.prompt.browser.autoLaunch.no"),
        description: setupCopyText(locale, "setupEditor.prompt.browser.autoLaunch.no.description"),
        value: false,
      },
    ],
    defaultValue: current.autoLaunch ?? false,
  });
  const cdpUrl = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.browser.cdpUrl.optional")),
    current.cdpUrl ?? ""
  );
  const launchExecutable = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.browser.launchExecutable")),
    current.launchExecutable ?? ""
  );
  const launchArgsInput = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.browser.launchArgs")),
    current.launchArgs?.join(", ") ?? ""
  );
  const chromeFlagsInput = await promptSetupStringWithDefault(
    prompt,
    setupPromptLabel(locale, setupCopyText(locale, "setupEditor.prompt.browser.chromeFlags")),
    current.chromeFlags?.join(", ") ?? ""
  );

  return browserCapabilityWithMode({
    backend: "local-cdp",
    cdpUrl: optionalTrimmedString(cdpUrl),
    launchExecutable: optionalTrimmedString(launchExecutable),
    launchArgs: splitCsv(launchArgsInput),
    chromeFlags: splitCsv(chromeFlagsInput),
    launchCommand: current.launchCommand,
    autoLaunch,
    supervised: true,
  }, "local-supervised");
}

export function promptedBrowserCapabilityMode(values: object): BrowserSetupModeChoice | undefined {
  return promptedBrowserModes.get(values);
}

function browserCapabilityWithMode<T extends object>(values: T, mode: BrowserSetupModeChoice): T {
  promptedBrowserModes.set(values, mode);
  return values;
}

const ttsProviders: readonly TtsProvider[] = ["edge", "elevenlabs", "openai", "minimax", "mistral", "gemini", "xai", "neutts", "kittentts"];
const sttProviders: readonly SttProvider[] = ["local", "groq", "openai", "mistral"];
const imageProviders: readonly ImageGenerationProvider[] = ["fal", "byteplus"];
function browserModeFromCurrent(current: {
  readonly backend?: BrowserBackendKind;
  readonly cloudProvider?: BrowserCloudProviderKind;
  readonly autoLaunch?: boolean;
  readonly cdpUrl?: string;
}): BrowserSetupModeChoice {
  if (current.backend === "unconfigured") return "disabled";
  if (current.backend === "browserbase" || current.cloudProvider === "browserbase") return "browserbase";
  if (current.backend === "local-cdp" && current.autoLaunch !== true && current.cdpUrl !== undefined && current.cdpUrl.trim().length > 0) {
    return "existing-cdp";
  }
  return "local-supervised";
}

function isRecommendedBrowserConfig(current: {
  readonly backend?: BrowserBackendKind;
  readonly autoLaunch?: boolean;
  readonly supervised?: boolean;
  readonly cdpUrl?: string;
  readonly launchExecutable?: string;
  readonly launchArgs?: readonly string[];
  readonly chromeFlags?: readonly string[];
  readonly engine?: BrowserEngineKind;
}): boolean {
  return current.backend === "local-cdp" &&
    current.autoLaunch === true &&
    current.supervised === true &&
    current.cdpUrl === undefined &&
    current.launchExecutable === undefined &&
    (current.launchArgs === undefined || current.launchArgs.length === 0) &&
    (current.chromeFlags === undefined || current.chromeFlags.length === 0) &&
    (current.engine === undefined || current.engine === "cdp");
}

function optionalTrimmedString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
