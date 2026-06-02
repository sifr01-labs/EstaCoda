import type { Prompt } from "../../cli/readline-prompt.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import type { BrowserBackendKind } from "../../contracts/browser.js";
import type { AuxiliaryModelTask, ModelProfile } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { ImageGenerationProvider, SttProvider, TtsProvider } from "../../config/runtime-config.js";
import type { ModelFallbackConfig } from "../../config/runtime-config.js";
import type { ModelCandidate, ProviderCandidate } from "../../providers/provider-model-selection-flow.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import {
  formatSetupCopy,
  promptSetupChoice,
  type SetupChoice,
  promptSetupStringWithDefault,
  setupPromptContext,
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

export type OptionalCapabilityPromptId = "telegram" | "discord" | "whatsapp" | "voice" | "vision" | "browser";

export type ChannelCapabilityPromptId = "telegram" | "whatsapp" | "discord";

export type VoiceCapabilityPromptId = "stt" | "tts";

export type IncompleteTelegramCapabilityAction = "retry" | "skip" | "unchanged";

export type CredentialReuseChoice = "existing" | "new";

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

export async function promptProviderCandidate(
  prompt: Prompt,
  input: {
    readonly candidates: readonly ProviderCandidate[];
    readonly currentProviderId?: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<ProviderCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.providers.primary.title"),
    message: `${setupCopyText(locale, "onboarding.providers.primary")}\n`,
    choices: input.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.displayName,
      description: candidate.baseUrl
        ? `${candidate.baseUrl} (${candidate.modelsCount} models)`
        : `${candidate.modelsCount} models`,
      value: candidate,
    })),
    defaultValue: input.candidates.find((candidate) => candidate.id === input.currentProviderId) ?? input.candidates[0],
  });
}

export async function promptModelCandidate(
  prompt: Prompt,
  input: {
    readonly providerId: string;
    readonly candidates: readonly ModelCandidate[];
    readonly currentModelId?: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<ModelCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.providers.primaryModel.title"),
    message: `${setupCopyText(locale, "onboarding.providers.primaryModel").replace("{providerId}", input.providerId)}\n`,
    choices: input.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.id,
      description: [
        candidate.profile.supportsTools ? setupCopyText(locale, "onboarding.catalog.model.features.tools") : undefined,
        candidate.profile.supportsVision ? setupCopyText(locale, "onboarding.catalog.model.features.vision") : undefined,
        candidate.profile.supportsReasoning ? setupCopyText(locale, "onboarding.catalog.model.features.reasoning") : undefined,
        renderableModelStatus(candidate.profile.status),
      ].filter((part): part is string => part !== undefined).join(", "),
      value: candidate,
    })),
    defaultValue: input.candidates.find((candidate) => candidate.id === input.currentModelId) ?? input.candidates[0],
  });
}

