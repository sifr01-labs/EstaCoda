import {
  checkForUpdate,
  prepareUpdateInfo,
  canApplyUpdate,
  applyUpdate,
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

export type UpdateOptions = {
  check?: boolean;
  dryRun: boolean;
  apply: boolean;
  homeDir?: string;
  installMethodInfo?: InstallMethodInfo;
  detectInstallMethod?: () => Promise<InstallMethodInfo>;
  checkForUpdate?: () => Promise<UpdateCheckResult>;
  checkGitUpdate?: (info: InstallMethodInfo, options: { mutateRemoteRefs: boolean }) => Promise<GitUpdateResolverResult>;
  canApplyUpdate?: typeof canApplyUpdate;
  applyUpdate?: typeof applyUpdate;
};

export type UpdateResult = {
  exitCode: number;
  output: string;
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
    if (options.apply) {
      return {
        exitCode: 1,
        output: [
          "Detected install method: managed-source",
          `Reason: ${installMethod.reason}`,
          "",
          "Managed source update apply is planned for PR-I5 and is not active in this build.",
          "No files were modified."
        ].join("\n")
      };
    }

    return await runSourceUpdateCheck(installMethod, options, true);
  }

  if (installMethod.method === "manual-source") {
    if (options.apply) {
      return {
        exitCode: 1,
        output: renderInstallMethodRouting(installMethod, "apply")
      };
    }

    if (!options.check) {
      return {
        exitCode: 0,
        output: renderInstallMethodRouting(installMethod, "dry-run")
      };
    }

    return await runSourceUpdateCheck(installMethod, options, false);
  }

  if (!installMethod.canSelfUpdate) {
    return {
      exitCode: options.apply ? 1 : 0,
      output: renderInstallMethodRouting(installMethod, options.apply ? "apply" : options.check ? "check" : "dry-run")
    };
  }

  const check = await (options.checkForUpdate ?? (() => checkForUpdate({ homeDir })))();

  if (check.kind === "error") {
    return {
      exitCode: 1,
      output: `Update check failed: ${check.message}`
    };
  }

  if (check.kind === "up-to-date") {
    return {
      exitCode: 2,
      output: `You are on the latest version (${check.current}).`
    };
  }

  const info = check.info;
  const summary = prepareUpdateInfo(info);

  if (!options.apply) {
    return {
      exitCode: 0,
      output: [
        summary,
        "",
        "This was a dry run. No files were modified."
      ].join("\n")
    };
  }

  const test = (options.canApplyUpdate ?? canApplyUpdate)();

  if (!test.testable) {
    return {
      exitCode: 1,
      output: [
        summary,
        "",
        `Cannot apply update: ${test.reason}`
      ].join("\n")
    };
  }

  const artifactPath = process.env.ESTACODA_UPDATE_ARTIFACT!;
  const result = await (options.applyUpdate ?? applyUpdate)({ artifactPath, homeDir });

  return {
    exitCode: result.kind === "success" ? 0 : 1,
    output: [
      summary,
      "",
      result.message
    ].join("\n")
  };
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
