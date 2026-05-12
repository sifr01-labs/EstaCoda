import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEnvPath } from "../config/env-secret-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic, type ProviderDiagnostic } from "../config/provider-diagnostics.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { formatSecurityMode, formatSkillAutonomy } from "../ui/settings-labels.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { setupVerificationCopy, type SetupVerificationCopy } from "./setup-verification-copy.js";

export type SetupVerificationResult = {
  ok: boolean;
  output: string;
};

export type SetupVerificationOptions = {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  projectConfigTrust?: "trusted" | "untrusted";
  runtime?: Runtime;
  trustStorePath?: string;
};

export type SetupVerificationIssueCode =
  | "provider-incomplete"
  | "missing-api-key"
  | "no-credential-pool"
  | "network-disabled"
  | "workspace-not-trusted"
  | "secret-permissions"
  | "state-not-writable"
  | "read-only-tool-blocked"
  | "provider-adapter-missing"
  | "provider-not-executable"
  | "provider-health-blocked"
  | "model-not-registered"
  | "small-context-window"
  | "no-available-credential"
  | string;

export type SetupVerificationIssue = {
  readonly code: SetupVerificationIssueCode;
  readonly message: string;
};

export type SetupVerificationToolStatus =
  | "skipped"
  | "ready"
  | "blocked"
  | "skipped-no-package-json";

export type SetupVerificationReport = {
  readonly stateWritable: boolean;
  readonly envFilePresent: boolean;
  readonly envFileMode?: string;
  readonly envFileSecure: boolean;
  readonly workspaceTrusted: boolean;
  readonly securityModeLabel: string;
  readonly securityModeValue: string;
  readonly skillAutonomyLabel: string;
  readonly skillAutonomyValue: string;
  readonly providerDiagnostic: ProviderDiagnostic;
  readonly toolStatus: SetupVerificationToolStatus;
  readonly configSources: readonly string[];
  readonly warnings: readonly string[];
  readonly issueCodes: readonly SetupVerificationIssueCode[];
};

export async function collectSetupVerificationReport(
  options: SetupVerificationOptions
): Promise<SetupVerificationReport> {
  const config = await loadRuntimeConfig(options);
  const locale = config.ui.language === "ar" ? "ar" : "en";
  const security = formatSecurityMode(config.security.approvalMode, locale);
  const autonomy = formatSkillAutonomy(config.skills.autonomy, locale);
  const provider = await diagnoseProviderConfig(config);
  const trustStore = new WorkspaceTrustStore({
    path: options.trustStorePath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "trust.json")
  });
  const workspaceTrusted = await isWorkspaceTrusted(trustStore, options.workspaceRoot);
  const stateRoot = join(options.homeDir ?? process.env.HOME ?? "", ".estacoda");
  const verifyFile = join(stateRoot, ".verify");
  const envPath = defaultEnvPath(options.homeDir);
  let stateWritable = false;
  let envFilePresent = false;
  let envMode: string | undefined;
  let envFileSecure = true;
  let toolStatus: SetupVerificationToolStatus = "skipped";
  const warnings: string[] = [];
  const issueCodes: SetupVerificationIssueCode[] = [];
  const copy = setupVerificationCopy(locale);

  try {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(verifyFile, "ok\n", "utf8");
    stateWritable = true;
  } catch {
    warnings.push(copy.verification.stateNotWritableWarning);
    issueCodes.push("state-not-writable");
  }

  try {
    const envStat = await stat(envPath);
    envFilePresent = true;
    envMode = (envStat.mode & 0o777).toString(8).padStart(3, "0");
    envFileSecure = (envStat.mode & 0o777) === 0o600;
    if (!envFileSecure) {
      warnings.push(copy.verification.secretModeWarning);
      issueCodes.push("secret-permissions");
    }
  } catch {
    envFilePresent = false;
    envMode = undefined;
    envFileSecure = true;
  }

  for (const warning of provider.warnings) {
    warnings.push(warning);
    issueCodes.push(...mapProviderWarningToCodes(warning));
  }

  if (!workspaceTrusted) {
    warnings.push(copy.verification.notTrustedWarning);
    issueCodes.push("workspace-not-trusted");
  }

  if (options.runtime?.executeTool !== undefined) {
    const packageJson = join(options.workspaceRoot, "package.json");
    try {
      await stat(packageJson);
      const response = await options.runtime.executeTool({
        tool: "file.read",
        toolInput: { path: "package.json" }
      });
      toolStatus = response?.result?.ok === true ? "ready" : "blocked";
      if (response?.result?.ok !== true) {
        warnings.push(copy.verification.readOnlyToolWarning);
        issueCodes.push("read-only-tool-blocked");
      }
    } catch {
      toolStatus = "skipped-no-package-json";
    }
  }

  return {
    stateWritable,
    envFilePresent,
    envFileMode: envMode,
    envFileSecure,
    workspaceTrusted,
    securityModeLabel: security.label,
    securityModeValue: security.value,
    skillAutonomyLabel: autonomy.label,
    skillAutonomyValue: autonomy.value,
    providerDiagnostic: provider,
    toolStatus,
    configSources: config.sources,
    warnings,
    issueCodes,
  };
}

async function isWorkspaceTrusted(store: WorkspaceTrustStore, workspaceRoot: string): Promise<boolean> {
  try {
    return await store.isTrusted(workspaceRoot);
  } catch {
    return false;
  }
}

