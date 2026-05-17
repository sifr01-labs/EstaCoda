import { readFile } from "node:fs/promises";
import type { ProfileStatePaths } from "../config/profile-home.js";

export type IdentityContext = {
  user: string | undefined;
  soul: string | undefined;
  memory: string | undefined;
};

export async function loadIdentityContext(options: {
  profilePaths: ProfileStatePaths;
}): Promise<IdentityContext> {
  const { profilePaths } = options;

  const [user, soul, memory] = await Promise.all([
    readOptionalFile(profilePaths.userMdPath),
    readOptionalFile(profilePaths.soulMdPath),
    readOptionalFile(profilePaths.memoryMdPath),
  ]);

  return { user, soul, memory };
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
