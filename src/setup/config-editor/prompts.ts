import type { Prompt } from "../../cli/prompt-contract.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import type { BrowserBackendKind, BrowserCloudProviderKind } from "../../contracts/browser.js";
import { defaultImageApiKeyEnv, defaultImageBaseUrl, defaultImageModel, IMAGE_MODEL_OPTIONS, resolveImageModel } from "../../contracts/image-generation.js";
import type { AuxiliaryModelTask } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { PromptCardStatusLine } from "../../contracts/view-model.js";
import type { BrowserEngineKind, ImageGenerationProvider, SttProvider, TtsProvider } from "../../config/runtime-config.js";
import type { ModelFallbackConfig } from "../../config/runtime-config.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import type {
  OpenAICompatibleAuthSelection,
  OpenAICompatibleChatTestSelection,
  OpenAICompatibleEndpointAction,
  OpenAICompatibleEndpointIntroAction,
  OpenAICompatibleEndpointFlowUi,
  OpenAICompatibleModelSelection,
  OpenAICompatibleSummaryDecision,
} from "../openai-compatible-endpoint-flow.js";
import {
  formatSetupCopy,
  promptSetupChoice,
  promptSetupChoiceResult,
  type SetupChoice,
  type SetupChoiceResult,
  type PromptSetupChoiceInput,
  promptSetupStringWithDefault,
  setupCsvPromptLabel,
  setupOutputLine,
  setupPromptLabel,
  setupPromptWithDefault,
  setupPromptContext,
  setupTechnicalToken,
  setupChoiceColumns,
  setupChoiceTableAlign,
  setupChoiceTableDirection,
  setupChoiceTableMaxWidth,
  setupChoiceTableWidth,
  setupCurrentStatusLines,
  setupNavigationChoice,
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

type BackPromptOptions = {
  readonly allowBack?: boolean;
};

type BackEnabled = {
  readonly allowBack: true;
};

export type WebSearchCapabilityResult =
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
    };

export type TtsCapabilityResult = {
  readonly ttsProvider: TtsProvider;
};

export type SttCapabilityResult = {
  readonly sttProvider: SttProvider;
};

export type VisionCapabilityResult = {
  readonly provider: ImageGenerationProvider;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly useGateway: boolean;
};

export type BrowserCapabilityResult = {
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
};

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
  locale: SetupCopyLocale = "en",
  options: {
    readonly statusLines?: readonly PromptCardStatusLine[];
  } = {}
): Promise<ConfigEditorRenderedAction | undefined> {
  if (actions.length === 0) {
    return undefined;
  }

  const defaultAction = actions.find((action) => action.id === defaultActionId) ?? actions[0];
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.action.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.action.body")}\n`,
    bodyLineStyles: [{ emphasis: "strong" }],
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    ...(options.statusLines === undefined ? {} : { statusLines: options.statusLines }),
    choices: actions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      group: action.group,
      value: action,
    })),
    defaultValue: defaultAction,
  });
}

