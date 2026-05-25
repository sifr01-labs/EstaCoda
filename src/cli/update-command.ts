import {
  checkForUpdate,
  prepareUpdateInfo,
  canApplyUpdate,
  applyUpdate,
  applyManagedSourceUpdate,
  type UpdateApplyResult,
  type UpdateCheckResult
} from "../lifecycle/update-engine.js";
import {
  detectInstallMethod,
  type InstallMethodInfo
} from "../lifecycle/install-method.js";
import {
  resolveGitUpdateInfo,
  type GitUpdateResolverResult
} from "../lifecycle/version-resolver.js";
import {
  runManagedSourceUpdateWithResilience,
  type UpdateResilienceResult
} from "./update-resilience.js";
import {
  detectServiceManager,
  probeServiceState,
  restartService,
  type ServiceManagerState,
  type ServiceScope
} from "../gateway/service-manager.js";

export type UpdateOptions = {
  check?: boolean;
  dryRun: boolean;
  apply: boolean;
  explicitApply?: boolean;
  backupMode?: "default" | "force" | "skip";
  gatewayMode?: boolean;
  homeDir?: string;
  profileId?: string;
  workspaceRoot?: string;
  installMethodInfo?: InstallMethodInfo;
  detectInstallMethod?: () => Promise<InstallMethodInfo>;
  checkForUpdate?: () => Promise<UpdateCheckResult>;
  checkGitUpdate?: (info: InstallMethodInfo, options: { mutateRemoteRefs: boolean }) => Promise<GitUpdateResolverResult>;
  canApplyUpdate?: typeof canApplyUpdate;
  applyUpdate?: typeof applyUpdate;
  applyManagedSourceUpdate?: typeof applyManagedSourceUpdate;
  runUpdateWithResilience?: typeof runManagedSourceUpdateWithResilience;
  restartGatewayService?: (options: GatewayRestartHandoffOptions) => Promise<GatewayRestartHandoffResult>;
};

export type UpdateResult = {
  exitCode: number;
  output: string;
};

export type GatewayRestartHandoffOptions = {
  homeDir: string;
  profileId: string;
};

export type GatewayRestartHandoffResult = {
  message: string;
  restarted: boolean;
};

export async function runUpdateCommand(options: UpdateOptions): Promise<UpdateResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";

  if (homeDir.length === 0) {
    return {
      exitCode: 1,
      output: "Error: HOME is not set. Use --home <dir> or set the HOME environment variable."
    };
  }

  const installMethod = options.installMethodInfo ?? await (options.detectInstallMethod ?? (() => detectInstallMethod({
    includeCwd: false,
    entrypointPath: process.argv[1],
    moduleUrl: import.meta.url
  })))();

  if (installMethod.method === "managed-source") {
    if (options.check || options.dryRun) {
      return appendGatewayGuidance(await runSourceUpdateCheck(installMethod, options, true), options);
    }

    const resilience = await (options.runUpdateWithResilience ?? runManagedSourceUpdateWithResilience)({
      homeDir,
      installMethod,
      processLike: process,
      stdout: process.stdout,
      stderr: process.stderr,
      run: async () => {
        const result = await (options.applyManagedSourceUpdate ?? applyManagedSourceUpdate)({
          installMethod,
          homeDir,
          workspaceRoot: options.workspaceRoot,
          backupMode: options.backupMode ?? "default"
        });

        if (options.gatewayMode === true && result.kind === "success") {
          const handoff = await (options.restartGatewayService ?? restartManagedGatewayService)({
            homeDir,
            profileId: options.profileId ?? "default"
          });
          return {
            kind: "success",
            message: [result.message, "", handoff.message].join("\n")
          };
        }

        return result;
      }
    });
    const result = resilience.result;

    return {
      exitCode: result.kind === "success" ? 0 : result.message.includes("Exit code: 3") ? 3 : 1,
      output: renderManagedSourceApplyOutput(installMethod, result, resilience)
    };
  }

  if (installMethod.method === "manual-source") {
    if (options.apply) {
      return {
        exitCode: options.explicitApply ? 1 : 0,
        output: withGatewayRestartInstruction(renderInstallMethodRouting(installMethod, "apply"), options)
      };
    }

    if (!options.check) {
      return {
        exitCode: 0,
        output: withGatewayRestartInstruction(renderInstallMethodRouting(installMethod, "dry-run"), options)
      };
    }

    return appendGatewayGuidance(await runSourceUpdateCheck(installMethod, options, false), options);
  }

  if (!installMethod.canSelfUpdate) {
    return {
      exitCode: options.apply && options.explicitApply ? 1 : 0,
      output: withGatewayRestartInstruction(
        renderInstallMethodRouting(installMethod, options.apply ? "apply" : options.check ? "check" : "dry-run"),
        options
      )
    };
  }

  const check = await (options.checkForUpdate ?? (() => checkForUpdate({ homeDir })))();

  if (check.kind === "error") {
    return {
      exitCode: 1,
      output: withGatewayRestartInstruction(`Update check failed: ${check.message}`, options)
    };
  }

  if (check.kind === "up-to-date") {
    return {
      exitCode: 2,
      output: withGatewayRestartInstruction(`You are on the latest version (${check.current}).`, options)
    };
  }

  const info = check.info;
  const summary = prepareUpdateInfo(info);

  if (!options.apply) {
    return {
      exitCode: 0,
      output: withGatewayRestartInstruction([
        summary,
        "",
        "This was a dry run. No files were modified."
      ].join("\n"), options)
    };
  }

  const test = (options.canApplyUpdate ?? canApplyUpdate)();

  if (!test.testable) {
    return {
      exitCode: 1,
      output: withGatewayRestartInstruction([
        summary,
        "",
        `Cannot apply update: ${test.reason}`
      ].join("\n"), options)
    };
  }

  const artifactPath = process.env.ESTACODA_UPDATE_ARTIFACT!;
  const result = await (options.applyUpdate ?? applyUpdate)({ artifactPath, homeDir });

  return {
    exitCode: result.kind === "success" ? 0 : 1,
    output: withGatewayRestartInstruction([
      summary,
      "",
      result.message
    ].join("\n"), options)
  };
}

