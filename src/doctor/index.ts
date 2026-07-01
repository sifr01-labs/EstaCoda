import { readFile, stat } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "../cli/cli.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { resolveStateHome } from "../config/state-home.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { detectTerminalCapabilities } from "../ui/terminal-capabilities.js";
import { createOperatorConsoleStyle } from "../ui/papyrus/operator-console/operatorConsoleStyle.js";
import type { OperatorConsoleStyle } from "../ui/papyrus/operator-console/operatorConsoleStyle.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { collectSetupEntryState, type SetupEntryState } from "../setup/setup-entry-state.js";
import {
  diagnoseProviderConfig,
  diagnoseProviderLive
} from "../config/provider-diagnostics.js";
import type { ProviderDiagnostic, ProviderLiveDiagnostic } from "../config/provider-diagnostics.js";
import { PackRegistry } from "../packs/pack-registry.js";
import { diagnoseBackupReadiness } from "./checks/backup-readiness.js";
import { diagnoseConfigHygiene, type ConfigHygieneDiagnostic } from "./checks/config-hygiene.js";
import {
  diagnoseDirectoryStructure,
  type DirectoryStructureDiagnostic
} from "./checks/directory-structure.js";
import { collectMissingProfileEnv } from "./checks/env-coverage.js";
import { diagnoseExternalTools, type ExternalToolDiagnostic } from "./checks/external-tools.js";
import { diagnoseLiveToolCall } from "./checks/live-tool.js";
import { diagnoseMemoryHealth, type MemoryHealthDiagnostic } from "./checks/memory-health.js";
import { diagnoseMcpSecurity, type McpSecurityDiagnostic } from "./checks/mcp-security.js";
import { diagnoseNpmAudit, type NpmAuditDiagnostic } from "./checks/npm-audit.js";
import { diagnoseOAuthStatus, type OAuthStatusDiagnostic } from "./checks/oauth-status.js";
import { diagnoseProviderChain, type ProviderChainDiagnostic } from "./checks/provider-chain.js";
import { diagnoseSQLiteHealth, type SQLiteHealthDiagnostic } from "./checks/sqlite-health.js";
import { renderDoctorJsonReport, renderDoctorReport } from "./cli-renderer.js";
import { runDoctorFix } from "./fix-engine.js";
import { renderDoctorFixReport } from "./fix-renderer.js";
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
  if (hasFlag(args, "--fix")) {
    const fixResult = await runDoctorFix({
      homeDir: options.homeDir,
      profileId: options.profileId,
      locale: await detectDoctorLocale(options)
    });
    return {
      handled: true,
      exitCode: 0,
      output: renderDoctorFixReport(fixResult)
    };
  }

  const activeProfile = readActiveProfileForDoctor({ homeDir: options.homeDir });
  const activeProfileId = activeProfile.profileId;
  const selectedProfile = options.profileId ?? activeProfileId;
  const effectiveOptions = { ...options, profileId: selectedProfile };
  const setupStateResult = await collectDoctorSetupEntryState(effectiveOptions, selectedProfile);
  const setupState = setupStateResult.setupState;
  let config: Awaited<ReturnType<typeof loadRuntimeConfig>> | undefined;
  let configSyntaxError: string | undefined;
  const selectedProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: selectedProfile });
  const activeProfilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: activeProfileId });
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const directoryDiagnostic = await diagnoseDirectoryStructure({ homeDir: options.homeDir, profileId: selectedProfile });
  const sqliteHealth = await diagnoseSQLiteHealth({ homeDir: options.homeDir });
  const oauthStatus = await diagnoseOAuthStatus({ homeDir: options.homeDir, profileId: selectedProfile });
  const externalTools = await diagnoseExternalTools();
  const memoryHealth = await diagnoseMemoryHealth({ homeDir: options.homeDir, profileId: selectedProfile });
  const npmAudit = await diagnoseNpmAudit({
    enabled: hasFlag(args, "--audit", "--security-audit"),
    cwd: options.workspaceRoot
  });

  try {
    config = await loadRuntimeConfig(effectiveOptions);
  } catch (error) {
    configSyntaxError = error instanceof Error ? error.message : String(error);
  }
  const configHygiene = await diagnoseConfigHygiene(selectedProfilePaths.configPath);
  const mcpSecurity = diagnoseMcpSecurity(config);

  const providerDiagnostic = config === undefined
    ? setupState.setupVerification.providerDiagnostic
    : await diagnoseProviderConfig(config);
  const liveProviderDiagnostic = config !== undefined && hasFlag(args, "--live")
    ? await diagnoseProviderLive(config)
    : undefined;
  const providerChain = await diagnoseProviderChain(config, { oauthStatus });
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

  warnings.push(...activeProfile.warnings);
  warnings.push(...setupStateResult.warnings);
  if (activeProfileMissing) {
    warnings.push(`Active profile is missing: ${activeProfileId}`);
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

  warnings.push(...directoryDiagnostic.warnings);
  warnings.push(...sqliteHealth.warnings);
  warnings.push(...oauthStatus.warnings);
  warnings.push(...mcpSecurity.warnings);
  warnings.push(...externalTools.warnings);
  warnings.push(...memoryHealth.warnings);
  warnings.push(...npmAudit.warnings);
  warnings.push(...providerChain.warnings);
  warnings.push(...configHygiene.warnings);
  warnings.push(...providerDiagnostic.warnings);
  warnings.push(...(liveProviderDiagnostic?.warnings ?? []));
  warnings.push(...(liveToolDiagnostic?.warnings ?? []));
  notes.push(...directoryDiagnostic.notes);
  notes.push(...sqliteHealth.notes);
  notes.push(...oauthStatus.notes);
  notes.push(...mcpSecurity.notes);
  notes.push(...externalTools.notes);
  notes.push(...memoryHealth.notes);
  notes.push(...npmAudit.notes);

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
  const backupReady = await diagnoseBackupReadiness({ homeDir });
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
    providerChain,
    liveProviderDiagnostic,
    liveToolDiagnostic,
    configSyntaxError,
    configHygiene,
    directoryDiagnostic,
    sqliteHealth,
    oauthStatus,
    mcpSecurity,
    externalTools,
    memoryHealth,
    npmAudit,
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
    output: hasFlag(args, "--json") ? renderDoctorJsonReport(report) : renderDoctorReport(report, { style: doctorConsoleStyle() })
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
  readonly providerChain: ProviderChainDiagnostic;
  readonly liveProviderDiagnostic?: ProviderLiveDiagnostic;
  readonly liveToolDiagnostic?: LiveToolDiagnostic;
  readonly configSyntaxError?: string;
  readonly configHygiene: ConfigHygieneDiagnostic;
  readonly directoryDiagnostic: DirectoryStructureDiagnostic;
  readonly sqliteHealth: SQLiteHealthDiagnostic;
  readonly oauthStatus: OAuthStatusDiagnostic;
  readonly mcpSecurity: McpSecurityDiagnostic;
  readonly externalTools: ExternalToolDiagnostic;
  readonly memoryHealth: MemoryHealthDiagnostic;
  readonly npmAudit: NpmAuditDiagnostic;
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
      "state",
      label(input.locale, "state"),
      stateSeverity(input),
      stateSummary(input)
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
      providerSeverity(input.providerDiagnostic, input.providerChain),
      providerSummary(input.providerDiagnostic, input.providerChain, input.locale)
    ),
    check(
      "oauth",
      label(input.locale, "oauth"),
      input.oauthStatus.status === "warning" ? "warning" : "healthy",
      oauthSummary(input.oauthStatus, input.locale)
    ),
    check(
      "models",
      label(input.locale, "models"),
      input.model === "unknown/unknown" || input.modelContextWindowWarning ? "warning" : "healthy",
      input.model
    ),
    check("capabilities", label(input.locale, "capabilities"), "healthy", input.browserBackend),
    check(
      "mcp",
      label(input.locale, "mcp"),
      input.mcpSecurity.status === "warning" ? "warning" : "healthy",
      mcpSummary(input.mcpSecurity, input.locale)
    ),
    check(
      "external-tools",
      label(input.locale, "externalTools"),
      input.externalTools.status === "warning" ? "warning" : "healthy",
      externalToolsSummary(input.externalTools, input.locale)
    ),
    check(
      "dependencies",
      label(input.locale, "dependencies"),
      dependencyAuditSeverity(input.npmAudit),
      dependencyAuditSummary(input.npmAudit, input.locale)
    ),
    check(
      "memory",
      label(input.locale, "memory"),
      memorySeverity(input.memoryHealth),
      memorySummary(input.memoryHealth, input.locale)
    ),
    check(
      "sessions",
      label(input.locale, "sessions"),
      sqliteSeverity(input.sqliteHealth),
      sqliteSummary(input.sqliteHealth, input.locale)
    ),
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
  const actions = [...new Set(input.warnings)].map((warning, index) => warningAction(warning, index, input.locale));
  if (input.npmAudit.status === "not-run") {
    actions.push({
      id: "dependency-audit",
      severity: "info",
      title: input.locale === "ar" ? "تشغيل فحص أمان الاعتماديات" : "Run dependency security audit",
      command: "estacoda doctor --audit"
    });
  }
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
    providerRoutes: input.providerChain.routes,
    verdict,
    actions,
    notes: input.notes
  };
}

