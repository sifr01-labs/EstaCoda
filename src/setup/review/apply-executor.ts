import {
  collectSetupVerificationReport,
  type SetupVerificationReport,
} from "../verification.js";
import { writeEnvSecret } from "../../config/env-secret-store.js";
import {
  executeSetupApplyPlan,
  type OptionalCapabilityApplyWarning,
  type SetupApplyEndState,
  type SetupDeferredOAuthApplyResult,
  type SetupDeferredOAuthWrite,
  type SetupDeferredSecretApplyResult,
  type SetupDeferredSecretWrite,
  type SetupApplyExecutionResult,
  type SetupApplyExecutor,
  type SetupApplyFlowOptions,
  type SetupApplyMode,
  type SetupApplyOperation,
  type SetupApplyPlan,
  type SetupPostSaveVerificationRequest,
} from "../setup-apply-plan.js";
import {
  setupImageGenerationConfig,
  setupBrowserConfig,
  readConfig,
  setupSecurityConfig,
  setupSkillConfig,
  setupModelFallbackConfig,
  setupAuxiliaryModelConfig,
  setupDiscordConfig,
  setupTelegramConfig,
  setupUiConfig,
  setupWhatsAppConfig,
  setupWebConfig,
  setupVoiceConfig,
  type ActivityLabelsLocale,
  type ImageGenerationProvider,
  type ModelFallbackConfig,
  type SttProvider,
  type TtsProvider,
  type UiFlavor,
  type UiLanguage,
  type VoiceSetupInput,
  type BrowserSnapshotSummarizeMode,
  type BrowserEngineKind,
} from "../../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import { createManagedEnvironment } from "../../python-env/manager.js";
import { DDGS_CAPABILITY_ID, EDGE_TTS_CAPABILITY_ID } from "../../python-env/capability-registry.js";
import {
  checkManagedPythonCapabilityStatus,
  installManagedPythonCapabilityEnvironment,
} from "../../python-env/capability-manager.js";
import {
  registerProviderConfig,
  registerProviderModel,
  setPreferredModelRoute,
  storeProviderCredential,
} from "../../config/provider-config-mutations.js";
import type { BrowserBackendKind, BrowserCloudProviderKind } from "../../contracts/browser.js";
import type { AuxiliaryModelTask, ProviderApiMode, ProviderAuthMethod, ProviderId } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import { resolveSetupCopy } from "../setup-copy.js";
import { loadOAuthStore, writeOAuthStore } from "../../providers/oauth/oauth-store.js";

export type ReviewedSetupApplyExecutorOptions = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly trustStorePath?: string;
  readonly mode?: SetupApplyMode;
  readonly collectVerification?: (options: ReviewedSetupApplyExecutorOptions) => Promise<SetupVerificationReport> | SetupVerificationReport;
};

type ConfigApplyTarget = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly profileId?: string;
};

type PlanContext = {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly credentialEnv?: string;
};

export function createReviewedSetupApplyExecutor(
  options: ReviewedSetupApplyExecutorOptions
): SetupApplyExecutor {
  const mode = options.mode ?? "strict";
  const normalizedOptions = { ...options, mode };
  return {
    apply: (plan, context) => applyReviewedSetupPlanOperations(plan, {
      ...normalizedOptions,
      mode: context?.mode ?? mode,
    }),
    applyDeferredSecrets: (plan, writes) => applyReviewedSetupDeferredSecrets(plan, writes, normalizedOptions),
    applyDeferredOAuth: (plan, writes) => applyReviewedSetupDeferredOAuth(plan, writes, normalizedOptions),
    verify: (request) => verifyReviewedSetup(request, normalizedOptions),
  };
}

export async function executeReviewedSetupApplyPlan(
  plan: SetupApplyPlan,
  options: ReviewedSetupApplyExecutorOptions,
  flowOptions: SetupApplyFlowOptions = {}
): Promise<SetupApplyEndState> {
  const mode = flowOptions.mode ?? options.mode ?? "strict";
  return executeSetupApplyPlan(plan, createReviewedSetupApplyExecutor({ ...options, mode }), {
    ...flowOptions,
    mode,
  });
}

