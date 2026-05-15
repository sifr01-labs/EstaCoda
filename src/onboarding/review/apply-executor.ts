import { join } from "node:path";
import {
  collectSetupVerificationReport,
  type SetupVerificationReport,
} from "../verification.js";
import {
  executeSetupApplyPlan,
  type SetupApplyEndState,
  type SetupApplyExecutionResult,
  type SetupApplyExecutor,
  type SetupApplyFlowOptions,
  type SetupApplyOperation,
  type SetupApplyPlan,
  type SetupPostSaveVerificationRequest,
} from "../setup-apply-plan.js";
import {
  setupImageGenerationConfig,
  setupBrowserConfig,
  setupSecurityConfig,
  setupSkillConfig,
  setupTelegramConfig,
  setupUiConfig,
  setupVoiceConfig,
  type ActivityLabelsLocale,
  type ImageGenerationProvider,
  type SttProvider,
  type TtsProvider,
  type UiFlavor,
  type UiLanguage,
} from "../../config/runtime-config.js";
import {
  registerProviderConfig,
  registerProviderModel,
  setPreferredModelRoute,
  storeProviderCredential,
} from "../../config/provider-config-mutations.js";
import type { BrowserBackendKind } from "../../contracts/browser.js";
import type { ProviderId } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";

export type ReviewedSetupApplyExecutorOptions = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly projectConfigTrust?: "trusted" | "untrusted";
  readonly trustStorePath?: string;
  readonly collectVerification?: (options: ReviewedSetupApplyExecutorOptions) => Promise<SetupVerificationReport> | SetupVerificationReport;
};

type ConfigScope = "user" | "project";

type ConfigApplyTarget = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly scope: ConfigScope;
};

type PlanContext = {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly credentialEnv?: string;
};

export function createReviewedSetupApplyExecutor(
  options: ReviewedSetupApplyExecutorOptions
): SetupApplyExecutor {
  return {
    apply: (plan) => applyReviewedSetupPlanOperations(plan, options),
    verify: (request) => verifyReviewedSetup(request, options),
  };
}

export async function executeReviewedSetupApplyPlan(
  plan: SetupApplyPlan,
  options: ReviewedSetupApplyExecutorOptions,
  flowOptions: SetupApplyFlowOptions = {}
): Promise<SetupApplyEndState> {
  return executeSetupApplyPlan(plan, createReviewedSetupApplyExecutor(options), flowOptions);
}

export async function applyReviewedSetupPlanOperations(
  plan: SetupApplyPlan,
  options: ReviewedSetupApplyExecutorOptions
): Promise<SetupApplyExecutionResult> {
  const appliedOperationIds: string[] = [];
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
          await applyConfigPatch(operation, context, options);
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
    };
  } catch (error) {
    return {
      ok: false,
      appliedOperationIds,
      error: error instanceof Error ? error.message : "Reviewed setup apply failed.",
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
    userConfigPath: options.userConfigPath,
    projectConfigPath: options.projectConfigPath,
    projectConfigTrust: options.projectConfigTrust,
    trustStorePath: options.trustStorePath,
  });
}

