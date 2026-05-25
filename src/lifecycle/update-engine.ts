import { mkdir, writeFile, rm, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  resolveLatestVersion,
  compareVersions,
  type VersionInfo,
  type VersionResolverResult
} from "./version-resolver.js";
import { backupState, getProtectedPaths } from "./state-preservation.js";

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

async function writeUpdateCache(homeDir: string, status: "up-to-date" | "update-available"): Promise<void> {
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
      await writeUpdateCache(homeDir, "up-to-date").catch(() => {});
    }
    return { kind: "up-to-date", current: info.current };
  }

  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  if (homeDir.length > 0) {
    await writeUpdateCache(homeDir, "update-available").catch(() => {});
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