function providerSummary(
  diagnostic: ProviderDiagnostic,
  chain: ProviderChainDiagnostic,
  locale: DoctorLocale
): string {
  if (chain.unavailableCount > 0) {
    return locale === "ar" ? `${chain.unavailableCount} مسار غير متاح` : `${chain.unavailableCount} route(s) unavailable`;
  }
  return firstOrReady(diagnostic.warnings, locale);
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
  if (
    input.activeProfileMissing ||
    input.selectedProfileConfigMissing ||
    input.missingProfileEnv.length > 0 ||
    input.configHygiene.warnings.length > 0
  ) return "warning";
  return "healthy";
}

function configSummary(input: BuildDoctorReportInput): string | undefined {
  if (input.configSyntaxError !== undefined) return `Config syntax error: ${input.configSyntaxError}`;
  if (input.selectedProfileConfigMissing) return "selected profile config missing";
  if (input.activeProfileMissing) return "active profile missing";
  if (input.configHygiene.staleRootKeys.length > 0) return "stale config keys";
  if (input.configHygiene.circularFallbacks.length > 0) return "circular fallback route";
  if (input.configHygiene.missingSections.length > 0) return "missing recommended sections";
  if (input.missingProfileEnv.length > 0) return "missing env values";
  return undefined;
}