function renderableModelStatus(status: ModelProfile["status"]): ModelProfile["status"] | undefined {
  return status === "alpha" || status === "beta" || status === "deprecated" ? status : undefined;
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
    choices: [
      {
        id: `${input.id}-unchanged`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      },
      ...skipChoice,
      {
        id: `${input.id}-enable`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure.description"),
        value: "enable" as const,
      },
    ],
    defaultValue: "unchanged" as const,
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
      `${setupCopyText(locale, "setupEditor.prompt.discord.botTokenEnv")} [ESTACODA_DISCORD_BOT_TOKEN]: `,
    ].join("\n"),
    current.botTokenEnv ?? "ESTACODA_DISCORD_BOT_TOKEN"
  );
  const botTokenInput = await promptForApiKeyInput({
    prompt,
    providerId: "discord",
    envVarName: botTokenEnv,
    question: `${setupCopyText(locale, "setupEditor.prompt.discord.botToken")}: `,
  });
  const allowedUsers = splitCsv(await promptSetupStringWithDefault(
    prompt,
    `${setupCopyText(locale, "setupEditor.prompt.discord.allowedUsers")}, comma-separated: `,
    (current.allowedUsers ?? []).join(",")
  ));
  const allowedGuilds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    `${setupCopyText(locale, "setupEditor.prompt.discord.allowedGuilds")}, comma-separated: `,
    (current.allowedGuilds ?? []).join(",")
  ));
  const allowedChannels = splitCsv(await promptSetupStringWithDefault(
    prompt,
    `${setupCopyText(locale, "setupEditor.prompt.discord.allowedChannels")}, comma-separated: `,
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
      `${setupCopyText(locale, "setupEditor.prompt.whatsapp.authDir")}: ${authDir}`,
      `${setupCopyText(locale, "setupEditor.prompt.whatsapp.allowedUsers")}, comma-separated: `,
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
    choices: ttsProviders.map((provider) => ({
      id: `tts-${provider}`,
      label: provider,
      value: provider,
    })),
    defaultValue: current.ttsProvider ?? "openai",
  });
  const ttsModel = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.voice.ttsModel")}: `, current.ttsModel ?? "gpt-4o-mini-tts");
  const ttsApiKeyEnv = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.voice.ttsApiKeyEnv")}: `, current.ttsApiKeyEnv ?? "OPENAI_API_KEY");

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
    choices: sttProviders.map((provider) => ({
      id: `stt-${provider}`,
      label: provider,
      value: provider,
    })),
    defaultValue: current.sttProvider ?? "openai",
  });

  let sttModel: string;
  let sttApiKeyEnv: string;

  if (sttProvider === "local") {
    sttModel = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.voice.sttModel")}: `, current.sttModel ?? "base");
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
    sttModel = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.voice.sttModel")}: `, current.sttModel ?? defaultSttModel);
    sttApiKeyEnv = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.voice.sttApiKeyEnv")}: `, current.sttApiKeyEnv ?? defaultSttApiKeyEnv);
  }

  return {
    sttProvider,
    sttModel,
    sttApiKeyEnv,
  };
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
    choices: imageProviders.map((candidate) => ({
      id: candidate,
      label: candidate,
      value: candidate,
    })),
    defaultValue: current.provider ?? "fal",
  });
  const model = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.vision.model")}: `, current.model ?? "fal-ai/imagen4/preview");
  const apiKeyEnv = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.vision.apiKeyEnv")}: `, current.apiKeyEnv ?? "FAL_KEY");
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
    readonly cdpUrl?: string;
    readonly launchCommand?: string;
  },
  locale: SetupCopyLocale = "en"
): Promise<{
  readonly backend: BrowserBackendKind;
  readonly cdpUrl: string;
  readonly launchCommand: string;
  readonly autoLaunch: false;
}> {
  const backend = await promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupModules.browser.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.browser.summary")}\n${setupCopyText(locale, "setupEditor.prompt.browser.backend")}\n`,
    choices: browserBackends.map((candidate) => ({
      id: candidate,
      label: candidate,
      value: candidate,
    })),
    defaultValue: current.backend ?? "local-cdp",
  });
  const cdpUrl = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.browser.cdpUrl")}: `, current.cdpUrl ?? "http://127.0.0.1:9222");
  const launchCommand = await promptSetupStringWithDefault(prompt, `${setupCopyText(locale, "setupEditor.prompt.browser.launchCommand")}: `, current.launchCommand ?? "");

  return {
    backend,
    cdpUrl,
    launchCommand,
    autoLaunch: false,
  };
}

const ttsProviders: readonly TtsProvider[] = ["edge", "elevenlabs", "openai", "minimax", "mistral", "gemini", "xai", "neutts", "kittentts"];
const sttProviders: readonly SttProvider[] = ["local", "groq", "openai", "mistral"];
const imageProviders: readonly ImageGenerationProvider[] = ["fal", "byteplus"];
const browserBackends: readonly BrowserBackendKind[] = ["local-cdp", "browserbase", "firecrawl", "camofox", "mock"];

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