export function createOpenAICompatibleEndpointFlowUi(
  prompt: Prompt,
  locale: SetupCopyLocale
): OpenAICompatibleEndpointFlowUi {
  const target = setupPromptContext(prompt, locale);
  return {
    selectEndpointIntro: ({ currentRoute, text }) => promptSetupChoice<OpenAICompatibleEndpointIntroAction>(prompt, {
      title: text.title,
      message: [
        text.body,
        "",
        text.process,
        "",
      ].join("\n"),
      statusLines: [
        {
          text: currentRoute === undefined ? text.currentNone : text.current,
          tone: "active",
          direction: locale === "ar" ? "rtl" : "ltr",
        },
        {
          text: text.hasCurrentEndpoint ? text.endpoint : text.defaultEndpoint,
          tone: "active",
          direction: locale === "ar" ? "rtl" : "ltr",
        },
      ],
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        {
          id: "continue-local-custom-endpoint",
          label: text.continue,
          description: text.continueDescription,
          value: "continue" as const,
        },
        {
          id: "change-local-custom-endpoint",
          label: text.changeEndpoint,
          description: text.changeEndpointDescription,
          value: "change-endpoint" as const,
        },
        setupNavigationChoice({
          id: "cancel",
          label: setupCopyText(locale, "setupEditor.review.cancel"),
          description: setupCopyText(locale, "setupEditor.review.cancel.description"),
          value: "cancel" as const,
        }),
      ],
      defaultValue: "continue" as const,
    }),
    promptBaseUrl: async ({ defaultBaseUrl, text, error }) => {
      if (error !== undefined) {
        await showSetupCard(target, {
          title: text.title,
          bodyLines: [error],
          options: [],
        });
      }
      return promptSetupStringWithDefault(prompt, setupOutputLine(locale, text.baseUrlQuestion), defaultBaseUrl);
    },
    selectEndpointAction: ({ baseUrl, authConfigured, text }) => promptSetupChoice(prompt, {
      title: text.title,
      message: `${text.body}\n${text.destination}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        {
          id: "check-endpoint",
          label: text.check,
          description: authConfigured
            ? setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.discoveredBadge")
            : setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.destination").replace("{baseUrl}", baseUrl),
          value: "check" as const,
        },
        {
          id: "continue-manually",
          label: text.manual,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.models.enterManual"),
          value: "manual" as const,
        },
        {
          id: "configure-authentication",
          label: text.auth,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.body"),
          value: "auth" as const,
        },
        setupNavigationChoice({
          id: "cancel",
          label: setupCopyText(locale, "setupEditor.review.cancel"),
          description: setupCopyText(locale, "setupEditor.review.cancel.description"),
          value: "cancel" as const,
        }),
      ],
      defaultValue: "check" as const,
    }),
    showChecking: ({ message }) => {
      void showSetupCard(target, {
        title: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.title"),
        bodyLines: [message],
        options: [],
      });
    },
    selectModel: ({ probe, choices, text }) => promptSetupChoice<OpenAICompatibleModelSelection>(prompt, {
      title: text.title,
      message: [
        probe.ok ? text.discovered : text.failed,
        ...(text.failureReason === undefined ? [] : [text.failureReason]),
        ...(!probe.ok || probe.models.length === 0 ? [text.possibleCauses] : []),
        "",
      ].join("\n"),
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        ...choices.map((choice) => ({
          id: `model-${choice.modelId}`,
          label: choice.label,
          description: choice.description,
          value: { kind: "model" as const, modelId: choice.modelId },
        })),
        {
          id: "manual-model-id",
          label: text.enterManual,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.sourceManual"),
          value: { kind: "manual" as const },
        },
        {
          id: "configure-authentication",
          label: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.auth"),
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.auth.body"),
          value: { kind: "configure-auth" as const },
        },
        {
          id: "change-endpoint",
          label: text.changeEndpoint,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.endpoint.changeEndpoint.description"),
          value: { kind: "change-endpoint" as const },
        },
        setupNavigationChoice({
          id: "cancel",
          label: setupCopyText(locale, "setupEditor.review.cancel"),
          description: setupCopyText(locale, "setupEditor.review.cancel.description"),
          value: { kind: "cancel" as const },
        }),
      ],
      defaultValue: choices.length > 0
        ? { kind: "model" as const, modelId: choices[0]!.modelId }
        : { kind: "manual" as const },
    }) as Promise<OpenAICompatibleModelSelection>,
    promptManualModelId: async ({ text }) => prompt(setupOutputLine(locale, `${text.question} `)),
    promptContextWindowTokens: async ({ text }) => {
      for (;;) {
        const raw = (await prompt(setupOutputLine(locale, `${text.question} `))).trim();
        if (raw.length === 0) return undefined;
        const tokens = Number.parseInt(raw, 10);
        if (Number.isFinite(tokens) && tokens > 0) return tokens;
        await showSetupCard(target, {
          title: text.question,
          bodyLines: [text.hint],
          options: [],
        });
      }
    },
    selectAuth: ({ defaultEnvVar, text }) => promptSetupChoice<OpenAICompatibleAuthSelection>(prompt, {
      title: text.title,
      message: `${text.body}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        {
          id: "no-api-key",
          label: text.none,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.authNone"),
          value: "none" as const,
        },
        {
          id: "env-api-key",
          label: text.env,
          description: formatSetupCopy(locale, "setupEditor.prompt.openaiCompatible.summary.authEnv", {
            envVar: defaultEnvVar,
          }),
          value: "env" as const,
        },
        {
          id: "enter-api-key",
          label: text.enter,
          description: text.secretStorage,
          value: "enter" as const,
        },
        setupNavigationChoice({
          id: "cancel",
          label: setupCopyText(locale, "setupEditor.review.cancel"),
          description: setupCopyText(locale, "setupEditor.review.cancel.description"),
          value: "cancel" as const,
        }),
      ],
      defaultValue: "none" as const,
    }) as Promise<OpenAICompatibleAuthSelection>,
    promptAuthEnvVar: async ({ defaultEnvVar, text }) =>
      promptSetupStringWithDefault(prompt, setupOutputLine(locale, text.envQuestion), defaultEnvVar),
    promptSecret: async ({ text }) => {
      await showSetupCard(target, {
        title: text.title,
        bodyLines: [text.secretStorage],
        options: [],
      });
      return prompt(setupOutputLine(locale, `${text.secretQuestion} `), { secret: true });
    },
    selectChatCompletionTest: ({ text }) => promptSetupChoice<OpenAICompatibleChatTestSelection>(prompt, {
      title: text.title,
      message: `${text.body}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        {
          id: "run-chat-test",
          label: text.run,
          description: text.body,
          value: "run" as const,
        },
        {
          id: "skip-chat-test",
          label: text.skip,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.test.notTested"),
          value: "skip" as const,
        },
      ],
      defaultValue: "run" as const,
    }) as Promise<OpenAICompatibleChatTestSelection>,
    confirmSummary: ({ text }) => promptSetupChoice<OpenAICompatibleSummaryDecision>(prompt, {
      title: text.title,
      message: `${text.lines.join("\n")}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      choices: [
        {
          id: "review-openai-compatible",
          label: text.review,
          description: setupCopyText(locale, "setupEditor.prompt.openaiCompatible.summary.review"),
          value: "review" as const,
        },
        setupNavigationChoice({
          id: "back",
          label: locale === "ar" ? "رجوع" : "Back",
          description: setupCopyText(locale, "onboarding.providers.navigation.back.description"),
          value: "back" as const,
        }),
        setupNavigationChoice({
          id: "cancel",
          label: setupCopyText(locale, "setupEditor.review.cancel"),
          description: setupCopyText(locale, "setupEditor.review.cancel.description"),
          value: "cancel" as const,
        }),
      ],
      defaultValue: "review" as const,
    }) as Promise<OpenAICompatibleSummaryDecision>,
  };
}

async function promptSetupChoiceMaybeBack<T>(
  prompt: Prompt,
  input: PromptSetupChoiceInput<T>,
  options: BackPromptOptions = {}
): Promise<T | SetupChoiceResult<T>> {
  if (options.allowBack === true) {
    return promptSetupChoiceResult(prompt, {
      ...input,
      allowBack: true,
    });
  }
  return promptSetupChoice(prompt, input);
}

