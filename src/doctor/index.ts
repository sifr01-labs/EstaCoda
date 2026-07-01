import { readFile, stat } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "../cli/cli.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { collectSetupEntryState } from "../setup/setup-entry-state.js";
import {
  diagnoseProviderConfig,
  diagnoseProviderLive
} from "../config/provider-diagnostics.js";
import type { ProviderDiagnostic, ProviderLiveDiagnostic } from "../config/provider-diagnostics.js";
import { isBackupReady } from "../lifecycle/state-preservation.js";
import { PackRegistry } from "../packs/pack-registry.js";
import { collectMissingProfileEnv } from "./checks/env-coverage.js";
import { diagnoseLiveToolCall } from "./checks/live-tool.js";
import { renderDoctorReport } from "./cli-renderer.js";
import type {
  DoctorAction,
  DoctorCheck,
  DoctorCheckSeverity,
  DoctorLocale,
  DoctorReport,
  DoctorVerdict,
  LiveToolDiagnostic
} from "./types.js";

export async function runDoctor(options: CliOptions, args: string[] = []): Promise<CliCommandResult> {
  const setupState = await collectSetupEntryState(options);
  let config: Awaited<ReturnType<typeof loadRuntimeConfig>> | undefined;
  let configSyntaxError: string | undefined;
  const activeProfileId = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const selectedProfile = selectedProfileId(options);
  const selectedProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: selectedProfile });
  const activeProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: activeProfileId });
  const stateHome = resolveStateHome({ homeDir: options.homeDir });

  try {
    config = await loadRuntimeConfig(options);
  } catch (error) {
    configSyntaxError = error instanceof Error ? error.message : String(error);
  }

  const providerDiagnostic = config === undefined
    ? setupState.setupVerification.providerDiagnostic
    : await diagnoseProviderConfig(config);
  const liveProviderDiagnostic = config !== undefined && hasFlag(args, "--live")
    ? await diagnoseProviderLive(config)
    : undefined;
  const liveToolDiagnostic = hasFlag(args, "--live-tools", "--live-tool")
    ? await diagnoseLiveToolCall({
        runtime: options.runtime,
        workspaceRoot: options.workspaceRoot
      })
    : undefined;
  const warnings: string[] = [];
  const notes: string[] = [];
  const activeProfileMissing = !await pathExists(activeProfilePaths.profileRoot);
  const selectedProfileConfigMissing = !await pathExists(selectedProfilePaths.configPath);
  const trustStoreOk = await trustStoreHealthy(stateHome.trustJsonPath);

  if (activeProfileMissing) {
    warnings.push(`Active profile is missing: ${activeProfileId}`);
  }
  if (selectedProfileConfigMissing) {
    warnings.push(`Selected profile config is missing: ${selectedProfilePaths.configPath}`);
  }
  if (!trustStoreOk) {
    warnings.push(`Global trust store is not valid JSON: ${stateHome.trustJsonPath}`);
  }

  const modelContextWindowWarning = config !== undefined && config.model.contextWindowTokens > 0 && config.model.contextWindowTokens < 64_000;
  if (modelContextWindowWarning) {
    warnings.push("Configured model context window is below 64K tokens.");
  }

  if (setupState.kind !== "configured-ready" && setupState.kind !== "configured-degraded") {
    warnings.push(...setupState.blockers);
  }

  warnings.push(...providerDiagnostic.warnings);
  warnings.push(...(liveProviderDiagnostic?.warnings ?? []));
  warnings.push(...(liveToolDiagnostic?.warnings ?? []));

  if (configSyntaxError !== undefined) {
    warnings.push(`Config syntax error: ${configSyntaxError}`);
  }

  const missingProfileEnv = config === undefined ? [] : collectMissingProfileEnv(config);
  if (config !== undefined) {
    if (missingProfileEnv.length > 0) {
      warnings.push(`Selected profile .env is missing required values: ${missingProfileEnv.join(", ")}`);
    }
  }

  // State directory backup integrity
  const homeDir = resolveHomeDir(options.homeDir);
  const backupReady = await isBackupReady(homeDir);
  if (!backupReady.ok) {
    warnings.push(`State backup not ready: ${backupReady.reason}`);
  }

  // pack registry health
  const spRegistry = new PackRegistry({ homeDir });
  const spEntries = await spRegistry.list();
  let packErrorCount = 0;
  let packDisabledCount = 0;
  if (spEntries.length === 0) {
    notes.push("pack registry: no packs installed");
  } else {
    notes.push(`pack registry: ${spEntries.length} installed`);
    const spErrors = await spRegistry.getErrors();
    packErrorCount = spErrors.length;
    packDisabledCount = spEntries.filter((e) => e.status === "disabled").length;
    if (packErrorCount > 0) {
      warnings.push(`${packErrorCount} pack(s) have status error`);
    }
    if (packDisabledCount > 0) {
      notes.push(`${packDisabledCount} pack(s) disabled`);
    }
  }

  const locale = config?.ui.language === "ar" ? "ar" : "en";
  const report = buildDoctorReport({
    locale,
    selectedProfile,
    workspaceRoot: options.workspaceRoot,
    home: stateHome.stateRoot,
    model: config === undefined ? "unknown/unknown" : `${config.model.provider}/${config.model.id}`,
    configSources: config?.sources ?? setupState.configSources,
    warnings,
    notes,
    providerDiagnostic,
    liveProviderDiagnostic,
    liveToolDiagnostic,
    configSyntaxError,
    activeProfileMissing,
    selectedProfileConfigMissing,
    trustStoreOk,
    modelContextWindowWarning,
    backupReady: backupReady.ok,
    backupReason: backupReady.ok ? undefined : backupReady.reason,
    packCount: spEntries.length,
    packErrorCount,
    packDisabledCount,
    browserBackend: config?.browser.backend ?? "unknown",
    missingProfileEnv
  });

  return {
    handled: true,
    exitCode: warnings.length === 0 &&
      liveProviderDiagnostic?.status !== "blocked" &&
      liveToolDiagnostic?.status !== "blocked"
      ? 0
      : 1,
    output: renderDoctorReport(report)
  };
}

