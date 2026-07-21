import type { EstaCodaConfig, LoadedRuntimeConfig } from "../config/runtime-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { StartupReadinessSnapshot } from "../runtime/startup-readiness.js";
import { collectStartupReadinessSnapshot } from "../runtime/startup-readiness.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { ModelsDevRegistryOptions } from "../model-catalog/models-dev-registry.js";
import type { FetchLike as ProviderFetchLike } from "../providers/openai-compatible-provider.js";
import type { SetupVerificationReport } from "./verification.js";
import { collectSetupVerificationReport } from "./verification.js";
import type { BudgetConfig } from "../contracts/budget.js";

export type SetupEntryStateKind =
  | "new-user"
  | "configured-ready"
  | "configured-degraded"
  | "partial-provider"
  | "missing-secret"
  | "broken-config"
  | "untrusted-workspace"
  | "state-not-writable";

export type SetupEntryRecommendedAction =
  | "start-first-run"
  | "launch-agent"
  | "repair-config"
  | "repair-provider"
  | "add-missing-secret"
  | "trust-workspace"
  | "fix-state-directory"
  | "review-warnings";

export type MissingCredentialInfo = {
  readonly envVars: readonly string[];
  readonly providers: readonly string[];
};

export type SetupEntryState = {
  readonly kind: SetupEntryStateKind;
  readonly recommendedAction: SetupEntryRecommendedAction;
  readonly configSources: readonly string[];
  readonly configPaths: {
    readonly profile: string;
  };
  readonly providerReadiness: StartupReadinessSnapshot["providerReadiness"];
  readonly workspaceTrust: StartupReadinessSnapshot["workspaceTrust"];
  readonly workspaceVerification: StartupReadinessSnapshot["workspaceVerification"];
  readonly stateDirectoryWritable: boolean;
  readonly missingCredentials: MissingCredentialInfo;
  readonly setupVerification: SetupVerificationReport;
  readonly budgets: BudgetConfig;
  readonly warnings: readonly string[];
  readonly blockers: readonly string[];
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly error?: string;
};

export type CollectSetupEntryStateOptions = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly providerFetch?: ProviderFetchLike;
  readonly modelsDevOptions?: ModelsDevRegistryOptions;
  readonly runtime?: Runtime;
  readonly trustStorePath?: string;
  readonly readOnly?: boolean;
};

export async function collectSetupEntryState(
  options: CollectSetupEntryStateOptions
): Promise<SetupEntryState> {
  const configPaths = setupConfigPaths(options);
  let loaded: LoadedRuntimeConfig;

  try {
    loaded = await loadRuntimeConfig(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "broken-config",
      recommendedAction: "repair-config",
      configSources: [],
      configPaths,
      providerReadiness: "unknown",
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      stateDirectoryWritable: true,
      missingCredentials: { envVars: [], providers: [] },
      setupVerification: brokenVerificationReport(message),
      budgets: {},
      warnings: [message],
      blockers: [message],
      error: message,
    };
  }

  const verificationReport = await collectSetupVerificationReport({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
    runtime: options.runtime,
    trustStorePath: options.trustStorePath,
    readOnly: options.readOnly,
  });
  const startup = collectStartupReadinessSnapshot({
    workspaceRoot: options.workspaceRoot,
    workspaceTrusted: verificationReport.workspaceTrusted,
    verificationReport,
    model: { provider: loaded.model.provider, id: loaded.model.id },
    securityMode: loaded.security.approvalMode,
    skillAutonomy: loaded.skills.autonomy,
  });
  const missingCredentials = collectMissingCredentials(verificationReport.providerDiagnostic);
  const hasConfiguredModel = loaded.model.provider !== "unconfigured" && loaded.model.id !== "unconfigured";
  const hasNoSetupIntentYet = isFirstRunSetupSkeleton(loaded.config);
  const kind = classifySetupEntryState({
    hasConfigSources: loaded.sources.length > 0,
    hasNoSetupIntentYet,
    hasConfiguredModel,
    stateDirectoryWritable: verificationReport.stateWritable,
    workspaceTrusted: verificationReport.workspaceTrusted,
    providerStatus: verificationReport.providerDiagnostic.status,
    missingCredentials,
  });
  const recommendedAction = recommendedActionFor(kind);
  const blockers = collectBlockers(kind, verificationReport, missingCredentials);

  return {
    kind,
    recommendedAction,
    configSources: loaded.sources,
    configPaths,
    providerReadiness: startup.providerReadiness,
    workspaceTrust: startup.workspaceTrust,
    workspaceVerification: startup.workspaceVerification,
    stateDirectoryWritable: verificationReport.stateWritable,
    missingCredentials,
    setupVerification: verificationReport,
    budgets: loaded.budgets,
    warnings: [...new Set(verificationReport.warnings)],
    blockers,
    model: {
      provider: loaded.model.provider,
      id: loaded.model.id,
    },
  };
}

