import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { TASK_GRAPH_LIMITS } from "../contracts/task.js";
import type { ResolveTaskArtifactContent } from "./agent-step-executor.js";

/** Builds a fail-closed artifact reader constrained to reviewed runtime-owned roots. */
export async function createTaskArtifactContentResolver(
  allowedRoots: readonly string[]
): Promise<ResolveTaskArtifactContent> {
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    const path = resolve(root);
    return { path, canonicalPath: await realpath(path).catch(() => undefined) };
  }));

  return async ({ artifact }) => {
    const localPath = artifact.localPath;
    if (localPath === undefined || !isAbsolute(localPath) || artifact.bytes < 0 ||
        artifact.bytes > TASK_GRAPH_LIMITS.maxResultBytesPerStep) {
      return undefined;
    }
    const original = await lstat(localPath).catch(() => undefined);
    if (original === undefined || original.isSymbolicLink() || !original.isFile() || original.size !== artifact.bytes) {
      return undefined;
    }
    const canonicalPath = await realpath(localPath).catch(() => undefined);
    const canonicalRoots = await Promise.all(roots.map(resolveAllowedRoot));
    if (canonicalPath === undefined || !canonicalRoots.some((root) => root !== undefined && isWithin(root, canonicalPath))) {
      return undefined;
    }
    const content = await readFile(canonicalPath);
    return content.byteLength === artifact.bytes ? new Uint8Array(content) : undefined;
  };
}

async function resolveAllowedRoot(root: { path: string; canonicalPath?: string }): Promise<string | undefined> {
  if (root.canonicalPath !== undefined) return root.canonicalPath;
  const state = await lstat(root.path).catch(() => undefined);
  if (state === undefined || state.isSymbolicLink() || !state.isDirectory()) return undefined;
  return await realpath(root.path).catch(() => undefined);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
