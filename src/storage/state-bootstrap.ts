import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGlobalStateHome, type GlobalStatePaths } from "../config/profile-home.js";

export const GLOBAL_STATE_DIRECTORIES = [
  "memory/shared",
  "packs",
  ".backups"
] as const;

export async function ensureGlobalStateBootstrap(options: {
  readonly homeDir?: string;
} = {}): Promise<GlobalStatePaths> {
  const paths = await ensureGlobalStateDirectories(options);
  await writeFileIfAbsent(paths.trustJsonPath, "{}\n");

  return paths;
}

export async function ensureGlobalStateDirectories(options: {
  readonly homeDir?: string;
} = {}): Promise<GlobalStatePaths> {
  const paths = resolveGlobalStateHome(options);
  if (paths.homeDir.length === 0) {
    throw new Error("HOME is not set. Use --home <dir> to specify a home directory.");
  }

  await Promise.all(
    GLOBAL_STATE_DIRECTORIES.map((directory) => mkdir(join(paths.stateRoot, directory), { recursive: true }))
  );

  return paths;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeFileIfAbsent(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
  }
}