export async function applyReviewedSetupPlanOperations(
  plan: SetupApplyPlan,
  options: ReviewedSetupApplyExecutorOptions
): Promise<SetupApplyExecutionResult> {
  const appliedOperationIds: string[] = [];
  const warnings: OptionalCapabilityApplyWarning[] = [];
  const credentialOperationIds = new Set(
    plan.operations
      .filter((operation) => operation.kind === "credential-reference")
      .map((operation) => operation.id)
  );
  const appliedCredentialOperationIds = new Set<string>();
  const context = planContext(plan);

  try {
    for (const operation of plan.operations) {
      switch (operation.kind) {
        case "config-patch":
          warnings.push(...await applyConfigPatch(operation, context, options));
          appliedOperationIds.push(operation.id);
          break;
        case "credential-reference":
          ensureCredentialReferenceCanApply(operation, context);
          appliedOperationIds.push(operation.id);
          appliedCredentialOperationIds.add(operation.id);
          break;
        case "workspace-trust-grant":
          await applyWorkspaceTrustGrant(operation, options);
          appliedOperationIds.push(operation.id);
          break;
        case "verification-request":
        case "launch-handoff":
          appliedOperationIds.push(operation.id);
          break;
      }
    }

    const unappliedCredentialOperationIds = [...credentialOperationIds].filter((id) => !appliedCredentialOperationIds.has(id));
    if (unappliedCredentialOperationIds.length > 0 && context.provider === undefined) {
      return {
        ok: false,
        appliedOperationIds,
        error: "Credential reference apply requires provider/model context.",
      };
    }

    return {
      ok: true,
      appliedOperationIds,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      appliedOperationIds,
      error: error instanceof Error ? error.message : "Reviewed setup apply failed.",
    };
  }
}

