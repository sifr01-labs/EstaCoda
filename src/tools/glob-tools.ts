import { explainPathBlock, workspaceSearchExclusionGlobs } from "../context/context-security.js";
import { HostProcessScope, type HostProcesses } from "../execution/host-processes.js";
import type { HostExecutionLease } from "../execution/host-environment.js";
import { HostWorkspaceFiles, type WorkspaceFiles } from "../execution/host-workspace-files.js";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import { errorResult } from "./workspace-paths.js";

export type FileGlobInput = {
  pattern?: string;
  path?: string;
  limit?: number;
  offset?: number;
  sort?: "path" | "modified";
  include_hidden?: boolean;
};

export type GlobToolOptions = {
  executionLease?: HostExecutionLease;
  workspaceRoot: string;
  rgCommand?: string;
  rgArgsPrefix?: readonly string[];
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const EXCLUDED_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "node_modules", "dist", "build", ".next", ".turbo"]);
const SENSITIVE_BASENAMES = new Set([".env", "id_rsa", "id_ed25519"]);
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SENSITIVE_GLOBS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519", "*.p12", "*.pfx"];
const EXCLUDED_DIR_GLOBS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "node_modules", "dist", "build", ".next", ".turbo"];

type GlobInputValidation =
  | {
    ok: true;
    pattern: string;
    limit: number;
    offset: number;
    sort: "path" | "modified";
    includeHidden: boolean;
  }
  | {
    ok: false;
    content: string;
    metadata?: ToolResult["metadata"];
  };

export function createGlobTools(options: GlobToolOptions): readonly RegisteredTool[] {
  const root = options.executionLease?.workspaceRoot ?? resolve(options.workspaceRoot);
  const files = options.executionLease?.files ?? new HostWorkspaceFiles(root);
  const rgCommand = options.rgCommand ?? "rg";
  const rgArgsPrefix = options.rgArgsPrefix ?? [];

  return [
    {
      name: "file.glob",
      description: "Find files in the active workspace by glob pattern. Respects .gitignore when ripgrep is available.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          sort: { type: "string", enum: ["path", "modified"] },
          include_hidden: { type: "boolean" }
        },
        required: ["pattern"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "finding files",
      maxResultSizeChars: 20_000,
      isAvailable: () => true,
      run: async (input: FileGlobInput, context) => {
        const signal = AbortSignal.any([...[context?.signal, options.executionLease?.signal].filter((value): value is AbortSignal => value !== undefined)]);
        if (signal.aborted) return errorResult("Glob cancelled before dispatch.");
        const validation = validateInput(input);
        if (!validation.ok) {
          return validation;
        }

        try { await options.executionLease?.content.assertMaterialized(); } catch (error) { return errorResult(error instanceof Error ? error.message : "Editor content is not materialized."); }
        const canonicalRoot = await files.realpath(root);
        const start = await files.resolvePath(input.path ?? ".", { allowDirectory: true });
        if (!start.ok) {
          return start;
        }

        const startStat = await files.stat(start.path);
        if (!startStat.isDirectory()) {
          return errorResult("path must point to a directory");
        }

        const startedAt = Date.now();
        const scopedPath = toWorkspaceRelative(canonicalRoot, start.path) || ".";
        const owned = options.executionLease ? undefined : new HostProcessScope(root);
        const rgResult = await runRipgrepFiles({
          processes: options.executionLease?.processes ?? owned!,
          signal,
          root: canonicalRoot,
          rgCommand,
          rgArgsPrefix,
          pattern: validation.pattern,
          scopedPath,
          includeHidden: validation.includeHidden
        }).finally(() => owned?.release());
        const backend = rgResult.kind === "ok" ? "rg" : "node";
        if (rgResult.kind === "error") {
          return errorResult(rgResult.content, rgResult.metadata);
        }

        const rawMatches = rgResult.kind === "ok"
          ? rgResult.paths
          : await findFilesWithNode({
            files, signal,
            root: canonicalRoot,
            startPath: start.path,
            pattern: validation.pattern,
            includeHidden: validation.includeHidden
          });
        const filtered = uniqueSorted(rawMatches
          .map((path) => normalizeWorkspacePath(canonicalRoot, path))
          .filter((path): path is string => path !== undefined)
          .filter((path) => isAllowedWorkspaceFile(path, validation.includeHidden)));
        const sorted = validation.sort === "modified"
          ? await sortByModifiedTime(files, canonicalRoot, filtered)
          : filtered.sort((left, right) => left.localeCompare(right));
        const total = sorted.length;
        const paged = sorted.slice(validation.offset, validation.offset + validation.limit);
        const durationMs = Date.now() - startedAt;

        return {
          ok: true,
          content: paged.length === 0 ? "No files found." : paged.join("\n"),
          metadata: {
            backend,
            numFiles: total,
            returned: paged.length,
            truncated: validation.offset + paged.length < total,
            offset: validation.offset,
            limit: validation.limit,
            sort: validation.sort,
            durationMs
          }
        };
      }
    }
  ];
}