function isSetupChoiceBackResult<T>(
  result: T | SetupChoiceResult<T>
): result is Extract<SetupChoiceResult<T>, { readonly kind: "back" }> {
  return typeof result === "object" && result !== null && "kind" in result && result.kind === "back";
}

function setupChoiceSelectedValue<T>(result: T | SetupChoiceResult<T>): T {
  if (typeof result === "object" && result !== null && "kind" in result && result.kind === "selected") {
    return result.value;
  }
  return result as T;
}

export function promptSecurityMode(
  prompt: Prompt,
  currentValue: SecurityApprovalMode,
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<SecurityApprovalMode>>;
export function promptSecurityMode(
  prompt: Prompt,
  currentValue: SecurityApprovalMode,
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<SecurityApprovalMode>;
export async function promptSecurityMode(
  prompt: Prompt,
  currentValue: SecurityApprovalMode,
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<SecurityApprovalMode | SetupChoiceResult<SecurityApprovalMode>> {
  const choices = [
    {
      id: "strict",
      label: setupCopyText(locale, "onboarding.security.options.strict.label"),
      description: setupCopyText(locale, "onboarding.security.options.strict.description"),
      value: "strict" as const,
      current: currentValue === "strict",
    },
    {
      id: "adaptive",
      label: setupCopyText(locale, "onboarding.security.options.adaptive.label"),
      description: setupCopyText(locale, "onboarding.security.options.adaptive.description"),
      value: "adaptive" as const,
      current: currentValue === "adaptive",
    },
    {
      id: "open",
      label: setupCopyText(locale, "onboarding.security.options.open.label"),
      description: setupCopyText(locale, "onboarding.security.options.open.description"),
      value: "open" as const,
      current: currentValue === "open",
    },
  ] as const;
  const currentLabel = choices.find((choice) => choice.value === currentValue)?.label ?? currentValue;
  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "onboarding.security.title"),
    message: `${setupCopyText(locale, "onboarding.security")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    statusLines: setupCurrentStatusLines(locale, currentLabel),
    showCurrentBadge: false,
    choices,
    defaultValue: currentValue,
  }, options);
}

export function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy,
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<SkillAutonomy>>;
export function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy,
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<SkillAutonomy>;
export async function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy,
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<SkillAutonomy | SetupChoiceResult<SkillAutonomy>> {
  const choices = [
    {
      id: "suggest",
      label: setupCopyText(locale, "onboarding.workflowLearning.options.suggest.label"),
      description: setupCopyText(locale, "onboarding.workflowLearning.options.suggest.description"),
      value: "suggest" as const,
      current: currentValue === "suggest",
    },
    {
      id: "proactive",
      label: setupCopyText(locale, "onboarding.workflowLearning.options.proactive.label"),
      description: setupCopyText(locale, "onboarding.workflowLearning.options.proactive.description"),
      value: "proactive" as const,
      current: currentValue === "proactive",
    },
    {
      id: "autonomous",
      label: setupCopyText(locale, "onboarding.workflowLearning.options.autonomous.label"),
      description: setupCopyText(locale, "onboarding.workflowLearning.options.autonomous.description"),
      value: "autonomous" as const,
      current: currentValue === "autonomous",
    },
    {
      id: "none",
      label: setupCopyText(locale, "onboarding.workflowLearning.options.none.label"),
      description: setupCopyText(locale, "onboarding.workflowLearning.options.none.description"),
      value: "none" as const,
      current: currentValue === "none",
    },
  ] as const;
  const currentLabel = choices.find((choice) => choice.value === currentValue)?.label ?? currentValue;
  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "onboarding.workflowLearning.title"),
    message: `${setupCopyText(locale, "onboarding.workflowLearning")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    statusLines: setupCurrentStatusLines(locale, currentLabel),
    showCurrentBadge: false,
    choices,
    defaultValue: currentValue,
  }, options);
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
      setupNavigationChoice({
        id: "cancel",
        label: setupCopyText(locale, "onboarding.review.cancelAction"),
        description: setupCopyText(locale, "setupApply.review.cancelled"),
        value: false,
      }),
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
    statusLines: [
      {
        text: `${setupCopyText(locale, "setupEditor.status.pendingChanges")}: ${selectedArea}`,
        tone: "warning",
        direction: locale === "ar" ? "rtl" : "ltr",
      },
    ],
    choices: [
      {
        id: "approve",
        label: setupCopyText(locale, "setupEditor.review.confirm"),
        description: setupCopyText(locale, "setupEditor.review.confirm.description"),
        value: true,
      },
      setupNavigationChoice({
        id: "cancel",
        label: setupCopyText(locale, "setupEditor.review.cancel"),
        description: setupCopyText(locale, "setupEditor.review.cancel.description"),
        value: false,
      }),
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
    case "add-custom-provider-route":
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

export function promptChannelCapability(
  prompt: Prompt,
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<ChannelCapabilityPromptId>>;
export function promptChannelCapability(
  prompt: Prompt,
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<ChannelCapabilityPromptId>;
export async function promptChannelCapability(
  prompt: Prompt,
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<ChannelCapabilityPromptId | SetupChoiceResult<ChannelCapabilityPromptId>> {
  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.channels.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.channels.body")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
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
  }, options);
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

export function promptWebSearchCapability(
  prompt: Prompt,
  current: {
    readonly searchBackend?: string;
    readonly braveApiKeyEnv?: string;
    readonly ddgsCapabilityStatus?: "ready" | "missing" | "failed" | "unknown";
  },
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<WebSearchCapabilityResult | { readonly kind: "back" }>;
export function promptWebSearchCapability(
  prompt: Prompt,
  current: {
    readonly searchBackend?: string;
    readonly braveApiKeyEnv?: string;
    readonly ddgsCapabilityStatus?: "ready" | "missing" | "failed" | "unknown";
  },
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<WebSearchCapabilityResult>;
export async function promptWebSearchCapability(
  prompt: Prompt,
  current: {
    readonly searchBackend?: string;
    readonly braveApiKeyEnv?: string;
    readonly ddgsCapabilityStatus?: "ready" | "missing" | "failed" | "unknown";
  },
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<WebSearchCapabilityResult | { readonly kind: "back" }> {
  const defaultProvider: WebSearchProviderChoice = current.searchBackend === "brave" || current.searchBackend === "ddgs"
    ? current.searchBackend
    : "none";
  const currentProvider = current.searchBackend === "brave" || current.searchBackend === "ddgs"
    ? current.searchBackend
    : undefined;
  const providerChoices = [
    {
      id: "web-search-brave",
      label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.brave"),
      description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.brave.description"),
      value: "brave" as const,
      current: currentProvider === "brave",
    },
    {
      id: "web-search-ddgs",
      label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.ddgs"),
      description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.ddgs.description"),
      value: "ddgs" as const,
      current: currentProvider === "ddgs",
    },
    {
      id: "web-search-none",
      label: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.none"),
      description: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.none.description"),
      value: "none" as const,
      current: false,
    },
  ] as const;
  const currentProviderLabel = providerChoices.find((choice) => choice.value === currentProvider)?.label;
  while (true) {
    const providerResult = await promptSetupChoiceMaybeBack<WebSearchProviderChoice>(prompt, {
      title: setupCopyText(locale, "setupEditor.prompt.webSearch.provider.title"),
      message: `${setupCopyText(locale, "setupEditor.prompt.webSearch.provider.body")}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      statusLines: setupCurrentStatusLines(locale, currentProviderLabel),
      showCurrentBadge: currentProviderLabel === undefined ? undefined : false,
      choices: providerChoices,
      defaultValue: defaultProvider,
    }, options);
    if (isSetupChoiceBackResult(providerResult)) {
      return providerResult;
    }
    const provider = setupChoiceSelectedValue(providerResult);

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

    const confirmedResult = await promptSetupChoiceMaybeBack(prompt, {
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
        setupNavigationChoice({
          id: "web-search-ddgs-install-skip",
          label: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.install.skip"),
          description: setupCopyText(locale, "setupEditor.prompt.webSearch.ddgs.notInstalled"),
          value: false,
        }),
      ],
      defaultValue: false,
    }, options);
    if (isSetupChoiceBackResult(confirmedResult)) {
      continue;
    }
    const confirmed = setupChoiceSelectedValue(confirmedResult);

    return {
      provider,
      ddgsSetupConfirmed: confirmed,
    };
  }
}

export function promptFallbackRouteAction(
  prompt: Prompt,
  fallbacks: readonly ModelFallbackConfig[],
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<FallbackRouteChoice>>;
export function promptFallbackRouteAction(
  prompt: Prompt,
  fallbacks: readonly ModelFallbackConfig[],
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<FallbackRouteChoice>;
export async function promptFallbackRouteAction(
  prompt: Prompt,
  fallbacks: readonly ModelFallbackConfig[],
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<FallbackRouteChoice | SetupChoiceResult<FallbackRouteChoice>> {
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

  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.fallbackRoute.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.fallbackRoute.body")}\n`,
    choices: [...editChoices, addChoice],
    defaultValue: editChoices[0]?.value ?? addChoice.value,
  }, options);
}

export function promptAuxiliaryModelTask(
  prompt: Prompt,
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<SetupEditorAuxiliaryTask>>;
export function promptAuxiliaryModelTask(
  prompt: Prompt,
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<SetupEditorAuxiliaryTask>;
export async function promptAuxiliaryModelTask(
  prompt: Prompt,
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<SetupEditorAuxiliaryTask | SetupChoiceResult<SetupEditorAuxiliaryTask>> {
  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.auxiliaryRoute.body")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
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
  }, options);
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
    ? [setupNavigationChoice({
        id: "launch",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.launch"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.launch.description"),
        value: "launch" as const,
      })]
    : [];
  const limitedChoices = input.limitedModeEligible
    ? [setupNavigationChoice({
        id: "accept-limited-mode",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.acceptLimitedMode"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.acceptLimitedMode.description"),
        value: "accept-limited-mode" as const,
      })]
    : [];
  const repairChoices = input.state === "ready"
    ? []
    : [setupNavigationChoice({
        id: "repair-again",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.repairAgain"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.repairAgain.description"),
        value: "repair-again" as const,
      })];

  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.postApply.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.postApply.body")}\n`,
    choices: [
      ...launchChoices,
      ...limitedChoices,
      ...repairChoices,
      setupNavigationChoice({
        id: "exit",
        label: setupCopyText(locale, "setupEditor.prompt.postApply.exit"),
        description: setupCopyText(locale, "setupEditor.prompt.postApply.exit.description"),
        value: "exit" as const,
      }),
    ],
    defaultValue: "exit" as const,
  });
}

export function promptOptionalCapabilityAction(
  prompt: Prompt,
  input: {
    readonly id: OptionalCapabilityPromptId;
    readonly title: string;
    readonly configured: boolean;
  },
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<OptionalCapabilityPromptAction>>;
export function promptOptionalCapabilityAction(
  prompt: Prompt,
  input: {
    readonly id: OptionalCapabilityPromptId;
    readonly title: string;
    readonly configured: boolean;
  },
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<OptionalCapabilityPromptAction>;
export async function promptOptionalCapabilityAction(
  prompt: Prompt,
  input: {
    readonly id: OptionalCapabilityPromptId;
    readonly title: string;
    readonly configured: boolean;
  },
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<OptionalCapabilityPromptAction | SetupChoiceResult<OptionalCapabilityPromptAction>> {
  const skipChoice = input.configured
    ? []
    : [setupNavigationChoice({
        id: `${input.id}-skip`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      })];
  const message = input.id === "telegram"
    ? setupCopyText(locale, "setupEditor.prompt.telegram.summary")
    : input.title;

  return promptSetupChoiceMaybeBack(prompt, {
    title: input.title,
    message: `${message}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    choices: [
      {
        id: `${input.id}-enable`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.enableConfigure.description"),
        value: "enable" as const,
      },
      setupNavigationChoice({
        id: `${input.id}-unchanged`,
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      }),
      ...skipChoice,
    ],
    defaultValue: "enable" as const,
  }, options);
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
    title: telegramSetupInputTitle(locale),
    description: telegramSetupInputDescription(locale, "botToken"),
  });
  await showTelegramSetupInputCard(prompt, locale, "allowedUserIds");
  const allowedUserIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupTelegramAllowedUserIdsQuestion(locale),
    (current.allowedUserIds ?? []).join(","),
    telegramSetupInputDescription(locale, "allowedUserIds"),
    telegramSetupInputTitle(locale)
  ));
  await showTelegramSetupInputCard(prompt, locale, "allowedChatIds");
  const allowedChatIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    setupTelegramAllowedChatIdsQuestion(locale),
    (current.allowedChatIds ?? []).join(","),
    telegramSetupInputDescription(locale, "allowedChatIds"),
    telegramSetupInputTitle(locale)
  ));

  return {
    botTokenEnv,
    botToken: botTokenInput.kind === "entered" ? botTokenInput.value : undefined,
    allowedUserIds,
    allowedChatIds,
  };
}

function telegramSetupInputTitle(locale: SetupCopyLocale): string {
  return locale === "ar" ? "𓂀 ضبط Telegram" : "𓂀 Telegram Setup";
}

function telegramSetupInputDescription(locale: SetupCopyLocale, kind: TelegramSetupInputCardKind): string {
  const keys = TELEGRAM_SETUP_INPUT_CARD_KEYS[kind];
  return [
    setupCopyText(locale, keys.heading),
    "",
    setupCopyText(locale, keys.body),
  ].join("\n");
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
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    choices: [
      setupNavigationChoice({
        id: "channel-incomplete-retry",
        label: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry"),
        description: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry.description"),
        value: "retry" as const,
      }),
      setupNavigationChoice({
        id: "channel-incomplete-skip",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      }),
      setupNavigationChoice({
        id: "channel-incomplete-unchanged",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      }),
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
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    choices: [
      setupNavigationChoice({
        id: "telegram-incomplete-retry",
        label: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry"),
        description: setupCopyText(locale, "setupEditor.prompt.telegram.incomplete.retry.description"),
        value: "retry" as const,
      }),
      setupNavigationChoice({
        id: "telegram-incomplete-skip",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.skip.description"),
        value: "skip" as const,
      }),
      setupNavigationChoice({
        id: "telegram-incomplete-unchanged",
        label: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged"),
        description: setupCopyText(locale, "setupEditor.prompt.optionalCapabilityAction.leaveUnchanged.description"),
        value: "unchanged" as const,
      }),
    ],
    defaultValue: "skip" as const,
  });
}

export function promptVoiceCapability(
  prompt: Prompt,
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SetupChoiceResult<VoiceCapabilityPromptId>>;
export function promptVoiceCapability(
  prompt: Prompt,
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<VoiceCapabilityPromptId>;
export async function promptVoiceCapability(
  prompt: Prompt,
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<VoiceCapabilityPromptId | SetupChoiceResult<VoiceCapabilityPromptId>> {
  return promptSetupChoiceMaybeBack(prompt, {
    title: setupCopyText(locale, "setupEditor.prompt.voice.mode.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.mode.body")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
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
  }, options);
}

export function promptTtsCapability(
  prompt: Prompt,
  current: {
    readonly ttsProvider?: TtsProvider;
  },
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<TtsCapabilityResult | { readonly kind: "back" }>;
export function promptTtsCapability(
  prompt: Prompt,
  current: {
    readonly ttsProvider?: TtsProvider;
  },
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<TtsCapabilityResult>;
export async function promptTtsCapability(
  prompt: Prompt,
  current: {
    readonly ttsProvider?: TtsProvider;
  },
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<TtsCapabilityResult | { readonly kind: "back" }> {
  const defaultProvider = current.ttsProvider ?? "edge";
  const currentTtsRoute = current.ttsProvider;
  const ttsProviderResult = await promptSetupChoiceMaybeBack<TtsProvider>(prompt, {
    title: setupCopyText(locale, "setupModules.voice.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.body")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    statusLines: setupCurrentStatusLines(locale, currentTtsRoute),
    showCurrentBadge: currentTtsRoute === undefined ? undefined : false,
    choices: ttsProviders.map((provider) => ({
      id: `tts-${provider}`,
      label: ttsProviderLabel(provider),
      description: ttsProviderDescription(locale, provider),
      current: current.ttsProvider === provider,
      value: provider,
    })),
    defaultValue: defaultProvider,
  }, options);
  if (isSetupChoiceBackResult(ttsProviderResult)) {
    return ttsProviderResult;
  }

  return {
    ttsProvider: setupChoiceSelectedValue(ttsProviderResult),
  };
}

export function promptSttCapability(
  prompt: Prompt,
  current: {
    readonly sttProvider?: SttProvider;
  },
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<SttCapabilityResult | { readonly kind: "back" }>;
export function promptSttCapability(
  prompt: Prompt,
  current: {
    readonly sttProvider?: SttProvider;
  },
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<SttCapabilityResult>;
export async function promptSttCapability(
  prompt: Prompt,
  current: {
    readonly sttProvider?: SttProvider;
  },
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<SttCapabilityResult | { readonly kind: "back" }> {
  const defaultProvider = current.sttProvider ?? "local";
  const currentSttRoute = current.sttProvider;
  const sttProviderResult = await promptSetupChoiceMaybeBack<SttProvider>(prompt, {
    title: setupCopyText(locale, "setupModules.voice.title"),
    message: `${setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.body")}\n`,
    columns: setupChoiceColumns(locale),
    tableDirection: setupChoiceTableDirection(locale),
    tableWidth: setupChoiceTableWidth(locale),
    tableMaxWidth: setupChoiceTableMaxWidth(locale),
    tableAlign: setupChoiceTableAlign(locale),
    showColumnHeaders: false,
    statusLines: setupCurrentStatusLines(locale, currentSttRoute),
    showCurrentBadge: currentSttRoute === undefined ? undefined : false,
    choices: sttProviders.map((provider) => ({
      id: `stt-${provider}`,
      label: provider === "local" ? setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.local") : provider,
      description: sttProviderDescription(locale, provider),
      current: current.sttProvider === provider,
      value: provider,
    })),
    defaultValue: defaultProvider,
  }, options);
  if (isSetupChoiceBackResult(sttProviderResult)) {
    return sttProviderResult;
  }
  return {
    sttProvider: setupChoiceSelectedValue(sttProviderResult),
  };
}

export function promptVisionCapability(
  prompt: Prompt,
  current: {
    readonly provider?: ImageGenerationProvider;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly baseUrl?: string;
    readonly useGateway?: boolean;
  },
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<VisionCapabilityResult | { readonly kind: "back" }>;
export function promptVisionCapability(
  prompt: Prompt,
  current: {
    readonly provider?: ImageGenerationProvider;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly baseUrl?: string;
    readonly useGateway?: boolean;
  },
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<VisionCapabilityResult>;
export async function promptVisionCapability(
  prompt: Prompt,
  current: {
    readonly provider?: ImageGenerationProvider;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly baseUrl?: string;
    readonly useGateway?: boolean;
  },
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<VisionCapabilityResult | { readonly kind: "back" }> {
  const defaultProvider = current.provider ?? "fal";
  const currentVisionRoute = current.provider === undefined && current.model === undefined
    ? undefined
    : setupRouteStatusText(locale, current.provider, current.model);
  let defaultProviderSelection = defaultProvider;
  while (true) {
    const providerResult = await promptSetupChoiceMaybeBack<ImageGenerationProvider>(prompt, {
      title: setupCopyText(locale, "setupModules.vision.title"),
      message: `${setupCopyText(locale, "setupEditor.prompt.vision.summary")}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      statusLines: setupCurrentStatusLines(locale, currentVisionRoute),
      showCurrentBadge: currentVisionRoute === undefined ? undefined : false,
      choices: imageProviders.map((candidate) => ({
        id: candidate,
        label: setupCopyText(locale, imageProviderLabelKey(candidate)),
        description: setupCopyText(locale, imageProviderDescriptionKey(candidate)),
        current: current.provider === candidate,
        value: candidate,
      })),
      defaultValue: defaultProviderSelection,
    }, options);
    if (isSetupChoiceBackResult(providerResult)) {
      return providerResult;
    }
    const provider = setupChoiceSelectedValue(providerResult);
    defaultProviderSelection = provider;
    const providerCurrent = current.provider === provider;
    const modelResult = await promptSetupChoiceMaybeBack<string>(prompt, {
      title: setupCopyText(locale, "setupEditor.prompt.vision.model.title"),
      message: `${formatSetupCopy(locale, "setupEditor.prompt.vision.model.body", {
        provider: setupCopyText(locale, imageProviderLabelKey(provider)),
      })}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      statusLines: setupCurrentStatusLines(locale, currentVisionRoute),
      showCurrentBadge: currentVisionRoute === undefined ? undefined : false,
      choices: imageModelChoices(locale, provider, providerCurrent ? current.model : undefined),
      defaultValue: resolveImageModel(provider, providerCurrent ? current.model : undefined) ?? defaultImageModel(provider),
    }, options);
    if (isSetupChoiceBackResult(modelResult)) {
      continue;
    }
    const model = setupChoiceSelectedValue(modelResult);
    const apiKeyEnv = providerCurrent && current.apiKeyEnv !== undefined
      ? current.apiKeyEnv
      : defaultImageApiKeyEnv(provider);
    const baseUrl = (providerCurrent ? current.baseUrl : undefined) ?? defaultImageBaseUrl(provider);

    return {
      provider,
      model,
      apiKeyEnv,
      baseUrl,
      useGateway: current.useGateway ?? false,
    };
  }
}

function imageModelChoices(locale: SetupCopyLocale, provider: ImageGenerationProvider, currentModel: string | undefined): readonly SetupChoice<string>[] {
  const resolvedCurrent = resolveImageModel(provider, currentModel);
  const choices: SetupChoice<string>[] = IMAGE_MODEL_OPTIONS[provider].map((model) => ({
    id: `image-model-${model.id}`,
    label: model.label,
    description: setupCopyText(locale, imageModelDescriptionKey(model.id)),
    technical: true,
    badges: model.id === defaultImageModel(provider) ? [setupCopyText(locale, "setupEditor.prompt.vision.model.badge.default")] : undefined,
    current: resolvedCurrent === model.id,
    value: model.id,
  }));
  if (currentModel !== undefined && currentModel.trim().length > 0 && !choices.some((choice) => choice.value === resolvedCurrent)) {
    choices.push({
      id: `image-model-current-${currentModel}`,
      label: currentModel,
      description: setupCopyText(locale, "setupEditor.prompt.vision.model.currentCustom.description"),
      technical: true,
      current: true,
      value: currentModel,
    });
  }
  return choices;
}

function imageModelDescriptionKey(modelId: string): SetupCopyKey {
  switch (modelId) {
    case "fal-ai/flux-2/klein/9b":
      return "setupEditor.prompt.vision.model.falFlux2Klein.description";
    case "fal-ai/flux-2-pro":
      return "setupEditor.prompt.vision.model.falFlux2Pro.description";
    case "fal-ai/z-image/turbo":
      return "setupEditor.prompt.vision.model.falZImageTurbo.description";
    case "fal-ai/nano-banana-pro":
      return "setupEditor.prompt.vision.model.falNanoBananaPro.description";
    case "fal-ai/gpt-image-1.5":
      return "setupEditor.prompt.vision.model.falGptImage15.description";
    case "fal-ai/gpt-image-2":
      return "setupEditor.prompt.vision.model.falGptImage2.description";
    case "fal-ai/ideogram/v3":
      return "setupEditor.prompt.vision.model.falIdeogramV3.description";
    case "fal-ai/recraft/v4/pro/text-to-image":
      return "setupEditor.prompt.vision.model.falRecraftV4Pro.description";
    case "fal-ai/qwen-image":
      return "setupEditor.prompt.vision.model.falQwenImage.description";
    case "fal-ai/krea/v2/medium/text-to-image":
      return "setupEditor.prompt.vision.model.falKrea2Medium.description";
    case "fal-ai/krea/v2/large/text-to-image":
      return "setupEditor.prompt.vision.model.falKrea2Large.description";
    case "seedream-5-0-260128":
      return "setupEditor.prompt.vision.model.seedream5.description";
    case "seedream-5-0-lite-260128":
      return "setupEditor.prompt.vision.model.seedream5Lite.description";
    case "seedream-4-5-251128":
      return "setupEditor.prompt.vision.model.seedream45.description";
    case "seedream-4-0-250828":
      return "setupEditor.prompt.vision.model.seedream40.description";
    case "gpt-image-2-low":
      return "setupEditor.prompt.vision.model.openaiGptImage2Low.description";
    case "gpt-image-2-medium":
      return "setupEditor.prompt.vision.model.openaiGptImage2Medium.description";
    case "gpt-image-2-high":
      return "setupEditor.prompt.vision.model.openaiGptImage2High.description";
    default:
      return "setupEditor.prompt.vision.model.falFlux.description";
  }
}

function imageProviderLabelKey(provider: ImageGenerationProvider): SetupCopyKey {
  if (provider === "byteplus") return "setupEditor.prompt.vision.provider.byteplus";
  if (provider === "openai") return "setupEditor.prompt.vision.provider.openai";
  return "setupEditor.prompt.vision.provider.fal";
}

function imageProviderDescriptionKey(provider: ImageGenerationProvider): SetupCopyKey {
  if (provider === "byteplus") return "setupEditor.prompt.vision.provider.byteplus.description";
  if (provider === "openai") return "setupEditor.prompt.vision.provider.openai.description";
  return "setupEditor.prompt.vision.provider.fal.description";
}

export function promptBrowserCapability(
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
  locale: SetupCopyLocale,
  options: BackEnabled
): Promise<BrowserCapabilityResult | { readonly kind: "back" }>;
export function promptBrowserCapability(
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
  locale?: SetupCopyLocale,
  options?: BackPromptOptions
): Promise<BrowserCapabilityResult>;
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
  locale: SetupCopyLocale = "en",
  options: BackPromptOptions = {}
): Promise<BrowserCapabilityResult | { readonly kind: "back" }> {
  const defaultMode = isRecommendedBrowserConfig(current) ? "recommended" : browserModeFromCurrent(current);
  const hasCurrentBrowserState = browserCurrentStateIsKnown(current);
  const modeChoices = [
    {
      id: "browser-recommended",
      label: setupCopyText(locale, "setupEditor.prompt.browser.mode.recommended"),
      description: setupCopyText(locale, "setupEditor.prompt.browser.mode.recommended.description"),
      value: "recommended" as const,
      current: hasCurrentBrowserState && defaultMode === "recommended",
    },
    {
      id: "browser-local-supervised",
      label: setupCopyText(locale, "setupEditor.prompt.browser.mode.localSupervised"),
      description: setupCopyText(locale, "setupEditor.prompt.browser.mode.localSupervised.description"),
      value: "local-supervised" as const,
      current: hasCurrentBrowserState && defaultMode === "local-supervised",
    },
    {
      id: "browser-existing-cdp",
      label: setupCopyText(locale, "setupEditor.prompt.browser.mode.existingCdp"),
      description: setupCopyText(locale, "setupEditor.prompt.browser.mode.existingCdp.description"),
      value: "existing-cdp" as const,
      current: hasCurrentBrowserState && defaultMode === "existing-cdp",
    },
    {
      id: "browser-browserbase",
      label: setupCopyText(locale, "setupEditor.prompt.browser.mode.browserbase"),
      description: setupCopyText(locale, "setupEditor.prompt.browser.mode.browserbase.description"),
      value: "browserbase" as const,
      current: hasCurrentBrowserState && defaultMode === "browserbase",
    },
    {
      id: "browser-disabled",
      label: setupCopyText(locale, "setupEditor.prompt.browser.mode.disable"),
      description: setupCopyText(locale, "setupEditor.prompt.browser.mode.disable.description"),
      value: "disabled" as const,
      current: hasCurrentBrowserState && defaultMode === "disabled",
    },
  ] as const;
  const currentModeLabel = modeChoices.find((choice) => choice.value === defaultMode)?.label ?? defaultMode;
  while (true) {
    const modeResult = await promptSetupChoiceMaybeBack<BrowserModeChoice>(prompt, {
      title: setupCopyText(locale, "setupEditor.prompt.browser.mode.title"),
      message: `${setupCopyText(locale, "setupEditor.prompt.browser.mode.body")}\n`,
      columns: setupChoiceColumns(locale),
      tableDirection: setupChoiceTableDirection(locale),
      tableWidth: setupChoiceTableWidth(locale),
      tableMaxWidth: setupChoiceTableMaxWidth(locale),
      tableAlign: setupChoiceTableAlign(locale),
      showColumnHeaders: false,
      statusLines: setupCurrentStatusLines(locale, hasCurrentBrowserState ? currentModeLabel : undefined),
      showCurrentBadge: hasCurrentBrowserState ? false : undefined,
      choices: modeChoices,
      defaultValue: defaultMode,
    }, options);
    if (isSetupChoiceBackResult(modeResult)) {
      return modeResult;
    }
    const mode = setupChoiceSelectedValue(modeResult);

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

    const autoLaunchResult = await promptSetupChoiceMaybeBack(prompt, {
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
    }, options);
    if (isSetupChoiceBackResult(autoLaunchResult)) {
      continue;
    }
    const autoLaunch = setupChoiceSelectedValue(autoLaunchResult);
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
}

export function promptedBrowserCapabilityMode(values: object): BrowserSetupModeChoice | undefined {
  return promptedBrowserModes.get(values);
}

function browserCapabilityWithMode<T extends object>(values: T, mode: BrowserSetupModeChoice): T {
  promptedBrowserModes.set(values, mode);
  return values;
}

const ttsProviders: readonly TtsProvider[] = ["edge", "elevenlabs", "openai", "minimax", "mistral", "gemini", "xai", "neutts", "kittentts"];
type SetupEditorSttProvider = "local" | "groq" | "openai" | "mistral" | "xai";

const sttProviders: readonly SetupEditorSttProvider[] = ["local", "groq", "openai", "mistral", "xai"];
const imageProviders: readonly ImageGenerationProvider[] = ["fal", "byteplus", "openai"];

function ttsProviderLabel(provider: TtsProvider): string {
  switch (provider) {
    case "edge":
      return "Edge";
    case "elevenlabs":
      return "ElevenLabs";
    case "openai":
      return "OpenAI";
    case "minimax":
      return "Minimax";
    case "mistral":
      return "Mistral";
    case "gemini":
      return "Gemini";
    case "xai":
      return "Xai";
    case "neutts":
      return "Neutts";
    case "kittentts":
      return "Kittentts";
  }
}

function ttsProviderDescription(locale: SetupCopyLocale, provider: TtsProvider): string {
  switch (provider) {
    case "edge":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.edge.description");
    case "elevenlabs":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.elevenlabs.description");
    case "openai":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.openai.description");
    case "minimax":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.minimax.description");
    case "mistral":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.mistral.description");
    case "gemini":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.gemini.description");
    case "xai":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.xai.description");
    case "neutts":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.neutts.description");
    case "kittentts":
      return setupCopyText(locale, "setupEditor.prompt.voice.ttsProvider.kittentts.description");
  }
}

function sttProviderDescription(locale: SetupCopyLocale, provider: SetupEditorSttProvider): string {
  switch (provider) {
    case "local":
      return setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.local.description");
    case "groq":
      return setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.groq.description");
    case "openai":
      return setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.openai.description");
    case "mistral":
      return setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.mistral.description");
    case "xai":
      return setupCopyText(locale, "setupEditor.prompt.voice.sttProvider.xai.description");
  }
}

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

function browserCurrentStateIsKnown(current: {
  readonly backend?: BrowserBackendKind;
  readonly cloudProvider?: BrowserCloudProviderKind;
  readonly autoLaunch?: boolean;
  readonly cdpUrl?: string;
  readonly launchExecutable?: string;
  readonly launchArgs?: readonly string[];
  readonly chromeFlags?: readonly string[];
  readonly engine?: BrowserEngineKind;
}): boolean {
  return current.backend !== undefined ||
    current.cloudProvider !== undefined ||
    current.autoLaunch !== undefined ||
    current.cdpUrl !== undefined ||
    current.launchExecutable !== undefined ||
    current.launchArgs !== undefined ||
    current.chromeFlags !== undefined ||
    current.engine !== undefined;
}

function optionalTrimmedString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function setupRouteStatusText(
  locale: SetupCopyLocale,
  provider: string | undefined,
  model: string | undefined
): string {
  const route = [provider, model]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("/");
  return setupTechnicalToken(locale, route);
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