export async function applyReviewedSetupDeferredSecrets(
  plan: SetupApplyPlan,
  writes: readonly SetupDeferredSecretWrite[],
  options: ReviewedSetupApplyExecutorOptions
): Promise<SetupDeferredSecretApplyResult> {
  const allowedEnvVars = new Set(reviewedSecretEnvVarsFromPlan(plan));
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  let appliedSecretCount = 0;

  try {
    for (const write of writes) {
      if (!allowedEnvVars.has(write.envVarName)) {
        return {
          ok: false,
          appliedSecretCount,
          error: `Deferred secret write is not part of the reviewed credential plan: ${write.envVarName}`,
        };
      }
      const result = await writeEnvSecret({
        homeDir: options.homeDir,
        profileId,
        key: write.envVarName,
        value: write.value,
      });
      process.env[result.key] = write.value;
      appliedSecretCount += 1;
    }

    return {
      ok: true,
      appliedSecretCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deferred secret persistence failed.";
    return {
      ok: false,
      appliedSecretCount,
      error: appliedSecretCount > 0
        ? `Deferred secret persistence failed after ${appliedSecretCount} secret write(s) succeeded: ${message}`
        : message,
    };
  }
}

export async function applyReviewedSetupDeferredOAuth(
  plan: SetupApplyPlan,
  writes: readonly SetupDeferredOAuthWrite[],
  options: ReviewedSetupApplyExecutorOptions
): Promise<SetupDeferredOAuthApplyResult> {
  const allowedCredentials = new Set(reviewedOAuthCredentialsFromPlan(plan));
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  let appliedOAuthCount = 0;

  try {
    for (const write of writes) {
      const credentialKey = oauthCredentialKey(write.providerId, write.authMethod);
      if (!allowedCredentials.has(credentialKey)) {
        return {
          ok: false,
          appliedOAuthCount,
          error: `Deferred OAuth write is not part of the reviewed credential plan: ${credentialKey}`,
        };
      }
      if (write.tokenRecord.authMethod !== write.authMethod) {
        return {
          ok: false,
          appliedOAuthCount,
          error: `Deferred OAuth write auth method does not match reviewed credential plan: ${credentialKey}`,
        };
      }
      const loaded = await loadOAuthStore({ homeDir: options.homeDir, profileId });
      await writeOAuthStore({
        ...loaded.store,
        providers: {
          ...loaded.store.providers,
          [write.providerId]: write.tokenRecord,
        },
      }, { homeDir: options.homeDir, profileId });
      appliedOAuthCount += 1;
    }

    return {
      ok: true,
      appliedOAuthCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deferred OAuth persistence failed.";
    return {
      ok: false,
      appliedOAuthCount,
      error: appliedOAuthCount > 0
        ? `Deferred OAuth persistence failed after ${appliedOAuthCount} OAuth write(s) succeeded: ${message}`
        : message,
    };
  }
}

async function verifyReviewedSetup(
  _request: SetupPostSaveVerificationRequest,
  options: ReviewedSetupApplyExecutorOptions
): Promise<SetupVerificationReport> {
  if (options.collectVerification !== undefined) {
    return options.collectVerification(options);
  }
  return collectSetupVerificationReport({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
    trustStorePath: options.trustStorePath,
  });
}

async function applyConfigPatch(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<readonly OptionalCapabilityApplyWarning[]> {
  switch (operation.review.summaryKey) {
    case "setupDrafts.providerModelRoute.summary":
    case "setupDrafts.providerModelEndpointRoute.summary":
    case "setupModules.provider.draft":
      await applyProviderRoute(operation, context, options);
      return [];
    case "setupDrafts.fallbackModelRoute.add.summary":
    case "setupDrafts.fallbackModelRoute.replace.summary":
      await applyFallbackRoute(operation, context, options);
      return [];
    case "setupDrafts.auxiliaryModelRoute.summary":
      await applyAuxiliaryModelRoute(operation, context, options);
      return [];
    case "setupDrafts.credentialReference.summary":
    case "setupModules.credentials.draft":
      await applyCredentialReference(operation, context, options);
      return [];
    case "setupDrafts.securityMode.summary":
    case "setupModules.security-mode.draft":
      await applySecurityMode(operation, options);
      return [];
    case "setupDrafts.workflowLearning.summary":
    case "setupModules.workflow-learning.draft":
      await applyWorkflowLearning(operation, options);
      return [];
    case "setupDrafts.uiPreferences.summary":
      await applyUiPreferences(operation, options);
      return [];
    case "setupDrafts.optionalCapabilities.summary":
      return applyFirstRunOptionalCapabilities(operation, options);
    case "setupModules.telegram.draft":
      await applyTelegramCapability(operation, options);
      return [];
    case "setupModules.discord.draft":
      await applyDiscordCapability(operation, options);
      return [];
    case "setupModules.whatsapp.draft":
      await applyWhatsAppCapability(operation, options);
      return [];
    case "setupModules.voice.draft":
      return applyVoiceCapability(operation, options);
    case "setupModules.vision.draft":
      await applyVisionCapability(operation, options);
      return [];
    case "setupModules.webSearch.draft":
      return applyWebSearchCapability(operation, options);
    case "setupModules.browser.draft":
      await applyBrowserCapability(operation, options);
      return [];
    default:
      throw new Error(`Unsupported reviewed config operation: ${operation.review.summaryKey}`);
  }
}

async function applyProviderRoute(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const provider = providerIdValue(operation.review.values.provider ?? operation.review.values.providerId);
  const model = stringValue(operation.review.values.model ?? operation.review.values.modelId);
  if (provider === undefined || model === undefined) {
    throw new Error("Provider/model apply requires provider and model review values.");
  }
  const baseUrl = stringValue(operation.review.values.baseUrl);
  const contextWindowTokens = numberValue(operation.review.values.contextWindowTokens);
  const authMethod = providerAuthMethodValue(operation.review.values.authMethod);
  const target = configApplyTarget(operation, options);
  await registerProviderConfig({
    ...target,
    input: {
      provider,
      baseUrl,
      kind: "openai-compatible",
      enableNetwork: true,
      apiMode: authMethod === undefined || authMethod === "api_key"
        ? undefined
        : providerApiModeValue(operation.review.values.apiMode),
      authMethod: authMethod === "api_key" ? undefined : authMethod,
    },
  });
  if (context.credentialEnv !== undefined) {
    await storeProviderCredential({
      ...target,
      input: {
        provider,
        apiKeyEnv: context.credentialEnv,
      },
    });
  }
  await registerProviderModel({
    ...target,
    input: {
      provider,
      models: [model],
    },
  });
  await setPreferredModelRoute({
    ...target,
    input: {
      provider,
      model,
      baseUrl,
      apiKeyEnv: context.credentialEnv,
      contextWindowTokens,
    },
  });
}

async function applyFallbackRoute(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const provider = providerIdValue(operation.review.values.provider ?? operation.review.values.providerId);
  const model = stringValue(operation.review.values.model ?? operation.review.values.modelId);
  if (provider === undefined || model === undefined) {
    throw new Error("Fallback apply requires provider and model review values.");
  }
  const operationKind = operation.review.values.fallbackOperation === "replace" ? "replace" : "add";
  const fallbackIndex = numberValue(operation.review.values.fallbackIndex);
  const baseUrl = stringValue(operation.review.values.baseUrl);
  const apiKeyEnv = stringValue(operation.review.values.apiKeyEnv) ?? context.credentialEnv;
  const contextWindowTokens = numberValue(operation.review.values.contextWindowTokens);
  const apiMode = providerApiModeValue(operation.review.values.apiMode);
  const authMethod = providerAuthMethodValue(operation.review.values.authMethod);
  const nextFallback: ModelFallbackConfig = {
    provider,
    id: model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
  const target = configApplyTarget(operation, options);
  const profileId = target.profileId ?? readActiveProfile({ homeDir: target.homeDir }).profileId ?? defaultProfileId();
  const configPath = resolveProfileStateHome({ homeDir: target.homeDir, profileId }).configPath;
  const existing = await readConfig(configPath);
  const currentFallbacks = existing.config.model?.fallbacks ?? [];
  const nextFallbacks = operationKind === "replace"
    ? replaceFallbackAtIndex(currentFallbacks, fallbackIndex, nextFallback)
    : [...currentFallbacks, nextFallback];

  await registerProviderConfig({
    ...target,
    input: {
      provider,
      baseUrl,
      kind: "openai-compatible",
      enableNetwork: true,
      apiMode: authMethod === undefined || authMethod === "api_key" ? undefined : apiMode,
      authMethod: authMethod === "api_key" ? undefined : authMethod,
    },
  });
  if (apiKeyEnv !== undefined) {
    await storeProviderCredential({
      ...target,
      input: {
        provider,
        apiKeyEnv,
      },
    });
  }
  await registerProviderModel({
    ...target,
    input: {
      provider,
      models: [model],
    },
  });
  await setupModelFallbackConfig({
    ...target,
    input: {
      fallbacks: nextFallbacks,
    },
  });
}

async function applyAuxiliaryModelRoute(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const auxiliaryTask = auxiliaryTaskValue(operation.review.values.auxiliaryTask);
  const provider = providerIdValue(operation.review.values.provider ?? operation.review.values.providerId);
  const model = stringValue(operation.review.values.model ?? operation.review.values.modelId);
  if (auxiliaryTask === undefined || provider === undefined || model === undefined) {
    throw new Error("Auxiliary route apply requires auxiliary task, provider, and model review values.");
  }
  const baseUrl = stringValue(operation.review.values.baseUrl);
  const apiKeyEnv = stringValue(operation.review.values.apiKeyEnv) ?? context.credentialEnv;
  const contextWindowTokens = numberValue(operation.review.values.contextWindowTokens);
  const target = configApplyTarget(operation, options);
  await setupAuxiliaryModelConfig({
    ...target,
    input: {
      task: auxiliaryTask,
      provider,
      id: model,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    },
  });
}

function replaceFallbackAtIndex(
  currentFallbacks: readonly ModelFallbackConfig[],
  index: number | undefined,
  nextFallback: ModelFallbackConfig
): ModelFallbackConfig[] {
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= currentFallbacks.length) {
    throw new Error("Fallback replace apply requires a valid fallback index.");
  }
  return currentFallbacks.map((fallback, fallbackIndex) => fallbackIndex === index ? nextFallback : fallback);
}

async function applyCredentialReference(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  ensureCredentialReferenceCanApply(operation, context);
  if (operation.review.values.credentialSurface === "oauth") {
    return;
  }
  const provider = providerIdValue(operation.review.values.provider) ?? context.provider;
  const envVar = arrayValue(operation.review.values.envVars)[0] ?? stringValue(operation.review.values.envVar) ?? context.credentialEnv;
  if (provider === undefined || envVar === undefined) {
    throw new Error("Credential reference apply requires provider and env-var review values.");
  }
  const target = configApplyTarget(operation, options);
  await storeProviderCredential({
    ...target,
    input: {
      provider,
      apiKeyEnv: envVar,
    },
  });
}

async function applySecurityMode(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const mode = securityModeValue(operation.review.values.securityMode);
  if (mode === undefined) {
    throw new Error("Security apply requires a valid security mode.");
  }
  const target = configApplyTarget(operation, options);
  await setupSecurityConfig({
    ...target,
    input: {
      mode,
    },
  });
}

async function applyWorkflowLearning(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const autonomy = skillAutonomyValue(operation.review.values.workflowLearning ?? operation.review.values.workflowMode);
  if (autonomy === undefined) {
    throw new Error("Agent Evolution apply requires a valid autonomy value.");
  }
  const target = configApplyTarget(operation, options);
  await setupSkillConfig({
    ...target,
    input: {
      autonomy,
    },
  });
}

async function applyUiPreferences(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const language = uiLanguageValue(operation.review.values.language);
  const flavor = uiFlavorValue(operation.review.values.flavor);
  const activityLabels = activityLabelsValue(operation.review.values.activityLabels);
  if (language === undefined || flavor === undefined || activityLabels === undefined) {
    throw new Error("UI preferences apply requires language, flavor, and activity label review values.");
  }
  const target = configApplyTarget(operation, options);
  await setupUiConfig({
    ...target,
    input: {
      language,
      flavor,
      activityLabels,
    },
  });
}

async function applyFirstRunOptionalCapabilities(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<readonly OptionalCapabilityApplyWarning[]> {
  if (operation.review.values.skipped === true) return [];
  const capabilities = arrayValue(operation.review.values.capabilities);
  const warnings: OptionalCapabilityApplyWarning[] = [];
  for (const capability of capabilities) {
    switch (capability) {
      case "channels":
        throw new Error("Remote-control capabilities require token references and allowed identities before apply.");
      case "voice":
        warnings.push(...await applyVoiceCapability(operation, options));
        break;
      case "vision":
        await applyVisionCapability(operation, options);
        break;
      case "browser":
        await applyBrowserCapability(operation, options);
        break;
      case "web-search":
        warnings.push(...await applyWebSearchCapability(operation, options));
        break;
      default:
        throw new Error(`Unsupported optional capability: ${capability}`);
    }
  }
  return warnings;
}

async function applyTelegramCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const botTokenEnv = stringValue(operation.review.values.botTokenEnv ?? operation.review.values.envVar) ?? "ESTACODA_TELEGRAM_BOT_TOKEN";
  const allowedUserIds = arrayValue(operation.review.values.allowedUserIds);
  const allowedChatIds = arrayValue(operation.review.values.allowedChatIds);
  if (allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    throw new Error("Telegram apply requires allowed user or chat identities.");
  }
  const target = configApplyTarget(operation, options);
  await setupTelegramConfig({
    ...target,
    input: {
      enabled: true,
      botTokenEnv,
      allowedUserIds,
      allowedChatIds,
    },
  });
}

async function applyDiscordCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const botTokenEnv = stringValue(operation.review.values.botTokenEnv ?? operation.review.values.envVar) ?? "ESTACODA_DISCORD_BOT_TOKEN";
  const allowedUsers = arrayValue(operation.review.values.allowedUsers);
  const allowedGuilds = arrayValue(operation.review.values.allowedGuilds);
  const allowedChannels = arrayValue(operation.review.values.allowedChannels);
  if (allowedUsers.length === 0 && allowedChannels.length === 0) {
    throw new Error("Discord apply requires at least one allowed user or channel.");
  }
  const target = configApplyTarget(operation, options);
  await setupDiscordConfig({
    ...target,
    input: {
      enabled: true,
      botTokenEnv,
      allowedUsers,
      allowedGuilds,
      allowedChannels,
    },
  });
}

async function applyWhatsAppCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const allowedUsers = arrayValue(operation.review.values.allowedUsers);
  const authDir = stringValue(operation.review.values.authDir);
  if (allowedUsers.length === 0) {
    throw new Error("WhatsApp apply requires allowed user numbers.");
  }
  const target = configApplyTarget(operation, options);
  await setupWhatsAppConfig({
    ...target,
    input: {
      enabled: true,
      experimental: true,
      authDir,
      allowedUsers,
    },
  });
}

async function applyVoiceCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<readonly OptionalCapabilityApplyWarning[]> {
  const target = configApplyTarget(operation, options);
  const sttProvider = sttProviderValue(operation.review.values.sttProvider);
  const input: VoiceSetupInput = {
    ttsProvider: ttsProviderValue(operation.review.values.ttsProvider),
    ttsModel: stringValue(operation.review.values.ttsModel),
    ttsApiKeyEnv: stringValue(operation.review.values.ttsApiKeyEnv),
    sttProvider,
    sttModel: stringValue(operation.review.values.sttModel),
    sttApiKeyEnv: stringValue(operation.review.values.sttApiKeyEnv),
  };
  const warnings: OptionalCapabilityApplyWarning[] = [];
  if (input.ttsProvider === "edge") {
    const warning = await ensureReviewedEdgeTtsCapability(operation, options);
    if (warning !== undefined) {
      delete input.ttsProvider;
      delete input.ttsModel;
      delete input.ttsApiKeyEnv;
      warnings.push(warning);
    }
  }
  if (sttProvider === "local") {
    const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
    const envResult = await createManagedEnvironment({ stateRoot: globalPaths.stateRoot });
    if (!envResult.ok) {
      if (isLocalSttTolerantVoiceOperation(operation, options)) {
        delete input.sttProvider;
        delete input.sttModel;
        delete input.sttApiKeyEnv;
        warnings.push({
          operationId: operation.id,
          capability: "voice",
          subCapability: "stt",
          code: "managed_python_setup_failed",
          message: resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.localSttSkipped"),
          cause: envResult.reason,
        });
      } else {
        throw new Error([
          resolveSetupCopy("en", "setupEditor.apply.voice.localStt.failed"),
          envResult.reason,
        ].join("\n"));
      }
    }
  }
  if (!hasVoiceSetupInput(input)) {
    return warnings;
  }
  await setupVoiceConfig({
    ...target,
    input,
  });
  return warnings;
}

async function ensureReviewedEdgeTtsCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<OptionalCapabilityApplyWarning | undefined> {
  const capabilityId = stringValue(operation.review.values.edgeTtsCapabilityId);
  if (capabilityId !== undefined && capabilityId !== EDGE_TTS_CAPABILITY_ID) {
    throw new Error("Edge TTS setup apply only supports the registered edge-tts managed Python capability.");
  }
  const stateRoot = resolveGlobalStateHome({ homeDir: options.homeDir }).stateRoot;
  const status = await checkManagedPythonCapabilityStatus({
    stateRoot,
    capabilityId: EDGE_TTS_CAPABILITY_ID,
  });
  if (status.ok) return undefined;

  if (operation.review.values.edgeTtsSetupConfirmed !== true) {
    throw new Error("Edge TTS setup requires explicit managed Python capability setup confirmation.");
  }

  const install = await installManagedPythonCapabilityEnvironment({
    stateRoot,
    capabilityId: EDGE_TTS_CAPABILITY_ID,
  });
  if (!install.ok) {
    if (isVoiceTolerantOperation(operation, options)) {
      return {
        operationId: operation.id,
        capability: "voice",
        subCapability: "tts",
        code: "managed_python_setup_failed",
        message: resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.edgeTtsSkipped"),
        cause: install.message,
      };
    }
    throw new Error([
      resolveSetupCopy("en", "setupEditor.apply.voice.edgeTts.failed"),
      install.message,
      install.diagnostic,
    ].filter((line): line is string => line !== undefined && line.trim().length > 0).join("\n"));
  }
  return undefined;
}

function isLocalSttTolerantVoiceOperation(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): boolean {
  return isVoiceTolerantOperation(operation, options);
}

function isVoiceTolerantOperation(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): boolean {
  return options.mode === "firstRunTolerant" &&
    operation.kind === "config-patch" &&
    operation.target?.kind === "config-scope" &&
    operation.target.scope.includes("voice");
}

function hasVoiceSetupInput(input: VoiceSetupInput): boolean {
  return input.ttsProvider !== undefined ||
    input.ttsSpeed !== undefined ||
    input.ttsVoice !== undefined ||
    input.ttsModel !== undefined ||
    input.ttsApiKeyEnv !== undefined ||
    input.ttsApiKey !== undefined ||
    input.sttProvider !== undefined ||
    input.sttModel !== undefined ||
    input.sttCommand !== undefined ||
    input.sttApiKeyEnv !== undefined ||
    input.sttApiKey !== undefined ||
    input.pythonBinary !== undefined;
}

async function applyVisionCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const target = configApplyTarget(operation, options);
  await setupImageGenerationConfig({
    ...target,
    input: {
      provider: imageProviderValue(operation.review.values.provider ?? operation.review.values.providerId),
      model: stringValue(operation.review.values.model ?? operation.review.values.modelId),
      apiKeyEnv: stringValue(operation.review.values.apiKeyEnv ?? operation.review.values.envVar),
      useGateway: booleanValue(operation.review.values.useGateway),
    },
  });
}