type BuildDoctorReportInput = {
  readonly locale: DoctorLocale;
  readonly selectedProfile: string;
  readonly workspaceRoot: string;
  readonly home: string;
  readonly model: string;
  readonly configSources: readonly string[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly providerDiagnostic: ProviderDiagnostic;
  readonly liveProviderDiagnostic?: ProviderLiveDiagnostic;
  readonly liveToolDiagnostic?: LiveToolDiagnostic;
  readonly configSyntaxError?: string;
  readonly activeProfileMissing: boolean;
  readonly selectedProfileConfigMissing: boolean;
  readonly trustStoreOk: boolean;
  readonly modelContextWindowWarning: boolean;
  readonly backupReady: boolean;
  readonly backupReason?: string;
  readonly packCount: number;
  readonly packErrorCount: number;
  readonly packDisabledCount: number;
  readonly browserBackend: string;
  readonly missingProfileEnv: readonly string[];
};

function buildDoctorReport(input: BuildDoctorReportInput): DoctorReport {
  const checks: DoctorCheck[] = [
    check("runtime", label(input.locale, "runtime"), "healthy"),
    check(
      "installation",
      label(input.locale, "installation"),
      input.backupReady ? "healthy" : "warning",
      input.backupReady ? undefined : input.backupReason
    ),
    check(
      "configuration",
      label(input.locale, "configuration"),
      configSeverity(input),
      configSummary(input)
    ),
    check(
      "providers",
      label(input.locale, "providers"),
      providerSeverity(input.providerDiagnostic),
      firstOrReady(input.providerDiagnostic.warnings, input.locale)
    ),
    check(
      "models",
      label(input.locale, "models"),
      input.model === "unknown/unknown" || input.modelContextWindowWarning ? "warning" : "healthy",
      input.model
    ),
    check("capabilities", label(input.locale, "capabilities"), "healthy", input.browserBackend),
    check("memory", label(input.locale, "memory"), "healthy"),
    check(
      "skills",
      label(input.locale, "skills"),
      input.packErrorCount > 0 ? "warning" : "healthy",
      packSummary(input)
    ),
    check("security", label(input.locale, "security"), input.trustStoreOk ? "healthy" : "warning"),
  ];

  if (input.liveProviderDiagnostic !== undefined) {
    checks.push(check(
      "live-provider",
      label(input.locale, "liveProvider"),
      input.liveProviderDiagnostic.status === "blocked" ? "blocked" : "healthy",
      firstOrReady(input.liveProviderDiagnostic.warnings, input.locale)
    ));
  }

  if (input.liveToolDiagnostic !== undefined) {
    checks.push(check(
      "live-tools",
      label(input.locale, "liveTools"),
      input.liveToolDiagnostic.status === "blocked" ? "blocked" : "healthy",
      firstOrReady(input.liveToolDiagnostic.warnings, input.locale)
    ));
  }

  const verdict = doctorVerdict(checks, input.locale);
  return {
    locale: input.locale,
    profile: input.selectedProfile,
    workspace: input.workspaceRoot,
    home: input.home,
    model: input.model,
    configSources: input.configSources,
    sections: [
      {
        id: "checks",
        title: label(input.locale, "checks"),
        checks
      }
    ],
    verdict,
    actions: [...new Set(input.warnings)].map((warning, index) => warningAction(warning, index, input.locale)),
    notes: input.notes
  };
}

function check(
  id: string,
  labelText: string,
  severity: DoctorCheckSeverity,
  summary?: string
): DoctorCheck {
  return { id, label: labelText, severity, summary };
}

function configSeverity(input: BuildDoctorReportInput): DoctorCheckSeverity {
  if (input.configSyntaxError !== undefined) return "blocked";
  if (input.activeProfileMissing || input.selectedProfileConfigMissing || input.missingProfileEnv.length > 0) return "warning";
  return "healthy";
}

function configSummary(input: BuildDoctorReportInput): string | undefined {
  if (input.configSyntaxError !== undefined) return `Config syntax error: ${input.configSyntaxError}`;
  if (input.selectedProfileConfigMissing) return "selected profile config missing";
  if (input.activeProfileMissing) return "active profile missing";
  if (input.missingProfileEnv.length > 0) return "missing env values";
  return undefined;
}

function providerSeverity(diagnostic: ProviderDiagnostic): DoctorCheckSeverity {
  if (diagnostic.status === "blocked") return "blocked";
  if (diagnostic.status === "warning") return "warning";
  return "healthy";
}

function firstOrReady(warnings: readonly string[], locale: DoctorLocale): string {
  if (warnings.length > 0) return warnings[0]!;
  return locale === "ar" ? "جاهز" : "ready";
}

function packSummary(input: BuildDoctorReportInput): string {
  if (input.packCount === 0) return input.locale === "ar" ? "لا توجد حزم" : "no packs installed";
  if (input.packErrorCount > 0) return `${input.packErrorCount} pack(s) have status error`;
  if (input.packDisabledCount > 0) return `${input.packDisabledCount} pack(s) disabled`;
  return `${input.packCount} installed`;
}

function doctorVerdict(checks: readonly DoctorCheck[], locale: DoctorLocale): DoctorVerdict {
  const blockedCount = checks.filter((checkItem) => checkItem.severity === "blocked").length;
  const warningCount = checks.filter((checkItem) => checkItem.severity === "warning").length;
  const healthyCount = checks.filter((checkItem) => checkItem.severity === "healthy").length;
  const status = blockedCount > 0 ? "blocked" : warningCount > 0 ? "warning" : "ready";
  return {
    status,
    title: verdictTitle(status, locale),
    blockedCount,
    warningCount,
    healthyCount
  };
}

function verdictTitle(status: DoctorVerdict["status"], locale: DoctorLocale): string {
  if (locale === "ar") {
    switch (status) {
      case "ready":
        return "جاهز";
      case "warning":
        return "جاهز مع تحذيرات";
      case "blocked":
        return "محظور";
    }
  }
  switch (status) {
    case "ready":
      return "Ready";
    case "warning":
      return "Ready with warnings";
    case "blocked":
      return "Blocked";
  }
}

function warningAction(warning: string, index: number, locale: DoctorLocale): DoctorAction {
  return {
    id: `warning-${index + 1}`,
    severity: warningSeverity(warning),
    title: localizeWarningTitle(warning, locale),
    detailLines: warningDetailLines(warning, locale),
    command: warningCommand(warning)
  };
}

function warningSeverity(warning: string): DoctorAction["severity"] {
  return /Config syntax error|Provider setup is incomplete|not writable|blocked/iu.test(warning)
    ? "blocked"
    : "warning";
}

function warningDetailLines(warning: string, locale: DoctorLocale): readonly string[] | undefined {
  const missingEnv = /missing required values: (.+)$/iu.exec(warning)?.[1];
  if (missingEnv !== undefined) {
    return [locale === "ar" ? `المتغيرات: ${missingEnv}` : `Env: ${missingEnv}`];
  }
  return undefined;
}

function warningCommand(warning: string): string | undefined {
  if (/Config syntax error/iu.test(warning)) return "estacoda setup --interactive";
  if (/Provider setup is incomplete|missing required values|Missing API key/iu.test(warning)) return "estacoda model setup";
  return undefined;
}

function localizeWarningTitle(warning: string, locale: DoctorLocale): string {
  if (locale !== "ar") return warning;
  if (/Config syntax error/iu.test(warning)) return warning.replace(/^Config syntax error:/iu, "خطأ في صياغة الإعدادات:");
  if (/Provider setup is incomplete/iu.test(warning)) return "إعداد المزوّد غير مكتمل";
  if (/Selected profile .env is missing required values/iu.test(warning)) return "ملف أسرار الملف الشخصي تنقصه قيم مطلوبة";
  if (/Active profile is missing/iu.test(warning)) return "الملف الشخصي النشط غير موجود";
  if (/Selected profile config is missing/iu.test(warning)) return "إعدادات الملف الشخصي المحدد غير موجودة";
  if (/Global trust store is not valid JSON/iu.test(warning)) return "ملف الثقة العام ليس JSON صالحًا";
  if (/State backup not ready/iu.test(warning)) return "نسخ الحالة الاحتياطي غير جاهز";
  if (/Configured model context window is below 64K tokens/iu.test(warning)) return "نافذة سياق النموذج أقل من 64K رمز";
  return warning;
}

function label(locale: DoctorLocale, key: DoctorLabelKey): string {
  return DOCTOR_LABELS[key][locale];
}

type DoctorLabelKey =
  | "runtime"
  | "installation"
  | "configuration"
  | "providers"
  | "models"
  | "capabilities"
  | "memory"
  | "skills"
  | "security"
  | "liveProvider"
  | "liveTools"
  | "checks";

const DOCTOR_LABELS: Record<DoctorLabelKey, Record<DoctorLocale, string>> = {
  runtime: { en: "Runtime", ar: "وقت التشغيل" },
  installation: { en: "Installation", ar: "التثبيت" },
  configuration: { en: "Configuration", ar: "الإعدادات" },
  providers: { en: "Providers", ar: "المزوّدون" },
  models: { en: "Models", ar: "النماذج" },
  capabilities: { en: "Capabilities", ar: "القدرات" },
  memory: { en: "Memory", ar: "الذاكرة" },
  skills: { en: "Skills", ar: "المهارات" },
  security: { en: "Security", ar: "الأمان" },
  liveProvider: { en: "Live provider", ar: "المزوّد الحي" },
  liveTools: { en: "Live tools", ar: "الأدوات الحية" },
  checks: { en: "Checks", ar: "الفحوصات" }
};

function selectedProfileId(options: Pick<CliOptions, "homeDir" | "profileId">): string {
  return options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function trustStoreHealthy(path: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(path, "utf8"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
}
