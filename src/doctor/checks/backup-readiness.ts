import { access, constants, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveGlobalStateHome } from "../../config/profile-home.js";

export type BackupReadinessDiagnostic = {
  readonly ok: boolean;
  readonly reason?: string;
};

export async function diagnoseBackupReadiness(options: {
  readonly homeDir?: string;
}): Promise<BackupReadinessDiagnostic> {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const backupsDir = join(globalPaths.stateRoot, ".backups");

  const backupDir = await statIfExists(backupsDir);
  if (backupDir !== undefined) {
    if (!backupDir.isDirectory()) {
      return { ok: false, reason: `State backup path is not a directory: ${backupsDir}` };
    }
    return writable(backupsDir, `State backup directory is not writable: ${backupsDir}`);
  }

  const stateRoot = await statIfExists(globalPaths.stateRoot);
  if (stateRoot === undefined) {
    return writable(globalPaths.homeDir, `Home directory is not writable for state backups: ${globalPaths.homeDir}`);
  }
  if (!stateRoot.isDirectory()) {
    return { ok: false, reason: `State root is not a directory: ${globalPaths.stateRoot}` };
  }
  return writable(globalPaths.stateRoot, `State root is not writable for backups: ${globalPaths.stateRoot}`);
}

async function writable(path: string, reason: string): Promise<BackupReadinessDiagnostic> {
  try {
    await access(path, constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, reason };
  }
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
