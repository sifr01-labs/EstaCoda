import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEnvPath } from "../config/env-secret-store.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "../config/provider-diagnostics.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { formatSecurityMode, formatSkillAutonomy } from "../ui/settings-labels.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { OnboardingOptions } from "./onboarding-flow.js";
import { onboardingCopy, type OnboardingCopy } from "./onboarding-copy.js";

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
  const copy = onboardingCopy(locale);
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
  let envMode = copy.verification.notPresent;
  let toolStatus = "skipped";
  const warnings: string[] = [];

  try {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(verifyFile, "ok\n", "utf8");
    stateWritable = true;
  } catch {
    warnings.push(copy.verification.stateNotWritableWarning);
  }

  try {
    const envStat = await stat(envPath);
    envMode = copy.verification.presentMode((envStat.mode & 0o777).toString(8).padStart(3, "0"));
    if ((envStat.mode & 0o777) !== 0o600) {
      warnings.push(copy.verification.secretModeWarning);
    }
  } catch {
    envMode = copy.verification.notPresent;
  }

  if (provider.status !== "ready") {
    warnings.push(...provider.warnings);
  }

  if (!workspaceTrusted) {
    warnings.push(copy.verification.notTrustedWarning);
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
      }
    } catch {
      toolStatus = copy.verification.skippedNoPackageJson;
    }
  }

  return {
    ok: warnings.length === 0,
    output: [
      copy.verification.title,
      copy.verification.body,
      "",
      `${copy.verification.stateDirectory}: ${stateWritable ? copy.verification.writable : copy.verification.blocked}`,
      `${copy.verification.secretStore}: ${envMode}`,
      `${copy.verification.workspaceTrust}: ${workspaceTrusted ? copy.setupCheck.trusted : copy.setupCheck.notTrusted}`,
      `${copy.verification.securityMode}: ${security.label} (${security.value})`,
      `${copy.verification.workflowLearning}: ${autonomy.label} (${autonomy.value})`,
      `${copy.verification.readOnlyToolCheck}: ${toolStatus}`,
      `${copy.verification.configSources}: ${config.sources.join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(provider),
      "",
      warnings.length === 0
        ? `${copy.verification.statusReady}\n${copy.verification.nextReady}`
        : [
            `${copy.verification.warningsTitle}\n${[...new Set(warnings)].map((warning) => `- ${warning}`).join("\n")}`,
            "",
            renderVerificationNextSteps(warnings, copy)
          ].join("\n")
    ].join("\n")
  };
}

function renderVerificationNextSteps(warnings: string[], copy: OnboardingCopy): string {
  const steps = new Set<string>();
  for (const warning of warnings) {
    if (/Provider setup is incomplete/u.test(warning)) {
      steps.add(copy.verification.actions.providerIncomplete);
    }
    if (/Missing API key environment variable ([A-Z0-9_]+)/u.test(warning)) {
      const envName = /Missing API key environment variable ([A-Z0-9_]+)/u.exec(warning)?.[1];
      steps.add(copy.verification.actions.missingApiKey(envName));
    }
    if (/No credential pool is configured/u.test(warning)) {
      steps.add(copy.verification.actions.noCredentialPool);
    }
    if (/Network inference is disabled/u.test(warning)) {
      steps.add(copy.verification.actions.networkDisabled);
    }
    if (/Workspace is not trusted|مجلد العمل غير موثوق/u.test(warning)) {
      steps.add(copy.verification.actions.workspaceNotTrusted);
    }
    if (/Secret store permissions|صلاحيات مخزن المفاتيح/u.test(warning)) {
      steps.add(copy.verification.actions.secretPermissions);
    }
    if (/State directory is not writable|مجلد الحالة غير قابل للكتابة/u.test(warning)) {
      steps.add(copy.verification.actions.stateNotWritable);
    }
    if (/Read-only file tool check|فحص أداة قراءة الملفات/u.test(warning)) {
      steps.add(copy.verification.actions.readOnlyTool);
    }
  }

  if (steps.size === 0) {
    steps.add(copy.verification.fallbackNextAction);
  }

  return `${copy.verification.nextActionsTitle}\n${Array.from(steps).map((step) => `- ${step}`).join("\n")}`;
}
