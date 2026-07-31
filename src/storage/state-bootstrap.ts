import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGlobalStateHome, type GlobalStatePaths } from "../config/profile-home.js";

export const GLOBAL_STATE_DIRECTORIES = [
  "memory/shared",
  "packs",
  ".backups"
] as const;

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
