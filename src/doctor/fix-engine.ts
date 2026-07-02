import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapStateDirectories, DEFAULT_STATE_DIRS } from "../cli/init-command.js";
import {
  ensureDefaultProfileState,
  ensureProfileSkeleton
} from "../cli/profile-state.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { resolveHomeDir } from "../config/home-dir.js";
import type { DoctorLocale } from "./types.js";

export type DoctorFixOperationKind = "create-directory" | "create-file" | "chmod-private-file";

export type DoctorFixOperation = {
  readonly id: string;
  readonly kind: DoctorFixOperationKind;
  readonly path: string;
  readonly mode?: number;
};

export type DoctorFixResult = {
  readonly locale: DoctorLocale;
  readonly profile: string;
  readonly home: string;
  readonly operations: readonly DoctorFixOperation[];
  readonly notChanged: readonly string[];
  readonly warnings: readonly string[];
};

const PRIVATE_FILE_MODE = 0o600;
const PROFILE_DIRECTORY_KEYS = [
  "profileRoot",
  "skillsPath",
  "cronPath",
  "logsPath",
  "gatewayStatePath",
  "channelMediaPath",
  "audioCachePath",
  "imageCachePath",
  "tempPath"
] as const;
const PROFILE_FILE_KEYS = [
  "configPath",
  "envPath",
  "authJsonPath",
  "userMdPath",
  "soulMdPath",
  "memoryMdPath",
  "promotionsPath"
] as const;
const PRIVATE_PROFILE_FILE_KEYS = ["envPath", "authJsonPath"] as const;

export async function runDoctorFix(options: {
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly locale?: DoctorLocale;
}): Promise<DoctorFixResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const activeProfile = readActiveProfileForFix({ homeDir: options.homeDir });
  const profileId = options.profileId ?? activeProfile.profileId;
  const plan = await planDoctorFix({ homeDir: options.homeDir, profileId });

  await bootstrapStateDirectories(homeDir);
  if (activeProfile.valid) {
    await ensureDefaultProfileState({ homeDir: options.homeDir, profileId });
  } else {
    await ensureProfileSkeleton({
      homeDir: options.homeDir,
      profileId,
      sourceProfileId: profileId,
      blank: true
    });
  }
  for (const privatePath of privateProfilePaths({ homeDir: options.homeDir, profileId })) {
    await chmod(privatePath, PRIVATE_FILE_MODE).catch(() => undefined);
  }

  return {
    locale: options.locale ?? "en",
    profile: profileId,
    home: resolveGlobalStateHome({ homeDir: options.homeDir }).stateRoot,
    operations: plan.operations,
    notChanged: [
      "Workspace trust requires explicit user approval",
      "Provider credentials were not created",
      "Network providers were not enabled",
      "Config migrations were not applied"
    ],
    warnings: activeProfile.valid ? [] : activeProfile.warnings
  };
}

export async function planDoctorFix(options: {
  readonly homeDir?: string;
  readonly profileId?: string;
}): Promise<{ readonly operations: readonly DoctorFixOperation[] }> {
  const activeProfile = readActiveProfileForFix({ homeDir: options.homeDir });
  const profileId = options.profileId ?? activeProfile.profileId;
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const operations: DoctorFixOperation[] = [];

  for (const dir of DEFAULT_STATE_DIRS) {
    const path = join(globalPaths.stateRoot, dir);
    if (!await isDirectory(path)) {
      operations.push({ id: `create-dir:${path}`, kind: "create-directory", path });
    }
  }
  if (!await pathExists(globalPaths.activeProfilePath)) {
    operations.push({
      id: `create-file:${globalPaths.activeProfilePath}`,
      kind: "create-file",
      path: globalPaths.activeProfilePath
    });
  }
  await appendProfileSkeletonOperations(operations, { homeDir: options.homeDir, profileId });
  if (activeProfile.valid && profileId !== defaultProfileId()) {
    await appendProfileSkeletonOperations(operations, { homeDir: options.homeDir, profileId: defaultProfileId() });
  }

  return { operations };
}

async function appendProfileSkeletonOperations(
  operations: DoctorFixOperation[],
  options: { readonly homeDir?: string; readonly profileId: string }
): Promise<void> {
  const profilePaths = resolveProfileStateHome(options);

  for (const key of PROFILE_DIRECTORY_KEYS) {
    const path = profilePaths[key];
    if (!await isDirectory(path)) {
      operations.push({ id: `create-dir:${path}`, kind: "create-directory", path });
    }
  }
  for (const key of PROFILE_FILE_KEYS) {
    const path = profilePaths[key];
    if (!await isFile(path)) {
      operations.push({ id: `create-file:${path}`, kind: "create-file", path });
    }
  }
  for (const path of privateProfilePaths({ homeDir: options.homeDir, profileId: options.profileId })) {
    const mode = await fileMode(path);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      operations.push({
        id: `chmod-private-file:${path}`,
        kind: "chmod-private-file",
        path,
        mode: PRIVATE_FILE_MODE
      });
    }
  }
}

function privateProfilePaths(options: { readonly homeDir?: string; readonly profileId: string }): readonly string[] {
  const profilePaths = resolveProfileStateHome(options);
  return PRIVATE_PROFILE_FILE_KEYS.map((key) => profilePaths[key]);
}

function readActiveProfileForFix(options: { readonly homeDir?: string }): {
  readonly valid: boolean;
  readonly profileId: string;
  readonly warnings: readonly string[];
} {
  try {
    return {
      valid: true,
      profileId: readActiveProfile(options).profileId ?? defaultProfileId(),
      warnings: []
    };
  } catch (error) {
    return {
      valid: false,
      profileId: defaultProfileId(),
      warnings: [`Active profile state was not changed because it is invalid: ${errorMessage(error)}`]
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
