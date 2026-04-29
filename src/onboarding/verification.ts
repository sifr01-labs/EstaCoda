import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEnvPath } from "../config/env-secret-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "../config/provider-diagnostics.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { formatSecurityMode, formatSkillAutonomy } from "../ui/settings-labels.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { OnboardingOptions } from "./onboarding-flow.js";

export type SetupVerificationResult = {
  ok: boolean;
  output: string;
};

export async function runSetupVerification(options: OnboardingOptions & {
  runtime?: Runtime;
  trustStorePath?: string;
}): Promise<SetupVerificationResult> {
  const config = await loadRuntimeConfig(options);
  const locale = config.ui.language === "ar" ? "ar" : "en";
  const security = formatSecurityMode(config.security.approvalMode, locale);
  const autonomy = formatSkillAutonomy(config.skills.autonomy, locale);
  const provider = await diagnoseProviderConfig(config);
  const trustStore = new WorkspaceTrustStore({
    path: options.trustStorePath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "trust.json")
  });
  const workspaceTrusted = await trustStore.isTrusted(options.workspaceRoot);
  const stateRoot = join(options.homeDir ?? process.env.HOME ?? "", ".estacoda");
  const verifyFile = join(stateRoot, ".verify");
  const envPath = defaultEnvPath(options.homeDir);
  let stateWritable = false;
  let envMode = "not present";
  let toolStatus = "skipped";
  const warnings: string[] = [];

  try {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(verifyFile, "ok\n", "utf8");
    stateWritable = true;
  } catch {
    warnings.push("State directory is not writable.");
  }

  try {
    const envStat = await stat(envPath);
    envMode = `present (${(envStat.mode & 0o777).toString(8).padStart(3, "0")})`;
    if ((envStat.mode & 0o777) !== 0o600) {
      warnings.push("Secret store permissions should be 0600.");
    }
  } catch {
    envMode = "not present";
  }

  if (provider.status !== "ready") {
    warnings.push(...provider.warnings);
  }

  if (!workspaceTrusted) {
    warnings.push("Workspace is not trusted yet; local write/terminal actions will ask first.");
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
        warnings.push("Read-only file tool check did not complete.");
      }
    } catch {
      toolStatus = "skipped (no package.json)";
    }
  }

  return {
    ok: warnings.length === 0,
    output: [
      "EstaCoda verify",
      "Checks your local setup, provider route, credential store, workspace trust, and basic tool readiness.",
      "",
      `State directory: ${stateWritable ? "writable" : "blocked"}`,
      `Secret store: ${envMode}`,
      `Workspace trust: ${workspaceTrusted ? "trusted" : "not trusted"}`,
      `Security mode: ${security.label} (${security.value})`,
      `Skill autonomy: ${autonomy.label} (${autonomy.value})`,
      `Read-only tool check: ${toolStatus}`,
      `Config sources: ${config.sources.join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(provider),
      "",
      warnings.length === 0
        ? "Status: ready\nNext: run estacoda, or configure optional channels with estacoda telegram setup / estacoda browser setup."
        : [
            `Warnings:\n${[...new Set(warnings)].map((warning) => `- ${warning}`).join("\n")}`,
            "",
            renderVerificationNextSteps(warnings)
          ].join("\n")
    ].join("\n")
  };
}

function renderVerificationNextSteps(warnings: string[]): string {
  const steps = new Set<string>();
  for (const warning of warnings) {
    if (/Provider setup is incomplete/u.test(warning)) {
      steps.add("Run estacoda setup to choose a provider/model.");
    }
    if (/Missing API key environment variable ([A-Z0-9_]+)/u.test(warning)) {
      const envName = /Missing API key environment variable ([A-Z0-9_]+)/u.exec(warning)?.[1];
      steps.add(envName === undefined
        ? "Export the missing provider API key, or rerun estacoda setup to store it locally."
        : `Export ${envName}, or rerun estacoda setup and choose local secret storage.`);
    }
    if (/No credential pool is configured/u.test(warning)) {
      steps.add("Run estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>.");
    }
    if (/Network inference is disabled/u.test(warning)) {
      steps.add("Enable network inference for the selected hosted provider with estacoda setup --advanced.");
    }
    if (/Workspace is not trusted/u.test(warning)) {
      steps.add("Run /workspace.trust.grant in an interactive session, or rerun estacoda setup and trust this workspace.");
    }
    if (/Secret store permissions/u.test(warning)) {
      steps.add("Run chmod 600 ~/.estacoda/.env to restrict local secret-store permissions.");
    }
    if (/State directory is not writable/u.test(warning)) {
      steps.add("Check write permissions for ~/.estacoda.");
    }
    if (/Read-only file tool check/u.test(warning)) {
      steps.add("Start an interactive session after fixing provider/trust warnings, then retry estacoda verify.");
    }
  }

  if (steps.size === 0) {
    steps.add("Fix the warnings above, then rerun estacoda verify.");
  }

  return `Next actions:\n${Array.from(steps).map((step) => `- ${step}`).join("\n")}`;
}
