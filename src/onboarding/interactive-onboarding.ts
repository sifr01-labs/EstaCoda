import { createInterface as createPromptInterface } from "node:readline/promises";
import { createInterface as createCallbackInterface } from "node:readline";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Writable, Readable } from "node:stream";
import { parseChoiceIndex, selectOption, type SelectPromptInput } from "../cli/interactive-select.js";
import {
  defaultEnvKey,
  loadRuntimeConfig,
  setupBrowserConfig,
  setupImageGenerationConfig,
  setupProviderConfig,
  setupSecurityConfig,
  setupSkillConfig,
  setupTelegramConfig,
  setupUiConfig,
  setupVoiceConfig,
  type ImageGenerationProvider,
  type UiLanguage
} from "../config/runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { ProviderId } from "../contracts/provider.js";
import type { ThemeDefinition } from "../contracts/theme.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import { kemetBlueTheme } from "../theme/kemet-blue.js";
import { defaultImageApiKeyEnv, defaultImageModel } from "../contracts/image-generation.js";
import {
  formatSecurityMode,
  formatSkillAutonomy,
  renderSecurityModeOption,
  renderSkillAutonomyOption,
  type Locale
} from "../ui/settings-labels.js";
import { ltr, onboardingCopy, type OnboardingCopy } from "./onboarding-copy.js";
import {
  formatProviderModel,
  interfaceLanguageChoices,
  interfaceStyleChoices,
  providerChoices,
  type InterfaceChoice,
  type InterfaceStyleChoice,
  type ModelChoice,
  type ProviderChoice
} from "./onboarding-provider-catalog.js";
import { completeOnboarding, defaultOnboardingSteps, getOnboardingStatus, type OnboardingOptions } from "./onboarding-flow.js";
import { runSetupVerification } from "./verification.js";

export type Prompt = ((question: string, options?: { secret?: boolean }) => Promise<string>) & {
  select?: <T>(input: SelectPromptInput<T>) => Promise<T>;
  close?: () => void;
};

type BackupRouteChoice = {
  provider: ProviderChoice;
  model: ModelChoice;
  apiKeyEnv?: string;
  apiKey?: string;
};

type TelegramSetupDraft = {
  botToken: string;
  allowedUserId: string;
  verifyAfterSave: boolean;
};

type VoiceSetupDraft = {
  sttProvider?: "local" | "openai";
  sttApiKeyEnv?: string;
  sttApiKey?: string;
  ttsProvider?: "edge" | "openai";
  ttsApiKeyEnv?: string;
  ttsApiKey?: string;
};

type VisionSetupDraft = {
  verifyInputAfterSave: boolean;
  imageProvider?: ImageGenerationProvider;
  imageModel?: string;
  imageApiKeyEnv?: string;
  imageApiKey?: string;
  verifyImageAfterSave: boolean;
};

type OptionalCapabilityDraft = {
  telegram?: TelegramSetupDraft;
  voice?: VoiceSetupDraft;
  vision?: VisionSetupDraft;
  browser?: boolean;
};

export type InteractiveOnboardingResult = {
  completed: boolean;
  output: string;
  exitCode: number;
  workspaceRoot?: string;
};