async function applyBrowserCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const target = configApplyTarget(operation, options);
  const preserveEmptyLaunchArrays = operation.review.values.engine === "cdp" &&
    operation.review.values.hybridRouting === false;
  await setupBrowserConfig({
    ...target,
    input: {
      backend: browserBackendValue(operation.review.values.backend ?? operation.review.values.browserBackend) ?? "local-cdp",
      cloudProvider: browserCloudProviderValue(operation.review.values.cloudProvider),
      cdpUrl: stringValue(operation.review.values.cdpUrl),
      launchCommand: stringValue(operation.review.values.launchCommand),
      launchExecutable: stringValue(operation.review.values.launchExecutable),
      launchArgs: preserveEmptyLaunchArrays
        ? explicitOptionalArrayValue(operation.review.values.launchArgs)
        : optionalArrayValue(operation.review.values.launchArgs),
      chromeFlags: preserveEmptyLaunchArrays
        ? explicitOptionalArrayValue(operation.review.values.chromeFlags)
        : optionalArrayValue(operation.review.values.chromeFlags),
      autoLaunch: booleanValue(operation.review.values.autoLaunch ?? operation.review.values.autoLaunchRequested),
      supervised: booleanValue(operation.review.values.supervised),
      engine: browserEngineValue(operation.review.values.engine),
      hybridRouting: booleanValue(operation.review.values.hybridRouting),
      cloudFallback: booleanValue(operation.review.values.cloudFallback),
      cloudSpendApproved: booleanValue(operation.review.values.cloudSpendApproved),
      summarizeSnapshots: snapshotSummarizeModeValue(operation.review.values.summarizeSnapshots),
      snapshotSummarizeThreshold: numberValue(operation.review.values.snapshotSummarizeThreshold),
    },
  });
}

