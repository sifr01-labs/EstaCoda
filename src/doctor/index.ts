import { readFile, stat } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "../cli/cli.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { collectSetupEntryState } from "../setup/setup-entry-state.js";
import {
  diagnoseProviderConfig,
  diagnoseProviderLive,
  renderProviderDiagnostic,
  renderProviderLiveDiagnostic
} from "../config/provider-diagnostics.js";
import { isBackupReady } from "../lifecycle/state-preservation.js";
import { PackRegistry } from "../packs/pack-registry.js";
import { collectMissingProfileEnv } from "./checks/env-coverage.js";
import { diagnoseLiveToolCall, renderLiveToolDiagnostic } from "./checks/live-tool.js";

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

  if (!await pathExists(activeProfilePaths.profileRoot)) {
    warnings.push(`Active profile is missing: ${activeProfileId}`);
  }
  if (!await pathExists(selectedProfilePaths.configPath)) {
    warnings.push(`Selected profile config is missing: ${selectedProfilePaths.configPath}`);
  }
  if (!await trustStoreHealthy(stateHome.trustJsonPath)) {
    warnings.push(`Global trust store is not valid JSON: ${stateHome.trustJsonPath}`);
  }

  if (config !== undefined && config.model.contextWindowTokens > 0 && config.model.contextWindowTokens < 64_000) {
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

  if (config !== undefined) {
    const missingProfileEnv = collectMissingProfileEnv(config);
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
  if (spEntries.length === 0) {
    notes.push("pack registry: no packs installed");
  } else {
    notes.push(`pack registry: ${spEntries.length} installed`);
    const spErrors = await spRegistry.getErrors();
    const errorCount = spErrors.length;
    const disabledCount = spEntries.filter((e) => e.status === "disabled").length;
    if (errorCount > 0) {
      warnings.push(`${errorCount} pack(s) have status error`);
    }
    if (disabledCount > 0) {
      notes.push(`${disabledCount} pack(s) disabled`);
    }
  }

  return {
    handled: true,
    exitCode: warnings.length === 0 &&
      liveProviderDiagnostic?.status !== "blocked" &&
      liveToolDiagnostic?.status !== "blocked"
      ? 0
      : 1,
    output: [
      "EstaCoda doctor",
      `Profile: ${selectedProfile}`,
      `Profile config: ${selectedProfilePaths.configPath}`,
      `Profile secrets: ${selectedProfilePaths.envPath}`,
      `Global trust: ${stateHome.trustJsonPath}`,
      `Model: ${config === undefined ? "unknown/unknown" : `${config.model.provider}/${config.model.id}`}`,
      `Web extraction: ${config === undefined ? "unknown" : config.web.enableNetwork ? "enabled" : "disabled"}`,
      `Browser backend: ${config?.browser.backend ?? "unknown"}`,
      `Config sources: ${(config?.sources ?? setupState.configSources).join(", ") || "none"}`,
      "",
      renderProviderDiagnostic(providerDiagnostic),
      liveProviderDiagnostic === undefined ? undefined : "",
      liveProviderDiagnostic === undefined ? undefined : renderProviderLiveDiagnostic(liveProviderDiagnostic),
      liveToolDiagnostic === undefined ? undefined : "",
      liveToolDiagnostic === undefined ? undefined : renderLiveToolDiagnostic(liveToolDiagnostic),
      "",
      warnings.length === 0 ? "Status: ready" : `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
      notes.length === 0 ? undefined : `\nNotes:\n${notes.map((note) => `- ${note}`).join("\n")}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

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
