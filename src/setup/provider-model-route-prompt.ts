import type { Prompt } from "../cli/readline-prompt.js";
import type { SelectPromptInput } from "../cli/interactive-select.js";
import type {
  FlowEngine,
  ModelCandidate,
  ProviderCandidate,
  ProviderModelSelectionResult,
} from "../providers/provider-model-selection-flow.js";
import type { ProviderId, ModelProfile } from "../contracts/provider.js";
import {
  CODEX_DEFAULT_MODEL,
} from "../providers/oauth/codex-setup.js";
import { isolateLtr } from "../ui/bidi.js";
import {
  formatSetupCopy,
  setupCopyText,
} from "./setup-prompts.js";
import { modelDescriptionOverride, type SetupCopyKey, type SetupCopyLocale } from "./setup-copy.js";

export type ProviderModelRoutePromptMode =
  | "primary"
  | "fallback"
  | "auxiliary"
  | "onboarding";

export type SelectProviderModelRouteOptions = {
  readonly prompt: Prompt;
  readonly flowEngine: FlowEngine;
  readonly locale: SetupCopyLocale;
  readonly currentProviderId?: string;
  readonly currentModelId?: string;
  readonly allowBack?: boolean;
  readonly allowCancel?: boolean;
  readonly mode: ProviderModelRoutePromptMode;
  readonly openAiCodexChoice?: boolean;
};

export type ProviderModelPromptResult =
  | { readonly kind: "selected"; readonly selection: ProviderModelSelectionResult }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" }
  | { readonly kind: "diagnostic"; readonly output: string };

type ProviderPromptAction =
  | { readonly kind: "provider"; readonly provider: ProviderCandidate }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" };

type ModelPromptAction =
  | { readonly kind: "model"; readonly model: ModelCandidate }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" };

type OpenAiCodexPromptAction =
  | { readonly kind: "openai" }
  | { readonly kind: "codex" }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" };

const PROMPT_HINT = "↑↓ navigate   ENTER select";

export async function selectProviderModelRoute(
  options: SelectProviderModelRouteOptions
): Promise<ProviderModelPromptResult> {
  const allProviders = await options.flowEngine.listProviderCandidates();
  const providers = providerPromptCandidates(options, allProviders);
  if (providers.length === 0) {
    return { kind: "diagnostic", output: "No setup-visible provider candidates are available." };
  }

  while (true) {
    const providerAction = await promptProvider(options, providers);
    if (providerAction.kind === "back" || providerAction.kind === "cancel") {
      return { kind: providerAction.kind };
    }

    const provider = providerAction.provider;
    if (shouldPromptOpenAiCodexChoice(options, allProviders, provider)) {
      const choiceAction = await promptOpenAiCodexChoice(options);
      if (choiceAction.kind === "back") {
        continue;
      }
      if (choiceAction.kind === "cancel") {
        return { kind: "cancel" };
      }
      if (choiceAction.kind === "codex") {
        const resolved = await options.flowEngine.resolveSelection("codex", CODEX_DEFAULT_MODEL);
        if (resolved.kind === "diagnostic") {
          return { kind: "diagnostic", output: `Provider/model selection failed: ${resolved.reason}` };
        }
        return { kind: "selected", selection: resolved };
      }
    }

    const models = await options.flowEngine.listModelCandidates(provider.id);
    if (models.length === 0) {
      return { kind: "diagnostic", output: `No setup-visible models are available for ${provider.displayName}.` };
    }

    const modelAction = await promptModel(options, provider, models);
    if (modelAction.kind === "back") {
      continue;
    }
    if (modelAction.kind === "cancel") {
      return { kind: "cancel" };
    }

    const resolved = await options.flowEngine.resolveSelection(provider.id, modelAction.model.id);
    if (resolved.kind === "diagnostic") {
      return { kind: "diagnostic", output: `Provider/model selection failed: ${resolved.reason}` };
    }

    return { kind: "selected", selection: resolved };
  }
}