async function applyWebSearchCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<readonly OptionalCapabilityApplyWarning[]> {
  if (operation.review.values.skipped === true) return [];

  const searchBackend = stringValue(operation.review.values.searchBackend);
  if (searchBackend === "ddgs") {
    const warning = await ensureReviewedDdgsCapability(operation, options);
    if (warning !== undefined) {
      return [warning];
    }
  }

  const target = configApplyTarget(operation, options);
  await setupWebConfig({
    ...target,
    input: {
      backend: stringValue(operation.review.values.backend),
      searchBackend,
      extractBackend: stringValue(operation.review.values.extractBackend),
      crawlBackend: stringValue(operation.review.values.crawlBackend),
      brave: {
        apiKeyEnv: stringValue(operation.review.values.braveApiKeyEnv),
      },
    },
  });
  return [];
}

async function ensureReviewedDdgsCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<OptionalCapabilityApplyWarning | undefined> {
  const capabilityId = stringValue(operation.review.values.ddgsCapabilityId);
  if (capabilityId !== undefined && capabilityId !== DDGS_CAPABILITY_ID) {
    throw new Error("DDGS setup apply only supports the registered ddgs managed Python capability.");
  }
  const stateRoot = resolveGlobalStateHome({ homeDir: options.homeDir }).stateRoot;
  const status = await checkManagedPythonCapabilityStatus({
    stateRoot,
    capabilityId: DDGS_CAPABILITY_ID,
  });
  if (status.ok) return undefined;

  if (operation.review.values.ddgsSetupConfirmed !== true) {
    throw new Error("DDGS search setup requires explicit managed Python capability setup confirmation.");
  }

  const install = await installManagedPythonCapabilityEnvironment({
    stateRoot,
    capabilityId: DDGS_CAPABILITY_ID,
  });
  if (!install.ok) {
    if (isDdgsTolerantWebSearchOperation(operation, options)) {
      return {
        operationId: operation.id,
        capability: "web-search",
        subCapability: "search",
        code: "managed_python_setup_failed",
        message: resolveSetupCopy("en", "onboarding.optionalCapabilities.webSearch.ddgsSkipped"),
        cause: install.message,
      };
    }
    throw new Error([
      resolveSetupCopy("en", "setupEditor.apply.webSearch.ddgs.failed"),
      install.message,
      install.diagnostic,
    ].filter((line): line is string => line !== undefined && line.trim().length > 0).join("\n"));
  }
  return undefined;
}