export async function runInteractiveOnboarding(options: OnboardingOptions & {
  prompt?: Prompt;
  theme?: ThemeDefinition;
  continueToSession?: boolean;
}): Promise<InteractiveOnboardingResult> {
  const status = await getOnboardingStatus(options);
  const loadedConfig = await loadRuntimeConfig(options);
  let locale: Locale = loadedConfig.ui.language === "ar" ? "ar" : "en";
  let copy = onboardingCopy(locale);
  const theme = options.theme ?? kemetBlueTheme;

  if (!status.needed) {
    return {
      completed: true,
      exitCode: 0,
      output: copy.final.alreadyConfigured(status.configuredModel ?? copy.final.configuredModelFallback)
    };
  }

  const prompt = options.prompt ?? createReadlinePrompt();
  const providerStep = defaultOnboardingSteps().find((step) => step.id === "provider");

  if (providerStep === undefined) {
    return {
      completed: false,
      exitCode: 1,
      output: copy.final.providerStepUnavailable
    };
  }

  try {
    await prompt(`${renderWelcome({ theme, copy })}\n${copy.common.pressEnterToBegin} `);
    const interfaceLanguage = await selectInterfaceLanguage(prompt, copy);
    locale = interfaceLanguage.language === "ar" ? "ar" : "en";
    copy = onboardingCopy(locale);
    const interfaceStyle = await selectInterfaceStyle(prompt, interfaceLanguage.language, copy);
    const workspaceRoot = await promptForWorkspaceRoot(prompt, copy, options.workspaceRoot, options.homeDir);
    const trustRaw = await prompt(copy.workspace.trustPrompt);
    const trustWorkspace = parseYesNo(trustRaw, true);
    const provider = await selectProvider(prompt, copy);
    const selected = await selectModel(prompt, provider, copy);
    const defaultApiKeyEnv = selected.provider === "local" ? undefined : defaultEnvKey(selected.provider);
    const normalizedEnvName = defaultApiKeyEnv;
    const apiKey = selected.provider === "local" || normalizedEnvName === undefined
      ? undefined
      : await promptForRequiredSecret(prompt, copy.providers.apiKeyPrompt(selected.label, normalizedEnvName), `${selected.label} API key`, copy);
    const backup = await selectBackupRoute(prompt, selected.provider, copy);
    const securityMode = await selectSecurityMode(prompt, locale, copy);
    const skillAutonomy = await selectSkillAutonomy(prompt, locale, copy);
    const optionalCapabilities = await collectOptionalCapabilities(prompt, copy);
    const reviewLines = renderReview({
      copy,
      interfaceLabel: `${interfaceLanguage.label} / ${interfaceStyle.label}`,
      provider: technical(copy, selected.provider),
      model: technical(copy, selected.model),
      backup: backup === undefined ? copy.review.backupSkipped : technical(copy, formatProviderModel(backup.model.provider, backup.model.model)),
      credential: normalizedEnvName === undefined
        ? copy.review.noHostedKey
        : copy.review.credentialLine(normalizedEnvName),
      trust: trustWorkspace ? technical(copy, workspaceRoot) : copy.review.notTrusted,
      securityMode: formatSecurityMode(securityMode, locale).label,
      workflowLearning: formatSkillAutonomy(skillAutonomy, locale).label,
      capabilities: summarizeCapabilities(optionalCapabilities, copy)
    });
    await prompt(`${reviewLines}\n${copy.common.pressEnterToSave} `);
    await setupUiConfig({
      ...options,
      workspaceRoot,
      input: {
        scope: "user",
        language: interfaceLanguage.language,
        flavor: interfaceStyle.flavor,
        activityLabels: interfaceStyle.activityLabels
      }
    });
    const result = await completeOnboarding({
      ...options,
      workspaceRoot,
      input: {
        scope: "user",
        provider: selected.provider,
        model: selected.model,
        apiKeyEnv: normalizedEnvName,
        apiKey,
        enableNetwork: selected.provider !== "local"
      }
    });
    if (backup !== undefined) {
      await setupProviderConfig({
        ...options,
        workspaceRoot,
        input: {
          scope: "user",
          provider: backup.model.provider,
          model: backup.model.model,
          apiKeyEnv: backup.apiKeyEnv,
          apiKey: backup.apiKey,
          enableNetwork: backup.model.provider !== "local",
          primary: false,
          backupForMain: true
        }
      });
    }
    await setupSecurityConfig({
      ...options,
      workspaceRoot,
      input: {
        scope: "user",
        mode: securityMode
      }
    });
    await setupSkillConfig({
      ...options,
      workspaceRoot,
      input: {
        scope: "user",
        autonomy: skillAutonomy
      }
    });
    await applyOptionalCapabilities({
      ...options,
      workspaceRoot,
      capabilities: optionalCapabilities
    });
    if (trustWorkspace) {
      await new WorkspaceTrustStore({
        path: `${options.homeDir ?? process.env.HOME ?? ""}/.estacoda/trust.json`
      }).grant(workspaceRoot, { label: "setup wizard" });
    }
    const loaded = await loadRuntimeConfig({ ...options, workspaceRoot });
    const diagnostic = await diagnoseProviderConfig(loaded);
    const verification = await runSetupVerification({ ...options, workspaceRoot });
    const security = formatSecurityMode(securityMode, locale);
    const autonomy = formatSkillAutonomy(skillAutonomy, locale);
    const setupCheck = diagnostic.status === "ready" && verification.ok
        ? [
          copy.setupCheck.ready,
          `${copy.setupCheck.provider}: ${technical(copy, formatProviderModel(loaded.model.provider, loaded.model.id))}`,
          `${copy.setupCheck.workspace}: ${trustWorkspace ? copy.setupCheck.trusted : copy.setupCheck.notTrusted}`,
          `${copy.setupCheck.security}: ${security.label}`,
          `${copy.setupCheck.workflow}: ${autonomy.label}`
        ].join("\n")
      : [
          copy.setupCheck.title,
          renderProviderDiagnostic(diagnostic),
          "",
          verification.output
        ].join("\n");
    const sessionLine = options.continueToSession === true
      ? copy.final.startSession
      : copy.final.nextNoSession;

    return {
      completed: !result.needed,
      exitCode: result.needed ? 1 : 0,
      output: [
        copy.final.complete,
        copy.final.ready,
        `${copy.final.configured}: ${technical(copy, formatProviderModel(selected.provider, selected.model))}`,
        backup === undefined ? undefined : `${copy.final.backupRoute}: ${technical(copy, formatProviderModel(backup.model.provider, backup.model.model))}`,
        `${copy.final.config}: ${technical(copy, result.configPath)}`,
        result.secretPath === undefined ? undefined : `${copy.final.secretStore}: ${technical(copy, result.secretPath)}`,
        normalizedEnvName === undefined ? undefined : `${copy.final.usingCredential} ${technical(copy, normalizedEnvName)}.`,
        `${copy.final.interface}: ${interfaceLanguage.label} / ${interfaceStyle.label}`,
        `${copy.final.workspaceTrust}: ${trustWorkspace ? copy.setupCheck.trusted : copy.setupCheck.notTrusted}`,
        `${copy.final.securityMode}: ${security.label} (${security.value})`,
        `${copy.final.workflowLearning}: ${autonomy.label} (${autonomy.value})`,
        `${copy.final.optionalCapabilities}: ${summarizeCapabilities(optionalCapabilities, copy)}`,
        "",
        setupCheck,
        sessionLine
      ].filter((line) => line !== undefined).join("\n"),
      workspaceRoot
    };
  } finally {
    prompt.close?.();
  }
}

