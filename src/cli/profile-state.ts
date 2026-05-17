import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultProfileId,
  normalizeProfileId,
  readActiveProfile,
  resolveGlobalStateHome,
  resolveProfileStateHome,
  writeActiveProfile,
  type ProfileStatePaths
} from "../config/profile-home.js";
import type { EstaCodaConfig } from "../config/runtime-config.js";

export type ProfileMemoryFile = "user" | "memory" | "soul";

export const PROFILE_MEMORY_FILES: readonly ProfileMemoryFile[] = ["user", "memory", "soul"];

export type ProfileContextualizer = (input: {
  profileId: string;
  sourceProfileId: string;
  focus: string;
  user: string;
  memory: string;
  soul: string;
}) => Promise<string>;

export type CreateProfileSkeletonOptions = {
  homeDir?: string;
  profileId: string;
  sourceProfileId?: string;
  blank?: boolean;
  copyFiles?: readonly ProfileMemoryFile[];
  contextualize?: string;
  contextualizer?: ProfileContextualizer;
  failIfExists?: boolean;
};

export const DEFAULT_PROFILE_CONFIG: EstaCodaConfig = {
  model: {
    provider: "unconfigured",
    id: "unconfigured"
  },
  providers: {},
  skills: {
    autonomy: "suggest"
  },
  ui: {
    language: "en",
    flavor: "standard",
    activityLabels: "en"
  },
  security: {
    approvalMode: "strict"
  }
};

export async function ensureDefaultProfileState(options: {
  homeDir?: string;
  profileId?: string;
} = {}): Promise<ProfileStatePaths> {
  const profileId = normalizeProfileId(options.profileId ?? defaultProfileId());
  const defaultId = defaultProfileId();
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const profilePaths = await ensureProfileSkeleton({
    homeDir: options.homeDir,
    profileId,
    blank: true
  });
  if (profileId !== defaultId) {
    await ensureProfileSkeleton({
      homeDir: options.homeDir,
      profileId: defaultId,
      blank: true
    });
  }
  await mkdir(dirname(globalPaths.activeProfilePath), { recursive: true });
  if (!existsSync(globalPaths.activeProfilePath)) {
    writeActiveProfile(defaultId, { homeDir: options.homeDir });
  }
  return profilePaths;
}

export async function ensureProfileSkeleton(options: CreateProfileSkeletonOptions): Promise<ProfileStatePaths> {
  const profileId = normalizeProfileId(options.profileId);
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId });

  if (options.failIfExists === true && existsSync(profilePaths.profileRoot)) {
    throw new Error(`Profile already exists: ${profileId}`);
  }

  const sourceProfileId = normalizeProfileId(options.sourceProfileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId());
  const sourcePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: sourceProfileId });
  const copyFiles = options.blank === true ? [] : [...new Set(options.copyFiles ?? ["user", "memory"])];

  await createProfileDirectories(profilePaths);
  await writeFileIfAbsent(profilePaths.configPath, `${JSON.stringify(DEFAULT_PROFILE_CONFIG, null, 2)}\n`);
  await writePrivateFileIfAbsent(profilePaths.envPath, "");
  await writePrivateFileIfAbsent(profilePaths.authJsonPath, "{}\n");
  await writeFileIfAbsent(profilePaths.promotionsPath, `${JSON.stringify({ version: 1, records: [] }, null, 2)}\n`);

  const sourceMemory = {
    user: await readOptionalFile(sourcePaths.userMdPath),
    soul: await readOptionalFile(sourcePaths.soulMdPath),
    memory: await readOptionalFile(sourcePaths.memoryMdPath)
  };
  const memoryContents = {
    user: copyFiles.includes("user") ? sourceMemory.user : "",
    memory: copyFiles.includes("memory") ? sourceMemory.memory : "",
    soul: copyFiles.includes("soul") ? sourceMemory.soul : ""
  };

  if (options.contextualize !== undefined) {
    if (options.contextualizer === undefined) {
      throw new Error("Profile contextualization requires an available provider/model; no contextualizer was provided.");
    }
    memoryContents.soul = await options.contextualizer({
      profileId,
      sourceProfileId,
      focus: options.contextualize,
      user: memoryContents.user ?? "",
      memory: memoryContents.memory ?? "",
      soul: sourceMemory.soul ?? ""
    });
  }

  await writeFileIfAbsent(profilePaths.userMdPath, memoryContents.user ?? "");
  await writeFileIfAbsent(profilePaths.soulMdPath, memoryContents.soul ?? "");
  await writeFileIfAbsent(profilePaths.memoryMdPath, memoryContents.memory ?? "");

  return profilePaths;
}

export async function createProfileDirectories(profilePaths: ProfileStatePaths): Promise<void> {
  await mkdir(profilePaths.profileRoot, { recursive: true });
  await Promise.all([
    mkdir(profilePaths.skillsPath, { recursive: true }),
    mkdir(join(profilePaths.skillsPath, ".evolution"), { recursive: true }),
    mkdir(profilePaths.cronPath, { recursive: true }),
    mkdir(profilePaths.logsPath, { recursive: true }),
    mkdir(profilePaths.gatewayStatePath, { recursive: true }),
    mkdir(profilePaths.channelMediaPath, { recursive: true }),
    mkdir(profilePaths.audioCachePath, { recursive: true }),
    mkdir(profilePaths.imageCachePath, { recursive: true }),
    mkdir(profilePaths.tempPath, { recursive: true }),
    mkdir(profilePaths.profileRoot, { recursive: true })
  ]);
}

export function parseProfileMemoryFiles(value: string | undefined): readonly ProfileMemoryFile[] {
  if (value === undefined || value.trim().length === 0) {
    return ["user", "memory"];
  }
  const files = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const parsed = files.map((file) => {
    if (file !== "user" && file !== "memory" && file !== "soul") {
      throw new Error(`Invalid --files value: ${file}. Use user, memory, or soul.`);
    }
    return file;
  });
  return [...new Set(parsed)];
}

export async function profileExists(options: { homeDir?: string; profileId: string }): Promise<boolean> {
  try {
    const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
    const profileStat = await stat(profilePaths.profileRoot);
    return profileStat.isDirectory();
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function renameProfileDirectory(options: {
  homeDir?: string;
  oldProfileId: string;
  newProfileId: string;
}): Promise<{ oldPaths: ProfileStatePaths; newPaths: ProfileStatePaths }> {
  const oldPaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.oldProfileId });
  const newPaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.newProfileId });
  await rename(oldPaths.profileRoot, newPaths.profileRoot);
  return { oldPaths, newPaths };
}

export async function removeProfileDirectory(profilePaths: ProfileStatePaths): Promise<void> {
  await rm(profilePaths.profileRoot, { recursive: true, force: true });
}

async function writeFileIfAbsent(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
}

async function writePrivateFileIfAbsent(path: string, contents: string): Promise<void> {
  await writeFileIfAbsent(path, contents);
  await chmod(path, 0o600).catch(() => undefined);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