function isDdgsTolerantWebSearchOperation(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): boolean {
  return options.mode === "firstRunTolerant" &&
    operation.kind === "config-patch" &&
    operation.target?.kind === "config-scope" &&
    operation.target.scope.includes("web");
}

async function applyWorkspaceTrustGrant(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  if (operation.target?.kind !== "trust-store") {
    throw new Error("Workspace trust apply requires a trust-store target.");
  }
  const store = new WorkspaceTrustStore({
    path: operation.target.trustStorePath || options.trustStorePath,
  });
  await store.grant(operation.target.workspaceRoot, {
    label: "EstaCoda setup",
  });
}

function ensureCredentialReferenceCanApply(
  operation: SetupApplyOperation,
  context: PlanContext
): void {
  if (operation.review.values.credentialSurface === "oauth") {
    const provider = providerIdValue(operation.review.values.provider ?? operation.review.values.providerId);
    const authMethod = stringValue(operation.review.values.authMethod);
    if (provider === undefined || authMethod === undefined) {
      throw new Error("OAuth credential reference apply requires provider and auth method review values.");
    }
    return;
  }
  if (arrayValue(operation.review.values.envVars).length === 0) {
    throw new Error("Credential reference apply requires env-var review values.");
  }
  if (operation.review.values.credentialSurface === "browserbase") {
    return;
  }
  if (operation.review.values.credentialSurface === "web-search-brave") {
    return;
  }
  if (operation.review.values.credentialSurface === "voice-tts" || operation.review.values.credentialSurface === "voice-stt") {
    return;
  }
  if (context.provider === undefined || context.model === undefined) {
    throw new Error("Credential reference apply requires provider/model context.");
  }
}