function stateSeverity(input: BuildDoctorReportInput): DoctorCheckSeverity {
  return input.directoryDiagnostic.warnings.length > 0 ? "warning" : "healthy";
}

function stateSummary(input: BuildDoctorReportInput): string | undefined {
  if (input.directoryDiagnostic.privateFileModeIssues.length > 0) return "private files are too permissive";
  if (input.directoryDiagnostic.missingProfilePaths.length > 0) return "profile state incomplete";
  return undefined;
}

function sqliteSeverity(diagnostic: SQLiteHealthDiagnostic): DoctorCheckSeverity {
  if (diagnostic.status === "blocked") return "blocked";
  if (diagnostic.status === "warning") return "warning";
  return "healthy";
}

function sqliteSummary(diagnostic: SQLiteHealthDiagnostic, locale: DoctorLocale): string {
  if (diagnostic.status === "not-initialized") {
    return locale === "ar" ? "غير مهيأ" : "not initialized";
  }
  if (diagnostic.status === "blocked") {
    if (!diagnostic.schemaValid) return locale === "ar" ? "المخطط غير صالح" : "schema invalid";
    if (!diagnostic.ftsHealthy) return locale === "ar" ? "فهرس FTS غير متاح" : "FTS unavailable";
  }
  if (!diagnostic.schemaValid) return locale === "ar" ? "انحراف في المخطط" : "schema drift";
  const count = diagnostic.sessionsCount ?? 0;
  return locale === "ar" ? `${count} جلسات` : `${count} sessions`;
}

function oauthSummary(diagnostic: OAuthStatusDiagnostic, locale: DoctorLocale): string {
  const expiredCount = diagnostic.providerStatuses.filter((provider) => provider.status === "expired").length;
  if (diagnostic.warnings.length > 0 && expiredCount > 0) {
    return locale === "ar" ? `${expiredCount} منتهية` : `${expiredCount} expired`;
  }
  const readyCount = diagnostic.providerStatuses.filter((provider) => provider.status === "ready").length;
  if (readyCount === 0) return locale === "ar" ? "لا توجد سجلات" : "no records";
  return locale === "ar" ? `${readyCount} جاهزة` : `${readyCount} ready`;
}