export const globToolProvider: SessionToolProvider = {
  name: "glob",
  kind: "session",
  createTools(ctx) {
    return createGlobTools({
      executionLease: ctx.executionLease,
      workspaceRoot: ctx.workspaceRoot
    });
  }
};

function validateInput(input: FileGlobInput): GlobInputValidation {
  if (typeof input.pattern !== "string" || input.pattern.trim().length === 0) {
    return validationError("pattern must be a non-empty string");
  }

  const limit = parseInteger(input.limit, DEFAULT_LIMIT);
  if (limit === undefined || limit < 1) {
    return validationError(`limit must be between 1 and ${MAX_LIMIT}`);
  }

  const offset = parseInteger(input.offset, 0);
  if (offset === undefined || offset < 0) {
    return validationError("offset must be a non-negative integer");
  }

  if (input.sort !== undefined && input.sort !== "path" && input.sort !== "modified") {
    return validationError("sort must be \"path\" or \"modified\"");
  }

  return {
    ok: true,
    pattern: input.pattern,
    limit: Math.min(limit, MAX_LIMIT),
    offset,
    sort: input.sort ?? "path",
    includeHidden: input.include_hidden === true
  };
}

function validationError(content: string): GlobInputValidation {
  return {
    ok: false,
    content
  };
}

function parseInteger(value: number | undefined, fallback: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function runRipgrepFiles(input: {
  processes: HostProcesses;
  signal?: AbortSignal;
  root: string;
  rgCommand: string;
  rgArgsPrefix: readonly string[];
  pattern: string;
  scopedPath: string;
  includeHidden: boolean;
}): Promise<
  | { kind: "ok"; paths: string[] }
  | { kind: "missing" }
  | { kind: "error"; content: string; metadata?: ToolResult["metadata"] }
> {
  return new Promise((resolveResult) => {
    const args = [
      ...input.rgArgsPrefix,
      "--files",
      "-g",
      input.pattern,
      ...exclusionArgs(),
      ...(input.includeHidden ? ["--hidden"] : []),
      input.scopedPath
    ];
    if (input.signal?.aborted) { resolveResult({ kind: "error", content: "Glob cancelled before dispatch." }); return; }
    const child = input.processes.spawn(input.rgCommand, args);
    let stopped = false;
    const cancel = () => { stopped = true; void input.processes.terminate(child).catch(() => resolveResult({ kind: "error", content: "Glob termination could not be confirmed." })); };
    const timer = setTimeout(cancel, 30_000);
    input.signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); };
    let stdout = "", stderr = "";
    let spawnFailed = false;

    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length + chunk.length > 2 * 1024 * 1024) cancel(); else stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 4000); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      spawnFailed = true;
      if (error.code === "ENOENT") {
        resolveResult({ kind: "missing" });
        return;
      }
      resolveResult({
        kind: "error",
        content: error.message
      });
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (stopped) { resolveResult({ kind: "error", content: "Glob cancelled or exceeded its time/output limit. Narrow the path." }); return; }
      if (spawnFailed) {
        return;
      }

      if (code === 1 && signal === null && stdout.length === 0) {
        resolveResult({
          kind: "ok",
          paths: []
        });
        return;
      }
      if (code !== 0 || signal !== null) {
        resolveResult({
          kind: "error",
          content: stderr.trim().length === 0 ? `rg --files failed with ${signal ?? `exit code ${code}`}` : stderr.trim(),
          metadata: { code, signal }
        });
        return;
      }
      const paths = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
      if (paths.length > 20_000) { resolveResult({ kind: "error", content: "Glob file limit reached. Narrow the path." }); return; }
      resolveResult({ kind: "ok", paths });
    });
  });
}

