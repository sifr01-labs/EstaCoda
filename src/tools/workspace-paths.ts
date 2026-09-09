import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolResult } from "../contracts/tool.js";
import { explainPathBlock } from "../context/context-security.js";

// The failure branch intentionally matches ToolResult shape so callers can
// return failed path resolution directly from tool handlers.
export type WorkspacePathResolution =
  | { ok: true; path: string }
  | {
      ok: false;
      content: string;
      metadata?: ToolResult["metadata"];
    };

export async function resolveWorkspacePath(
  root: string,
  path: string | undefined,
  options: { allowMissingLeaf?: boolean; allowDirectory?: boolean; forbidSymlinks?: boolean } = {}
): Promise<WorkspacePathResolution> {
  if (typeof path !== "string" || path.length === 0) {
    return pathError("path must be a non-empty string");
  }

  // Step 1: Resolve target lexically under workspaceRoot
  const candidate = resolve(root, path);

  // Step 2: Reject traversal before filesystem mutation
  const blockedReason = explainPathBlock(root, candidate);
  if (blockedReason !== undefined) {
    return pathError(blockedReason);
  }

  if (options.forbidSymlinks === true) {
    const issue = await checkParentSegmentsForSymlinks(root, path);
    if (issue !== undefined) return pathError(issue);
    const entry = await lstat(candidate).catch(() => undefined);
    if (entry?.isSymbolicLink()) return pathError("path is a symlink");
  }

  let canonical: string;

  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (options.allowMissingLeaf !== true) {
      return pathError(error instanceof Error ? error.message : "path does not exist");
    }

    // Step 3: Find nearest existing ancestor
    const ancestor = await findNearestExistingAncestor(candidate);
    if (ancestor === undefined) {
      return pathError("unable to resolve parent directory");
    }

    // Step 4: realpath nearest existing ancestor
    let resolvedAncestor: string;
    try {
      resolvedAncestor = await realpath(ancestor);
    } catch {
      return pathError("unable to resolve parent directory");
    }

    // Reject symlinks in existing parent segments when required
    if (options.forbidSymlinks === true) {
      const symlinkCheck = await checkParentSegmentsForSymlinks(root, path);
      if (symlinkCheck !== undefined) {
        return pathError(symlinkCheck);
      }
    }

    // Step 5: realpath workspaceRoot
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      resolvedRoot = root;
    }

    // Step 6: Verify ancestor realpath is inside workspaceRoot realpath
    const ancestorRelative = relative(resolvedRoot, resolvedAncestor);
    if (ancestorRelative.startsWith("..") || isAbsolute(ancestorRelative)) {
      return pathError("path is outside the trusted workspace");
    }

    // Step 7 & 8: Build canonical from resolved ancestor + missing descendants
    const missingSuffix = relative(ancestor, candidate);
    canonical = resolve(resolvedAncestor, missingSuffix);

    // Final containment verification
    const finalRelative = relative(resolvedRoot, canonical);
    if (finalRelative.startsWith("..") || isAbsolute(finalRelative)) {
      return pathError("path is outside the trusted workspace");
    }
  }

  // Additional containment check for success path (symlinks may have resolved outside)
  const resolvedRoot = await realpath(root).catch(() => root);
  const canonicalRelative = relative(resolvedRoot, canonical);
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
    return pathError("path is outside the trusted workspace");
  }

  const targetStat = await stat(canonical).catch(() => undefined);
  if (targetStat?.isDirectory() && options.allowDirectory !== true) {
    return pathError("path points to a directory");
  }

  return {
    ok: true,
    path: canonical
  };
}

export function errorResult(content: string, metadata?: ToolResult["metadata"]): ToolResult {
  return {
    ok: false,
    content,
    ...(metadata === undefined ? {} : { metadata })
  };
}

async function findNearestExistingAncestor(candidate: string): Promise<string | undefined> {
  let current = dirname(candidate);
  while (true) {
    const statResult = await stat(current).catch(() => undefined);
    if (statResult !== undefined) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function checkParentSegmentsForSymlinks(
  root: string,
  rawPath: string
): Promise<string | undefined> {
  const resolvedRoot = await realpath(root).catch(() => root);
  const candidate = resolve(resolvedRoot, rawPath);
  let current = dirname(candidate);

  while (current !== resolvedRoot && current !== dirname(current)) {
    try {
      const statResult = await lstat(current);
      if (statResult.isSymbolicLink()) {
        return "path contains a symlink in parent directories";
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return error instanceof Error ? error.message : "failed to inspect path segment";
      }
      // Segment does not exist; continue upward
    }
    current = dirname(current);
  }

  return undefined;
}

function pathError(content: string): WorkspacePathResolution {
  return {
    ok: false,
    content
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
