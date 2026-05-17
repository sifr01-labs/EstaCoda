import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
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
  const kind = classifySetupEntryState({
    hasConfigSources: loaded.sources.length > 0,
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
  readonly hasConfiguredModel: boolean;
  readonly stateDirectoryWritable: boolean;
  readonly workspaceTrusted: boolean;
  readonly providerStatus: ProviderDiagnostic["status"];
  readonly missingCredentials: MissingCredentialInfo;
}): SetupEntryStateKind {
  if (!input.stateDirectoryWritable) return "state-not-writable";
  if (!input.hasConfigSources) return "new-user";
  if (!input.hasConfiguredModel) return "partial-provider";
  if (input.missingCredentials.envVars.length > 0 || input.missingCredentials.providers.length > 0) {
    return "missing-secret";
  }
  if (input.providerStatus === "blocked") return "partial-provider";
  if (!input.workspaceTrusted) return "untrusted-workspace";
  if (input.providerStatus === "warning") return "configured-degraded";
  return "configured-ready";
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
    blockers.add("No setup config exists yet.");
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
    toolStatus: "skipped",
    configSources: [],
    warnings: [message],
    issueCodes: ["broken-config"],
  };
}