function exclusionArgs(): string[] {
  const args: string[] = workspaceSearchExclusionGlobs().flatMap((pattern) => ["-g", `!${pattern}`]);
  for (const pattern of SENSITIVE_GLOBS) {
    args.push("-g", `!${pattern}`, "-g", `!**/${pattern}`);
  }
  for (const dir of EXCLUDED_DIR_GLOBS) {
    args.push("-g", `!${dir}/**`, "-g", `!**/${dir}/**`);
  }
  return args;
}

async function findFilesWithNode(input: {
  files: WorkspaceFiles;
  signal?: AbortSignal;
  root: string;
  startPath: string;
  pattern: string;
  includeHidden: boolean;
}): Promise<string[]> {
  const matcher = createGlobMatcher(input.pattern);
  const results: string[] = [];
  await walkDirectory(input.root, input.startPath, {
    files: input.files, signal: input.signal, visited: { count: 0 },
    includeHidden: input.includeHidden,
    matcher,
    results
  });
  return results;
}

async function walkDirectory(
  root: string,
  path: string,
  options: {
    includeHidden: boolean;
    files: WorkspaceFiles; signal?: AbortSignal; visited: { count: number };
    matcher: (workspaceRelativePath: string) => boolean;
    results: string[];
  }
): Promise<void> {
  options.signal?.throwIfAborted();
  if (++options.visited.count > 20_000 || options.results.length > 20_000) throw new Error("Glob traversal limit reached. Narrow the path.");
  const resolved = await options.files.resolvePath(path, { allowDirectory: true });
  if (!resolved.ok) return;
  const entries = await options.files.readdir(resolved.path, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(path, entry.name);
    const workspaceRelativePath = toWorkspaceRelative(root, absolutePath);
    if (workspaceRelativePath.length === 0) {
      continue;
    }
    if (!isAllowedWorkspaceFile(workspaceRelativePath, options.includeHidden)) {
      if (entry.isDirectory()) {
        continue;
      }
      continue;
    }
    if (entry.isDirectory()) {
      await walkDirectory(root, absolutePath, options);
      continue;
    }
    if (entry.isFile() && options.matcher(workspaceRelativePath)) {
      options.results.push(workspaceRelativePath);
    }
  }
}

function createGlobMatcher(pattern: string): (workspaceRelativePath: string) => boolean {
  const normalizedPattern = normalizeSlashes(pattern);
  const regex = globToRegExp(normalizedPattern);
  const hasSlash = normalizedPattern.includes("/");
  return (workspaceRelativePath) => {
    const normalizedPath = normalizeSlashes(workspaceRelativePath);
    return regex.test(normalizedPath) || (!hasSlash && regex.test(basename(normalizedPath)));
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      const closeIndex = pattern.indexOf("}", index + 1);
      if (closeIndex !== -1) {
        const group = pattern.slice(index + 1, closeIndex).split(",")
          .map((part) => escapeRegExp(part))
          .join("|");
        source += `(?:${group})`;
        index = closeIndex;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
}

function normalizeWorkspacePath(root: string, path: string): string | undefined {
  const normalizedInput = path.trim();
  if (normalizedInput.length === 0) {
    return undefined;
  }
  const absolutePath = isAbsolute(normalizedInput)
    ? normalizedInput
    : resolve(root, normalizedInput);
  const relativePath = relative(root, absolutePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }
  return normalizeSlashes(relativePath);
}

function toWorkspaceRelative(root: string, path: string): string {
  return normalizeSlashes(relative(root, path));
}

function normalizeSlashes(path: string): string {
  return path.split(sep).join("/");
}

function isAllowedWorkspaceFile(workspaceRelativePath: string, includeHidden: boolean): boolean {
  if (explainPathBlock(process.cwd(), resolve(process.cwd(), workspaceRelativePath))) return false;
  const segments = normalizeSlashes(workspaceRelativePath).split("/");
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) {
    return false;
  }
  if (segments.some((segment) => segment.startsWith(".")) && !includeHidden) {
    return false;
  }
  const name = segments.at(-1) ?? "";
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith(".env.")) {
    return false;
  }
  return !SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function sortByModifiedTime(files: WorkspaceFiles, root: string, paths: string[]): Promise<string[]> {
  const entries = await Promise.all(paths.map(async (path) => ({
    path,
    mtimeMs: (await files.stat(join(root, path)).catch(() => undefined))?.mtimeMs ?? 0
  })));
  return entries
    .sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }
      return left.path.localeCompare(right.path);
    })
    .map((entry) => entry.path);
}