function mcpSummary(diagnostic: McpSecurityDiagnostic, locale: DoctorLocale): string {
  if (diagnostic.serverCount === 0) return locale === "ar" ? "لا توجد خوادم" : "no servers";
  if (diagnostic.warnings.length > 0) {
    return locale === "ar" ? `${diagnostic.warnings.length} تحذيرات` : `${diagnostic.warnings.length} warning(s)`;
  }
  return locale === "ar" ? `${diagnostic.enabledCount}/${diagnostic.serverCount} مفعلة` : `${diagnostic.enabledCount}/${diagnostic.serverCount} enabled`;
}

function externalToolsSummary(diagnostic: ExternalToolDiagnostic, locale: DoctorLocale): string {
  if (diagnostic.missingRequired.length > 0) {
    return locale === "ar" ? `${diagnostic.missingRequired.length} مفقودة` : `${diagnostic.missingRequired.length} missing`;
  }
  return locale === "ar" ? `${diagnostic.available.length} متاحة` : `${diagnostic.available.length} available`;
}

function dependencyAuditSeverity(diagnostic: NpmAuditDiagnostic): DoctorCheckSeverity {
  if (diagnostic.status === "not-run") return "info";
  if (diagnostic.status === "warning") return "warning";
  return "healthy";
}

function dependencyAuditSummary(diagnostic: NpmAuditDiagnostic, locale: DoctorLocale): string {
  if (diagnostic.status === "not-run") {
    return locale === "ar" ? "لم يتم تشغيل الفحص" : "audit not run";
  }
  if (diagnostic.timedOut) {
    return locale === "ar" ? "انتهت مهلة الفحص" : "audit timed out";
  }
  if (diagnostic.totalVulnerabilities === 0) {
    return locale === "ar" ? "لا توجد ثغرات" : "0 advisories";
  }
  const highCount = diagnostic.severityCounts.critical + diagnostic.severityCounts.high;
  if (highCount > 0) {
    return locale === "ar" ? `${highCount} عالية/حرجة` : `${highCount} high/critical`;
  }
  return locale === "ar"
    ? `${diagnostic.totalVulnerabilities} تنبيهات`
    : `${diagnostic.totalVulnerabilities} advisories`;
}

function memorySeverity(diagnostic: MemoryHealthDiagnostic): DoctorCheckSeverity {
  if (diagnostic.status === "blocked") return "blocked";
  if (diagnostic.status === "warning") return "warning";
  return "healthy";
}

function memorySummary(diagnostic: MemoryHealthDiagnostic, locale: DoctorLocale): string {
  if (diagnostic.problemFiles.length > 0) {
    return locale === "ar"
      ? `${diagnostic.problemFiles.length} مشاكل في ملفات الذاكرة`
      : `${diagnostic.problemFiles.length} memory file issue(s)`;
  }
  return locale === "ar" ? "ملفات الذاكرة جاهزة" : "file profile ready";
}

function providerSeverity(diagnostic: ProviderDiagnostic, chain: ProviderChainDiagnostic): DoctorCheckSeverity {
  if (diagnostic.status === "blocked") return "blocked";
  if (chain.routes.some((route) => route.kind === "primary" && route.status === "blocked")) return "blocked";
  if (diagnostic.status === "warning" || chain.unavailableCount > 0) return "warning";
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
  return /Config syntax error|Provider setup is incomplete|Provider route primary is unavailable|not writable|blocked|SQLite session DB (?:could not be opened|schema is missing required|FTS index is unavailable|path is not a file)/iu.test(warning)
    ? "blocked"
    : "warning";
}

function warningDetailLines(warning: string, locale: DoctorLocale): readonly string[] | undefined {
  const missingEnv = /missing required values: (.+)$/iu.exec(warning)?.[1];
  if (missingEnv !== undefined) {
    return [locale === "ar" ? `المتغيرات: ${missingEnv}` : `Env: ${missingEnv}`];
  }
  const mcpServer = /^MCP server ([^ ]+) /iu.exec(warning)?.[1];
  if (mcpServer !== undefined) {
    return [locale === "ar" ? `الخادم: ${mcpServer}` : `Server: ${mcpServer}`];
  }
  return undefined;
}

