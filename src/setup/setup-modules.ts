import type { BrowserBackendKind, BrowserCloudProviderKind } from "../contracts/browser.js";
import type { ProviderId } from "../contracts/provider.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { ImageGenerationProvider, SttProvider, TtsProvider } from "../config/runtime-config.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { SetupEditorPatchField } from "./setup-editor-actions.js";
import type {
  SetupDraft,
  SetupDraftApplyIntent,
  SetupDraftBundle,
  SetupDraftBundleOptions,
  SetupDraftKind,
  SetupDraftReviewMetadata,
  SetupDraftRiskSurface,
  SetupDraftSource,
  SetupDraftTarget,
} from "./setup-drafts.js";

export type SetupModuleId =
  | "provider"
  | "credentials"
  | "workspace-trust"
  | "security-mode"
  | "workflow-learning"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "voice"
  | "vision"
  | "browser";

export type SetupModuleDetectionStatus = "configured" | "missing" | "skipped" | "blocked" | "warning";

export type SetupModuleContext = SetupDraftBundleOptions & {
  readonly brokenConfig?: boolean;
  readonly skippedModules?: readonly SetupModuleId[];
  readonly provider?: {
    readonly id?: ProviderId;
    readonly model?: string;
    readonly credentialEnv?: string;
  };
  readonly credentials?: {
    readonly envVars?: readonly string[];
    readonly values?: Record<string, string | undefined>;
  };
  readonly workspaceTrust?: {
    readonly trusted?: boolean;
  };
  readonly securityMode?: SecurityApprovalMode;
  readonly workflowLearning?: SkillAutonomy;
  readonly telegram?: {
    readonly enabled?: boolean;
    readonly botTokenEnv?: string;
    readonly botToken?: string;
    readonly allowedUserIds?: readonly string[];
    readonly allowedChatIds?: readonly string[];
  };
  readonly discord?: {
    readonly enabled?: boolean;
    readonly botTokenEnv?: string;
    readonly botToken?: string;
    readonly allowedUsers?: readonly string[];
    readonly allowedGuilds?: readonly string[];
    readonly allowedChannels?: readonly string[];
  };
  readonly whatsapp?: {
    readonly enabled?: boolean;
    readonly experimental?: boolean;
    readonly authDir?: string;
    readonly allowedUsers?: readonly string[];
  };
  readonly browser?: {
    readonly backend?: BrowserBackendKind;
    readonly cloudProvider?: BrowserCloudProviderKind;
    readonly cdpUrl?: string;
    readonly launchCommand?: string;
    readonly launchExecutable?: string;
    readonly launchArgs?: readonly string[];
    readonly chromeFlags?: readonly string[];
    readonly autoLaunch?: boolean;
    readonly supervised?: boolean;
    readonly hybridRouting?: boolean;
    readonly cloudFallback?: boolean;
    readonly cloudSpendApproved?: boolean;
  };
  readonly voice?: {
    readonly ttsProvider?: TtsProvider;
    readonly ttsModel?: string;
    readonly ttsApiKeyEnv?: string;
    readonly ttsApiKey?: string;
    readonly sttProvider?: SttProvider;
    readonly sttModel?: string;
    readonly sttApiKeyEnv?: string;
    readonly sttApiKey?: string;
  };
  readonly vision?: {
    readonly provider?: ImageGenerationProvider;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly apiKey?: string;
    readonly useGateway?: boolean;
  };
};

export type SetupModuleConfigureOptions = {
  readonly skip?: boolean;
};

