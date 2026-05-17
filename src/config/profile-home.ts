import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ProfileId = string;

export type GlobalStatePaths = {
  homeDir: string;
  stateRoot: string;
  profilesRoot: string;
  activeProfilePath: string;
  trustJsonPath: string;
  workspaceApprovalsPath: string;
  sessionsSqlitePath: string;
  sharedMemoryPath: string;
  binPath: string;
  packsPath: string;
};

export type ProfileStatePaths = {
  profileId: string;
  profileRoot: string;
  configPath: string;
  envPath: string;
  authJsonPath: string;
  soulMdPath: string;
  memoryMdPath: string;
  userMdPath: string;
  promotionsPath: string;
  skillsPath: string;
  logsPath: string;
  channelMediaPath: string;
  audioCachePath: string;
  imageCachePath: string;
  gatewayStatePath: string;
  tempPath: string;
  cronPath: string;
};

export type ActiveProfileRecord = {
  profileId: string;
  lastSwitchedAt?: string;
  previousProfileId?: string | null;
};

export function resolveGlobalStateHome(options?: { homeDir?: string }): GlobalStatePaths {
  const homeDir = resolveHomeDir(options?.homeDir);
  const stateRoot = join(homeDir, ".estacoda");
  return {
    homeDir,
    stateRoot,
    profilesRoot: join(stateRoot, "profiles"),
    activeProfilePath: join(stateRoot, "active-profile.json"),
    trustJsonPath: join(stateRoot, "trust.json"),
    workspaceApprovalsPath: join(stateRoot, "workspace-approvals.json"),
    sessionsSqlitePath: join(stateRoot, "sessions.sqlite"),
    sharedMemoryPath: join(stateRoot, "memory", "shared"),
    binPath: join(stateRoot, "bin"),
    packsPath: join(stateRoot, "packs")
  };
}

export function resolveProfileStateHome(options: { homeDir?: string; profileId: string }): ProfileStatePaths {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const profileId = normalizeProfileId(options.profileId);
  const profileRoot = join(globalPaths.profilesRoot, profileId);
  return {
    profileId,
    profileRoot,
    configPath: join(profileRoot, "config.json"),
    envPath: join(profileRoot, ".env"),
    authJsonPath: join(profileRoot, "auth.json"),
    soulMdPath: join(profileRoot, "SOUL.md"),
    memoryMdPath: join(profileRoot, "MEMORY.md"),
    userMdPath: join(profileRoot, "USER.md"),
    promotionsPath: join(profileRoot, "promotions.json"),
    skillsPath: join(profileRoot, "skills"),
    logsPath: join(profileRoot, "logs"),
    channelMediaPath: join(profileRoot, "channel-media"),
    audioCachePath: join(profileRoot, "audio-cache"),
    imageCachePath: join(profileRoot, "image-cache"),
    gatewayStatePath: join(profileRoot, "gateway"),
    tempPath: join(profileRoot, "temp"),
    cronPath: join(profileRoot, "cron")
  };
}

export function normalizeProfileId(value: string): ProfileId {
  const profileId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profileId) || profileId === "." || profileId === "..") {
    throw new Error(`Invalid profile id: ${value}`);
  }
  return profileId;
}

export function defaultProfileId(): ProfileId {
  return "default";
}

export function readActiveProfile(options?: { homeDir?: string }): ActiveProfileRecord {
  const globalPaths = resolveGlobalStateHome(options);
  let content: string;
  try {
    content = readFileSyncUtf8(globalPaths.activeProfilePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { profileId: defaultProfileId(), previousProfileId: null };
    }
    throw error;
  }

  const parsed = parseJsonObject(content, globalPaths.activeProfilePath);
  if (typeof parsed.profileId !== "string") {
    throw new Error(`Invalid active profile file: ${globalPaths.activeProfilePath}`);
  }
  const profileId = normalizeProfileId(parsed.profileId);
  const result: ActiveProfileRecord = { profileId };

  if (typeof parsed.lastSwitchedAt === "string") {
    result.lastSwitchedAt = parsed.lastSwitchedAt;
  }
  if (parsed.previousProfileId === null) {
    result.previousProfileId = null;
  } else if (typeof parsed.previousProfileId === "string") {
    result.previousProfileId = normalizeProfileId(parsed.previousProfileId);
  }

  return result;
}

export function writeActiveProfile(profileId: string, options?: { homeDir?: string }): void {
  const normalizedProfileId = normalizeProfileId(profileId);
  const globalPaths = resolveGlobalStateHome(options);
  const previous = readPreviousActiveProfile(globalPaths.activeProfilePath);
  const record: Required<ActiveProfileRecord> = {
    profileId: normalizedProfileId,
    lastSwitchedAt: new Date().toISOString(),
    previousProfileId: previous?.profileId !== undefined && previous.profileId !== normalizedProfileId
      ? previous.profileId
      : null
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = `${globalPaths.activeProfilePath}.${process.pid}.${Date.now()}.tmp`;

  mkdirSync(dirname(globalPaths.activeProfilePath), { recursive: true });
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, globalPaths.activeProfilePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only; the active profile file is replaced by rename.
    }
    throw error;
  }
}

function resolveHomeDir(homeDir: string | undefined): string {
  return homeDir ?? process.env.HOME ?? homedir() ?? "";
}

function readPreviousActiveProfile(activeProfilePath: string): ActiveProfileRecord | undefined {
  let content: string;
  try {
    content = readFileSyncUtf8(activeProfilePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  const parsed = parseJsonObject(content, activeProfilePath);
  if (typeof parsed.profileId !== "string") {
    throw new Error(`Invalid active profile file: ${activeProfilePath}`);
  }
  return { profileId: normalizeProfileId(parsed.profileId) };
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function parseJsonObject(content: string, path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid active profile file: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