function classifySetupEntryState(input: {
  readonly hasConfigSources: boolean;
  readonly hasNoSetupIntentYet: boolean;
  readonly hasConfiguredModel: boolean;
  readonly stateDirectoryWritable: boolean;
  readonly workspaceTrusted: boolean;
  readonly providerStatus: ProviderDiagnostic["status"];
  readonly missingCredentials: MissingCredentialInfo;
}): SetupEntryStateKind {
  if (!input.stateDirectoryWritable) return "state-not-writable";
  if (!input.hasConfigSources || input.hasNoSetupIntentYet) return "new-user";
  if (!input.hasConfiguredModel) return "partial-provider";
  if (input.missingCredentials.envVars.length > 0 || input.missingCredentials.providers.length > 0) {
    return "missing-secret";
  }
  if (input.providerStatus === "blocked") return "partial-provider";
  if (!input.workspaceTrusted) return "untrusted-workspace";
  if (input.providerStatus === "warning") return "configured-degraded";
  return "configured-ready";
}

function isFirstRunSetupSkeleton(config: EstaCodaConfig): boolean {
  return isUnconfiguredPrimaryModelOnly(config.model)
    && hasNoConfiguredProviders(config)
    && config.modelAliases === undefined
    && config.model_aliases === undefined
    && config.auxiliaryModels === undefined
    && config.web === undefined
    && config.browser === undefined
    && config.imageGen === undefined
    && config.image_gen === undefined
    && config.gateway === undefined
    && config.tts === undefined
    && config.stt === undefined
    && config.voice === undefined
    && config.mcpServers === undefined
    && config.mcp_servers === undefined
    && config.memory === undefined
    && config.compression === undefined
    && config.externalMemory === undefined
    && config.external_memory === undefined
    && config.delegation === undefined
    && hasNoChannelConfig(config)
    && hasNoCredentialRefs(config)
    && hasDefaultSetupSensitivePrefs(config);
}

function isUnconfiguredPrimaryModelOnly(config: EstaCodaConfig["model"]): boolean {
  if (config === undefined) return true;
  return (config.provider === undefined || config.provider === "unconfigured")
    && (config.id === undefined || config.id === "unconfigured")
    && config.contextWindowTokens === undefined
    && config.maxTokens === undefined
    && config.timeoutMs === undefined
    && config.staleTimeoutMs === undefined
    && (config.fallbacks?.length ?? 0) === 0;
}

function hasNoConfiguredProviders(config: EstaCodaConfig): boolean {
  return Object.keys(config.providers ?? {}).length === 0;
}

function hasNoChannelConfig(config: EstaCodaConfig): boolean {
  return Object.keys(config.channels ?? {}).length === 0;
}

function hasNoCredentialRefs(config: EstaCodaConfig): boolean {
  return !containsCredentialRef(config);
}

function containsCredentialRef(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialRef);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:apiKeyEnv|api_key_env|botTokenEnv|passwordEnv)$/u.test(key) &&
      typeof child === "string" &&
      child.trim().length > 0
    ) {
      return true;
    }
    if (containsCredentialRef(child)) return true;
  }

  return false;
}

function hasDefaultSetupSensitivePrefs(config: EstaCodaConfig): boolean {
  return hasDefaultSecurityConfig(config.security) && hasDefaultSkillsConfig(config.skills);
}

