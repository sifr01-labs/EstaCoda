import { access, mkdir, writeFile, rm, rename, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  resolveLatestVersion,
  compareVersions,
  type VersionInfo,
  type VersionResolverResult,
  type GitCommandResult
} from "./version-resolver.js";
import { backupState, getProtectedPaths } from "./state-preservation.js";
import type { InstallMethodInfo } from "./install-method.js";

export type UpdateCheckResult =
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; info: VersionInfo }
  | { kind: "error"; message: string };

export type ArtifactTestResult = {
  testable: boolean;
  reason: string;
};

export type UpdateApplyResult =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export type SourceUpdateCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string }
) => Promise<GitCommandResult>;

export type ManagedSourceUpdateOptions = {
  installMethod: InstallMethodInfo;
  homeDir: string;
  commandRunner?: SourceUpdateCommandRunner;
  pathExists?: (path: string) => Promise<boolean>;
  writeCache?: (homeDir: string, status: "up-to-date" | "update-available") => Promise<void>;
};

type UpdateCacheEntry = {
  checkedAt: string;
  versionStatus: "up-to-date" | "update-available";
};

export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cachePath(homeDir: string): string {
  return join(homeDir, ".estacoda", "update-cache.json");
}

export async function readCachedUpdateStatus(homeDir: string): Promise<"up-to-date" | "update-available" | "unknown"> {
  try {
    const raw = await readFile(cachePath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as UpdateCacheEntry;
    const checkedAt = new Date(parsed.checkedAt).getTime();
    const now = Date.now();
    if (Number.isNaN(checkedAt) || now - checkedAt > UPDATE_CACHE_TTL_MS) {
      return "unknown";
    }
    if (parsed.versionStatus === "up-to-date" || parsed.versionStatus === "update-available") {
      return parsed.versionStatus;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function writeCachedUpdateStatus(homeDir: string, status: "up-to-date" | "update-available"): Promise<void> {
  const entry: UpdateCacheEntry = {
    checkedAt: new Date().toISOString(),
    versionStatus: status,
  };
  await mkdir(join(homeDir, ".estacoda"), { recursive: true });
  await writeFile(cachePath(homeDir), JSON.stringify(entry, null, 2) + "\n", "utf8");
}

export async function checkForUpdate(input?: typeof fetch | {
  fetchFn?: typeof fetch;
  homeDir?: string;
  resolveLatestVersion?: () => Promise<VersionResolverResult>;
}): Promise<UpdateCheckResult> {
  const options = typeof input === "function" ? { fetchFn: input } : input ?? {};
  const resolved = options.resolveLatestVersion !== undefined
    ? await options.resolveLatestVersion()
    : await resolveLatestVersion(options.fetchFn);

  if (!resolved.ok) {
    return { kind: "error", message: resolved.error };
  }

  const { info } = resolved;

  if (compareVersions(info.current, info.latest) >= 0) {
    const homeDir = options.homeDir ?? process.env.HOME ?? "";
    if (homeDir.length > 0) {
      await writeCachedUpdateStatus(homeDir, "up-to-date").catch(() => {});
    }
    return { kind: "up-to-date", current: info.current };
  }

  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  if (homeDir.length > 0) {
    await writeCachedUpdateStatus(homeDir, "update-available").catch(() => {});
  }
  return { kind: "available", info };
}

export function prepareUpdateInfo(info: VersionInfo): string {
  const lines = [
    "Update check",
    `Current: ${info.current}`,
    `Latest:  ${info.latest}`,
    info.breakingChanges ? "Warning: this release includes breaking changes." : undefined,
    `Release notes: ${info.releaseNotesUrl}`,
    "",
    "Protected state paths:",
    ...getProtectedPaths(process.env.HOME ?? "").map((p) => `  ${p.label}`),
    "",
    "Run with --apply to attempt installation."
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
}

export function canApplyUpdate(): ArtifactTestResult {
  const artifactPath = process.env.ESTACODA_UPDATE_ARTIFACT;

  if (artifactPath === undefined || artifactPath.length === 0) {
    return {
      testable: false,
      reason: "ESTACODA_UPDATE_ARTIFACT is not set. Define it to enable --apply."
    };
  }

  if (!existsSync(artifactPath)) {
    return {
      testable: false,
      reason: `Artifact path does not exist: ${artifactPath}`
    };
  }

  return {
    testable: true,
    reason: `Artifact path is valid: ${artifactPath}`
  };
}

export async function applyUpdate(options: {
  artifactPath: string;
  homeDir: string;
  workspaceRoot?: string;
}): Promise<UpdateApplyResult> {
  const tempDir = join(options.homeDir, ".estacoda", ".backups", `update-temp-${Date.now()}`);

  try {
    const backup = await backupState({
      homeDir: options.homeDir,
      workspaceRoot: options.workspaceRoot,
      label: `pre-update-${Date.now()}`
    });

    if (backup.backedUp.length === 0) {
      return {
        kind: "error",
        message: "Update aborted: state backup failed (no paths were backed up)."
      };
    }

    await mkdir(tempDir, { recursive: true });

    const destPath = join(options.homeDir, ".estacoda", "bin", "estacoda-new");
    await mkdir(join(options.homeDir, ".estacoda", "bin"), { recursive: true });

    const { copyFile } = await import("node:fs/promises");
    await copyFile(options.artifactPath, destPath);

    const finalPath = join(options.homeDir, ".estacoda", "bin", "estacoda");
    await rename(destPath, finalPath);

    return {
      kind: "success",
      message: [
        "Update applied.",
        `Backup: ${backup.backupPath}`,
        `Binary: ${finalPath}`,
        "Run `estacoda verify` to confirm the update."
      ].join("\n")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", message: `Update failed: ${message}` };
  } finally {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function applyManagedSourceUpdate(options: ManagedSourceUpdateOptions): Promise<UpdateApplyResult> {
  const info = options.installMethod;
  const runner = options.commandRunner ?? runCommand;
  const pathExists = options.pathExists ?? defaultPathExists;
  const writeCache = options.writeCache ?? writeCachedUpdateStatus;

  const validation = validateManagedSourceInfo(info);
  if (validation.kind === "error") {
    return { kind: "error", message: validation.message };
  }

  const { installDir, expectedBranch, sourceUrl } = validation;
  const gitDir = join(installDir, ".git");
  if (!await pathExists(gitDir)) {
    return {
      kind: "error",
      message: `Update refused: managed-source install directory is not a git repository: ${installDir}`
    };
  }

  const repoRoot = await runStep(runner, "resolve repository root", "git", ["rev-parse", "--show-toplevel"], installDir);
  if (!repoRoot.ok) return { kind: "error", message: repoRoot.message };

  if (resolve(repoRoot.result.stdout.trim()) !== resolve(installDir)) {
    return {
      kind: "error",
      message: [
        "Update refused: install method stamp does not match the current repository root.",
        `Stamp installDir: ${installDir}`,
        `Repository root: ${repoRoot.result.stdout.trim()}`
      ].join("\n")
    };
  }

  const origin = await runStep(runner, "resolve origin remote", "git", ["remote", "get-url", "origin"], installDir);
  if (!origin.ok) return { kind: "error", message: origin.message };

  const originUrl = origin.result.stdout.trim();
  if (normalizeSourceUrl(originUrl) !== normalizeSourceUrl(sourceUrl)) {
    return {
      kind: "error",
      message: [
        "Update refused: origin remote does not match the managed-source install stamp.",
        `Stamp sourceUrl: ${sourceUrl}`,
        `Origin remote: ${originUrl}`
      ].join("\n")
    };
  }

  const branch = await runStep(runner, "resolve current branch", "git", ["rev-parse", "--abbrev-ref", "HEAD"], installDir);
  if (!branch.ok) return { kind: "error", message: branch.message };

  const currentBranch = branch.result.stdout.trim();
  if (currentBranch !== expectedBranch) {
    return {
      kind: "error",
      message: [
        `Update refused: current branch is ${currentBranch || "(detached HEAD)"}, expected ${expectedBranch}.`,
        "EstaCoda will not switch branches automatically."
      ].join("\n")
    };
  }

  const status = await runStep(runner, "check worktree status", "git", ["status", "--porcelain"], installDir);
  if (!status.ok) return { kind: "error", message: status.message };

  if (status.result.stdout.trim().length > 0) {
    return {
      kind: "error",
      message: [
        "Update refused: managed-source worktree has uncommitted changes.",
        "Commit, stash, or discard local changes before running `estacoda update`.",
        "Exit code: 3"
      ].join("\n")
    };
  }

  const prePull = await runStep(runner, "capture current HEAD", "git", ["rev-parse", "HEAD"], installDir);
  if (!prePull.ok) return { kind: "error", message: prePull.message };
  const prePullSha = prePull.result.stdout.trim();
  if (!isLikelyGitObjectId(prePullSha)) {
    return { kind: "error", message: "Update refused: current HEAD did not resolve to a commit." };
  }

  const fetch = await runStep(runner, "fetch origin", "git", ["fetch", "origin"], installDir);
  if (!fetch.ok) return { kind: "error", message: fetch.message };

  const behind = await runStep(runner, `compute commits behind origin/${expectedBranch}`, "git", ["rev-list", "--count", `HEAD..origin/${expectedBranch}`], installDir);
  if (!behind.ok) return { kind: "error", message: behind.message };

  const commitsBehind = Number.parseInt(behind.result.stdout.trim(), 10);
  if (!Number.isFinite(commitsBehind)) {
    return {
      kind: "error",
      message: "Update refused: could not determine whether the managed-source checkout is behind origin."
    };
  }

  if (Number.isFinite(commitsBehind) && commitsBehind <= 0) {
    await writeCache(options.homeDir, "up-to-date").catch(() => {});
    return {
      kind: "success",
      message: [
        "Already up to date.",
        "No files were modified.",
        "Bundled skill sync: no-op for v0.1.0."
      ].join("\n")
    };
  }

  const pull = await runStep(runner, `pull origin ${expectedBranch}`, "git", ["pull", "--ff-only", "origin", expectedBranch], installDir);
  if (!pull.ok) {
    return await rollbackAfterMutation({
      runner,
      installDir,
      prePullSha,
      failure: pull.message,
      phase: "pull"
    });
  }

  const install = await runStep(runner, "install dependencies", "pnpm", ["install", "--frozen-lockfile"], installDir);
  if (!install.ok) {
    return await rollbackAfterMutation({
      runner,
      installDir,
      prePullSha,
      failure: install.message,
      phase: "dependency install"
    });
  }

  const build = await runStep(runner, "build dist", "pnpm", ["run", "build"], installDir);
  if (!build.ok) {
    return await rollbackAfterMutation({
      runner,
      installDir,
      prePullSha,
      failure: build.message,
      phase: "build"
    });
  }

  const version = await runStep(runner, "validate version command", "node", ["dist/index.js", "--version"], installDir);
  if (!version.ok) {
    return await rollbackAfterMutation({
      runner,
      installDir,
      prePullSha,
      failure: version.message,
      phase: "post-update validation"
    });
  }

  const help = await runStep(runner, "validate help command", "node", ["dist/index.js", "--help"], installDir);
  if (!help.ok) {
    return await rollbackAfterMutation({
      runner,
      installDir,
      prePullSha,
      failure: help.message,
      phase: "post-update validation"
    });
  }

  await writeCache(options.homeDir, "up-to-date").catch(() => {});

  return {
    kind: "success",
    message: [
      `Update applied: fast-forwarded ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} from origin/${expectedBranch}.`,
      "Validated: node dist/index.js --version",
      "Validated: node dist/index.js --help",
      "Bundled skill sync: no-op for v0.1.0.",
      "No profile-local skills were modified."
    ].join("\n")
  };
}

function validateManagedSourceInfo(info: InstallMethodInfo): { kind: "ok"; installDir: string; expectedBranch: string; sourceUrl: string } | { kind: "error"; message: string } {
  if (info.method !== "managed-source" || !info.canSelfUpdate) {
    return {
      kind: "error",
      message: `Update refused: install method ${info.method} is not managed by EstaCoda source updates.`
    };
  }

  if (info.source !== "stamp") {
    return {
      kind: "error",
      message: "Update refused: managed-source updates require a trusted .install-method.json stamp."
    };
  }

  const installDir = info.installDir?.trim();
  const expectedBranch = (info.expectedBranch ?? info.branch)?.trim();
  const sourceUrl = info.sourceUrl?.trim();

  if (installDir === undefined || installDir.length === 0) {
    return { kind: "error", message: "Update refused: managed-source stamp is missing installDir." };
  }

  if (sourceUrl === undefined || sourceUrl.length === 0) {
    return { kind: "error", message: "Update refused: managed-source stamp is missing sourceUrl." };
  }

  if (expectedBranch === undefined || expectedBranch.length === 0) {
    return { kind: "error", message: "Update refused: managed-source stamp is missing branch." };
  }

  return { kind: "ok", installDir: resolve(installDir), expectedBranch, sourceUrl };
}

async function rollbackAfterMutation(input: {
  runner: SourceUpdateCommandRunner;
  installDir: string;
  prePullSha: string;
  failure: string;
  phase: string;
}): Promise<UpdateApplyResult> {
  const rollback = await input.runner("git", ["reset", "--hard", input.prePullSha], { cwd: input.installDir });
  const rollbackMessage = rollback.exitCode === 0
    ? `Rolled back managed-source checkout to ${input.prePullSha}.`
    : `Rollback failed: ${formatCommandFailure("git reset --hard", rollback)}`;

  return {
    kind: "error",
    message: [
      `Update failed during ${input.phase}.`,
      input.failure,
      rollbackMessage,
      "Review the checkout before retrying `estacoda update`."
    ].join("\n")
  };
}

async function runStep(
  runner: SourceUpdateCommandRunner,
  label: string,
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ ok: true; result: GitCommandResult } | { ok: false; message: string }> {
  const result = await runner(command, args, { cwd });
  if (result.exitCode === 0) {
    return { ok: true, result };
  }

  return { ok: false, message: formatCommandFailure(label, result) };
}

function formatCommandFailure(label: string, result: GitCommandResult): string {
  const detail = redactCommandOutput(result.stderr.trim() || result.stdout.trim()) || `exit ${result.exitCode}`;
  return `Command failed during ${label}: ${detail}`;
}

function redactCommandOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+@)/gi, "$1[redacted]@")
    .replace(/(git@[^:\s]+:)[^\s]+/gi, "$1[redacted]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]+/g, "$1[redacted]")
    .slice(0, 500);
}

function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return normalizeGitHubSourceUrl(trimmed) ?? trimmed;
}

function normalizeGitHubSourceUrl(value: string): string | undefined {
  const scpLike = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(value);
  if (scpLike !== null) {
    return formatGitHubSourceKey(scpLike[1], scpLike[2]);
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }

    if (parsed.username !== "" && parsed.username !== "git") {
      return undefined;
    }

    if (parsed.password !== "") {
      return undefined;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
      return undefined;
    }

    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) {
      return undefined;
    }

    return formatGitHubSourceKey(parts[0], parts[1]);
  } catch {
    return undefined;
  }
}

function formatGitHubSourceKey(owner: string, repo: string): string {
  return `github.com/${owner.toLowerCase()}/${repo.replace(/\.git$/i, "").toLowerCase()}`;
}

function isLikelyGitObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: readonly string[], options: { cwd: string }): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    execFile(command, [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      const exitCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
        ? error.code
        : error === null
          ? 0
          : 1;

      resolveResult({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}
