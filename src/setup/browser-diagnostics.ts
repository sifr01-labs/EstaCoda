import { hasSavedEnvSecret } from "../config/env-secret-store.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { SetupVerificationCopy } from "./setup-verification-copy.js";

export const BROWSERBASE_CREDENTIAL_ENV_VARS = [
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
] as const;

export type BrowserSetupDiagnosticStatus =
  | "not-configured"
  | "disabled"
  | "configured"
  | "runtime-blocked"
  | "invalid";

export type BrowserSetupDiagnostic = {
  readonly status: BrowserSetupDiagnosticStatus;
  readonly label: string;
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
};

export type BrowserSetupDiagnosticOptions = {
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly copy: SetupVerificationCopy;
};

export type BrowserSetupValidationInput = {
  readonly mode?: "local-supervised" | "existing-cdp" | "browserbase" | "disabled";
  readonly backend?: string;
  readonly cloudProvider?: string;
  readonly cdpUrl?: string;
  readonly autoLaunch?: boolean;
  readonly supervised?: boolean;
  readonly cloudSpendApproved?: boolean | "pending";
  readonly credentialReady?: boolean;
  readonly credentialBlockers?: readonly string[];
};

export async function diagnoseBrowserSetup(
  config: LoadedRuntimeConfig,
  options: BrowserSetupDiagnosticOptions
): Promise<BrowserSetupDiagnostic> {
  const rawBrowser = config.config.browser;
  if (rawBrowser === undefined || rawBrowser.backend === undefined) {
    return browserDiagnostic("not-configured", options.copy, [], []);
  }

  const warnings = await browserSetupBlockers(config.browser, options);
  if (warnings.length > 0) {
    return browserDiagnostic("invalid", options.copy, browserLines(config.browser), warnings);
  }

  if (config.browser.backend === "unconfigured") {
    return browserDiagnostic("disabled", options.copy, browserLines(config.browser), []);
  }

  if (config.browser.backend === "browserbase" && config.browser.cloudSpendApproved !== true) {
    return browserDiagnostic("runtime-blocked", options.copy, browserLines(config.browser), [
      options.copy.verification.browserWarnings.browserbaseSpendPending,
    ]);
  }

  return browserDiagnostic("configured", options.copy, browserLines(config.browser), []);
}

export async function browserSetupBlockers(
  input: BrowserSetupValidationInput,
  options: Pick<BrowserSetupDiagnosticOptions, "homeDir" | "profileId" | "copy">
): Promise<readonly string[]> {
  const warnings = [...browserSetupStaticBlockers(input, options.copy)];

  if (input.backend === "browserbase") {
    if (input.credentialReady === false) {
      warnings.push(...(input.credentialBlockers ?? []));
    } else {
      const missing = await missingBrowserbaseCredentialSources(options);
      warnings.push(...missing.map((envVarName) => options.copy.verification.browserWarnings.missingBrowserbaseCredential(envVarName)));
    }
  }

  return [...new Set(warnings)];
}

export function browserSetupStaticBlockers(
  input: BrowserSetupValidationInput,
  copy: SetupVerificationCopy
): readonly string[] {
  const warnings: string[] = [];

  if (input.backend === "local-cdp") {
    const cdpUrl = normalizedOptionalString(input.cdpUrl);
    if (input.mode === "existing-cdp" && cdpUrl === undefined) {
      warnings.push(copy.verification.browserWarnings.existingCdpMissingUrl);
    } else if (input.autoLaunch === false && cdpUrl === undefined && input.supervised === true) {
      warnings.push(copy.verification.browserWarnings.localSupervisedIncomplete);
    }
    if (cdpUrl !== undefined && !isLocalCdpUrl(cdpUrl)) {
      warnings.push(copy.verification.browserWarnings.existingCdpNonLocal);
    }
  }

  return [...new Set(warnings)];
}

export function isLocalCdpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1";
  } catch {
    return false;
  }
}

export async function missingBrowserbaseCredentialSources(options: {
  readonly homeDir?: string;
  readonly profileId?: string;
}): Promise<readonly string[]> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const missing: string[] = [];

  for (const envVarName of BROWSERBASE_CREDENTIAL_ENV_VARS) {
    if ((process.env[envVarName] ?? "").trim().length > 0) {
      continue;
    }
    const saved = await hasSavedEnvSecret({
      homeDir: options.homeDir,
      profileId,
      key: envVarName,
    });
    if (!saved.exists) {
      missing.push(envVarName);
    }
  }

  return missing;
}

function browserDiagnostic(
  status: BrowserSetupDiagnosticStatus,
  copy: SetupVerificationCopy,
  lines: readonly string[],
  warnings: readonly string[]
): BrowserSetupDiagnostic {
  return {
    status,
    label: browserStatusLabel(status, copy),
    lines,
    warnings,
  };
}

function browserStatusLabel(status: BrowserSetupDiagnosticStatus, copy: SetupVerificationCopy): string {
  switch (status) {
    case "not-configured":
      return copy.verification.browserStates.notConfigured;
    case "disabled":
      return copy.verification.browserStates.disabled;
    case "configured":
      return copy.verification.browserStates.configuredConnectionNotTested;
    case "runtime-blocked":
      return copy.verification.browserStates.configuredRuntimeBlocked;
    case "invalid":
      return copy.verification.browserStates.invalid;
  }
}

function browserLines(input: BrowserSetupValidationInput): readonly string[] {
  return [
    `Browser backend: ${input.backend ?? "not configured"}`,
    ...(input.cloudProvider === undefined ? [] : [`Browser cloud provider: ${input.cloudProvider}`]),
    ...(input.cdpUrl === undefined ? [] : [`Browser CDP URL: ${input.cdpUrl}`]),
  ];
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