function planContext(plan: SetupApplyPlan): PlanContext {
  const providerOperation = plan.operations.find((operation) =>
    operation.kind === "config-patch" &&
    (operation.review.summaryKey === "setupDrafts.providerModelRoute.summary" ||
      operation.review.summaryKey === "setupModules.provider.draft")
  );
  const credentialOperation = plan.operations.find((operation) => operation.kind === "credential-reference");
  return {
    provider: providerIdValue(
      providerOperation?.review.values.provider ??
      providerOperation?.review.values.providerId ??
      credentialOperation?.review.values.provider
    ),
    model: stringValue(
      providerOperation?.review.values.model ??
      providerOperation?.review.values.modelId ??
      credentialOperation?.review.values.model
    ),
    credentialEnv: arrayValue(credentialOperation?.review.values.envVars)[0] ??
      stringValue(credentialOperation?.review.values.envVar),
  };
}

function reviewedSecretEnvVarsFromPlan(plan: SetupApplyPlan): string[] {
  const envVars = new Set<string>();
  for (const operation of plan.operations) {
    for (const envVar of arrayValue(operation.review.values.envVars)) {
      envVars.add(envVar);
    }
    for (const key of [
      "envVar",
      "apiKeyEnv",
      "botTokenEnv",
      "ttsApiKeyEnv",
      "sttApiKeyEnv",
      "braveApiKeyEnv",
    ] as const) {
      const envVar = stringValue(operation.review.values[key]);
      if (envVar !== undefined) {
        envVars.add(envVar);
      }
    }
  }
  return [...envVars];
}

