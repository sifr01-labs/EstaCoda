import { stat } from "node:fs/promises";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";

export type DoctorPathIssue = {
  readonly path: string;
  readonly expected: "directory" | "file" | "private-file";
  readonly actual: "missing" | "file" | "directory" | "other" | "mode";
  readonly mode?: string;
};

export type DirectoryStructureDiagnostic = {
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly missingProfilePaths: readonly string[];
  readonly privateFileModeIssues: readonly DoctorPathIssue[];
};

export async function diagnoseDirectoryStructure(options: {
  readonly homeDir?: string;
  readonly profileId: string;
}): Promise<DirectoryStructureDiagnostic> {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const profilePaths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
  const warnings: string[] = [];
  const notes: string[] = [];
  const missingProfilePaths: string[] = [];
  const privateFileModeIssues: DoctorPathIssue[] = [];

  for (const entry of [
    { path: globalPaths.stateRoot, expected: "directory" as const, label: "state root" },
    { path: globalPaths.profilesRoot, expected: "directory" as const, label: "profiles root" },
    { path: globalPaths.sharedMemoryPath, expected: "directory" as const, label: "shared memory" },
    { path: globalPaths.packsPath, expected: "directory" as const, label: "packs root" }
  ]) {
    const issue = await diagnosePath(entry.path, entry.expected);
    if (issue !== undefined) {
      notes.push(`Global ${entry.label} is not initialized: ${entry.path}`);
    }
  }

  const sessionIssue = await diagnosePath(globalPaths.sessionsSqlitePath, "file");
  if (sessionIssue !== undefined) {
    notes.push(`Global sessions store is not initialized: ${globalPaths.sessionsSqlitePath}`);
  }

  const profileRootIssue = await diagnosePath(profilePaths.profileRoot, "directory");
  if (profileRootIssue !== undefined) {
    missingProfilePaths.push(profilePaths.profileRoot);
    warnings.push(`Selected profile root is missing or invalid: ${profilePaths.profileRoot}`);
    return {
      warnings,
      notes,
      missingProfilePaths,
      privateFileModeIssues
    };
  }

  for (const entry of [
    { path: profilePaths.skillsPath, expected: "directory" as const, label: "skills directory" },
    { path: profilePaths.cronPath, expected: "directory" as const, label: "cron directory" },
    { path: profilePaths.logsPath, expected: "directory" as const, label: "logs directory" },
    { path: profilePaths.gatewayStatePath, expected: "directory" as const, label: "gateway directory" },
    { path: profilePaths.channelMediaPath, expected: "directory" as const, label: "channel media directory" },
    { path: profilePaths.audioCachePath, expected: "directory" as const, label: "audio cache directory" },
    { path: profilePaths.imageCachePath, expected: "directory" as const, label: "image cache directory" },
    { path: profilePaths.tempPath, expected: "directory" as const, label: "temp directory" },
    { path: profilePaths.configPath, expected: "file" as const, label: "config.json" },
    { path: profilePaths.promotionsPath, expected: "file" as const, label: "promotions.json" }
  ]) {
    const issue = await diagnosePath(entry.path, entry.expected);
    if (issue !== undefined) {
      missingProfilePaths.push(entry.path);
      warnings.push(`Selected profile ${entry.label} is missing or invalid: ${entry.path}`);
    }
  }

  for (const entry of [
    { path: profilePaths.envPath, label: ".env" },
    { path: profilePaths.authJsonPath, label: "auth.json" }
  ]) {
    const issue = await diagnosePath(entry.path, "private-file");
    if (issue === undefined) continue;
    if (issue.actual === "mode") {
      privateFileModeIssues.push(issue);
      warnings.push(`Selected profile ${entry.label} is not private: ${entry.path} (${issue.mode})`);
    } else {
      missingProfilePaths.push(entry.path);
      warnings.push(`Selected profile ${entry.label} is missing or invalid: ${entry.path}`);
    }
  }

  return {
    warnings,
    notes,
    missingProfilePaths,
    privateFileModeIssues
  };
}

async function diagnosePath(
  path: string,
  expected: DoctorPathIssue["expected"]
): Promise<DoctorPathIssue | undefined> {
  try {
    const pathStat = await stat(path);
    if (expected === "directory") {
      return pathStat.isDirectory() ? undefined : { path, expected, actual: pathStat.isFile() ? "file" : "other" };
    }
    if (!pathStat.isFile()) {
      return { path, expected, actual: pathStat.isDirectory() ? "directory" : "other" };
    }
    if (expected === "private-file" && (pathStat.mode & 0o077) !== 0) {
      return { path, expected, actual: "mode", mode: formatMode(pathStat.mode) };
    }
    return undefined;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { path, expected, actual: "missing" };
    }
    throw error;
  }
}

function formatMode(mode: number): string {
  return `0o${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