function providerPromptCandidates(
  options: SelectProviderModelRouteOptions,
  candidates: readonly ProviderCandidate[]
): readonly ProviderCandidate[] {
  if (!hasOpenAiCodexChoice(options, candidates)) {
    return candidates;
  }
  return candidates.filter((candidate) => candidate.id !== "codex");
}

function hasOpenAiCodexChoice(
  options: SelectProviderModelRouteOptions,
  candidates: readonly ProviderCandidate[]
): boolean {
  return options.openAiCodexChoice === true &&
    candidates.some((candidate) => candidate.id === "openai") &&
    candidates.some((candidate) => candidate.id === "codex");
}

function shouldPromptOpenAiCodexChoice(
  options: SelectProviderModelRouteOptions,
  allProviders: readonly ProviderCandidate[],
  provider: ProviderCandidate
): boolean {
  return provider.id === "openai" && hasOpenAiCodexChoice(options, allProviders);
}

async function promptProvider(
  options: SelectProviderModelRouteOptions,
  candidates: readonly ProviderCandidate[]
): Promise<ProviderPromptAction> {
  const currentProviderIndex = candidates.findIndex((candidate) => candidate.id === options.currentProviderId);
  const promptOptions: Array<SelectPromptInput<ProviderPromptAction>["options"][number]> = [
    ...candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.displayName,
      value: { kind: "provider" as const, provider: candidate },
      cells: {
        name: candidate.displayName,
        details: providerCandidateDescription(options.locale, candidate),
      },
      current: candidate.id === options.currentProviderId,
    })),
    ...navigationOptions<ProviderPromptAction>(options),
  ];

  return selectStructuredOption(options.prompt, {
    title: providerTitle(options.locale, options.mode),
    body: `${providerBody(options.locale, options.mode)}\n`,
    statusLines: currentRouteStatusLines(options.locale, options.currentProviderId, options.currentModelId),
    columns: promptColumns(options.locale),
    options: promptOptions,
    defaultIndex: currentProviderIndex >= 0 ? currentProviderIndex : 0,
    fallbackPrompt: "Choose: ",
    surface: "promptCard",
    hint: PROMPT_HINT,
    showCurrentBadge: false,
    locale: options.locale,
    direction: options.locale === "ar" ? "rtl" : "ltr",
  });
}

async function promptModel(
  options: SelectProviderModelRouteOptions,
  provider: ProviderCandidate,
  candidates: readonly ModelCandidate[]
): Promise<ModelPromptAction> {
  const currentModelVisible =
    provider.id === options.currentProviderId &&
    options.currentModelId !== undefined &&
    candidates.some((candidate) => candidate.id === options.currentModelId);
  const currentModelIndex = currentModelVisible
    ? candidates.findIndex((candidate) => candidate.id === options.currentModelId)
    : -1;
  const promptOptions: Array<SelectPromptInput<ModelPromptAction>["options"][number]> = [
    ...candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.id,
      value: { kind: "model" as const, model: candidate },
      cells: {
        name: candidate.id,
        details: modelCandidateDescription(options.locale, candidate),
      },
      current: provider.id === options.currentProviderId && candidate.id === options.currentModelId,
    })),
    ...navigationOptions<ModelPromptAction>(options),
  ];

  return selectStructuredOption(options.prompt, {
    title: modelTitle(options.locale, options.mode),
    body: `${modelBody(options.locale, options.mode).replace("{providerId}", provider.id)}\n`,
    statusLines: currentRouteStatusLines(options.locale, options.currentProviderId, options.currentModelId),
    technicalLines: currentModelNotShownLines(options.locale, provider.id, options.currentProviderId, options.currentModelId, currentModelVisible),
    columns: promptColumns(options.locale),
    options: promptOptions,
    defaultIndex: currentModelIndex >= 0 ? currentModelIndex : 0,
    fallbackPrompt: "Choose: ",
    surface: "promptCard",
    hint: PROMPT_HINT,
    showCurrentBadge: false,
    locale: options.locale,
    direction: options.locale === "ar" ? "rtl" : "ltr",
  });
}