async function applyConfigPatch(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  switch (operation.review.summaryKey) {
    case "setupDrafts.providerModelRoute.summary":
    case "setupModules.provider.draft":
      await applyProviderRoute(operation, context, options);
      return;
    case "setupDrafts.credentialReference.summary":
    case "setupModules.credentials.draft":
      await applyCredentialReference(operation, context, options);
      return;
    case "setupDrafts.securityMode.summary":
    case "setupModules.security-mode.draft":
      await applySecurityMode(operation, options);
      return;
    case "setupDrafts.workflowLearning.summary":
    case "setupModules.workflow-learning.draft":
      await applyWorkflowLearning(operation, options);
      return;
    case "setupDrafts.optionalCapabilities.summary":
      await applyFirstRunOptionalCapabilities(operation, options);
      return;
    case "setupModules.telegram.draft":
      await applyTelegramCapability(operation, options);
      return;
    case "setupModules.voice.draft":
      await applyVoiceCapability(operation, options);
      return;
    case "setupModules.vision.draft":
      await applyVisionCapability(operation, options);
      return;
    case "setupModules.browser.draft":
      await applyBrowserCapability(operation, options);
      return;
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
  const target = configApplyTarget(operation, options);
  await registerProviderConfig({
    ...target,
    input: {
      provider,
      baseUrl,
      kind: "openai-compatible",
      enableNetwork: true,
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

async function applyCredentialReference(
  operation: SetupApplyOperation,
  context: PlanContext,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  ensureCredentialReferenceCanApply(operation, context);
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
      scope: target.scope,
    },
  });
}

async function applyWorkflowLearning(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const autonomy = skillAutonomyValue(operation.review.values.workflowLearning ?? operation.review.values.workflowMode);
  if (autonomy === undefined) {
    throw new Error("Workflow learning apply requires a valid autonomy value.");
  }
  const target = configApplyTarget(operation, options);
  await setupSkillConfig({
    ...target,
    input: {
      autonomy,
      scope: target.scope,
    },
  });
}

async function applyFirstRunOptionalCapabilities(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  if (operation.review.values.skipped === true) return;
  const capabilities = arrayValue(operation.review.values.capabilities);
  for (const capability of capabilities) {
    switch (capability) {
      case "channels":
        throw new Error("Remote-control capabilities require token references and allowed identities before apply.");
      case "voice":
        await applyVoiceCapability(operation, options);
        break;
      case "vision":
        await applyVisionCapability(operation, options);
        break;
      case "browser":
        await applyBrowserCapability(operation, options);
        break;
      default:
        throw new Error(`Unsupported optional capability: ${capability}`);
    }
  }
}

async function applyTelegramCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const botTokenEnv = stringValue(operation.review.values.botTokenEnv ?? operation.review.values.envVar);
  const allowedUserIds = arrayValue(operation.review.values.allowedUserIds);
  const allowedChatIds = arrayValue(operation.review.values.allowedChatIds);
  if (botTokenEnv === undefined) {
    throw new Error("Telegram apply requires a bot token environment-variable reference.");
  }
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
      scope: target.scope,
    },
  });
}

async function applyVoiceCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const target = configApplyTarget(operation, options);
  await setupVoiceConfig({
    ...target,
    input: {
      ttsProvider: ttsProviderValue(operation.review.values.ttsProvider),
      ttsModel: stringValue(operation.review.values.ttsModel),
      ttsApiKeyEnv: stringValue(operation.review.values.ttsApiKeyEnv),
      sttProvider: sttProviderValue(operation.review.values.sttProvider),
      sttModel: stringValue(operation.review.values.sttModel),
      sttApiKeyEnv: stringValue(operation.review.values.sttApiKeyEnv),
      scope: target.scope,
    },
  });
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
      scope: target.scope,
    },
  });
}

async function applyBrowserCapability(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): Promise<void> {
  const target = configApplyTarget(operation, options);
  await setupBrowserConfig({
    ...target,
    input: {
      backend: browserBackendValue(operation.review.values.backend ?? operation.review.values.browserBackend) ?? "local-cdp",
      cdpUrl: stringValue(operation.review.values.cdpUrl),
      launchCommand: stringValue(operation.review.values.launchCommand),
      autoLaunch: false,
      scope: target.scope,
    },
  });
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
  if (arrayValue(operation.review.values.envVars).length === 0) {
    throw new Error("Credential reference apply requires env-var review values.");
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

function configApplyTarget(
  operation: SetupApplyOperation,
  options: ReviewedSetupApplyExecutorOptions
): ConfigApplyTarget {
  const targetPath = operation.target?.kind === "config-scope" ? operation.target.path : undefined;
  const projectConfigPath = options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json");
  if (targetPath !== undefined && targetPath === projectConfigPath) {
    return {
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      projectConfigPath: targetPath,
      scope: "project",
    };
  }
  return {
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    userConfigPath: targetPath ?? options.userConfigPath,
    projectConfigPath: options.projectConfigPath,
    scope: "user",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
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

function securityModeValue(value: unknown): SecurityApprovalMode | undefined {
  return value === "strict" || value === "adaptive" || value === "open" ? value : undefined;
}

function skillAutonomyValue(value: unknown): SkillAutonomy | undefined {
  return value === "none" || value === "suggest" || value === "proactive" || value === "autonomous"
    ? value
    : undefined;
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

export async function applyReviewedUiPreferences(
  options: ReviewedSetupApplyExecutorOptions,
  input: {
    readonly language?: UiLanguage;
    readonly flavor?: UiFlavor;
    readonly activityLabels?: ActivityLabelsLocale;
    readonly scope?: ConfigScope;
  }
): Promise<void> {
  await setupUiConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    userConfigPath: options.userConfigPath,
    projectConfigPath: options.projectConfigPath,
    input,
  });
}