export function renderSetupVerificationReport(
  report: SetupVerificationReport,
  copy: SetupVerificationCopy
): string {
  const lines: string[] = [
    copy.verification.title,
    copy.verification.body,
    "",
    `${copy.verification.stateDirectory}: ${report.stateWritable ? copy.verification.writable : copy.verification.blocked}`,
    `${copy.verification.secretStore}: ${report.envFilePresent && report.envFileMode !== undefined ? copy.verification.presentMode(report.envFileMode) : copy.verification.notPresent}`,
    `${copy.verification.workspaceTrust}: ${report.workspaceTrusted ? copy.setupCheck.trusted : copy.setupCheck.notTrusted}`,
    `${copy.verification.securityMode}: ${report.securityModeLabel} (${report.securityModeValue})`,
    `${copy.verification.workflowLearning}: ${report.skillAutonomyLabel} (${report.skillAutonomyValue})`,
    `${copy.verification.readOnlyToolCheck}: ${renderToolStatus(report.toolStatus, copy)}`,
    `${copy.verification.configSources}: ${report.configSources.join(", ") || "none"}`,
    "",
    renderProviderDiagnostic(report.providerDiagnostic),
    "",
  ];

  if (report.warnings.length === 0) {
    lines.push(`${copy.verification.statusReady}\n${copy.verification.nextReady}`);
  } else {
    lines.push(
      `${copy.verification.warningsTitle}\n${[...new Set(report.warnings)].map((warning) => `- ${warning}`).join("\n")}`,
      "",
      renderVerificationNextSteps(report.issueCodes, copy)
    );
  }

  return lines.join("\n");
}

export async function runSetupVerification(options: SetupVerificationOptions): Promise<SetupVerificationResult> {
  const report = await collectSetupVerificationReport(options);
  const config = await loadRuntimeConfig(options);
  const locale = config.ui.language === "ar" ? "ar" : "en";
  const copy = setupVerificationCopy(locale);
  const output = renderSetupVerificationReport(report, copy);

  return {
    ok: report.warnings.length === 0,
    output,
  };
}

function renderToolStatus(status: SetupVerificationToolStatus, copy: SetupVerificationCopy): string {
  switch (status) {
    case "ready":
      return copy.verification.ready;
    case "blocked":
      return copy.verification.blocked;
    case "skipped-no-package-json":
      return copy.verification.skippedNoPackageJson;
    case "skipped":
      return copy.verification.skipped;
  }
}

function renderVerificationNextSteps(issueCodes: readonly SetupVerificationIssueCode[], copy: SetupVerificationCopy): string {
  const steps = new Set<string>();
  for (const code of issueCodes) {
    switch (code) {
      case "provider-incomplete":
        steps.add(copy.verification.actions.providerIncomplete);
        break;
      case "missing-api-key":
        steps.add(copy.verification.actions.missingApiKey());
        break;
      case "no-credential-pool":
        steps.add(copy.verification.actions.noCredentialPool);
        break;
      case "no-available-credential":
        steps.add(copy.verification.actions.noCredentialPool);
        break;
      case "network-disabled":
        steps.add(copy.verification.actions.networkDisabled);
        break;
      case "workspace-not-trusted":
        steps.add(copy.verification.actions.workspaceNotTrusted);
        break;
      case "secret-permissions":
        steps.add(copy.verification.actions.secretPermissions);
        break;
      case "state-not-writable":
        steps.add(copy.verification.actions.stateNotWritable);
        break;
      case "read-only-tool-blocked":
        steps.add(copy.verification.actions.readOnlyTool);
        break;
      default:
        break;
    }
  }

  if (steps.size === 0) {
    steps.add(copy.verification.fallbackNextAction);
  }

  return `${copy.verification.nextActionsTitle}\n${Array.from(steps).map((step) => `- ${step}`).join("\n")}`;
}

function mapProviderWarningToCodes(warning: string): SetupVerificationIssueCode[] {
  const codes: SetupVerificationIssueCode[] = [];
  if (/Provider setup is incomplete/u.test(warning)) {
    codes.push("provider-incomplete");
  }
  if (/Missing API key environment variable ([A-Z0-9_]+)/u.test(warning)) {
    codes.push("missing-api-key");
  }
  if (/Missing env var ([A-Z0-9_]+)/u.test(warning)) {
    codes.push("missing-api-key");
  }
  if (/No credential pool is configured/u.test(warning)) {
    codes.push("no-credential-pool");
  }
  if (/No available credential is configured/u.test(warning)) {
    codes.push("no-available-credential");
  }
  if (/Network inference is disabled/u.test(warning)) {
    codes.push("network-disabled");
  }
  if (/No provider adapter is registered/u.test(warning)) {
    codes.push("provider-adapter-missing");
  }
  if (/registered for model discovery only and is not yet executable/u.test(warning)) {
    codes.push("provider-not-executable");
  }
  if (/Provider health check failed|blocked|missing|incomplete|disabled|No provider|No credential/iu.test(warning)) {
    codes.push("provider-health-blocked");
  }
  if (/Configured model .* is not registered/u.test(warning)) {
    codes.push("model-not-registered");
  }
  if (/context window is below 64K/u.test(warning)) {
    codes.push("small-context-window");
  }
  return codes;
}