async function promptOpenAiCodexChoice(
  options: SelectProviderModelRouteOptions
): Promise<OpenAiCodexPromptAction> {
  const promptOptions: Array<SelectPromptInput<OpenAiCodexPromptAction>["options"][number]> = [
    {
      id: "openai-api-key",
      label: openAiModelsLabel(options.locale),
      value: { kind: "openai" },
      cells: {
        name: openAiModelsLabel(options.locale),
        details: openAiModelsDetails(options.locale),
      },
      current: options.currentProviderId === "openai",
    },
    {
      id: "codex-oauth",
      label: codexOauthLabel(options.locale),
      value: { kind: "codex" },
      cells: {
        name: codexOauthLabel(options.locale),
        details: codexOauthDetails(options.locale),
      },
      current: options.currentProviderId === "codex",
    },
    ...navigationOptions<OpenAiCodexPromptAction>(options),
  ];

  return selectStructuredOption(options.prompt, {
    title: openAiCodexTitle(options.locale),
    body: `${openAiCodexBody(options.locale)}\n`,
    statusLines: currentRouteStatusLines(options.locale, options.currentProviderId, options.currentModelId),
    columns: promptColumns(options.locale),
    options: promptOptions,
    defaultIndex: options.currentProviderId === "codex" ? 1 : 0,
    fallbackPrompt: "Choose: ",
    surface: "promptCard",
    hint: PROMPT_HINT,
    showCurrentBadge: false,
    locale: options.locale,
    direction: options.locale === "ar" ? "rtl" : "ltr",
  });
}

async function selectStructuredOption<T>(
  prompt: Prompt,
  input: SelectPromptInput<T>
): Promise<T> {
  if (prompt.select !== undefined) {
    return prompt.select(input);
  }

  const options = input.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
  const raw = await prompt(`${input.body ?? ""}${options}\n${input.fallbackPrompt}`);
  const selectedIndex = Number.parseInt(raw.trim(), 10) - 1;
  return input.options[selectedIndex]?.value ?? input.options[input.defaultIndex ?? 0]?.value ?? input.options[0]!.value;
}

function navigationOptions<T extends { readonly kind: string }>(
  options: SelectProviderModelRouteOptions
): Array<SelectPromptInput<T>["options"][number]> {
  const rows: Array<SelectPromptInput<T>["options"][number]> = [];
  if (options.allowBack === true) {
    rows.push({
      id: "back",
      label: backLabel(options.locale),
      value: { kind: "back" } as T,
      group: "navigation",
      cells: {
        name: backLabel(options.locale),
        details: backDetails(options.locale),
      },
    });
  }
  if (options.allowCancel === true) {
    rows.push({
      id: "cancel",
      label: setupCopyText(options.locale, "onboarding.review.cancelAction"),
      value: { kind: "cancel" } as T,
      group: "navigation",
      cells: {
        name: setupCopyText(options.locale, "onboarding.review.cancelAction"),
        details: cancelDetails(options.locale),
      },
    });
  }
  return rows;
}

function promptColumns(locale: SetupCopyLocale): SelectPromptInput<unknown>["columns"] {
  return [
    { key: "name", header: locale === "ar" ? "الاسم" : "Name" },
    { key: "details", header: locale === "ar" ? "التفاصيل" : "Details" },
  ];
}

function openAiCodexTitle(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.title");
}

function openAiCodexBody(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.body");
}

function openAiModelsLabel(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.openAiModels");
}

function openAiModelsDetails(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.openAiModels.description");
}

function codexOauthLabel(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.codex");
}

function codexOauthDetails(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "setupEditor.prompt.openAiRoute.codex.description");
}

