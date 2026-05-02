import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PathSafetyResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function isSafeRelativeSkillPath(path: string): boolean {
  const normalized = path.trim();
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split(/[\\/]+/u).some((part) => part === "" || part === "." || part === "..") &&
    normalized !== "SKILL.md" &&
    normalized !== ".snapshots" &&
    normalized !== ".archive" &&
    normalized !== ".usage.json" &&
    normalized !== ".bundled_manifest.json" &&
    !normalized.startsWith(".snapshots/") &&
    !normalized.startsWith(".archive/") &&
    !normalized.startsWith(".bundled_manifest.json");
}

export async function resolveContainedPath(root: string, requestedPath: string): Promise<PathSafetyResult> {
  if (isAbsolute(requestedPath) || !isSafeRelativeSkillPath(requestedPath)) {
    return { ok: false, reason: "Skill path must be a safe relative path inside the skill root." };
  }

  const target = resolve(root, requestedPath);
  const rootReal = await realpath(root).catch(() => undefined);

  if (rootReal === undefined) {
    return { ok: false, reason: `Skill root does not exist: ${root}` };
  }

  const targetParent = await canonicalExistingParent(target);
  if (targetParent === undefined) {
    return { ok: false, reason: `Skill path parent does not exist: ${dirname(target)}` };
  }

  const relativePath = relative(rootReal, targetParent);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return { ok: false, reason: "Skill path must stay inside the local skills root." };
  }

  const targetEntry = await lstat(target).catch(() => undefined);
  if (targetEntry?.isSymbolicLink() === true) {
    return { ok: false, reason: "Skill path cannot target an existing symlink." };
  }

  return { ok: true, path: target };
}

export async function ensureContainedDirectory(root: string, requestedPath: string): Promise<PathSafetyResult> {
  return await resolveContainedPath(root, requestedPath);
}

async function canonicalExistingParent(path: string): Promise<string | undefined> {
  let current = dirname(path);

  while (current.length > 1) {
    const resolved = await realpath(current).catch(() => undefined);
    if (resolved !== undefined) {
      return resolved;
    }
    current = dirname(current);
  }

  return undefined;
}
