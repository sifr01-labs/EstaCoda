import { resolveStateHome } from "../../config/state-home.js";
import {
  defaultEnvKey,
  loadRuntimeConfig,
  type ActivityLabelsLocale,
  type UiFlavor,
  type UiLanguage,
} from "../../config/runtime-config.js";
import type { ProviderId } from "../../contracts/provider.js";
import type { Prompt } from "../../cli/readline-prompt.js";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import { createModelSelectionCatalog } from "../../providers/model-selection-catalog.js";
import {
  type FirstRunOnboardingSelections,
  type OptionalCapabilityId,
} from "../first-run-plan.js";
import { buildFirstRunDraftBundle, type SetupDraftBundle } from "../setup-drafts.js";
import {
  buildSetupReviewManifest,
  type SetupReviewManifest,
  type SetupReviewManifestSection,
} from "../setup-review-manifest.js";
import {
  executeSetupApplyPlan,
  planSetupApply,
  type SetupApplyEndState,
  type SetupApplyExecutor,
  type SetupApplyFlowOptions,
  type SetupApplyPlanningResult,
} from "../setup-apply-plan.js";
import {
  collectSetupEntryState,
  type CollectSetupEntryStateOptions,
  type SetupEntryState,
} from "../setup-entry-state.js";
import { routeSetupEntryState, type FirstRunPlanSession } from "../setup-router.js";
import { hasSetupCopyKey, resolveSetupCopy, type SetupCopyKey, type SetupCopyLocale } from "../setup-copy.js";

export type FirstRunProviderOption = {
  readonly id: ProviderId;
  readonly label: string;
  readonly description?: string;
  readonly requiresCredential: boolean;
};

export type FirstRunModelOption = {
  readonly provider: ProviderId;
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};

export type FirstRunCatalog = {
  readonly listProviders: () => Promise<readonly FirstRunProviderOption[]>;
  readonly listModels: (provider: ProviderId) => Promise<readonly FirstRunModelOption[]>;
};

export type FirstRunSetupRunnerOptions = CollectSetupEntryStateOptions & {
  readonly prompt: Prompt;
  readonly catalog?: FirstRunCatalog;
  readonly defaultSelections?: FirstRunOnboardingSelections;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
  readonly output?: {
    readonly write: (value: string) => void;
  };
};

export type FirstRunSetupRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly state: SetupEntryState;
  readonly selections: FirstRunOnboardingSelections;
  readonly planSession: FirstRunPlanSession;
  readonly draftBundle: SetupDraftBundle;
  readonly reviewManifest: SetupReviewManifest;
  readonly applyPlanningResult: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
};

type Choice<T> = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: T;
};

type InterfaceStyleChoice = Choice<{
  readonly flavor: UiFlavor;
  readonly activityLabels: ActivityLabelsLocale;
}> & {
  readonly labelKey: SetupCopyKey;
  readonly descriptionKey: SetupCopyKey;
};

const REVIEW_SECTION_COPY_KEYS: Record<SetupReviewManifestSection, SetupCopyKey> = {
  "files-to-write-update": "setupReview.sections.filesToWriteUpdate",
  "secret-refs-to-store": "setupReview.sections.secretRefsToStore",
  "workspace-trust-grants": "setupReview.sections.workspaceTrustGrants",
  "provider-model-network": "setupReview.sections.providerModelNetwork",
  "enabled-optional-capabilities": "setupReview.sections.enabledOptionalCapabilities",
  "remote-control-surfaces": "setupReview.sections.remoteControlSurfaces",
  "security-mode": "setupReview.sections.securityMode",
  "workflow-learning": "setupReview.sections.workflowLearning",
  "verification-checks": "setupReview.sections.verificationChecks",
  "launch-handoff": "setupReview.sections.launchHandoff",
  blockers: "setupReview.sections.blockers",
  warnings: "setupReview.sections.warnings",
};

const OPTIONAL_CAPABILITY_COPY_KEYS: Record<OptionalCapabilityId, {
  readonly title: SetupCopyKey;
}> = {
  channels: {
    title: "setupModules.telegram.title",
  },
  voice: {
    title: "setupModules.voice.title",
  },
  vision: {
    title: "setupModules.vision.title",
  },
  browser: {
    title: "setupModules.browser.title",
  },
};