async function restartManagedGatewayService(
  options: GatewayRestartHandoffOptions
): Promise<GatewayRestartHandoffResult> {
  const detected = await detectManagedGatewayService(options);

  if (detected === undefined) {
    return {
      restarted: false,
      message: [
        "Gateway restart: no managed gateway service was detected.",
        "Restart the gateway manually with: estacoda gateway restart"
      ].join("\n")
    };
  }

  const restart = await restartService({
    homeDir: options.homeDir,
    profileId: options.profileId,
    system: detected.scope === "system"
  });

  if (!restart.ok) {
    return {
      restarted: false,
      message: [
        `Gateway restart failed for ${detected.scope} service ${detected.unitName ?? "(unknown service)"}.`,
        `Reason: ${restart.error}`,
        `Restart the gateway manually with: estacoda gateway restart${detected.scope === "system" ? " --system" : ""}`
      ].join("\n")
    };
  }

  return {
    restarted: true,
    message: `Gateway service restarted (${detected.scope} scope, profile: ${options.profileId}).`
  };
}

async function detectManagedGatewayService(options: GatewayRestartHandoffOptions): Promise<(ServiceManagerState & { scope: ServiceScope }) | undefined> {
  const userState = await probeServiceState({
    homeDir: options.homeDir,
    profileId: options.profileId,
    system: false
  });
  if (userState.installed && userState.scope !== undefined) {
    return userState as ServiceManagerState & { scope: ServiceScope };
  }

  if (detectServiceManager().startsWith("systemd")) {
    const systemState = await probeServiceState({
      homeDir: options.homeDir,
      profileId: options.profileId,
      system: true
    });
    if (systemState.installed && systemState.scope !== undefined) {
      return systemState as ServiceManagerState & { scope: ServiceScope };
    }
  }

  return undefined;
}

function appendGatewayGuidance(result: UpdateResult, options: UpdateOptions): UpdateResult {
  return {
    ...result,
    output: withGatewayRestartInstruction(result.output, options)
  };
}

function withGatewayRestartInstruction(output: string, options: UpdateOptions): string {
  if (options.gatewayMode !== true) {
    return output;
  }

  return [
    output,
    "",
    "Gateway mode: no gateway restart was attempted.",
    "After completing the update, restart the gateway with: estacoda gateway restart"
  ].join("\n");
}