export type SetupModuleDetection = {
  readonly kind: "setup-module-detection";
  readonly moduleId: SetupModuleId;
  readonly status: SetupModuleDetectionStatus;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly required: boolean;
  readonly optional: boolean;
  readonly data: SetupDraftReviewMetadata["values"];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export type SetupModuleConfiguration = {
  readonly kind: "setup-module-configuration";
  readonly moduleId: SetupModuleId;
  readonly skipped: boolean;
  readonly required: boolean;
  readonly optional: boolean;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly data: SetupDraftReviewMetadata["values"];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export type SetupModuleReview = {
  readonly kind: "setup-module-review";
  readonly moduleId: SetupModuleId;
  readonly copyKey: `setupModules.${string}`;
  readonly redacted: true;
  readonly data: SetupDraftReviewMetadata["values"];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export type SetupModuleVerification = {
  readonly kind: "setup-module-verification";
  readonly moduleId: SetupModuleId;
  readonly readOnly: true;
  readonly mutatesConfig: false;
  readonly writesState: false;
  readonly data: SetupDraftReviewMetadata["values"];
};

export type SetupModule = {
  readonly id: SetupModuleId;
  readonly titleKey: `setupModules.${string}.title`;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly required: boolean;
  readonly optional: boolean;
  readonly detect: (context: SetupModuleContext) => SetupModuleDetection;
  readonly configure: (context: SetupModuleContext, options?: SetupModuleConfigureOptions) => SetupModuleConfiguration;
  readonly review: (context: SetupModuleContext, configuration?: SetupModuleConfiguration) => SetupModuleReview;
  readonly toDrafts: (context: SetupModuleContext, configuration?: SetupModuleConfiguration) => readonly SetupDraft[];
  readonly verify?: (context: SetupModuleContext) => SetupModuleVerification;
};

export const providerSetupModule: SetupModule = {
  id: "provider",
  titleKey: "setupModules.provider.title",
  riskSurface: "provider-selection",
  required: true,
  optional: false,
  detect(context) {
    const provider = context.provider?.id;
    const model = context.provider?.model;
    const local = isLocalProvider(provider);
    const missingRoute = provider === undefined || provider === "unconfigured" || model === undefined || model === "unconfigured";
    const missingCredential = !missingRoute && !local && context.provider?.credentialEnv === undefined;
    return detection({
      moduleId: "provider",
      status: context.brokenConfig === true ? "blocked" : missingRoute || missingCredential ? "missing" : "configured",
      riskSurface: "provider-selection",
      required: true,
      optional: false,
      data: {
        provider,
        model,
        localProvider: local,
        hostedCredentialRequired: !local,
        credentialEnv: context.provider?.credentialEnv,
      },
      blockers: [
        ...(context.brokenConfig === true ? ["Config must be repaired before provider setup can be drafted."] : []),
        ...(missingRoute ? ["Primary provider and model are required."] : []),
        ...(missingCredential ? ["Hosted providers require a credential environment-variable reference."] : []),
      ],
    });
  },
  configure(context, options) {
    return configurationFromDetection(providerSetupModule.detect(context), options);
  },
  review(context, configuration = providerSetupModule.configure(context)) {
    return reviewFromConfiguration("setupModules.provider.review", configuration);
  },
  toDrafts(context, configuration = providerSetupModule.configure(context)) {
    if (context.brokenConfig === true) return [diagnosticDraft("provider", configuration.blockers)];
    if (configuration.skipped) return [];
    return [
      configDraft({
        id: "setup-module.provider.route",
        moduleId: "provider",
        actionId: "configure-route",
        kind: "provider-model-route",
        riskSurface: "provider-selection",
        scope: ["model.provider", "model.id"],
        configPath: context.configPath,
        summaryKey: "setupModules.provider.draft",
        values: configuration.data,
        blockers: configuration.blockers,
      }),
    ];
  },
  verify: readOnlyVerification("provider"),
};

export const credentialsSetupModule: SetupModule = {
  id: "credentials",
  titleKey: "setupModules.credentials.title",
  riskSurface: "credential-reference",
  required: true,
  optional: false,
  detect(context) {
    const envVars = credentialEnvVars(context);
    const localProvider = isLocalProvider(context.provider?.id);
    return detection({
      moduleId: "credentials",
      status: context.brokenConfig === true ? "blocked" : localProvider ? "skipped" : envVars.length > 0 ? "configured" : "missing",
      riskSurface: "credential-reference",
      required: !localProvider,
      optional: localProvider,
      data: {
        envVars,
        localProvider,
        credentialValuesIncluded: false,
      },
      blockers: [
        ...(context.brokenConfig === true ? ["Config must be repaired before credential setup can be drafted."] : []),
        ...(!localProvider && envVars.length === 0 ? ["Hosted setup requires credential environment-variable references."] : []),
      ],
    });
  },
  configure(context, options) {
    return configurationFromDetection(credentialsSetupModule.detect(context), options);
  },
  review(context, configuration = credentialsSetupModule.configure(context)) {
    return reviewFromConfiguration("setupModules.credentials.review", configuration);
  },
  toDrafts(context, configuration = credentialsSetupModule.configure(context)) {
    if (context.brokenConfig === true) return [diagnosticDraft("credentials", configuration.blockers)];
    if (configuration.skipped || configuration.data.localProvider === true) return [];
    return [
      credentialDraft({
        moduleId: "credentials",
        id: "setup-module.credentials.env-refs",
        envVars: arrayValue(configuration.data.envVars),
        configPath: context.configPath,
        blockers: configuration.blockers,
      }),
    ];
  },
  verify: readOnlyVerification("credentials"),
};

export const workspaceTrustSetupModule: SetupModule = {
  id: "workspace-trust",
  titleKey: "setupModules.workspaceTrust.title",
  riskSurface: "workspace-trust",
  required: true,
  optional: false,
  detect(context) {
    const trusted = context.workspaceTrust?.trusted === true;
    return detection({
      moduleId: "workspace-trust",
      status: trusted ? "configured" : "missing",
      riskSurface: "workspace-trust",
      required: true,
      optional: false,
      data: {
        trusted,
        workspaceRoot: context.workspaceRoot,
        trustStorePath: context.trustStorePath,
      },
      blockers: trusted ? [] : ["Workspace trust must be explicit."],
    });
  },
  configure(context, options) {
    return configurationFromDetection(workspaceTrustSetupModule.detect(context), options);
  },
  review(context, configuration = workspaceTrustSetupModule.configure(context)) {
    return reviewFromConfiguration("setupModules.workspaceTrust.review", configuration);
  },
  toDrafts(context, configuration = workspaceTrustSetupModule.configure(context)) {
    if (configuration.skipped) return [];
    return [
      workspaceTrustDraft({
        id: "setup-module.workspace-trust.grant",
        moduleId: "workspace-trust",
        workspaceRoot: context.workspaceRoot ?? "",
        trustStorePath: context.trustStorePath ?? "",
        blockers: configuration.blockers,
      }),
    ];
  },
  verify: readOnlyVerification("workspace-trust"),
};

export const securityModeSetupModule: SetupModule = simpleConfigModule({
  id: "security-mode",
  titleKey: "setupModules.securityMode.title",
  riskSurface: "security-policy",
  required: true,
  optional: false,
  kind: "security-mode",
  scope: ["security.approvalMode"],
  value: (context) => ({ securityMode: context.securityMode }),
  blocker: "Security mode must be selected.",
});

export const workflowLearningSetupModule: SetupModule = simpleConfigModule({
  id: "workflow-learning",
  titleKey: "setupModules.workflowLearning.title",
  riskSurface: "workflow-learning",
  required: true,
  optional: false,
  kind: "workflow-learning",
  scope: ["skills.autonomy"],
  value: (context) => ({ workflowLearning: context.workflowLearning }),
  blocker: "Agent Evolution mode must be selected.",
});

export const telegramSetupModule: SetupModule = optionalCapabilityModule({
  id: "telegram",
  titleKey: "setupModules.telegram.title",
  scope: ["channels"],
  value: (context) => ({
    enabled: context.telegram?.enabled === true,
    botTokenEnv: context.telegram?.botTokenEnv,
    tokenValueIncluded: false,
    allowedUserIds: context.telegram?.allowedUserIds ?? [],
    allowedChatIds: context.telegram?.allowedChatIds ?? [],
    remoteControlIdentityConstraint: context.telegram?.enabled === true ? "allowed-user-or-chat-id" : undefined,
  }),
  blockers: (context) => [
    ...(context.telegram?.enabled === true && context.telegram.botTokenEnv === undefined
      ? ["Telegram bot token must be referenced by environment-variable name."]
      : []),
    ...(context.telegram?.enabled === true && (context.telegram.allowedUserIds?.length ?? 0) === 0 && (context.telegram.allowedChatIds?.length ?? 0) === 0
      ? ["Telegram remote control requires allowed user or chat identities."]
      : []),
  ],
});

export const discordSetupModule: SetupModule = optionalCapabilityModule({
  id: "discord",
  titleKey: "setupModules.discord.title",
  scope: ["channels"],
  value: (context) => ({
    enabled: context.discord?.enabled === true,
    beta: context.discord?.enabled === true ? true : undefined,
    botTokenEnv: context.discord?.botTokenEnv,
    tokenValueIncluded: false,
    allowedUsers: context.discord?.allowedUsers ?? [],
    allowedGuilds: context.discord?.allowedGuilds ?? [],
    allowedChannels: context.discord?.allowedChannels ?? [],
    remoteControlIdentityConstraint: context.discord?.enabled === true ? "allowed-discord-user-or-channel" : undefined,
  }),
  blockers: (context) => [
    ...(context.discord?.enabled === true && context.discord.botTokenEnv === undefined
      ? ["Discord bot token must be referenced by environment-variable name."]
      : []),
    ...(context.discord?.enabled === true && (context.discord.allowedUsers?.length ?? 0) === 0 && (context.discord.allowedChannels?.length ?? 0) === 0
      ? ["Discord remote control requires at least one allowed user or channel."]
      : []),
  ],
});

export const whatsappSetupModule: SetupModule = optionalCapabilityModule({
  id: "whatsapp",
  titleKey: "setupModules.whatsapp.title",
  scope: ["channels"],
  value: (context) => ({
    enabled: context.whatsapp?.enabled === true,
    beta: context.whatsapp?.enabled === true ? true : undefined,
    experimental: context.whatsapp?.experimental === true,
    authDir: context.whatsapp?.authDir,
    allowedUsers: context.whatsapp?.allowedUsers ?? [],
    remoteControlIdentityConstraint: context.whatsapp?.enabled === true ? "allowed-whatsapp-users" : undefined,
  }),
  blockers: (context) => [
    ...(context.whatsapp?.enabled === true && context.whatsapp.experimental !== true
      ? ["WhatsApp beta setup requires experimental mode."]
      : []),
    ...(context.whatsapp?.enabled === true && context.whatsapp.authDir === undefined
      ? ["WhatsApp setup requires a profile-local auth directory."]
      : []),
    ...(context.whatsapp?.enabled === true && (context.whatsapp.allowedUsers?.length ?? 0) === 0
      ? ["WhatsApp remote control requires allowed user numbers."]
      : []),
  ],
});

export const voiceSetupModule: SetupModule = optionalCapabilityModule({
  id: "voice",
  titleKey: "setupModules.voice.title",
  scope: ["voice"],
  value: (context) => ({
    ...(context.voice?.ttsProvider === undefined ? {} : { ttsProvider: context.voice.ttsProvider }),
    ...(context.voice?.ttsModel === undefined ? {} : { ttsModel: context.voice.ttsModel }),
    ...optionalStringReviewValue("ttsApiKeyEnv", context.voice?.ttsApiKeyEnv),
    ...(context.voice?.sttProvider === undefined ? {} : { sttProvider: context.voice.sttProvider }),
    ...(context.voice?.sttModel === undefined ? {} : { sttModel: context.voice.sttModel }),
    ...optionalStringReviewValue("sttApiKeyEnv", context.voice?.sttApiKeyEnv),
    secretValuesIncluded: false,
  }),
});

export const visionSetupModule: SetupModule = optionalCapabilityModule({
  id: "vision",
  titleKey: "setupModules.vision.title",
  scope: ["vision"],
  value: (context) => ({
    provider: context.vision?.provider,
    model: context.vision?.model,
    apiKeyEnv: context.vision?.apiKeyEnv,
    useGateway: context.vision?.useGateway,
    secretValuesIncluded: false,
  }),
});

export const browserSetupModule: SetupModule = optionalCapabilityModule({
  id: "browser",
  titleKey: "setupModules.browser.title",
  scope: ["browser"],
  value: (context) => ({
    backend: context.browser?.backend,
    cloudProvider: context.browser?.cloudProvider,
    cdpUrl: context.browser?.cdpUrl,
    launchCommand: context.browser?.launchCommand,
    launchExecutable: context.browser?.launchExecutable,
    launchArgs: context.browser?.launchArgs,
    chromeFlags: context.browser?.chromeFlags,
    supervised: context.browser?.supervised,
    hybridRouting: context.browser?.hybridRouting,
    cloudFallback: context.browser?.cloudFallback,
    cloudSpendApproved: context.browser?.cloudSpendApproved,
    autoLaunchRequested: context.browser?.autoLaunch === true,
    autoLaunchWillRunNow: false,
  }),
});

function optionalStringReviewValue(key: string, value: string | undefined): Record<string, string> {
  return value === undefined || value.trim().length === 0 ? {} : { [key]: value };
}

export const SETUP_MODULES: readonly SetupModule[] = [
  providerSetupModule,
  credentialsSetupModule,
  workspaceTrustSetupModule,
  securityModeSetupModule,
  workflowLearningSetupModule,
  telegramSetupModule,
  discordSetupModule,
  whatsappSetupModule,
  voiceSetupModule,
  visionSetupModule,
  browserSetupModule,
] as const;

export function buildSetupModuleDraftBundle(
  context: SetupModuleContext,
  modules: readonly SetupModule[] = SETUP_MODULES
): SetupDraftBundle {
  const drafts = modules.flatMap((module) => {
    const configuration = module.configure(context, {
      skip: context.skippedModules?.includes(module.id) === true,
    });
    return module.toDrafts(context, configuration);
  });
  const blockers = [...new Set(drafts.flatMap((draft) => draft.blockers))].sort();
  const warnings = [...new Set(drafts.flatMap((draft) => draft.warnings))].sort();
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId: "setup-modules",
    drafts,
    blockers,
    warnings,
    safeToApplyLater: context.brokenConfig !== true && blockers.length === 0,
    metadata: {
      draftCount: drafts.length,
      requiresReviewCount: drafts.filter((draft) => draft.requiresReview).length,
      readOnlyCount: drafts.filter((draft) => draft.readOnly).length,
    },
  };
}

function simpleConfigModule(input: {
  readonly id: SetupModuleId;
  readonly titleKey: SetupModule["titleKey"];
  readonly riskSurface: SetupDraftRiskSurface;
  readonly required: boolean;
  readonly optional: boolean;
  readonly kind: SetupDraftKind;
  readonly scope: readonly SetupEditorPatchField[];
  readonly value: (context: SetupModuleContext) => SetupDraftReviewMetadata["values"];
  readonly blocker: string;
}): SetupModule {
  const module: SetupModule = {
    id: input.id,
    titleKey: input.titleKey,
    riskSurface: input.riskSurface,
    required: input.required,
    optional: input.optional,
    detect(context) {
      const values = input.value(context);
      const configured = Object.values(values).some((value) => value !== undefined && value !== false);
      return detection({
        moduleId: input.id,
        status: context.brokenConfig === true ? "blocked" : configured ? "configured" : "missing",
        riskSurface: input.riskSurface,
        required: input.required,
        optional: input.optional,
        data: values,
        blockers: [
          ...(context.brokenConfig === true ? ["Config must be repaired before setup can be drafted."] : []),
          ...(!configured ? [input.blocker] : []),
        ],
      });
    },
    configure(context, options) {
      return configurationFromDetection(module.detect(context), options);
    },
    review(context, configuration = module.configure(context)) {
      return reviewFromConfiguration(`setupModules.${input.id}.review`, configuration);
    },
    toDrafts(context, configuration = module.configure(context)) {
      if (context.brokenConfig === true) return [diagnosticDraft(input.id, configuration.blockers)];
      if (configuration.skipped) return [];
      return [
        configDraft({
          id: `setup-module.${input.id}.config`,
          moduleId: input.id,
          actionId: "configure",
          kind: input.kind,
          riskSurface: input.riskSurface,
          scope: input.scope,
          configPath: context.configPath,
          summaryKey: `setupModules.${input.id}.draft`,
          values: configuration.data,
          blockers: configuration.blockers,
        }),
      ];
    },
    verify: readOnlyVerification(input.id),
  };
  return module;
}

function optionalCapabilityModule(input: {
  readonly id: Extract<SetupModuleId, "telegram" | "discord" | "whatsapp" | "voice" | "vision" | "browser">;
  readonly titleKey: SetupModule["titleKey"];
  readonly scope: readonly SetupEditorPatchField[];
  readonly value: (context: SetupModuleContext) => SetupDraftReviewMetadata["values"];
  readonly blockers?: (context: SetupModuleContext) => readonly string[];
}): SetupModule {
  const module: SetupModule = {
    id: input.id,
    titleKey: input.titleKey,
    riskSurface: "optional-capability",
    required: false,
    optional: true,
    detect(context) {
      const values = input.value(context);
      const configured = Object.values(values).some((value) => value !== undefined && value !== false && (!Array.isArray(value) || value.length > 0));
      return detection({
        moduleId: input.id,
        status: context.brokenConfig === true ? "blocked" : configured ? "configured" : "skipped",
        riskSurface: "optional-capability",
        required: false,
        optional: true,
        data: values,
        blockers: [
          ...(context.brokenConfig === true ? ["Config must be repaired before optional capability setup can be drafted."] : []),
          ...(input.blockers?.(context) ?? []),
        ],
      });
    },
    configure(context, options) {
      return configurationFromDetection(module.detect(context), options);
    },
    review(context, configuration = module.configure(context)) {
      return reviewFromConfiguration(`setupModules.${input.id}.review`, configuration);
    },
    toDrafts(context, configuration = module.configure(context)) {
      if (context.brokenConfig === true) return [diagnosticDraft(input.id, configuration.blockers)];
      return [
        configDraft({
          id: `setup-module.${input.id}.capability`,
          moduleId: input.id,
          actionId: configuration.skipped ? "skip" : "configure",
          kind: "optional-capability",
          riskSurface: "optional-capability",
          scope: input.scope,
          configPath: context.configPath,
          summaryKey: `setupModules.${input.id}.draft`,
          values: {
            ...configuration.data,
            skipped: configuration.skipped,
          },
          blockers: configuration.skipped ? [] : configuration.blockers,
          requiresReview: !configuration.skipped,
          readOnly: configuration.skipped,
        }),
      ];
    },
    verify: readOnlyVerification(input.id),
  };
  return module;
}

function detection(input: Omit<SetupModuleDetection, "kind" | "warnings"> & { readonly warnings?: readonly string[] }): SetupModuleDetection {
  return {
    kind: "setup-module-detection",
    warnings: [],
    ...input,
  };
}

function configurationFromDetection(
  detected: SetupModuleDetection,
  options: SetupModuleConfigureOptions = {}
): SetupModuleConfiguration {
  return {
    kind: "setup-module-configuration",
    moduleId: detected.moduleId,
    skipped: options.skip === true || detected.status === "skipped",
    required: detected.required,
    optional: detected.optional,
    riskSurface: detected.riskSurface,
    data: detected.data,
    blockers: options.skip === true && detected.optional ? [] : detected.blockers,
    warnings: detected.warnings,
  };
}

function reviewFromConfiguration(copyKey: SetupModuleReview["copyKey"], configuration: SetupModuleConfiguration): SetupModuleReview {
  return {
    kind: "setup-module-review",
    moduleId: configuration.moduleId,
    copyKey,
    redacted: true,
    data: configuration.data,
    blockers: configuration.blockers,
    warnings: configuration.warnings,
  };
}

function configDraft(input: {
  readonly id: string;
  readonly moduleId: SetupModuleId;
  readonly actionId: string;
  readonly kind: SetupDraftKind;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly scope: readonly SetupEditorPatchField[];
  readonly configPath?: string;
  readonly summaryKey: string;
  readonly values: SetupDraftReviewMetadata["values"];
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
  readonly requiresReview?: boolean;
  readonly readOnly?: boolean;
}): SetupDraft {
  return {
    id: input.id,
    kind: input.kind,
    source: moduleSource(input.moduleId, input.actionId),
    riskSurface: input.riskSurface,
    target: configTarget(input.scope, input.configPath),
    review: review(input.summaryKey, input.values),
    applyIntent: intent("config-patch"),
    preserveUnrelatedConfig: true,
    requiresReview: input.requiresReview ?? true,
    readOnly: input.readOnly ?? false,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
  };
}

function credentialDraft(input: {
  readonly id: string;
  readonly moduleId: SetupModuleId;
  readonly envVars: readonly string[];
  readonly configPath?: string;
  readonly blockers?: readonly string[];
}): SetupDraft {
  return {
    id: input.id,
    kind: "credential-reference",
    source: moduleSource(input.moduleId, "configure-env-refs"),
    riskSurface: "credential-reference",
    target: configTarget(["providers.*.apiKeyEnv"], input.configPath),
    review: review("setupModules.credentials.draft", {
      envVars: [...new Set(input.envVars)].sort(),
      credentialValuesIncluded: false,
    }),
    applyIntent: intent("credential-reference"),
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: input.blockers ?? [],
    warnings: [],
  };
}

function workspaceTrustDraft(input: {
  readonly id: string;
  readonly moduleId: SetupModuleId;
  readonly workspaceRoot: string;
  readonly trustStorePath: string;
  readonly blockers?: readonly string[];
}): SetupDraft {
  return {
    id: input.id,
    kind: "workspace-trust",
    source: moduleSource(input.moduleId, "grant-trust"),
    riskSurface: "workspace-trust",
    target: {
      kind: "trust-store",
      workspaceRoot: input.workspaceRoot,
      trustStorePath: input.trustStorePath,
    },
    review: review("setupModules.workspaceTrust.draft", {
      workspaceRoot: input.workspaceRoot,
      trustStorePath: input.trustStorePath,
    }),
    applyIntent: intent("trust-grant"),
    requiresReview: true,
    readOnly: false,
    blockers: input.blockers ?? [],
    warnings: [],
  };
}

function diagnosticDraft(moduleId: SetupModuleId, blockers: readonly string[]): SetupDraft {
  return {
    id: `setup-module.${moduleId}.diagnostic-blocker`,
    kind: "diagnostic-blocker",
    source: moduleSource(moduleId, "diagnostic-only"),
    riskSurface: "config-repair",
    target: { kind: "diagnostic-only" },
    review: review(`setupModules.${moduleId}.blocked`, { moduleId }),
    applyIntent: intent("diagnostic-only"),
    requiresReview: true,
    readOnly: true,
    blockers,
    warnings: [],
  };
}

function readOnlyVerification(moduleId: SetupModuleId): SetupModule["verify"] {
  return () => ({
    kind: "setup-module-verification",
    moduleId,
    readOnly: true,
    mutatesConfig: false,
    writesState: false,
    data: {
      readOnly: true,
    },
  });
}

function moduleSource(moduleId: SetupModuleId, actionId: string): SetupDraftSource {
  return {
    kind: "setup-module",
    moduleId,
    actionId,
  };
}

function configTarget(scope: readonly SetupEditorPatchField[], configPath: string | undefined): SetupDraftTarget {
  return {
    kind: "config-scope",
    scope,
    path: configPath,
    preserveUnrelatedConfig: true,
  };
}

function review(summaryKey: string, values: SetupDraftReviewMetadata["values"]): SetupDraftReviewMetadata {
  return {
    copyKey: "setupDrafts.review",
    summaryKey,
    redacted: true,
    values,
  };
}

function intent(effect: SetupDraftApplyIntent["effect"]): SetupDraftApplyIntent {
  return {
    kind: "dry-run-apply-intent",
    effect,
    dryRunOnly: true,
    writesConfig: false,
    writesTrustStore: false,
  };
}

function credentialEnvVars(context: SetupModuleContext): readonly string[] {
  return [
    ...(context.provider?.credentialEnv === undefined ? [] : [context.provider.credentialEnv]),
    ...(context.credentials?.envVars ?? []),
  ].filter((value, index, values) => values.indexOf(value) === index).sort();
}

function isLocalProvider(provider: ProviderId | undefined): boolean {
  return provider === "local";
}

function arrayValue(value: SetupDraftReviewMetadata["values"][string]): readonly string[] {
  return Array.isArray(value) ? value : [];
}
