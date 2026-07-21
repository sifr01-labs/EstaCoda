import { access, constants, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { diagnoseProviderConfig, renderProviderDiagnostic, type ProviderDiagnostic } from "../config/provider-diagnostics.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { formatSecurityMode, formatSkillAutonomy } from "../ui/settings-labels.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { setupVerificationCopy, type SetupVerificationCopy } from "./setup-verification-copy.js";
import { setupOutputLine, setupTechnicalToken } from "./setup-prompts.js";
import { diagnoseBrowserSetup, type BrowserSetupDiagnostic } from "./browser-diagnostics.js";
import type { BudgetConfig, SpendingLimit } from "../contracts/budget.js";

export type SetupVerificationResult = {
  ok: boolean;
  output: string;
};

export type SetupVerificationOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  runtime?: Runtime;
  trustStorePath?: string;
  readOnly?: boolean;
};

export type SetupVerificationIssueCode =
  | "provider-incomplete"
  | "missing-api-key"
  | "missing-credential-reference"
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
  readonly browserDiagnostic?: BrowserSetupDiagnostic;
  readonly toolStatus: SetupVerificationToolStatus;
  readonly configSources: readonly string[];
  readonly budgets?: BudgetConfig;
  readonly warnings: readonly string[];
  readonly issueCodes: readonly SetupVerificationIssueCode[];
};