const OPTIONAL_CAPABILITY_IDS: readonly OptionalCapabilityId[] = ["channels", "voice", "vision", "browser"];

export async function runFirstRunSetup(
  options: FirstRunSetupRunnerOptions
): Promise<FirstRunSetupRunnerResult> {
  const prompt = options.prompt;
  const state = await collectSetupEntryState(options);
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const catalog = options.catalog ?? await createDefaultCatalog(options);
  const initialLocale = options.defaultSelections?.language ?? "en";

  await showCard(prompt, initialLocale, {
    title: copy(initialLocale, "onboarding.welcome.title"),
    bodyLines: [copy(initialLocale, "onboarding.welcome")],
    options: [{ id: "begin", label: copy(initialLocale, "onboarding.common.begin") }],
  });

  const language = await choose(prompt, {
    title: copy(initialLocale, "onboarding.interfaceLanguage.title"),
    message: `${copy(initialLocale, "onboarding.interfaceLanguage")}\n`,
    choices: [
      {
        id: "en",
        label: copy(initialLocale, "onboarding.interfaceLanguage.options.en.label"),
        description: copy(initialLocale, "onboarding.interfaceLanguage.options.en.description"),
        value: "en" as const,
      },
      {
        id: "ar",
        label: copy(initialLocale, "onboarding.interfaceLanguage.options.ar.label"),
        description: copy(initialLocale, "onboarding.interfaceLanguage.options.ar.description"),
        value: "ar" as const,
      },
    ],
    defaultValue: options.defaultSelections?.language ?? "en",
  });

  const interfaceChoices = interfaceStyleChoices(language);
  const defaultInterfaceChoice = interfaceChoices.find((choice) =>
    choice.value.flavor === options.defaultSelections?.interfaceFlavor
  )?.value ?? interfaceChoices[0]!.value;
  const interfaceChoice = await choose(prompt, {
    title: copy(language, "onboarding.interfaceStyle.title"),
    message: `${copy(language, "onboarding.interfaceStyle.prompt")}\n`,
    choices: interfaceChoices.map((choice) => ({
      ...choice,
      label: copy(language, choice.labelKey),
      description: copy(language, choice.descriptionKey),
    })),
    defaultValue: defaultInterfaceChoice,
  });

  await showCard(prompt, language, {
    title: copy(language, "onboarding.workspace.title"),
    bodyLines: [copy(language, "onboarding.workspace.root")],
    technicalLines: [options.workspaceRoot],
    options: [{ id: "workspace", label: options.workspaceRoot, technical: true }],
  });
  const workspaceRoot = await askWithDefault(
    prompt,
    `${copy(language, "onboarding.workspace.root")} [${options.workspaceRoot}]: `,
    options.defaultSelections?.workspaceRoot ?? options.workspaceRoot
  );

  const workspaceTrusted = await choose(prompt, {
    title: copy(language, "onboarding.workspace.trust.title"),
    message: `${copy(language, "onboarding.workspace.trust")}\n`,
    choices: [
      {
        id: "trust",
        label: copy(language, "onboarding.workspace.trustAction.label"),
        description: copy(language, "onboarding.workspace.trustAction.description"),
        value: true,
      },
      {
        id: "skip",
        label: copy(language, "onboarding.workspace.deferTrustAction.label"),
        description: copy(language, "onboarding.workspace.deferTrustAction.description"),
        value: false,
      },
    ],
    defaultValue: options.defaultSelections?.workspaceTrusted ?? true,
  });

  const providerOptions = await catalog.listProviders();
  const primaryProvider = await choose(prompt, {
    title: copy(language, "onboarding.providers.primary.title"),
    message: `${copy(language, "onboarding.providers.primary")}\n`,
    choices: providerOptions.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      value: provider.id,
    })),
    defaultValue: options.defaultSelections?.primaryProvider ?? providerOptions[0]?.id,
  });

  const modelOptions = await catalog.listModels(primaryProvider);
  const primaryModel = await choose(prompt, {
    title: copy(language, "onboarding.providers.primaryModel.title"),
    message: `${copy(language, "onboarding.providers.primaryModel").replace("{providerId}", primaryProvider)}\n`,
    choices: modelOptions.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      value: model.id,
    })),
    defaultValue: options.defaultSelections?.primaryModel ?? modelOptions[0]?.id,
  });

  const providerRequiresCredential = providerOptions.find((provider) => provider.id === primaryProvider)?.requiresCredential ?? primaryProvider !== "local";
  const primaryCredential = providerRequiresCredential
    ? {
        kind: "env" as const,
        name: await askWithDefault(
          prompt,
          `${copy(language, "onboarding.providers.primaryCredential")} [${defaultEnvKey(primaryProvider)}]: `,
          options.defaultSelections?.primaryCredential?.kind === "env"
            ? options.defaultSelections.primaryCredential.name
            : defaultEnvKey(primaryProvider)
        ),
      }
    : { kind: "none" as const };

  if (!providerRequiresCredential) {
    write(options, `${copy(language, "onboarding.providers.primaryCredential.localProviderSkip")}\n`);
  }

  const securityMode = await choose(prompt, {
    title: copy(language, "onboarding.security.title"),
    message: `${copy(language, "onboarding.security")}\n`,
    choices: [
      {
        id: "adaptive",
        label: copy(language, "onboarding.security.options.adaptive.label"),
        description: copy(language, "onboarding.security.options.adaptive.description"),
        value: "adaptive" as const,
      },
      {
        id: "strict",
        label: copy(language, "onboarding.security.options.strict.label"),
        description: copy(language, "onboarding.security.options.strict.description"),
        value: "strict" as const,
      },
      {
        id: "open",
        label: copy(language, "onboarding.security.options.open.label"),
        description: copy(language, "onboarding.security.options.open.description"),
        value: "open" as const,
      },
    ],
    defaultValue: options.defaultSelections?.securityMode ?? "adaptive",
  });

  const workflowLearning = await choose(prompt, {
    title: copy(language, "onboarding.workflowLearning.title"),
    message: `${copy(language, "onboarding.workflowLearning")}\n`,
    choices: [
      {
        id: "suggest",
        label: copy(language, "onboarding.workflowLearning.options.suggest.label"),
        description: copy(language, "onboarding.workflowLearning.options.suggest.description"),
        value: "suggest" as const,
      },
      {
        id: "none",
        label: copy(language, "onboarding.workflowLearning.options.none.label"),
        description: copy(language, "onboarding.workflowLearning.options.none.description"),
        value: "none" as const,
      },
      {
        id: "proactive",
        label: copy(language, "onboarding.workflowLearning.options.proactive.label"),
        description: copy(language, "onboarding.workflowLearning.options.proactive.description"),
        value: "proactive" as const,
      },
      {
        id: "autonomous",
        label: copy(language, "onboarding.workflowLearning.options.autonomous.label"),
        description: copy(language, "onboarding.workflowLearning.options.autonomous.description"),
        value: "autonomous" as const,
      },
    ],
    defaultValue: options.defaultSelections?.workflowLearning ?? "suggest",
  });

  const optionalCapabilities = await chooseOptionalCapabilities(prompt, language, options.defaultSelections);
  const launchSelected = await choose(prompt, {
    title: copy(language, "onboarding.launch.preferenceTitle"),
    message: `${copy(language, "onboarding.launch")}\n`,
    choices: [
      {
        id: "skip",
        label: copy(language, "onboarding.launch.skipAction.label"),
        description: copy(language, "onboarding.launch.skipAction.description"),
        value: false,
      },
      {
        id: "offer",
        label: copy(language, "onboarding.launch.offerAction.label"),
        description: copy(language, "onboarding.launch.offerAction.description"),
        value: true,
      },
    ],
    defaultValue: options.defaultSelections?.launchSelected ?? false,
  });

  const selections: FirstRunOnboardingSelections = {
    language,
    interfaceFlavor: interfaceChoice.flavor,
    activityLabels: interfaceChoice.activityLabels,
    workspaceRoot,
    workspaceTrusted,
    primaryProvider,
    primaryModel,
    primaryCredential,
    securityMode,
    workflowLearning,
    optionalCapabilities,
    optionalCapabilitiesSkipped: optionalCapabilities.length === 0,
    verifySelected: true,
    launchSelected,
  };

  const routeDecision = routeSetupEntryState(state, {
    selection: "run-first-run",
    firstRunSelections: selections,
  });
  if (routeDecision.firstRunPlanSession === undefined) {
    throw new Error("Setup router did not produce a first-run plan session.");
  }

  const draftBundle = buildFirstRunDraftBundle(routeDecision.firstRunPlanSession, {
    configPath: options.userConfigPath ?? stateHome.configPath,
    workspaceRoot,
    trustStorePath: stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const reviewText = renderReviewManifest(reviewManifest, language);
  write(options, `${copy(language, "onboarding.review")}\n${reviewText}\n`);

  const reviewAccepted = await choose(prompt, {
    title: copy(language, "onboarding.review"),
    message: `${copy(language, "onboarding.review.validation.accepted")}\n`,
    choices: [
      {
        id: "approve",
        label: copy(language, "onboarding.review.approveAction"),
        description: copy(language, "setupApply.review.approved"),
        value: true,
      },
      {
        id: "cancel",
        label: copy(language, "onboarding.review.cancelAction"),
        description: copy(language, "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: options.defaultSelections?.reviewAccepted ?? true,
  });

  const finalSelections = {
    ...selections,
    reviewAccepted,
    saveAccepted: reviewAccepted,
  };
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });
  const applyEndState = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
    ? await executeSetupApplyPlan(applyPlanningResult.applyPlan, options.applyExecutor, options.applyFlowOptions)
    : undefined;
  const output = applyEndState === undefined
    ? resultSummary(applyPlanningResult, language)
    : endStateSummary(applyEndState, language);
  const completed = applyEndState === undefined
    ? applyPlanningResult.kind === "apply-plan-ready"
    : applyEndState.kind !== "blocked" && applyEndState.kind !== "cancelled";

  return {
    completed,
    exitCode: completed ? 0 : 1,
    output,
    state,
    selections: finalSelections,
    planSession: routeDecision.firstRunPlanSession,
    draftBundle,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
  };
}

async function createDefaultCatalog(options: CollectSetupEntryStateOptions): Promise<FirstRunCatalog> {
  const loaded = await loadRuntimeConfig(options);
  const catalog = await createModelSelectionCatalog({
    config: loaded.config,
    providerRegistry: loaded.providerRegistry,
    homeDir: options.homeDir,
    allowNetwork: false,
  });

  return {
    listProviders: async () => {
      const providers = (await catalog.listProviders()).filter((provider) => provider.id !== "unconfigured");
      return providers.map((provider) => ({
        id: provider.id,
        label: provider.name,
        description: provider.catalogOnly
          ? copy("en", "onboarding.catalog.provider.catalogOnly")
          : provider.configured
            ? copy("en", "onboarding.catalog.provider.configured")
            : copy("en", "onboarding.catalog.provider.available"),
        requiresCredential: provider.setupMode !== "none" && provider.id !== "local",
      }));
    },
    listModels: async (providerId) => {
      const models = (await catalog.listModels({ provider: providerId, includeBeta: true }))
        .filter((model) => model.id !== "unconfigured");
      return models.map((model) => ({
        provider: model.provider,
        id: model.id,
        label: model.id,
        description: [
          model.profile.supportsTools ? copy("en", "onboarding.catalog.model.features.tools") : undefined,
          model.profile.supportsVision ? copy("en", "onboarding.catalog.model.features.vision") : undefined,
          model.profile.supportsReasoning ? copy("en", "onboarding.catalog.model.features.reasoning") : undefined,
          model.profile.status !== undefined ? model.profile.status : undefined,
        ].filter((part): part is string => part !== undefined).join(", "),
      }));
    },
  };
}

async function choose<T>(prompt: Prompt, input: {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly Choice<T>[];
  readonly defaultValue?: T;
}): Promise<T> {
  if (input.choices.length === 0) {
    throw new Error(`${input.title} has no choices.`);
  }

  const defaultIndex = Math.max(0, input.choices.findIndex((choice) => Object.is(choice.value, input.defaultValue)));
  if (prompt.select !== undefined) {
    return prompt.select({
      title: input.title,
      body: input.message.trim(),
      options: input.choices.map((choice) => ({
        label: choice.label,
        description: choice.description,
        value: choice.value,
      })),
      defaultIndex,
      fallbackPrompt: "Choose: ",
      surface: "onboarding",
    } satisfies SelectPromptInput<T>);
  }

  const options = input.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
  const raw = await prompt(`${input.message}${options}\nChoose [${(defaultIndex === -1 ? 0 : defaultIndex) + 1}]: `);
  const selectedIndex = Number.parseInt(raw.trim(), 10) - 1;
  return input.choices[selectedIndex]?.value ?? input.choices[defaultIndex === -1 ? 0 : defaultIndex]!.value;
}

async function chooseOptionalCapabilities(
  prompt: Prompt,
  locale: SetupCopyLocale,
  defaultSelections: FirstRunOnboardingSelections | undefined
): Promise<readonly OptionalCapabilityId[]> {
  const selected = new Set(defaultSelections?.optionalCapabilities ?? []);
  const result: OptionalCapabilityId[] = [];

  for (const capabilityId of OPTIONAL_CAPABILITY_IDS) {
    const capabilityCopy = OPTIONAL_CAPABILITY_COPY_KEYS[capabilityId];
    const title = copy(locale, capabilityCopy.title);
    const enabled = await choose(prompt, {
      title,
      message: `${formatCopy(locale, "onboarding.optionalCapabilities.promptCapability", {
        capabilityId: title,
      })}\n`,
      choices: [
        {
          id: "enable",
          label: copy(locale, "onboarding.optionalCapabilities.enable"),
          description: formatCopy(locale, "onboarding.optionalCapabilities.enableDescription", { capabilityId: title }),
          value: true,
        },
        {
          id: "skip",
          label: copy(locale, "onboarding.optionalCapabilities.skip"),
          description: formatCopy(locale, "setupValidation.capability.skipped", { capabilityId: title }),
          value: false,
        },
      ],
      defaultValue: selected.has(capabilityId),
    });
    if (enabled) {
      result.push(capabilityId);
    }
  }

  return result;
}

async function askWithDefault(prompt: Prompt, question: string, defaultValue: string): Promise<string> {
  const answer = (await prompt(question)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

async function showCard(
  prompt: Prompt,
  locale: SetupCopyLocale,
  input: {
    readonly title: string;
    readonly bodyLines: readonly string[];
    readonly technicalLines?: readonly string[];
    readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string; readonly technical?: boolean }[];
  }
): Promise<void> {
  await prompt.onboardingCard?.({
    title: input.title,
    bodyLines: input.bodyLines,
    technicalLines: input.technicalLines,
    options: input.options,
    selectedOptionIndex: 0,
    locale,
    direction: locale === "ar" ? "rtl" : "ltr",
  });
}

function interfaceStyleChoices(language: UiLanguage): readonly InterfaceStyleChoice[] {
  if (language === "ar") {
    return [
      {
        id: "arabic-light",
        label: "",
        labelKey: "onboarding.interfaceStyle.arabicLight.label",
        description: "",
        descriptionKey: "onboarding.interfaceStyle.arabicLight.description",
        value: { flavor: "arabic-light", activityLabels: "ar" },
      },
      {
        id: "standard",
        label: "",
        labelKey: "onboarding.interfaceStyle.standard.label",
        description: "",
        descriptionKey: "onboarding.interfaceStyle.arabicStandard.description",
        value: { flavor: "standard", activityLabels: "ar" },
      },
    ];
  }

  return [
    {
      id: "standard",
      label: "",
      labelKey: "onboarding.interfaceStyle.standard.label",
      description: "",
      descriptionKey: "onboarding.interfaceStyle.standard.description",
      value: { flavor: "standard", activityLabels: "en" },
    },
    {
      id: "arabic-light",
      label: "",
      labelKey: "onboarding.interfaceStyle.arabicLight.label",
      description: "",
      descriptionKey: "onboarding.interfaceStyle.englishArabicLight.description",
      value: { flavor: "arabic-light", activityLabels: "en" },
    },
  ];
}

function renderReviewManifest(manifest: SetupReviewManifest, locale: SetupCopyLocale): string {
  const lines = [copy(locale, "setupReview.title")];
  for (const section of Object.keys(REVIEW_SECTION_COPY_KEYS) as SetupReviewManifestSection[]) {
    const entries = manifest.sections[section];
    if (entries.length === 0) continue;
    lines.push("", copy(locale, REVIEW_SECTION_COPY_KEYS[section]));
    for (const line of entries) {
      lines.push(`- ${renderReviewLine(locale, line.summaryKey, line.review.values)}`);
    }
  }
  if (manifest.metadata.lineCount === 0) {
    lines.push(`- ${copy(locale, "setupReview.empty")}`);
  }
  return lines.join("\n");
}

function renderReviewLine(
  locale: SetupCopyLocale,
  summaryKey: string,
  values: Record<string, string | readonly string[] | boolean | undefined>
): string {
  if (hasSetupCopyKey(summaryKey)) {
    return formatCopy(locale, summaryKey, reviewPlaceholderValues(values));
  }
  return copy(locale, "setupReview.itemFallback");
}

function resultSummary(result: SetupApplyPlanningResult, locale: SetupCopyLocale): string {
  switch (result.kind) {
    case "apply-plan-ready":
      return copy(locale, "setupApply.plan.ready");
    case "blocked":
      return formatCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(result.eligibility.blockers.length),
      });
    case "cancelled":
      return copy(locale, "setupApply.review.cancelled");
  }
}

function endStateSummary(endState: SetupApplyEndState, locale: SetupCopyLocale): string {
  switch (endState.kind) {
    case "verified-ready":
      return copy(locale, "setupApply.endState.verifiedReady");
    case "verified-degraded":
      return copy(locale, "setupApply.endState.verifiedDegraded");
    case "blocked":
      if (endState.reason === "save-failed") {
        return formatCopy(locale, "setupApply.endState.saveFailed", {
          error: endState.blockers[0] ?? "unknown",
        });
      }
      if (endState.reason === "verification-blocked") {
        return formatCopy(locale, "setupApply.endState.verificationBlocked", {
          blocker: endState.blockers[0] ?? "unknown",
        });
      }
      return formatCopy(locale, "setupApply.review.blocked", {
        blockerCount: String(endState.blockers.length),
      });
    case "cancelled":
      return copy(locale, "setupApply.review.cancelled");
    case "saved-not-launched":
      return copy(locale, "setupApply.endState.savedNotLaunched");
    case "launched":
      return [
        copy(locale, "setupApply.endState.launched"),
        endState.acceptedDegraded ? copy(locale, "setupApply.endState.acceptedDegraded") : undefined,
      ].filter((line): line is string => line !== undefined).join("\n");
  }
}

function copy(locale: SetupCopyLocale, key: SetupCopyKey): string {
  return resolveSetupCopy(locale, key);
}

function formatCopy(
  locale: SetupCopyLocale,
  key: SetupCopyKey,
  values: Record<string, string | readonly string[] | boolean | undefined>
): string {
  const template = copy(locale, key);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}

function reviewPlaceholderValues(
  values: Record<string, string | readonly string[] | boolean | undefined>
): Record<string, string | readonly string[] | boolean | undefined> {
  const envVars = values.envVars;
  return {
    ...values,
    providerId: values.providerId ?? values.provider,
    modelId: values.modelId ?? values.model,
    envVar: values.envVar ?? (Array.isArray(envVars) ? envVars.join(", ") : envVars),
    workspacePath: values.workspacePath ?? values.workspaceRoot,
    workflowMode: values.workflowMode ?? values.workflowLearning,
    capabilities: values.capabilities,
    launchPreference: values.launchPreference ?? launchPreference(values.launchSelected),
  };
}

function launchPreference(value: string | readonly string[] | boolean | undefined): string | undefined {
  if (value === true) return "offer-after-verify";
  if (value === false) return "skip-launch";
  if (typeof value === "string") return value;
  return undefined;
}

function write(options: FirstRunSetupRunnerOptions, value: string): void {
  options.output?.write(value);
}
