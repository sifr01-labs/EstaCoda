import type { Prompt } from "../../cli/readline-prompt.js";
import type { BrowserBackendKind } from "../../contracts/browser.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { ImageGenerationProvider, SttProvider, TtsProvider } from "../../config/runtime-config.js";
import type { ModelCandidate, ProviderCandidate } from "../../providers/provider-model-selection-flow.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import {
  promptSetupChoice,
  promptSetupStringWithDefault,
  setupCopyText,
} from "../setup-prompts.js";
import type { ConfigEditorRenderedAction } from "./render.js";

export type OptionalCapabilityPromptAction = "unchanged" | "skip" | "enable";

export type OptionalCapabilityPromptId = "telegram" | "voice" | "vision" | "browser";

export async function promptConfigEditorAction(
  prompt: Prompt,
  actions: readonly ConfigEditorRenderedAction[],
  defaultActionId?: string
): Promise<ConfigEditorRenderedAction | undefined> {
  if (actions.length === 0) {
    return undefined;
  }

  const defaultAction = actions.find((action) => action.id === defaultActionId) ?? actions[0];
  return promptSetupChoice(prompt, {
    title: "Guided setup editor",
    message: "Choose a setup action.\n",
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
  currentValue: SecurityApprovalMode
): Promise<SecurityApprovalMode> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.security.title"),
    message: `${setupCopyText("en", "onboarding.security")}\n`,
    choices: [
      {
        id: "strict",
        label: setupCopyText("en", "onboarding.security.options.strict.label"),
        description: setupCopyText("en", "onboarding.security.options.strict.description"),
        value: "strict" as const,
      },
      {
        id: "adaptive",
        label: setupCopyText("en", "onboarding.security.options.adaptive.label"),
        description: setupCopyText("en", "onboarding.security.options.adaptive.description"),
        value: "adaptive" as const,
      },
      {
        id: "open",
        label: setupCopyText("en", "onboarding.security.options.open.label"),
        description: setupCopyText("en", "onboarding.security.options.open.description"),
        value: "open" as const,
      },
    ],
    defaultValue: currentValue,
  });
}

export async function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy
): Promise<SkillAutonomy> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.workflowLearning.title"),
    message: `${setupCopyText("en", "onboarding.workflowLearning")}\n`,
    choices: [
      {
        id: "none",
        label: setupCopyText("en", "onboarding.workflowLearning.options.none.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.none.description"),
        value: "none" as const,
      },
      {
        id: "suggest",
        label: setupCopyText("en", "onboarding.workflowLearning.options.suggest.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.suggest.description"),
        value: "suggest" as const,
      },
      {
        id: "proactive",
        label: setupCopyText("en", "onboarding.workflowLearning.options.proactive.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.proactive.description"),
        value: "proactive" as const,
      },
      {
        id: "autonomous",
        label: setupCopyText("en", "onboarding.workflowLearning.options.autonomous.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.autonomous.description"),
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
  }
): Promise<boolean> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.workspace.trust.title"),
    message: [
      setupCopyText("en", "onboarding.workspace.trust"),
      `Workspace: ${input.workspaceRoot}`,
      `Trust store: ${input.trustStorePath}`,
      "",
    ].join("\n"),
    choices: [
      {
        id: "trust",
        label: setupCopyText("en", "onboarding.workspace.trustAction.label"),
        description: setupCopyText("en", "onboarding.workspace.trustAction.description"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText("en", "onboarding.review.cancelAction"),
        description: setupCopyText("en", "setupApply.review.cancelled"),
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
  }
): Promise<ProviderCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.providers.primary.title"),
    message: `${setupCopyText("en", "onboarding.providers.primary")}\n`,
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
  }
): Promise<ModelCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.providers.primaryModel.title"),
    message: `${setupCopyText("en", "onboarding.providers.primaryModel").replace("{providerId}", input.providerId)}\n`,
    choices: input.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.id,
      description: [
        candidate.profile.supportsTools ? setupCopyText("en", "onboarding.catalog.model.features.tools") : undefined,
        candidate.profile.supportsVision ? setupCopyText("en", "onboarding.catalog.model.features.vision") : undefined,
        candidate.profile.supportsReasoning ? setupCopyText("en", "onboarding.catalog.model.features.reasoning") : undefined,
        candidate.profile.status,
      ].filter((part): part is string => part !== undefined).join(", "),
      value: candidate,
    })),
    defaultValue: input.candidates.find((candidate) => candidate.id === input.currentModelId) ?? input.candidates[0],
  });
}