export async function collectSetupVerificationReport(
  options: SetupVerificationOptions
): Promise<SetupVerificationReport> {
  const homeDir = resolveHomeDir(options.homeDir);
  let config: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  try {
    config = await loadRuntimeConfig({ ...options, homeDir });
  } catch (error) {
    return invalidConfigVerificationReport({
      homeDir,
      workspaceRoot: options.workspaceRoot,
      trustStorePath: options.trustStorePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const locale = config.ui.language === "ar" ? "ar" : "en";
  const security = formatSecurityMode(config.security.approvalMode, locale);
  const autonomy = formatSkillAutonomy(config.skills.autonomy, locale);
  const provider = await diagnoseProviderConfig(config);
  const trustStore = new WorkspaceTrustStore({
    path: options.trustStorePath ?? join(homeDir, ".estacoda", "trust.json")
  });
  const workspaceTrusted = await isWorkspaceTrusted(trustStore, options.workspaceRoot);
  const stateRoot = join(homeDir, ".estacoda");
  const verifyFile = join(stateRoot, ".verify");
  const profileId = options.profileId ?? readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  const envPath = resolveProfileStateHome({ homeDir, profileId }).envPath;
  let stateWritable = false;
  let envFilePresent = false;
  let envMode: string | undefined;
  let envFileSecure = true;
  let toolStatus: SetupVerificationToolStatus = "skipped";
  const warnings: string[] = [];
  const issueCodes: SetupVerificationIssueCode[] = [];
  const copy = setupVerificationCopy(locale);
  const browser = await diagnoseBrowserSetup(config, {
    homeDir,
    profileId,
    copy,
  });

  if (options.readOnly === true) {
    stateWritable = await checkStateWritableReadOnly(stateRoot, homeDir);
    if (!stateWritable) {
      warnings.push(copy.verification.stateNotWritableWarning);
      issueCodes.push("state-not-writable");
    }
  } else {
    try {
      await mkdir(stateRoot, { recursive: true });
      await writeFile(verifyFile, "ok\n", "utf8");
      stateWritable = true;
    } catch {
      warnings.push(copy.verification.stateNotWritableWarning);
      issueCodes.push("state-not-writable");
    }
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

  for (const warning of browser.warnings) {
    warnings.push(warning);
    issueCodes.push(...mapBrowserWarningToCodes(warning));
  }

  if (options.readOnly !== true && options.runtime?.executeTool !== undefined) {
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
    browserDiagnostic: browser,
    toolStatus,
    configSources: config.sources,
    budgets: config.budgets,
    warnings,
    issueCodes,
  };
}

async function checkStateWritableReadOnly(stateRoot: string, homeDir: string): Promise<boolean> {
  try {
    const stateRootStat = await stat(stateRoot);
    return stateRootStat.isDirectory() && await canWrite(stateRoot);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return canWrite(homeDir);
    }
    return false;
  }
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
  const locale = copy.locale === "ar" ? "ar" : "en";
  const browserDiagnostic = report.browserDiagnostic ?? defaultBrowserDiagnostic(copy);
  const lines: string[] = [
    renderVerificationLine(copy, copy.verification.title),
    renderVerificationLine(copy, copy.verification.body),
    "",
    renderVerificationPair(copy, copy.verification.stateDirectory, report.stateWritable ? copy.verification.writable : copy.verification.blocked),
    renderVerificationPair(copy, copy.verification.secretStore, report.envFilePresent && report.envFileMode !== undefined ? copy.verification.presentMode(report.envFileMode) : copy.verification.notPresent),
    renderVerificationPair(copy, copy.verification.workspaceTrust, report.workspaceTrusted ? copy.setupCheck.trusted : copy.setupCheck.notTrusted),
    renderVerificationPair(copy, copy.verification.securityMode, `${setupTechnicalToken(locale, report.securityModeLabel)} (${setupTechnicalToken(locale, report.securityModeValue)})`),
    renderVerificationPair(copy, copy.verification.workflowLearning, `${setupTechnicalToken(locale, report.skillAutonomyLabel)} (${setupTechnicalToken(locale, report.skillAutonomyValue)})`),
    renderVerificationPair(copy, copy.verification.taskSpendingLimit, renderSpendingLimit(report.budgets?.task, copy)),
    renderVerificationPair(copy, copy.verification.sessionSpendingLimit, renderSpendingLimit(report.budgets?.session, copy)),
    renderVerificationPair(copy, copy.verification.readOnlyToolCheck, renderToolStatus(report.toolStatus, copy)),
    renderVerificationPair(copy, copy.verification.browserBackend, browserDiagnostic.label),
    renderVerificationPair(copy, copy.verification.configSources, report.configSources.length > 0
      ? report.configSources.map((source) => setupTechnicalToken(locale, source)).join(", ")
      : setupTechnicalToken(locale, "none")),
    "",
    renderVerificationBlock(copy, renderProviderDiagnostic(report.providerDiagnostic)),
    "",
    renderVerificationBlock(copy, renderBrowserDiagnostic(browserDiagnostic)),
    "",
  ];

  if (report.warnings.length === 0) {
    lines.push([
      renderVerificationLine(copy, copy.verification.statusReady),
      renderVerificationLine(copy, copy.verification.nextReady),
    ].join("\n"));
  } else {
    lines.push(
      [
        renderVerificationLine(copy, copy.verification.warningsTitle),
        [...new Set(report.warnings)].map((warning) => renderVerificationBullet(copy, warning)).join("\n"),
      ].join("\n"),
      "",
      renderVerificationNextSteps(report.issueCodes, copy)
    );
  }

  return lines.join("\n");
}

function renderSpendingLimit(
  limit: SpendingLimit | undefined,
  copy: SetupVerificationCopy
): string {
  if (limit === undefined) return copy.verification.off;
  const value = `$${limit.maxEstimatedCostUsd.toFixed(2)} USD · ${limit.warningThresholdPercent}%`;
  return setupTechnicalToken(copy.locale === "ar" ? "ar" : "en", value);
}

function defaultBrowserDiagnostic(copy: SetupVerificationCopy): BrowserSetupDiagnostic {
  return {
    status: "not-configured",
    label: copy.verification.browserStates.notConfigured,
    lines: [],
    warnings: [],
  };
}

function renderBrowserDiagnostic(diagnostic: BrowserSetupDiagnostic): string {
  return [
    ...diagnostic.lines,
    diagnostic.warnings.length === 0
      ? `Browser status: ${diagnostic.label}`
      : `Browser warnings:\n${diagnostic.warnings.map((warning) => `- ${warning}`).join("\n")}`
  ].join("\n");
}

export async function runSetupVerification(options: SetupVerificationOptions): Promise<SetupVerificationResult> {
  const report = await collectSetupVerificationReport(options);
  let locale: "en" | "ar" = "en";
  try {
    const config = await loadRuntimeConfig(options);
    locale = config.ui.language === "ar" ? "ar" : "en";
  } catch {
    locale = "en";
  }
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
      case "missing-credential-reference":
        steps.add(copy.verification.actions.missingCredentialReference);
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

  return [
    renderVerificationLine(copy, copy.verification.nextActionsTitle),
    Array.from(steps).map((step) => renderVerificationBullet(copy, step)).join("\n"),
  ].join("\n");
}

function renderVerificationPair(copy: SetupVerificationCopy, label: string, value: string): string {
  return renderVerificationLine(copy, `${label}: ${value}`);
}

function renderVerificationBullet(copy: SetupVerificationCopy, value: string): string {
  return renderVerificationLine(copy, `- ${value}`);
}

function renderVerificationBlock(copy: SetupVerificationCopy, value: string): string {
  return value.split("\n").map((line) => renderVerificationLine(copy, line)).join("\n");
}

function renderVerificationLine(copy: SetupVerificationCopy, value: string): string {
  if (copy.locale !== "ar") return value;
  return containsArabic(value) ? setupOutputLine("ar", value) : setupTechnicalToken("ar", value);
}

function containsArabic(value: string): boolean {
  return /[\u0600-\u06FF]/u.test(value);
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
  if (/No apiKeyEnv is configured/u.test(warning)) {
    codes.push("missing-credential-reference");
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

function mapBrowserWarningToCodes(warning: string): SetupVerificationIssueCode[] {
  const codes: SetupVerificationIssueCode[] = [];
  if (/BROWSERBASE_[A-Z0-9_]+/u.test(warning)) {
    codes.push("missing-api-key");
  }
  if (/runtime-blocked|spend|الإنفاق/u.test(warning)) {
    codes.push("browser-runtime-blocked");
  }
  if (/CDP|Browser config|المتصفح/u.test(warning)) {
    codes.push("browser-invalid");
  }
  return codes;
}

async function invalidConfigVerificationReport(input: {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly trustStorePath?: string;
  readonly message: string;
}): Promise<SetupVerificationReport> {
  const copy = setupVerificationCopy("en");
  const trustStore = new WorkspaceTrustStore({
    path: input.trustStorePath ?? join(input.homeDir, ".estacoda", "trust.json")
  });
  const stateRoot = join(input.homeDir, ".estacoda");
  const verifyFile = join(stateRoot, ".verify");
  const profileId = readActiveProfile({ homeDir: input.homeDir }).profileId ?? defaultProfileId();
  const envPath = resolveProfileStateHome({ homeDir: input.homeDir, profileId }).envPath;
  let stateWritable = false;
  let envFilePresent = false;
  let envMode: string | undefined;
  let envFileSecure = true;
  const browserConfigError = /\bbrowser(?:\.|\b)/iu.test(input.message);
  const primaryWarning = browserConfigError
    ? copy.verification.browserWarnings.invalidConfig(input.message)
    : input.message;
  const warnings: string[] = [primaryWarning];
  const issueCodes: SetupVerificationIssueCode[] = browserConfigError ? ["browser-invalid"] : ["broken-config"];

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

  const workspaceTrusted = await isWorkspaceTrusted(trustStore, input.workspaceRoot);
  if (!workspaceTrusted) {
    warnings.push(copy.verification.notTrustedWarning);
    issueCodes.push("workspace-not-trusted");
  }

  return {
    stateWritable,
    envFilePresent,
    envFileMode: envMode,
    envFileSecure,
    workspaceTrusted,
    securityModeLabel: "Unknown",
    securityModeValue: "unknown",
    skillAutonomyLabel: "Unknown",
    skillAutonomyValue: "unknown",
    providerDiagnostic: {
      status: "blocked",
      lines: ["Provider check skipped because config could not load."],
      warnings: [input.message],
    },
    browserDiagnostic: {
      status: browserConfigError ? "invalid" : "not-configured",
      label: browserConfigError
        ? copy.verification.browserStates.invalid
        : copy.verification.browserStates.notConfigured,
      lines: ["Browser check skipped because config could not load."],
      warnings: browserConfigError ? [primaryWarning] : [],
    },
    toolStatus: "skipped",
    configSources: [],
    warnings,
    issueCodes,
  };
}