function reviewedOAuthCredentialsFromPlan(plan: SetupApplyPlan): string[] {
  const credentials = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.review.values.credentialSurface !== "oauth") continue;
    const provider = providerIdValue(operation.review.values.provider ?? operation.review.values.providerId);
    const authMethod = providerAuthMethodValue(operation.review.values.authMethod);
    const status = stringValue(operation.review.values.oauthCredentialStatus);
    if (
      provider !== undefined &&
      authMethod !== undefined &&
      (status === "ready" || status === "pending")
    ) {
      credentials.add(oauthCredentialKey(provider, authMethod));
    }
  }
  return [...credentials];
}

function oauthCredentialKey(provider: ProviderId, authMethod: string): string {
  return `${provider}:${authMethod}`;
}

function configApplyTarget(
  _operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): ConfigApplyTarget {
  return {
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function optionalArrayValue(value: unknown): string[] | undefined {
  const values = arrayValue(value);
  return values.length > 0 ? values : undefined;
}

function explicitOptionalArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? arrayValue(value) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function providerIdValue(value: unknown): ProviderId | undefined {
  return stringValue(value) as ProviderId | undefined;
}

function providerApiModeValue(value: unknown): ProviderApiMode | undefined {
  return stringValue(value) as ProviderApiMode | undefined;
}

function providerAuthMethodValue(value: unknown): ProviderAuthMethod | undefined {
  return stringValue(value) as ProviderAuthMethod | undefined;
}

function auxiliaryTaskValue(value: unknown): AuxiliaryModelTask | undefined {
  return value === "assessor" ||
    value === "compression" ||
    value === "session_search" ||
    value === "memory_compaction" ||
    value === "profile_context"
    ? value
    : undefined;
}

function securityModeValue(value: unknown): SecurityApprovalMode | undefined {
  return value === "strict" || value === "adaptive" || value === "open" ? value : undefined;
}

function skillAutonomyValue(value: unknown): SkillAutonomy | undefined {
  return value === "none" || value === "suggest" || value === "proactive" || value === "autonomous"
    ? value
    : undefined;
}

function uiLanguageValue(value: unknown): UiLanguage | undefined {
  return value === "en" || value === "ar" ? value : undefined;
}

function uiFlavorValue(value: unknown): UiFlavor | undefined {
  return value === "standard" || value === "arabic-light" || value === "kemet-full" ? value : undefined;
}

function activityLabelsValue(value: unknown): ActivityLabelsLocale | undefined {
  return value === "en" || value === "ar" ? value : undefined;
}

function ttsProviderValue(value: unknown): TtsProvider | undefined {
  return stringValue(value) as TtsProvider | undefined;
}

function sttProviderValue(value: unknown): SttProvider | undefined {
  return stringValue(value) as SttProvider | undefined;
}

function imageProviderValue(value: unknown): ImageGenerationProvider | undefined {
  return stringValue(value) as ImageGenerationProvider | undefined;
}

function browserBackendValue(value: unknown): BrowserBackendKind | undefined {
  return stringValue(value) as BrowserBackendKind | undefined;
}

function browserCloudProviderValue(value: unknown): BrowserCloudProviderKind | undefined {
  return stringValue(value) as BrowserCloudProviderKind | undefined;
}

function browserEngineValue(value: unknown): BrowserEngineKind | undefined {
  return value === "cdp" || value === "agent-browser" || value === "auto" ? value : undefined;
}

function snapshotSummarizeModeValue(value: unknown): BrowserSnapshotSummarizeMode | undefined {
  return value === "auto" || typeof value === "boolean" ? value : undefined;
}

export async function applyReviewedUiPreferences(
  options: ReviewedSetupApplyExecutorOptions,
  input: {
    readonly language?: UiLanguage;
    readonly flavor?: UiFlavor;
    readonly activityLabels?: ActivityLabelsLocale;
  }
): Promise<void> {
  const target = configApplyTarget({
    kind: "config-patch",
    id: "apply.ui-preferences.direct",
    sourceLineIds: [],
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.uiPreferences.summary",
      redacted: true,
      values: input,
    },
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
  }, options);
  await setupUiConfig({
    ...target,
    input,
  });
}