function renderManagedSourceApplyOutput(
  installMethod: InstallMethodInfo,
  result: UpdateApplyResult,
  resilience: UpdateResilienceResult
): string {
  return [
    "Detected install method: managed-source",
    `Reason: ${installMethod.reason}`,
    "",
    result.message,
    resilience.logPath !== undefined ? `Update log: ${resilience.logPath}` : undefined,
    resilience.logPath === undefined && resilience.logFailure !== undefined
      ? `Update log unavailable: ${resilience.logFailure}`
      : undefined,
    resilience.sighupReceived ? "SIGHUP received during update; update continued where possible." : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

async function runSourceUpdateCheck(
  info: InstallMethodInfo,
  options: UpdateOptions,
  mutateRemoteRefs: boolean
): Promise<UpdateResult> {
  const checker = options.checkGitUpdate ?? defaultGitUpdateCheck;
  const result = await checker(info, { mutateRemoteRefs });

  if (!result.ok) {
    if (info.method === "manual-source") {
      return {
        exitCode: 0,
        output: renderInstallMethodRouting(info, options.check ? "check" : "dry-run")
      };
    }

    return {
      exitCode: 1,
      output: `Update check failed: ${result.error}`
    };
  }

  if (info.method === "manual-source") {
    return {
      exitCode: result.kind === "up-to-date" ? 2 : 0,
      output: renderManualSourceCheck(info, result)
    };
  }

  if (result.kind === "up-to-date") {
    return {
      exitCode: 2,
      output: "Already up to date."
    };
  }

  return {
    exitCode: 0,
    output: renderManagedSourceUpdateAvailable(info, result)
  };
}

function defaultGitUpdateCheck(info: InstallMethodInfo, options: { mutateRemoteRefs: boolean }): Promise<GitUpdateResolverResult> {
  return resolveGitUpdateInfo({
    repoDir: info.installDir ?? "",
    branch: info.expectedBranch ?? info.branch ?? "main",
    remote: info.sourceUrl ?? "origin",
    mutateRemoteRefs: options.mutateRemoteRefs
  });
}

function renderManagedSourceUpdateAvailable(info: InstallMethodInfo, result: Extract<GitUpdateResolverResult, { ok: true; kind: "available" }>): string {
  const target = renderGitTarget(result.info.remote, result.info.branch);
  const availability = result.info.commitsBehind === undefined
    ? `Update available on ${target}.`
    : `Update available: ${result.info.commitsBehind} commits behind ${target}.`;

  return [
    availability,
    `Run: ${info.recommendedUpdateCommand}`,
    "",
    "This was a check. No files were modified."
  ].join("\n");
}

function renderManualSourceCheck(info: InstallMethodInfo, result: Extract<GitUpdateResolverResult, { ok: true }>): string {
  const target = renderGitTarget(result.info.remote, result.info.branch);
  const status = result.kind === "up-to-date"
    ? "Already up to date."
    : result.info.commitsBehind === undefined
      ? `Update may be available on ${target}.`
      : `Update available: ${result.info.commitsBehind} commits behind ${target}.`;

  return [
    status,
    `Manual source checkout detected. Run: ${info.recommendedUpdateCommand}`,
    "EstaCoda will not mutate this checkout automatically.",
    "",
    "This was a check. No files were modified."
  ].join("\n");
}

function renderGitTarget(remote: string, branch: string): string {
  if (/^(https?:|git@|ssh:)/.test(remote)) {
    return `origin/${branch}`;
  }

  return `${remote}/${branch}`;
}

function renderInstallMethodRouting(info: InstallMethodInfo, mode: "check" | "dry-run" | "apply"): string {
  const heading = mode === "apply"
    ? "Update routing"
    : mode === "check"
      ? "Update check"
      : "Update routing (dry run)";
  const lines = [
    heading,
    `Detected install method: ${info.method}`,
    `Reason: ${info.reason}`,
    `Recommended update command: ${info.recommendedUpdateCommand}`
  ];

  if (info.installDir !== undefined) {
    lines.push(`Install directory: ${info.installDir}`);
  }

  lines.push(renderMethodAdvice(info));

  if (mode === "apply") {
    lines.push("", "No files were modified.");
  } else if (mode === "check") {
    lines.push("", "This was a check. No files were modified.");
  } else {
    lines.push("", "This was a dry run. No files were modified.");
  }

  return lines.join("\n");
}

function renderMethodAdvice(info: InstallMethodInfo): string {
  switch (info.method) {
    case "manual-source":
      return [
        `Manual source checkout detected. Run: ${info.recommendedUpdateCommand}`,
        "Manual source checkouts are not self-mutated by `estacoda update`.",
        "EstaCoda will not mutate this checkout automatically."
      ].join("\n");
    case "homebrew":
      return `Homebrew install detected. Run: ${info.recommendedUpdateCommand}`;
    case "docker":
      return `Docker/container install detected. Run: ${info.recommendedUpdateCommand}`;
    case "npm-global":
      return `npm global install detected. Run: ${info.recommendedUpdateCommand}`;
    case "pnpm-global":
      return `pnpm global install detected. Run: ${info.recommendedUpdateCommand}`;
    case "unknown":
      return `Unknown install method. Run: ${info.recommendedUpdateCommand}`;
    case "managed-source":
      return `Managed source install detected. Run: ${info.recommendedUpdateCommand}`;
  }
}