function warningCommand(warning: string): string | undefined {
  if (/Config syntax error/iu.test(warning)) return "estacoda setup --interactive";
  if (/OAuth credentials are expired/iu.test(warning)) return "estacoda model setup";
  if (/Provider route .*(?:missing (?:env var|apiKeyEnv|OAuth credentials)|OAuth credentials expired|provider setup incomplete)/iu.test(warning)) return "estacoda model setup";
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
  if (/Selected profile .* is missing or invalid/iu.test(warning)) return "حالة الملف الشخصي غير مكتملة";
  if (/Selected profile .* is not private/iu.test(warning)) return "ملف خاص في الملف الشخصي أذوناته واسعة";
  if (/auth\.json/iu.test(warning)) return "ملف OAuth غير صالح";
  if (/OAuth credentials are expired/iu.test(warning)) return "اعتمادات OAuth منتهية";
  if (/Provider route .*unavailable/iu.test(warning)) return "مسار مزوّد غير متاح";
  if (/MCP server .* shell wrapper/iu.test(warning)) return "خادم MCP يستخدم غلاف shell";
  if (/MCP server .* shell execution flags/iu.test(warning)) return "خادم MCP يمرر أعلام تنفيذ shell";
  if (/MCP server .* secret-looking env keys/iu.test(warning)) return "خادم MCP يمرر أسماء متغيرات تبدو سرية";
  if (/MCP server .* broad tool exposure/iu.test(warning)) return "خادم MCP يعرّض أدوات بشكل واسع";
  if (/MCP server .* network MCP trust/iu.test(warning)) return "خادم MCP يستخدم ثقة شبكة";
  if (/MCP server .* invalid HTTP URL/iu.test(warning)) return "خادم MCP لديه رابط HTTP غير صالح";
  if (/MCP server .* explicit resource risk class/iu.test(warning)) return "خادم MCP يعرّض موارد دون فئة مخاطر";
  if (/MCP server .* explicit prompt risk class/iu.test(warning)) return "خادم MCP يعرّض مطالبات دون فئة مخاطر";
  if (/Required external tools are missing/iu.test(warning)) return "أدوات خارجية مطلوبة غير موجودة";
  if (/Dependency audit found/iu.test(warning)) return "فحص الاعتماديات وجد تنبيهات أمنية";
  if (/Dependency audit timed out/iu.test(warning)) return "انتهت مهلة فحص الاعتماديات";
  if (/Dependency audit could not run because pnpm was not found/iu.test(warning)) return "تعذر تشغيل فحص الاعتماديات لأن pnpm غير موجود";
  if (/Dependency audit output could not be parsed/iu.test(warning)) return "تعذر قراءة ناتج فحص الاعتماديات";
  if (/Dependency audit could not run/iu.test(warning)) return "تعذر تشغيل فحص الاعتماديات";
  if (/Memory profile root is missing or invalid/iu.test(warning)) return "جذر ذاكرة الملف الشخصي غير موجود أو غير صالح";
  if (/Memory file .* is not usable/iu.test(warning)) return "ملف ذاكرة غير قابل للاستخدام";
  if (/SQLite session DB schema is missing required tables/iu.test(warning)) return "قاعدة بيانات الجلسات تنقصها جداول مطلوبة";
  if (/SQLite session DB schema is missing auxiliary tables/iu.test(warning)) return "قاعدة بيانات الجلسات تنقصها جداول إضافية";
  if (/SQLite session DB schema is missing required columns/iu.test(warning)) return "قاعدة بيانات الجلسات تنقصها أعمدة مطلوبة";
  if (/SQLite session DB schema is missing auxiliary columns/iu.test(warning)) return "قاعدة بيانات الجلسات تنقصها أعمدة إضافية";
  if (/SQLite session DB FTS index is unavailable/iu.test(warning)) return "فهرس بحث قاعدة بيانات الجلسات غير متاح";
  if (/SQLite session DB WAL is large/iu.test(warning)) return "ملف WAL لقاعدة بيانات الجلسات كبير";
  if (/SQLite session DB could not be opened/iu.test(warning)) return "تعذر فتح قاعدة بيانات الجلسات";
  if (/SQLite session DB path is not a file/iu.test(warning)) return "مسار قاعدة بيانات الجلسات ليس ملفًا";
  if (/Profile config has stale root keys/iu.test(warning)) return "إعدادات الملف الشخصي تحتوي مفاتيح قديمة";
  if (/Profile config is missing recommended sections/iu.test(warning)) return "إعدادات الملف الشخصي تنقصها أقسام موصى بها";
  if (/Profile config fallback repeats/iu.test(warning)) return "مسار احتياطي يكرر النموذج الأساسي";
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
  | "state"
  | "configuration"
  | "providers"
  | "oauth"
  | "models"
  | "capabilities"
  | "mcp"
  | "externalTools"
  | "dependencies"
  | "memory"
  | "sessions"
  | "skills"
  | "security"
  | "liveProvider"
  | "liveTools"
  | "checks";

const DOCTOR_LABELS: Record<DoctorLabelKey, Record<DoctorLocale, string>> = {
  runtime: { en: "Runtime", ar: "وقت التشغيل" },
  installation: { en: "Installation", ar: "التثبيت" },
  state: { en: "State", ar: "الحالة" },
  configuration: { en: "Configuration", ar: "الإعدادات" },
  providers: { en: "Providers", ar: "المزوّدون" },
  oauth: { en: "OAuth", ar: "OAuth" },
  models: { en: "Models", ar: "النماذج" },
  capabilities: { en: "Capabilities", ar: "القدرات" },
  mcp: { en: "MCP", ar: "MCP" },
  externalTools: { en: "External tools", ar: "الأدوات الخارجية" },
  dependencies: { en: "Dependencies", ar: "الاعتماديات" },
  memory: { en: "Memory", ar: "الذاكرة" },
  sessions: { en: "Sessions", ar: "الجلسات" },
  skills: { en: "Skills", ar: "المهارات" },
  security: { en: "Security", ar: "الأمان" },
  liveProvider: { en: "Live provider", ar: "المزوّد الحي" },
  liveTools: { en: "Live tools", ar: "الأدوات الحية" },
  checks: { en: "Checks", ar: "الفحوصات" }
};

function readActiveProfileForDoctor(options: Pick<CliOptions, "homeDir">): {
  readonly profileId: string;
  readonly warnings: readonly string[];
} {
  try {
    return {
      profileId: readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId(),
      warnings: []
    };
  } catch (error) {
    return {
      profileId: defaultProfileId(),
      warnings: [`Active profile state is invalid: ${errorMessage(error)}`]
    };
  }
}

async function collectDoctorSetupEntryState(
  options: CliOptions & { profileId: string },
  selectedProfile: string
): Promise<{ readonly setupState: SetupEntryState; readonly warnings: readonly string[] }> {
  try {
    return {
      setupState: await collectSetupEntryState({ ...options, readOnly: true }),
      warnings: []
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      setupState: fallbackSetupEntryState(options, selectedProfile, message),
      warnings: [`Setup state could not be fully collected: ${message}`]
    };
  }
}

function fallbackSetupEntryState(
  options: Pick<CliOptions, "homeDir" | "workspaceRoot">,
  selectedProfile: string,
  message: string
): SetupEntryState {
  const providerDiagnostic: ProviderDiagnostic = {
    status: "blocked",
    lines: ["Provider check skipped because setup state could not load."],
    warnings: [message]
  };
  return {
    kind: "broken-config",
    recommendedAction: "repair-config",
    configSources: [],
    configPaths: {
      profile: resolveProfileStateHome({ homeDir: options.homeDir, profileId: selectedProfile }).configPath
    },
    providerReadiness: "unknown",
    workspaceTrust: "unknown",
    workspaceVerification: "unknown",
    stateDirectoryWritable: false,
    missingCredentials: { envVars: [], providers: [] },
    setupVerification: {
      stateWritable: false,
      envFilePresent: false,
      envFileSecure: true,
      workspaceTrusted: false,
      securityModeLabel: "Unknown",
      securityModeValue: "unknown",
      skillAutonomyLabel: "Unknown",
      skillAutonomyValue: "unknown",
      providerDiagnostic,
      toolStatus: "skipped",
      configSources: [],
      warnings: [message],
      issueCodes: ["doctor-setup-state-invalid"]
    },
    warnings: [message],
    blockers: [message],
    error: message
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function doctorConsoleStyle(): OperatorConsoleStyle {
  const capabilities = detectTerminalCapabilities();
  return createOperatorConsoleStyle({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    capabilities
  });
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

async function detectDoctorLocale(options: CliOptions): Promise<DoctorLocale> {
  try {
    const config = await loadRuntimeConfig(options);
    return config.ui.language === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}