export function providerCandidateDescription(locale: SetupCopyLocale, candidate: ProviderCandidate): string {
  const key = PROVIDER_DESCRIPTION_KEYS[candidate.id];
  if (key !== undefined) {
    return setupCopyText(locale, key);
  }
  if (candidate.baseUrl !== undefined && candidate.baseUrl.length > 0) {
    return formatSetupCopy(locale, "onboarding.providers.description.customBaseUrl", {
      baseUrl: candidate.baseUrl,
    });
  }
  return setupCopyText(locale, "onboarding.providers.description.custom");
}

export function modelCandidateDescription(locale: SetupCopyLocale, candidate: ModelCandidate): string {
  const metadataParts = [
    candidate.profile.contextWindowTokens > 0
      ? formatSetupCopy(locale, "onboarding.catalog.model.context", {
          contextWindow: formatContextWindow(candidate.profile.contextWindowTokens),
        })
      : undefined,
    candidate.profile.supportsTools ? setupCopyText(locale, "onboarding.catalog.model.features.tools") : undefined,
    candidate.profile.supportsVision ? setupCopyText(locale, "onboarding.catalog.model.features.vision") : undefined,
    candidate.profile.supportsReasoning ? setupCopyText(locale, "onboarding.catalog.model.features.reasoning") : undefined,
  ].filter((part): part is string => part !== undefined);

  const descriptionParts: string[] = [...metadataParts];
  const status = renderableModelStatus(locale, candidate.profile.status);
  if (status !== undefined) {
    descriptionParts.push(status);
  }
  const lifecycle = renderableLifecycle(locale, candidate.lifecycle);
  if (lifecycle !== undefined && lifecycle !== status) {
    descriptionParts.push(lifecycle);
  }
  if (candidate.lifecycleNote !== undefined && candidate.lifecycleNote.trim().length > 0) {
    descriptionParts.push(trimSentencePunctuation(candidate.lifecycleNote));
  }
  for (const warning of candidate.warnings ?? []) {
    if (warning.trim().length > 0) {
      descriptionParts.push(trimSentencePunctuation(warning));
    }
  }

  const override = modelDescriptionOverride(locale, candidate.provider, candidate.id);
  if (override !== undefined) {
    descriptionParts.push(trimSentencePunctuation(override));
  }

  if (descriptionParts.length === 0) {
    if (candidate.provider === "local") {
      return setupCopyText(locale, "onboarding.catalog.model.description.local");
    }
    if (candidate.provider === "openai-compatible") {
      return setupCopyText(locale, "onboarding.catalog.model.description.custom");
    }
  }

  return joinMetadataList(descriptionParts);
}

const PROVIDER_DESCRIPTION_KEYS: Partial<Record<string, SetupCopyKey>> = {
  openai: "onboarding.providers.description.openai",
  google: "onboarding.providers.description.google",
  deepseek: "onboarding.providers.description.deepseek",
  kimi: "onboarding.providers.description.kimi",
  openrouter: "onboarding.providers.description.openrouter",
  zai: "onboarding.providers.description.zai",
  local: "onboarding.providers.description.local",
  codex: "onboarding.providers.description.codex",
  "openai-compatible": "onboarding.providers.description.custom",
};

function renderableModelStatus(locale: SetupCopyLocale, status: ModelProfile["status"]): string | undefined {
  if (status === "alpha") return setupCopyText(locale, "onboarding.catalog.model.status.alpha");
  if (status === "beta") return setupCopyText(locale, "onboarding.catalog.model.status.beta");
  if (status === "deprecated") return setupCopyText(locale, "onboarding.catalog.model.status.deprecated");
  return undefined;
}