async function promptForWorkspaceRoot(
  prompt: Prompt,
  copy: OnboardingCopy,
  defaultRoot: string,
  homeDir?: string
): Promise<string> {
  while (true) {
    const raw = await prompt(copy.workspace.rootPrompt(defaultRoot));
    const root = normalizeWorkspaceRoot(raw.trim().length === 0 ? defaultRoot : raw.trim(), homeDir);
    const result = await ensureWorkspaceDirectory(root);
    if (result.ok) {
      return root;
    }
    await prompt(`${copy.workspace.createFailed(root, result.reason)}\n${copy.common.pressEnterToContinue} `);
  }
}

function normalizeWorkspaceRoot(input: string, homeDir?: string): string {
  const expanded = input === "~"
    ? homeDir ?? process.env.HOME ?? input
    : input.startsWith("~/")
      ? `${homeDir ?? process.env.HOME ?? "~"}${input.slice(1)}`
      : input;
  return resolve(expanded);
}

async function ensureWorkspaceDirectory(root: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await mkdir(root, { recursive: true });
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      return { ok: false, reason: "path exists but is not a directory" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function createReadlinePrompt(input: Readable = defaultInput, output: Writable = defaultOutput): Prompt {
  return Object.assign(
    async (question: string, options?: { secret?: boolean }) => {
      if (options?.secret === true) {
        return hiddenQuestion(input, output, question);
      }
      return plainQuestion(input, output, question);
    },
    {
      select: async <T>(selection: SelectPromptInput<T>) => selectOption(input, output, selection),
      close: () => undefined
    }
  );
}

export function canRunInteractive(input: NodeJS.ReadStream = defaultInput): boolean {
  return input.isTTY === true;
}

function withSelectChrome<T>(copy: OnboardingCopy, input: SelectPromptInput<T>): SelectPromptInput<T> {
  return {
    ...input,
    instruction: input.instruction ?? copy.common.selectInstruction,
    selectedLabel: input.selectedLabel ?? copy.common.selectedLabel
  };
}

function technical(copy: OnboardingCopy, value: string): string {
  return copy.common.selectedLabel === "تم الاختيار" ? ltr(value) : value;
}

async function selectInterfaceLanguage(prompt: Prompt, copy: OnboardingCopy): Promise<InterfaceChoice> {
  const choices = interfaceLanguageChoices(copy);
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.interfaceLanguage.title,
      body: copy.interfaceLanguage.body,
      defaultIndex: 0,
      options: choices.map((choice) => ({
        value: choice,
        label: choice.label,
        description: choice.description
      })),
      fallbackPrompt: `${renderNumberedChoices(copy.interfaceLanguage.title, copy.interfaceLanguage.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }

  const selectedRaw = await prompt(`${renderNumberedChoices(copy.interfaceLanguage.title, copy.interfaceLanguage.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  const selectedIndex = parseChoiceIndex(selectedRaw, choices.length, 0);
  return choices[selectedIndex] ?? choices[0]!;
}

async function selectInterfaceStyle(prompt: Prompt, language: UiLanguage, copy: OnboardingCopy): Promise<InterfaceStyleChoice> {
  const choices = interfaceStyleChoices(language, copy);
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.interfaceStyle.title,
      body: copy.interfaceStyle.body,
      defaultIndex: 0,
      options: choices.map((choice) => ({
        value: choice,
        label: choice.label,
        description: choice.description
      })),
      fallbackPrompt: `${renderNumberedChoices(copy.interfaceStyle.title, copy.interfaceStyle.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }

  const selectedRaw = await prompt(`${renderNumberedChoices(copy.interfaceStyle.title, copy.interfaceStyle.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  const selectedIndex = parseChoiceIndex(selectedRaw, choices.length, 0);
  return choices[selectedIndex] ?? choices[0]!;
}

async function selectProvider(
  prompt: Prompt,
  copy: OnboardingCopy
): Promise<ProviderChoice> {
  const choices = providerChoices(copy);
  const defaultIndex = 0;
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.providers.title,
      body: copy.providers.body,
      defaultIndex,
      options: choices.map((option) => ({
        value: option,
        label: option.label,
        description: option.description
      })),
      fallbackPrompt: `${renderProviderPicker(copy, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }

  const selectedRaw = await prompt(`${renderProviderPicker(copy, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  const parsedIndex = Number.parseInt(selectedRaw, 10) - 1;
  const selectedIndex = Number.isFinite(parsedIndex) && parsedIndex >= 0 ? parsedIndex : defaultIndex;
  return choices[selectedIndex] ?? choices[defaultIndex] ?? choices[0]!;
}

async function selectBackupRoute(prompt: Prompt, primaryProvider: ProviderId, copy: OnboardingCopy): Promise<BackupRouteChoice | undefined> {
  const choices = [
    {
      value: "skip" as const,
      label: copy.backup.skipLabel,
      description: copy.backup.skipDescription
    },
    {
      value: "add" as const,
      label: copy.backup.addLabel,
      description: copy.backup.addDescription
    }
  ];
  const decision = prompt.select === undefined
    ? choices[parseChoiceIndex(await prompt(`${renderNumberedChoices(copy.backup.title, copy.backup.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`), choices.length, 0)]?.value ?? "skip"
    : await prompt.select(withSelectChrome(copy, {
      title: copy.backup.title,
      body: copy.backup.body,
      defaultIndex: 0,
      options: choices,
      fallbackPrompt: `${renderNumberedChoices(copy.backup.title, copy.backup.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));

  if (decision === "skip") {
    return undefined;
  }

  const backupProviders = providerChoices(copy).filter((provider) => provider.provider !== primaryProvider);
  const provider = await selectProviderFromChoices(prompt, backupProviders, {
    title: copy.backup.providerTitle,
    body: copy.backup.providerBody
  }, copy);
  const model = await selectModel(prompt, provider, copy);
  const apiKeyEnv = model.provider === "local" ? undefined : defaultEnvKey(model.provider);
  const apiKey = model.provider === "local" || apiKeyEnv === undefined
    ? undefined
    : await promptForRequiredSecret(prompt, copy.providers.apiKeyPrompt(model.label, apiKeyEnv), `${model.label} API key`, copy);

  return {
    provider,
    model,
    apiKeyEnv,
    apiKey
  };
}

async function selectProviderFromChoices(
  prompt: Prompt,
  choices: ProviderChoice[],
  input: { title: string; body: string },
  copy: OnboardingCopy
): Promise<ProviderChoice> {
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: input.title,
      body: input.body,
      defaultIndex: 0,
      options: choices.map((choice) => ({
        value: choice,
        label: choice.label,
        description: choice.description
      })),
      fallbackPrompt: `${renderProviderPicker(copy, choices, input.title, input.body)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }

  const selectedRaw = await prompt(`${renderProviderPicker(copy, choices, input.title, input.body)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  const selectedIndex = parseChoiceIndex(selectedRaw, choices.length, 0);
  return choices[selectedIndex] ?? choices[0]!;
}

async function selectModel(prompt: Prompt, provider: ProviderChoice, copy: OnboardingCopy): Promise<ModelChoice> {
  const defaultIndex = 0;
  if (provider.models.length === 1) {
    return provider.models[0]!;
  }
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.providers.modelTitle(provider.label),
      body: copy.providers.modelBody,
      defaultIndex,
      options: provider.models.map((model) => ({
        value: model,
        label: model.label,
        description: model.description
      })),
      fallbackPrompt: `${renderModelPicker(provider, copy)}\n${renderFallbackChoicePrompt(copy, 0, provider.models)}`
    }));
  }

  const selectedRaw = await prompt(`${renderModelPicker(provider, copy)}\n${renderFallbackChoicePrompt(copy, 0, provider.models)}`);
  const selectedIndex = parseChoiceIndex(selectedRaw, provider.models.length, defaultIndex);
  return provider.models[selectedIndex] ?? provider.models[defaultIndex] ?? provider.models[0]!;
}

async function selectSecurityMode(prompt: Prompt, locale: Locale, copy: OnboardingCopy): Promise<SecurityApprovalMode> {
  const options: SecurityApprovalMode[] = ["strict", "adaptive", "open"];
  const defaultIndex = 1;
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.security.title,
      body: copy.security.body,
      defaultIndex,
      options: options.map((mode) => {
        const formatted = formatSecurityMode(mode, locale);
        return {
          value: mode,
          label: formatted.label,
          description: formatted.description
        };
      }),
      fallbackPrompt: renderSecurityModePrompt(locale, copy)
    }));
  }

  return parseSecurityMode(await prompt(renderSecurityModePrompt(locale, copy)));
}

async function selectSkillAutonomy(prompt: Prompt, locale: Locale, copy: OnboardingCopy): Promise<SkillAutonomy> {
  const options: SkillAutonomy[] = ["none", "suggest", "proactive", "autonomous"];
  const defaultIndex = 1;
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.workflowLearning.title,
      body: copy.workflowLearning.body,
      defaultIndex,
      options: options.map((mode) => {
        const formatted = formatSkillAutonomy(mode, locale);
        return {
          value: mode,
          label: formatted.label,
          description: formatted.description
        };
      }),
      fallbackPrompt: renderSkillAutonomyPrompt(locale, copy)
    }));
  }

  return parseSkillAutonomy(await prompt(renderSkillAutonomyPrompt(locale, copy)));
}

async function collectOptionalCapabilities(prompt: Prompt, copy: OnboardingCopy): Promise<OptionalCapabilityDraft> {
  const draft: OptionalCapabilityDraft = {};
  while (true) {
    const hasConfigured = summarizeCapabilities(draft, copy) !== copy.review.optionalSkipped;
    const choice = await selectOptionalCapability(prompt, hasConfigured, copy);
    if (choice === "skip" || choice === "done") {
      return draft;
    }
    if (choice === "channels") {
      const channel = await selectChannel(prompt, copy);
      if (channel === "telegram") {
        draft.telegram = await collectTelegramSetup(prompt, copy);
      }
    }
    if (choice === "voice") {
      const voice = await collectVoiceSetup(prompt, copy);
      if (voice !== undefined) {
        draft.voice = voice;
      }
    }
    if (choice === "vision") {
      const vision = await collectVisionSetup(prompt, copy);
      if (vision !== undefined) {
        draft.vision = vision;
      }
    }
    if (choice === "browser") {
      draft.browser = await collectBrowserSetup(prompt, copy);
    }
  }
}

async function selectOptionalCapability(prompt: Prompt, hasConfigured: boolean, copy: OnboardingCopy): Promise<"skip" | "done" | "channels" | "voice" | "vision" | "browser"> {
  const choices = [
    hasConfigured
      ? { value: "done" as const, label: copy.common.done, description: copy.optional.doneDescription }
      : { value: "skip" as const, label: copy.common.skipForNow, description: copy.optional.skipDescription },
    { value: "channels" as const, label: copy.optional.channels.label, description: copy.optional.channels.description },
    { value: "voice" as const, label: copy.optional.voice.label, description: copy.optional.voice.description },
    { value: "vision" as const, label: copy.optional.vision.label, description: copy.optional.vision.description },
    { value: "browser" as const, label: copy.optional.browser.label, description: copy.optional.browser.description }
  ];
  const body = hasConfigured ? copy.optional.bodyAfterSelection : copy.optional.body;
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.optional.title,
      body,
      defaultIndex: 0,
      options: choices,
      fallbackPrompt: `${renderNumberedChoices(copy.optional.title, body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }
  const selectedRaw = await prompt(`${renderNumberedChoices(copy.optional.title, body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  return choices[parseChoiceIndex(selectedRaw, choices.length, 0)]?.value ?? "skip";
}

async function selectChannel(prompt: Prompt, copy: OnboardingCopy): Promise<"skip" | "telegram"> {
  const choices = [
    { value: "skip" as const, label: copy.common.skipForNow, description: copy.channels.skipDescription },
    { value: "telegram" as const, label: copy.channels.telegramLabel, description: copy.channels.telegramDescription }
  ];
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(copy, {
      title: copy.channels.title,
      body: copy.channels.body,
      defaultIndex: 0,
      options: choices,
      fallbackPrompt: `${renderNumberedChoices(copy.channels.title, copy.channels.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`
    }));
  }
  const selectedRaw = await prompt(`${renderNumberedChoices(copy.channels.title, copy.channels.body, choices)}\n${renderFallbackChoicePrompt(copy, 0, choices)}`);
  return choices[parseChoiceIndex(selectedRaw, choices.length, 0)]?.value ?? "skip";
}

async function collectTelegramSetup(prompt: Prompt, copy: OnboardingCopy): Promise<TelegramSetupDraft> {
  await prompt(copy.telegram.intro.join("\n"));
  const botToken = await promptForValidatedSecret(
    prompt,
    copy.telegram.tokenPrompt.join("\n"),
    (value) => /^\d+:[A-Za-z0-9_-]+$/u.test(value.trim()),
    copy.telegram.tokenInvalid
  );
  const allowedUserId = await promptForValidatedText(
    prompt,
    [...copy.telegram.tokenSaved, "", ...copy.telegram.userIdPrompt].join("\n"),
    (value) => /^\d+$/u.test(value.trim()),
    copy.telegram.userIdInvalid
  );
  const verifyAfterSave = await selectRunSkip(prompt, {
    title: copy.telegram.verifyTitle,
    body: copy.telegram.verifyBody,
    runLabel: copy.telegram.verifyLabel,
    runDescription: copy.telegram.verifyDescription,
    skipDescription: copy.telegram.verifySkipDescription,
    copy
  });
  if (verifyAfterSave) {
    // Full network verification is handled by `estacoda telegram status/test`; first-run keeps the setup local and deterministic.
    await prompt(copy.telegram.verifyAfterSaveNotice);
  }
  return {
    botToken,
    allowedUserId,
    verifyAfterSave
  };
}

async function collectVoiceSetup(prompt: Prompt, copy: OnboardingCopy): Promise<VoiceSetupDraft | undefined> {
  const setup = await selectBinarySetup(prompt, {
    title: copy.voice.title,
    body: copy.voice.body,
    skipLabel: copy.common.skipForNow,
    skipDescription: copy.voice.skipDescription,
    setupLabel: copy.voice.setupLabel,
    setupDescription: copy.voice.setupDescription,
    copy
  });
  if (!setup) {
    return undefined;
  }
  const sttChoice = await selectSimpleChoice(prompt, {
    title: copy.voice.sttTitle,
    body: copy.voice.sttBody,
    defaultIndex: 0,
    choices: [
      { value: "skip" as const, label: copy.common.skipForNow, description: copy.voice.sttSkipDescription },
      { value: "local" as const, label: copy.voice.sttLocalLabel, description: copy.voice.sttLocalDescription },
      { value: "hosted" as const, label: copy.voice.sttHostedLabel, description: copy.voice.sttHostedDescription }
    ],
    copy
  });
  const ttsChoice = await selectSimpleChoice(prompt, {
    title: copy.voice.ttsTitle,
    body: copy.voice.ttsBody,
    defaultIndex: 0,
    choices: [
      { value: "skip" as const, label: copy.common.skipForNow, description: copy.voice.ttsSkipDescription },
      { value: "local" as const, label: copy.voice.ttsLocalLabel, description: copy.voice.ttsLocalDescription },
      { value: "hosted" as const, label: copy.voice.ttsHostedLabel, description: copy.voice.ttsHostedDescription }
    ],
    copy
  });
  const sttApiKey = sttChoice === "hosted"
    ? await promptForRequiredSecret(prompt, copy.voice.sttKeyPrompt, "hosted speech-to-text API key", copy)
    : undefined;
  const ttsApiKey = ttsChoice === "hosted"
    ? await promptForRequiredSecret(prompt, copy.voice.ttsKeyPrompt, "hosted text-to-speech API key", copy)
    : undefined;

  return {
    sttProvider: sttChoice === "local" ? "local" : sttChoice === "hosted" ? "openai" : undefined,
    sttApiKeyEnv: sttChoice === "hosted" ? "OPENAI_API_KEY" : undefined,
    sttApiKey,
    ttsProvider: ttsChoice === "local" ? "edge" : ttsChoice === "hosted" ? "openai" : undefined,
    ttsApiKeyEnv: ttsChoice === "hosted" ? "OPENAI_API_KEY" : undefined,
    ttsApiKey
  };
}

async function collectVisionSetup(prompt: Prompt, copy: OnboardingCopy): Promise<VisionSetupDraft | undefined> {
  const setup = await selectBinarySetup(prompt, {
    title: copy.vision.title,
    body: copy.vision.body,
    skipLabel: copy.common.skipForNow,
    skipDescription: copy.vision.skipDescription,
    setupLabel: copy.vision.setupLabel,
    setupDescription: copy.vision.setupDescription,
    copy
  });
  if (!setup) {
    return undefined;
  }
  const verifyInputAfterSave = await selectRunSkip(prompt, {
    title: copy.vision.inputTitle,
    body: copy.vision.inputBody,
    runLabel: copy.vision.inputVerifyLabel,
    runDescription: copy.vision.inputVerifyDescription,
    skipDescription: copy.vision.inputSkipDescription,
    copy
  });
  const imageChoice = await selectSimpleChoice(prompt, {
    title: copy.vision.imageTitle,
    body: copy.vision.imageBody,
    defaultIndex: 0,
    choices: [
      { value: "skip" as const, label: copy.common.skipForNow, description: copy.vision.imageSkipDescription },
      { value: "byteplus" as const, label: copy.vision.providerLabels.byteplus.label, description: copy.vision.providerLabels.byteplus.description },
      { value: "fal" as const, label: copy.vision.providerLabels.fal.label, description: copy.vision.providerLabels.fal.description }
    ],
    copy
  });
  if (imageChoice === "skip") {
    return {
      verifyInputAfterSave,
      verifyImageAfterSave: false
    };
  }
  const imageApiKeyEnv = defaultImageApiKeyEnv(imageChoice);
  const imageModel = defaultImageModel(imageChoice);
  const imageApiKey = await promptForRequiredSecret(prompt, copy.vision.imageKeyPrompt(imageApiKeyEnv), "image generation API key", copy);
  const verifyImageAfterSave = await selectRunSkip(prompt, {
    title: copy.vision.imageVerifyTitle,
    body: copy.vision.imageVerifyBody,
    runLabel: copy.vision.imageVerifyLabel,
    runDescription: copy.vision.imageVerifyDescription,
    skipDescription: copy.vision.imageVerifySkipDescription,
    copy
  });
  return {
    verifyInputAfterSave,
    imageProvider: imageChoice,
    imageModel,
    imageApiKeyEnv,
    imageApiKey,
    verifyImageAfterSave
  };
}

async function collectBrowserSetup(prompt: Prompt, copy: OnboardingCopy): Promise<boolean> {
  return await selectBinarySetup(prompt, {
    title: copy.browser.title,
    body: copy.browser.body,
    skipLabel: copy.common.skipForNow,
    skipDescription: copy.browser.skipDescription,
    setupLabel: copy.browser.setupLabel,
    setupDescription: copy.browser.setupDescription,
    copy
  });
}

async function selectRunSkip(prompt: Prompt, input: {
  title: string;
  body: string;
  runLabel: string;
  runDescription: string;
  skipDescription: string;
  copy: OnboardingCopy;
}): Promise<boolean> {
  const value = await selectSimpleChoice(prompt, {
    title: input.title,
    body: input.body,
    defaultIndex: 0,
    choices: [
      { value: "run" as const, label: input.runLabel, description: input.runDescription },
      { value: "skip" as const, label: input.copy.verifyChoice.skipLabel, description: input.skipDescription }
    ],
    copy: input.copy
  });
  return value === "run";
}

async function selectBinarySetup(prompt: Prompt, input: {
  title: string;
  body: string;
  skipLabel: string;
  skipDescription: string;
  setupLabel: string;
  setupDescription: string;
  copy: OnboardingCopy;
}): Promise<boolean> {
  const value = await selectSimpleChoice(prompt, {
    title: input.title,
    body: input.body,
    defaultIndex: 0,
    choices: [
      { value: "skip" as const, label: input.skipLabel, description: input.skipDescription },
      { value: "setup" as const, label: input.setupLabel, description: input.setupDescription }
    ],
    copy: input.copy
  });
  return value === "setup";
}

async function selectSimpleChoice<T extends string>(prompt: Prompt, input: {
  title: string;
  body: string;
  defaultIndex: number;
  choices: Array<{ value: T; label: string; description: string }>;
  copy: OnboardingCopy;
}): Promise<T> {
  if (prompt.select !== undefined) {
    return await prompt.select(withSelectChrome(input.copy, {
      title: input.title,
      body: input.body,
      defaultIndex: input.defaultIndex,
      options: input.choices,
      fallbackPrompt: `${renderNumberedChoices(input.title, input.body, input.choices)}\n${renderFallbackChoicePrompt(input.copy, input.defaultIndex, input.choices)}`
    }));
  }

  const selectedRaw = await prompt(`${renderNumberedChoices(input.title, input.body, input.choices)}\n${renderFallbackChoicePrompt(input.copy, input.defaultIndex, input.choices)}`);
  return input.choices[parseChoiceIndex(selectedRaw, input.choices.length, input.defaultIndex)]?.value ?? input.choices[input.defaultIndex]!.value;
}

async function promptForValidatedText(
  prompt: Prompt,
  question: string,
  isValid: (value: string) => boolean,
  failure: string
): Promise<string> {
  let retryNotice = "";
  while (true) {
    const value = await prompt(`${retryNotice}${question}`);
    if (isValid(value)) {
      return value.trim();
    }
    retryNotice = `${failure}\n\n`;
  }
}

async function promptForValidatedSecret(
  prompt: Prompt,
  question: string,
  isValid: (value: string) => boolean,
  failure: string
): Promise<string> {
  let retryNotice = "";
  while (true) {
    const value = await prompt(`${retryNotice}${question}`, { secret: true });
    if (isValid(value)) {
      return value.trim();
    }
    retryNotice = `${failure}\n\n`;
  }
}

async function promptForRequiredSecret(prompt: Prompt, question: string, label: string, copy: OnboardingCopy): Promise<string> {
  return await promptForValidatedSecret(
    prompt,
    question,
    (value) => value.trim().length > 0,
    copy.providers.requiredSecretError(label)
  );
}

function renderWelcome(input: {
  theme: ThemeDefinition;
  copy: OnboardingCopy;
}): string {
  const brand = input.theme.branding;
  const rule = "─".repeat(64);

  return [
    `${brand.responseLabel} ${input.copy.welcome.titleSuffix}`,
    brand.taglinePrimary,
    brand.taglineSecondary,
    rule,
    "",
    input.copy.welcome.intro,
    ...input.copy.welcome.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    input.copy.welcome.outro
  ].join("\n");
}

function renderProviderPicker(
  copy: OnboardingCopy,
  choices: ProviderChoice[] = providerChoices(copy),
  title = copy.providers.title,
  body = copy.providers.body
): string {
  return [
    title,
    body,
    "",
    ...choices.map((option, index) => {
      const credential = option.provider === "local" ? copy.common.localProviderNoKey : `${defaultEnvKey(option.provider)}`;
      return `${index + 1}. ${option.label.padEnd(14)} ${option.description} (${credential})`;
    })
  ].join("\n");
}

function renderNumberedChoices(
  title: string,
  body: string,
  choices: Array<{ label: string; description?: string }>
): string {
  return [
    title,
    body,
    "",
    ...choices.map((choice, index) => `${index + 1}. ${choice.label}${choice.description === undefined ? "" : `\n   ${choice.description}`}`)
  ].join("\n");
}

function renderFallbackChoicePrompt(copy: OnboardingCopy, defaultIndex: number, choices: Array<{ label: string }>): string {
  return copy.common.choicePrompt(defaultIndex + 1, choices[defaultIndex]?.label ?? copy.common.firstOption);
}

function renderModelPicker(provider: ProviderChoice, copy: OnboardingCopy): string {
  return [
    copy.providers.modelTitle(provider.label),
    copy.providers.modelBody,
    "",
    ...provider.models.map((option, index) => `${index + 1}. ${option.label.padEnd(24)} ${option.description ?? formatProviderModel(option.provider, option.model)}`)
  ].join("\n");
}

async function applyOptionalCapabilities(options: OnboardingOptions & {
  workspaceRoot: string;
  capabilities: OptionalCapabilityDraft;
}): Promise<void> {
  if (options.capabilities.telegram !== undefined) {
    await setupTelegramConfig({
      ...options,
      input: {
        scope: "user",
        enabled: true,
        botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
        botToken: options.capabilities.telegram.botToken,
        allowedUserIds: [options.capabilities.telegram.allowedUserId]
      }
    });
  }

  if (options.capabilities.voice !== undefined) {
    await setupVoiceConfig({
      ...options,
      input: {
        scope: "user",
        sttProvider: options.capabilities.voice.sttProvider,
        sttApiKeyEnv: options.capabilities.voice.sttApiKeyEnv,
        sttApiKey: options.capabilities.voice.sttApiKey,
        ttsProvider: options.capabilities.voice.ttsProvider,
        ttsApiKeyEnv: options.capabilities.voice.ttsApiKeyEnv,
        ttsApiKey: options.capabilities.voice.ttsApiKey
      }
    });
  }

  if (options.capabilities.vision?.imageProvider !== undefined) {
    await setupImageGenerationConfig({
      ...options,
      input: {
        scope: "user",
        provider: options.capabilities.vision.imageProvider,
        model: options.capabilities.vision.imageModel,
        apiKeyEnv: options.capabilities.vision.imageApiKeyEnv,
        apiKey: options.capabilities.vision.imageApiKey
      }
    });
  }

  if (options.capabilities.browser === true) {
    await setupBrowserConfig({
      ...options,
      input: {
        scope: "user",
        backend: "local-cdp",
        autoLaunch: false
      }
    });
  }
}

function summarizeCapabilities(input: OptionalCapabilityDraft, copy: OnboardingCopy): string {
  const capabilities = [
    input.telegram === undefined ? undefined : copy.channels.telegramLabel,
    input.voice === undefined ? undefined : copy.optional.voice.label,
    input.vision === undefined ? undefined : copy.optional.vision.label,
    input.browser === true ? copy.optional.browser.label : undefined
  ].filter((value): value is string => value !== undefined);
  return capabilities.length === 0 ? copy.review.optionalSkipped : capabilities.join(", ");
}

function renderReview(input: {
  copy: OnboardingCopy;
  interfaceLabel: string;
  provider: string;
  model: string;
  backup: string;
  credential: string;
  trust: string;
  securityMode: string;
  workflowLearning: string;
  capabilities: string;
}): string {
  const labels = input.copy.review.labels;
  return [
    input.copy.review.title,
    `${labels.interface}:  ${input.interfaceLabel}`,
    `${labels.provider}:   ${input.provider}`,
    `${labels.model}:      ${input.model}`,
    `${labels.backup}:     ${input.backup}`,
    `${labels.credential}: ${input.credential}`,
    `${labels.workspace}:  ${input.trust}`,
    `${labels.security}:   ${input.securityMode}`,
    `${labels.workflow}:   ${input.workflowLearning}`,
    `${labels.optional}:   ${input.capabilities}`,
    "",
    input.copy.review.note
  ].join("\n");
}

function renderSecurityModePrompt(locale: Locale, copy: OnboardingCopy): string {
  return [
    copy.security.fallbackTitle,
    renderSecurityModeOption(1, "strict", locale),
    renderSecurityModeOption(2, "adaptive", locale),
    renderSecurityModeOption(3, "open", locale),
    copy.security.fallbackPrompt
  ].join("\n");
}

function renderSkillAutonomyPrompt(locale: Locale, copy: OnboardingCopy): string {
  return [
    copy.workflowLearning.fallbackTitle,
    renderSkillAutonomyOption(1, "none", locale),
    renderSkillAutonomyOption(2, "suggest", locale),
    renderSkillAutonomyOption(3, "proactive", locale),
    renderSkillAutonomyOption(4, "autonomous", locale),
    copy.workflowLearning.fallbackPrompt
  ].join("\n");
}

function parseSecurityMode(value: string): SecurityApprovalMode {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "strict":
      return "strict";
    case "3":
    case "open":
      return "open";
    case "2":
    case "adaptive":
    default:
      return "adaptive";
  }
}

function parseSkillAutonomy(value: string): SkillAutonomy {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "none":
      return "none";
    case "3":
    case "proactive":
      return "proactive";
    case "4":
    case "autonomous":
      return "autonomous";
    case "2":
    case "suggest":
    default:
      return "suggest";
  }
}

function parseYesNo(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return defaultValue;
  }
  return normalized === "y" || normalized === "yes";
}

async function plainQuestion(input: Readable, output: Writable, question: string): Promise<string> {
  const readline = createPromptInterface({ input, output });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

async function hiddenQuestion(input: Readable, output: Writable, question: string): Promise<string> {
  const isTty = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  if (!isTty) {
    const readline = createPromptInterface({ input, output });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  }

  return await new Promise<string>((resolve) => {
    const readline = createCallbackInterface({ input, output, terminal: true });
    const mutable = readline as unknown as { _writeToOutput?: (value: string) => void; stdoutMuted?: boolean };
    const originalWrite = mutable._writeToOutput?.bind(readline);
    output.write(`${question}\n`);
    mutable.stdoutMuted = true;
    mutable._writeToOutput = (value: string) => {
      if (mutable.stdoutMuted === true) {
        output.write(value.replace(/[^\r\n]/gu, "*"));
      } else {
        originalWrite?.(value);
      }
    };
    readline.question("", (answer) => {
      mutable.stdoutMuted = false;
      output.write("\n");
      readline.close();
      resolve(answer);
    });
  });
}