function hasDefaultSecurityConfig(config: EstaCodaConfig["security"]): boolean {
  if (config === undefined) return true;
  return (config.approvalMode === undefined || config.approvalMode === "strict")
    && (config.approvals === undefined || (
      (config.approvals.mode === undefined || config.approvals.mode === "strict") &&
      Object.keys(config.approvals).every((key) => key === "mode")
    ))
    && config.allowPrivateUrls === undefined
    && config.websiteBlocklist === undefined
    && config.assessor === undefined
    && Object.keys(config).every((key) => [
      "approvalMode",
      "approvals",
    ].includes(key));
}

function hasDefaultSkillsConfig(config: EstaCodaConfig["skills"]): boolean {
  if (config === undefined) return true;
  return (config.autonomy === undefined || config.autonomy === "suggest")
    && config.externalDirs === undefined
    && config.config === undefined
    && Object.keys(config).every((key) => key === "autonomy");
}

function recommendedActionFor(kind: SetupEntryStateKind): SetupEntryRecommendedAction {
  switch (kind) {
    case "new-user":
      return "start-first-run";
    case "configured-ready":
      return "launch-agent";
    case "configured-degraded":
      return "review-warnings";
    case "partial-provider":
      return "repair-provider";
    case "missing-secret":
      return "add-missing-secret";
    case "broken-config":
      return "repair-config";
    case "untrusted-workspace":
      return "trust-workspace";
    case "state-not-writable":
      return "fix-state-directory";
  }
}

function collectMissingCredentials(diagnostic: ProviderDiagnostic): MissingCredentialInfo {
  const envVars = new Set<string>();
  const providers = new Set<string>();

  for (const warning of diagnostic.warnings) {
    const envPatterns = [
      /Missing env var ([A-Z0-9_]+)/u,
      /Missing API key environment variable ([A-Z0-9_]+)/u,
      /Missing ([A-Z0-9_]+)/u,
    ];
    for (const pattern of envPatterns) {
      const match = pattern.exec(warning);
      if (match?.[1] !== undefined && match[1] !== "API") {
        envVars.add(match[1]);
      }
    }

    const providerMatch = /for\s+([a-z][a-z0-9_-]*)\b/iu.exec(warning);
    if (/No credential|No available credential/iu.test(warning) && providerMatch?.[1] !== undefined) {
      providers.add(providerMatch[1]);
    }
  }

  return {
    envVars: [...envVars].sort(),
    providers: [...providers].sort(),
  };
}

function collectBlockers(
  kind: SetupEntryStateKind,
  report: SetupVerificationReport,
  missingCredentials: MissingCredentialInfo
): string[] {
  const blockers = new Set<string>();

  if (kind === "new-user") {
    blockers.add("First-run setup has not completed yet.");
  }
  if (kind === "partial-provider") {
    blockers.add("Provider setup is incomplete.");
  }
  if (kind === "missing-secret") {
    for (const envName of missingCredentials.envVars) {
      blockers.add(`Missing credential environment variable ${envName}.`);
    }
    for (const provider of missingCredentials.providers) {
      blockers.add(`No available credential is configured for ${provider}.`);
    }
  }
  if (kind === "untrusted-workspace") {
    blockers.add("Workspace is not trusted.");
  }
  if (kind === "state-not-writable") {
    blockers.add("EstaCoda state directory is not writable.");
  }

  for (const code of report.issueCodes) {
    if (code === "secret-permissions") {
      blockers.add("Secret store permissions are not restricted to 0600.");
    }
  }

  return [...blockers];
}

function setupConfigPaths(options: CollectSetupEntryStateOptions): SetupEntryState["configPaths"] {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  return {
    profile: resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath,
  };
}

function brokenVerificationReport(message: string): SetupVerificationReport {
  return {
    stateWritable: true,
    envFilePresent: false,
    envFileSecure: true,
    workspaceTrusted: false,
    securityModeLabel: "Unknown",
    securityModeValue: "unknown",
    skillAutonomyLabel: "Unknown",
    skillAutonomyValue: "unknown",
    providerDiagnostic: {
      status: "blocked",
      lines: ["Provider check skipped because config could not load."],
      warnings: [message],
    },
    browserDiagnostic: {
      status: "invalid",
      label: "invalid",
      lines: ["Browser check skipped because config could not load."],
      warnings: [message],
    },
    toolStatus: "skipped",
    configSources: [],
    warnings: [message],
    issueCodes: ["broken-config"],
  };
}