function renderableLifecycle(locale: SetupCopyLocale, lifecycle: ModelCandidate["lifecycle"]): string | undefined {
  if (lifecycle === "deprecated") return setupCopyText(locale, "onboarding.catalog.model.status.deprecated");
  return lifecycle === "retired" ? setupCopyText(locale, "onboarding.catalog.model.status.retired") : undefined;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(1))}K`;
  }
  return String(tokens);
}

function trimSentencePunctuation(value: string): string {
  return value.trim().replace(/[.。]+$/u, "");
}

function joinMetadataList(parts: readonly string[]): string {
  return parts.join(" | ");
}

function currentRouteStatusLines(
  locale: SetupCopyLocale,
  currentProviderId: string | undefined,
  currentModelId: string | undefined
): SelectPromptInput<unknown>["statusLines"] {
  if (currentProviderId === undefined || currentModelId === undefined) {
    return undefined;
  }
  const route = formatRoute(currentProviderId, currentModelId);
  return [{
    text: locale === "ar"
      ? `${setupCopyText(locale, "onboarding.providers.current")}: ${isolateLtr(route)}`
      : `${setupCopyText(locale, "onboarding.providers.current")}: ${route}`,
    tone: "active",
    direction: locale === "ar" ? "rtl" : "ltr",
  }];
}

function currentModelNotShownLines(
  locale: SetupCopyLocale,
  providerId: string,
  currentProviderId: string | undefined,
  currentModelId: string | undefined,
  currentModelVisible: boolean
): readonly string[] | undefined {
  if (currentProviderId === undefined || currentModelId === undefined) {
    return undefined;
  }
  if (providerId === currentProviderId && !currentModelVisible) {
    return [formatSetupCopy(locale, "onboarding.providers.currentModelNotShown", {
      route: formatRoute(currentProviderId, currentModelId),
    })];
  }
  return undefined;
}

function formatRoute(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

function providerTitle(locale: SetupCopyLocale, mode: ProviderModelRoutePromptMode): string {
  if (mode === "fallback") return locale === "ar" ? "المزوّد الاحتياطي" : "Fallback provider";
  if (mode === "auxiliary") return locale === "ar" ? "المزوّد المساعد" : "Auxiliary provider";
  return setupCopyText(locale, "onboarding.providers.primary.title");
}

function providerBody(locale: SetupCopyLocale, mode: ProviderModelRoutePromptMode): string {
  if (mode === "fallback") return locale === "ar" ? "اختر مزوّدًا احتياطيًا." : "Choose a fallback provider.";
  if (mode === "auxiliary") return locale === "ar" ? "اختر مزوّدًا مساعدًا." : "Choose an auxiliary provider.";
  return setupCopyText(locale, "onboarding.providers.primary");
}

function modelTitle(locale: SetupCopyLocale, mode: ProviderModelRoutePromptMode): string {
  if (mode === "fallback") return locale === "ar" ? "النموذج الاحتياطي" : "Fallback model";
  if (mode === "auxiliary") return locale === "ar" ? "النموذج المساعد" : "Auxiliary model";
  return setupCopyText(locale, "onboarding.providers.primaryModel.title");
}

function modelBody(locale: SetupCopyLocale, mode: ProviderModelRoutePromptMode): string {
  if (mode === "fallback") return locale === "ar" ? "اختر النموذج الاحتياطي للمزوّد {providerId}." : "Choose the fallback model for {providerId}.";
  if (mode === "auxiliary") return locale === "ar" ? "اختر النموذج المساعد للمزوّد {providerId}." : "Choose the auxiliary model for {providerId}.";
  return setupCopyText(locale, "onboarding.providers.primaryModel");
}

function backLabel(locale: SetupCopyLocale): string {
  return locale === "ar" ? "رجوع" : "Back";
}

function backDetails(locale: SetupCopyLocale): string {
  return setupCopyText(locale, "onboarding.providers.navigation.back.description");
}

function cancelDetails(locale: SetupCopyLocale): string {
  return locale === "ar" ? "اخرج بدون تغيير الإعداد." : "Exit without changing setup.";
}