export async function promptConfigEditorReviewApproval(
  prompt: Prompt
): Promise<boolean> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.review"),
    message: `${setupCopyText("en", "onboarding.review.validation.accepted")}\n`,
    choices: [
      {
        id: "approve",
        label: setupCopyText("en", "onboarding.review.approveAction"),
        description: setupCopyText("en", "setupApply.review.approved"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText("en", "onboarding.review.cancelAction"),
        description: setupCopyText("en", "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: true,
  });
}

export async function promptOptionalCapabilityAction(
  prompt: Prompt,
  input: {
    readonly id: OptionalCapabilityPromptId;
    readonly title: string;
    readonly configured: boolean;
  }
): Promise<OptionalCapabilityPromptAction> {
  return promptSetupChoice(prompt, {
    title: input.title,
    message: `${input.title}\n`,
    choices: [
      {
        id: `${input.id}-unchanged`,
        label: "Leave unchanged",
        description: input.configured
          ? "Keep the current optional capability config exactly as-is."
          : "Do not configure this optional capability now.",
        value: "unchanged" as const,
      },
      {
        id: `${input.id}-skip`,
        label: "Skip",
        description: "Keep this optional capability non-blocking for core setup.",
        value: "skip" as const,
      },
      {
        id: `${input.id}-enable`,
        label: "Enable/configure",
        description: "Draft reviewed config references for this optional capability.",
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
  }
): Promise<{
  readonly botTokenEnv: string;
  readonly allowedUserIds: readonly string[];
  readonly allowedChatIds: readonly string[];
}> {
  const botTokenEnv = await promptSetupStringWithDefault(
    prompt,
    "Telegram bot token environment variable [ESTACODA_TELEGRAM_BOT_TOKEN]: ",
    current.botTokenEnv ?? "ESTACODA_TELEGRAM_BOT_TOKEN"
  );
  const allowedUserIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    "Allowed Telegram user IDs, comma-separated: ",
    (current.allowedUserIds ?? []).join(",")
  ));
  const allowedChatIds = splitCsv(await promptSetupStringWithDefault(
    prompt,
    "Allowed Telegram chat IDs, comma-separated: ",
    (current.allowedChatIds ?? []).join(",")
  ));

  return {
    botTokenEnv,
    allowedUserIds,
    allowedChatIds,
  };
}

export async function promptVoiceCapability(
  prompt: Prompt,
  current: {
    readonly ttsProvider?: TtsProvider;
    readonly ttsModel?: string;
    readonly ttsApiKeyEnv?: string;
    readonly sttProvider?: SttProvider;
    readonly sttModel?: string;
    readonly sttApiKeyEnv?: string;
  }
): Promise<{
  readonly ttsProvider: TtsProvider;
  readonly ttsModel: string;
  readonly ttsApiKeyEnv: string;
  readonly sttProvider: SttProvider;
  readonly sttModel: string;
  readonly sttApiKeyEnv: string;
}> {
  const ttsProvider = await promptSetupChoice(prompt, {
    title: setupCopyText("en", "setupModules.voice.title"),
    message: "Choose a TTS provider.\n",
    choices: ttsProviders.map((provider) => ({
      id: `tts-${provider}`,
      label: provider,
      value: provider,
    })),
    defaultValue: current.ttsProvider ?? "openai",
  });
  const ttsModel = await promptSetupStringWithDefault(prompt, "TTS model: ", current.ttsModel ?? "gpt-4o-mini-tts");
  const ttsApiKeyEnv = await promptSetupStringWithDefault(prompt, "TTS API key environment variable: ", current.ttsApiKeyEnv ?? "OPENAI_API_KEY");
  const sttProvider = await promptSetupChoice(prompt, {
    title: setupCopyText("en", "setupModules.voice.title"),
    message: "Choose an STT provider.\n",
    choices: sttProviders.map((provider) => ({
      id: `stt-${provider}`,
      label: provider,
      value: provider,
    })),
    defaultValue: current.sttProvider ?? "openai",
  });
  const sttModel = await promptSetupStringWithDefault(prompt, "STT model: ", current.sttModel ?? "gpt-4o-mini-transcribe");
  const sttApiKeyEnv = await promptSetupStringWithDefault(prompt, "STT API key environment variable: ", current.sttApiKeyEnv ?? "OPENAI_API_KEY");

  return {
    ttsProvider,
    ttsModel,
    ttsApiKeyEnv,
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
  }
): Promise<{
  readonly provider: ImageGenerationProvider;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly useGateway: boolean;
}> {
  const provider = await promptSetupChoice(prompt, {
    title: setupCopyText("en", "setupModules.vision.title"),
    message: "Choose an image generation provider.\n",
    choices: imageProviders.map((candidate) => ({
      id: candidate,
      label: candidate,
      value: candidate,
    })),
    defaultValue: current.provider ?? "fal",
  });
  const model = await promptSetupStringWithDefault(prompt, "Image generation model: ", current.model ?? "fal-ai/imagen4/preview");
  const apiKeyEnv = await promptSetupStringWithDefault(prompt, "Image API key environment variable: ", current.apiKeyEnv ?? "FAL_KEY");
  const useGateway = await promptSetupChoice(prompt, {
    title: setupCopyText("en", "setupModules.vision.title"),
    message: "Use image gateway if configured?\n",
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
  }
): Promise<{
  readonly backend: BrowserBackendKind;
  readonly cdpUrl: string;
  readonly launchCommand: string;
  readonly autoLaunch: false;
}> {
  const backend = await promptSetupChoice(prompt, {
    title: setupCopyText("en", "setupModules.browser.title"),
    message: "Choose a browser backend. Browser setup will not launch a browser during planning.\n",
    choices: browserBackends.map((candidate) => ({
      id: candidate,
      label: candidate,
      value: candidate,
    })),
    defaultValue: current.backend ?? "local-cdp",
  });
  const cdpUrl = await promptSetupStringWithDefault(prompt, "Browser CDP URL: ", current.cdpUrl ?? "http://127.0.0.1:9222");
  const launchCommand = await promptSetupStringWithDefault(prompt, "Browser launch command reference: ", current.launchCommand ?? "");

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
