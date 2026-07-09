import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { EnvironmentType } from "../contracts/security.js";
import type { SessionToolContext } from "../contracts/tool-context.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import type { FileStateOperationKind, FileStateTracker } from "../delegation/file-state-tracker.js";
import { isLikelyBinary, isTextyPath } from "../context/context-security.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import { buildSafeChildEnv } from "../security/process-env.js";
import { createTerminalInspectTool } from "./terminal-inspect-tool.js";
import { errorResult, resolveWorkspacePath } from "./workspace-paths.js";

export type WorkspaceToolOptions = {
  workspaceRoot: string;
  maxReadBytes?: number;
  maxSearchResults?: number;
  commandTimeoutMs?: number;
  fsAdapter?: WorkspaceFsAdapter;
  fileStateTracker?: FileStateTracker;
  sessionId?: string | (() => string);
  parentSessionId?: string;
  childSessionId?: string | (() => string | undefined);
  childProcessEnv?: SessionToolContext["childProcessEnv"];
};

export type WorkspaceFsAdapter = {
  readTextFile(input: { path: string; lineStart?: number; lineEnd?: number }): Promise<string>;
  writeTextFile?(input: { path: string; content: string }): Promise<void>;
};

const DEFAULT_MAX_READ_BYTES = 48_000;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const FILE_CHANGE_PREVIEW_LINES = 8;
const MAX_TERMINAL_CONTEXT_SUMMARY_CHARS = 500;
const MAX_TERMINAL_CONTEXT_COMMAND_CHARS = 220;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

type PatchMatchStrategy =
  | "exact"
  | "line_trimmed"
  | "whitespace_normalized"
  | "indentation_flexible"
  | "escape_normalized"
  | "trimmed_boundary"
  | "unicode_normalized"
  | "block_anchor"
  | "context_aware";

type PatchMatchRange = {
  start: number;
  end: number;
  strategy: PatchMatchStrategy;
};

type PatchMatchResult =
  | {
      ok: true;
      ranges: PatchMatchRange[];
      strategy: PatchMatchStrategy;
    }
  | {
      ok: false;
      content: string;
      metadata?: ToolResult["metadata"];
    };

type ParsedWorkspacePatch = {
  files: ParsedWorkspacePatchFile[];
};

type ParsedWorkspacePatchFile = {
  path: string;
  hunks: ParsedWorkspacePatchHunk[];
};

type ParsedWorkspacePatchHunk = {
  contextHint?: string;
  lines: ParsedWorkspacePatchLine[];
};

type ParsedWorkspacePatchLine = {
  kind: "context" | "remove" | "add";
  text: string;
};

type PreparedWorkspacePatchFile = {
  path: string;
  absolutePath: string;
  before: string;
  after: string;
  hunkCount: number;
};

type PatchFailureTracker = {
  record(result: ToolResult, path: string | undefined): ToolResult;
  clear(path: string): void;
  clearMany(paths: string[]): void;
};

export function createWorkspaceTools(options: WorkspaceToolOptions): readonly RegisteredTool[] {
  const root = resolve(options.workspaceRoot);
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const fsAdapter = options.fsAdapter;
  const patchFailureTracker = createPatchFailureTracker();

  return [
    {
      name: "file.read",
      description: "Read a text file inside the active workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          lineStart: { type: "number" },
          lineEnd: { type: "number" }
        },
        required: ["path"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "reading file",
      maxResultSizeChars: maxReadBytes,
      isAvailable: () => true,
      run: async (input: { path?: string; lineStart?: number; lineEnd?: number }) => {
        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path);
        if (!path.ok) {
          return path;
        }

        let result: ToolResult;
        if (fsAdapter !== undefined) {
          const content = await fsAdapter.readTextFile({
            path: path.path,
            lineStart: input.lineStart,
            lineEnd: input.lineEnd
          });
          result = renderWorkspaceFile(canonicalRoot, path.path, content, {
            maxReadBytes,
            lineStart: input.lineStart,
            lineEnd: input.lineEnd
          });
        } else {
          result = await readWorkspaceFile(canonicalRoot, path.path, {
            maxReadBytes,
            lineStart: input.lineStart,
            lineEnd: input.lineEnd
          });
        }

        recordFileStateOperation(options, {
          operation: "read",
          sourceTool: "file.read",
          path: metadataPath(result, canonicalRoot, path.path),
          bytes: metadataNumber(result.metadata?.bytes),
          changed: undefined,
          previewAvailable: false
        });
        return result;
      }
    },
    {
      name: "file.write",
      description: "Write a text file inside the active workspace, creating parent directories as needed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "writing file",
      maxResultSizeChars: 2000,
      isAvailable: () => true,
      run: async (input: { path?: string; content?: string }) => {
        if (typeof input.content !== "string") {
          return errorResult("content must be a string");
        }

        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path, { allowMissingLeaf: true, forbidSymlinks: true });
        if (!path.ok) {
          return path;
        }

        const relativePath = relative(canonicalRoot, path.path);
        const existing = await readExistingWorkspaceText(path.path, fsAdapter);

        if (fsAdapter?.writeTextFile !== undefined) {
          await fsAdapter.writeTextFile({
            path: path.path,
            content: input.content
          });
        } else {
          const ensureResult = await ensureSafeParentDirectories(path.path, canonicalRoot);
          if (ensureResult !== undefined) {
            return ensureResult;
          }
          await writeFile(path.path, input.content, "utf8");
        }

        const bytes = Buffer.byteLength(input.content);
        const result: ToolResult = {
          ok: true,
          content: `Wrote ${relativePath} (${bytes} bytes).`,
          metadata: {
            path: relativePath,
            bytes,
            fileChangePreview: buildFileWriteChangePreview({
              path: relativePath,
              before: existing,
              after: input.content,
              bytes
            })
          }
        };
        recordFileStateOperation(options, {
          operation: "write",
          sourceTool: "file.write",
          path: relativePath,
          bytes,
          changed: existing !== input.content,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
        return result;
      }
    },
    {
      name: "file.patch",
      description: "Patch workspace files. Replace mode finds old_string with exact matching first, then deterministic fuzzy fallbacks for minor whitespace, indentation, escaping, and Unicode differences. Patch mode applies V4A-style multi-file update patches atomically after validating every hunk.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["replace", "patch"],
            description: "Edit mode. 'replace' requires path, old_string, and new_string. 'patch' requires patch.",
            default: "replace"
          },
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences instead of requiring a unique match.",
            default: false
          },
          patch: {
            type: "string",
            description: "Required when mode='patch'. V4A format patch content with *** Begin Patch, one or more *** Update File sections, hunks introduced by @@ optional context @@, and *** End Patch."
          }
        },
        required: ["mode"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "patching file",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { mode?: string; path?: string; old_string?: string; new_string?: string; replace_all?: boolean; patch?: string }) => {
        const mode = input.mode ?? "replace";
        if (mode !== "replace" && mode !== "patch") {
          return errorResult("mode must be 'replace' or 'patch'");
        }
        if (mode === "patch") {
          if (typeof input.patch !== "string" || input.patch.trim().length === 0) {
            return errorResult("patch must be a non-empty string when mode='patch'");
          }
          const canonicalRoot = await realpath(root);
          const result = await applyWorkspacePatchMode({
            root: canonicalRoot,
            patch: input.patch,
            fsAdapter,
            recordOperation: (operation) => recordFileStateOperation(options, operation)
          });
          if (!result.ok) {
            return patchFailureTracker.record(result, metadataPathString(result.metadata?.path));
          }
          patchFailureTracker.clearMany(metadataPathList(result.metadata?.paths));
          return result;
        }
        if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
          return errorResult("old_string and new_string must be strings");
        }
        if (input.old_string.length === 0) {
          return errorResult("old_string must not be empty");
        }

        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path);
        if (!path.ok) {
          return path;
        }

        const existing = fsAdapter !== undefined
          ? await fsAdapter.readTextFile({ path: path.path })
          : await readFile(path.path, "utf8");
        const replaceAll = input.replace_all === true;
        const relativePath = relative(canonicalRoot, path.path);
        const match = findPatchReplacementRanges(existing, input.old_string, {
          path: relativePath,
          replaceAll
        });
        if (!match.ok) {
          return patchFailureTracker.record(errorResult(match.content, match.metadata), relativePath);
        }

        const matchCount = match.ranges.length;
        const next = applyPatchReplacementRanges(existing, match.ranges, input.new_string);
        if (fsAdapter?.writeTextFile !== undefined) {
          await fsAdapter.writeTextFile({
            path: path.path,
            content: next
          });
        } else {
          await writeFile(path.path, next, "utf8");
        }

        const result: ToolResult = {
          ok: true,
          content: `Updated ${relativePath}.`,
          metadata: {
            path: relativePath,
            oldBytes: Buffer.byteLength(existing),
            newBytes: Buffer.byteLength(next),
            matchCount,
            matchStrategy: match.strategy,
            fileChangePreview: buildFileReplaceChangePreview({
              path: relativePath,
              oldString: input.old_string,
              newString: input.new_string,
              oldBytes: Buffer.byteLength(existing),
              newBytes: Buffer.byteLength(next),
              matchCount,
              matchStrategy: match.strategy
            })
          }
        };
        recordFileStateOperation(options, {
          operation: "replace",
          sourceTool: "file.patch",
          path: relativePath,
          bytes: Buffer.byteLength(next),
          changed: next !== existing,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
        patchFailureTracker.clear(relativePath);
        return result;
      }
    },
    {
      name: "file.search",
      description: "Search text files inside the active workspace with a simple literal or regex query. For ripgrep-backed search, file filtering, output modes, context, and pagination, prefer file.grep.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean" },
          path: { type: "string" }
        },
        required: ["query"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "searching files",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { query?: string; regex?: boolean; path?: string }) => {
        if (typeof input.query !== "string" || input.query.length === 0) {
          return errorResult("query must be a non-empty string");
        }

        const canonicalRoot = await realpath(root);
        const start = await resolveWorkspacePath(canonicalRoot, input.path ?? ".", { allowDirectory: true });
        if (!start.ok) {
          return start;
        }

        let matcher: RegExp | undefined;
        if (input.regex === true) {
          try {
            matcher = new RegExp(input.query, "i");
          } catch (error) {
            return errorResult(`invalid regex: ${error instanceof Error ? error.message : "failed to compile query"}`);
          }
        }
        const results: string[] = [];

        await searchDirectory(canonicalRoot, start.path, {
          matcher,
          query: input.query,
          results,
          maxSearchResults,
          visitedDirectories: new Set()
        });

        return {
          ok: true,
          content: results.length === 0
            ? `No matches for ${input.query}.`
            : results.join("\n"),
          metadata: {
            query: input.query,
            results: results.length,
            truncated: results.length >= maxSearchResults
          }
        };
      }
    },
    createTerminalInspectTool({
      workspaceRoot: root,
      timeoutMs: Math.min(commandTimeoutMs, 10_000)
    }),
    {
      name: "terminal.run",
      description: "Run a bounded shell command in the active workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["command"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-readonly", "shell-write", "coding", "research"],
      progressLabel: "running command",
      maxResultSizeChars: 16_000,
      isAvailable: () => true,
      run: async (input: { command?: string; timeoutMs?: number }, context) => {
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
          return errorResult("command must be a non-empty string");
        }

        const blockedReason = explainCommandBlock(input.command, context?.environmentType);
        if (blockedReason !== undefined) {
          return errorResult(blockedReason);
        }

        return runCommand(
          await realpath(root),
          input.command,
          Math.min(input.timeoutMs ?? commandTimeoutMs, commandTimeoutMs),
          options.childProcessEnv
        );
      }
    }
  ];
}

export const workspaceToolProvider: SessionToolProvider = {
  name: "workspace",
  kind: "session",
  createTools(ctx) {
    return createWorkspaceTools({
      workspaceRoot: ctx.workspaceRoot,
      fsAdapter: ctx.workspaceFsAdapter,
      fileStateTracker: ctx.fileStateTracker,
      sessionId: ctx.currentSessionId,
      parentSessionId: ctx.parentSessionId,
      childSessionId: ctx.childSessionId,
      childProcessEnv: ctx.childProcessEnv
    });
  }
};

function recordFileStateOperation(
  options: WorkspaceToolOptions,
  input: {
    operation: FileStateOperationKind;
    sourceTool: string;
    path: string;
    bytes?: number;
    changed?: boolean;
    previewAvailable?: boolean;
  }
): void {
  const sessionId = resolveString(options.sessionId);
  if (options.fileStateTracker === undefined || sessionId === undefined) {
    return;
  }
  const childSessionId = resolveString(options.childSessionId);
  options.fileStateTracker.recordOperation({
    sessionId,
    parentSessionId: options.parentSessionId,
    childSessionId,
    path: input.path,
    operation: input.operation,
    sourceTool: input.sourceTool,
    metadata: {
      bytes: input.bytes,
      changed: input.changed,
      previewAvailable: input.previewAvailable
    }
  });
}

function resolveString(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}

function metadataPath(result: ToolResult, root: string, path: string): string {
  return typeof result.metadata?.path === "string" ? result.metadata.path : relative(root, path);
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataPathString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataPathList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
}

function createPatchFailureTracker(): PatchFailureTracker {
  const failuresByPath = new Map<string, number>();

  return {
    record(result, path) {
      if (path === undefined) {
        return result;
      }

      const failureCount = (failuresByPath.get(path) ?? 0) + 1;
      failuresByPath.set(path, failureCount);
      const escalated = failureCount >= 3;
      const recoveryHint = escalated
        ? `This is failure #${failureCount} patching '${path}'. Stop retrying. Re-read the file or use file.write only if replacing the entire file is intended.`
        : "Use file.read to verify current content, or file.search to locate the text.";
      const content = result.content.includes(recoveryHint)
        ? result.content
        : `${result.content}\n\n${recoveryHint}`;

      return {
        ...result,
        content,
        metadata: {
          ...(result.metadata ?? {}),
          path,
          patchFailureCount: failureCount,
          patchFailureEscalated: escalated
        }
      };
    },
    clear(path) {
      failuresByPath.delete(path);
    },
    clearMany(paths) {
      for (const path of paths) {
        failuresByPath.delete(path);
      }
    }
  };
}

async function applyWorkspacePatchMode(input: {
  root: string;
  patch: string;
  fsAdapter: WorkspaceFsAdapter | undefined;
  recordOperation: (operation: {
    operation: FileStateOperationKind;
    sourceTool: string;
    path: string;
    bytes?: number;
    changed?: boolean;
    previewAvailable?: boolean;
  }) => void;
}): Promise<ToolResult> {
  const parsed = parseWorkspacePatch(input.patch);
  if (!("patch" in parsed)) {
    return parsed;
  }

  const prepared = await prepareWorkspacePatchFiles(input.root, parsed.patch, input.fsAdapter);
  if (!("files" in prepared)) {
    return prepared;
  }

  for (const file of prepared.files) {
    if (input.fsAdapter?.writeTextFile !== undefined) {
      await input.fsAdapter.writeTextFile({
        path: file.absolutePath,
        content: file.after
      });
    } else {
      await writeFile(file.absolutePath, file.after, "utf8");
    }
  }

  const fileCount = prepared.files.length;
  const hunkCount = prepared.files.reduce((total, file) => total + file.hunkCount, 0);
  const oldBytes = prepared.files.reduce((total, file) => total + Buffer.byteLength(file.before), 0);
  const newBytes = prepared.files.reduce((total, file) => total + Buffer.byteLength(file.after), 0);
  const preview = buildPatchModeChangePreview({
    files: prepared.files,
    patch: input.patch,
    oldBytes,
    newBytes
  });
  const result: ToolResult = {
    ok: true,
    content: `Applied patch to ${fileCount} file(s), ${hunkCount} hunk(s).`,
    metadata: {
      paths: prepared.files.map((file) => file.path),
      fileCount,
      hunkCount,
      oldBytes,
      newBytes,
      fileChangePreview: preview
    }
  };

  for (const file of prepared.files) {
    input.recordOperation({
      operation: "replace",
      sourceTool: "file.patch",
      path: file.path,
      bytes: Buffer.byteLength(file.after),
      changed: file.before !== file.after,
      previewAvailable: result.metadata?.fileChangePreview !== undefined
    });
  }

  return result;
}

function parseWorkspacePatch(patch: string): { ok: true; patch: ParsedWorkspacePatch } | ToolResult {
  const lines = patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    return errorResult("patch must start with *** Begin Patch");
  }

  const files: ParsedWorkspacePatchFile[] = [];
  const seenPaths = new Set<string>();
  let currentFile: ParsedWorkspacePatchFile | undefined;
  let currentHunk: ParsedWorkspacePatchHunk | undefined;
  let ended = false;

  const finishHunk = () => {
    if (currentHunk !== undefined) {
      currentFile?.hunks.push(currentHunk);
      currentHunk = undefined;
    }
  };

  const finishFile = () => {
    finishHunk();
    if (currentFile !== undefined) {
      if (currentFile.hunks.length === 0) {
        throw new Error(`patch file ${currentFile.path} has no hunks`);
      }
      files.push(currentFile);
      currentFile = undefined;
    }
  };

  try {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (ended) {
        if (line.trim().length !== 0) {
          return errorResult("patch contains content after *** End Patch");
        }
        continue;
      }

      if (line === "*** End Patch") {
        finishFile();
        ended = true;
        continue;
      }

      if (line.startsWith("*** Update File: ")) {
        finishFile();
        const path = line.slice("*** Update File: ".length).trim();
        if (path.length === 0) {
          return errorResult("patch update file path must be non-empty");
        }
        if (seenPaths.has(path)) {
          return errorResult(`patch updates ${path} more than once; combine hunks under one file section`);
        }
        seenPaths.add(path);
        currentFile = { path, hunks: [] };
        continue;
      }

      if (line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ")) {
        return errorResult("patch mode currently supports *** Update File sections only");
      }

      if (line.startsWith("@@")) {
        if (currentFile === undefined) {
          return errorResult("patch hunk appears before an update file section");
        }
        finishHunk();
        currentHunk = {
          contextHint: parsePatchContextHint(line),
          lines: []
        };
        continue;
      }

      if (currentHunk === undefined) {
        return errorResult(`patch line appears outside a hunk: ${line}`);
      }

      if (line.startsWith(" ")) {
        currentHunk.lines.push({ kind: "context", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1) });
      } else {
        return errorResult(`patch hunk line must start with space, '-', or '+': ${line}`);
      }
    }
    finishFile();
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "failed to parse patch");
  }

  if (!ended) {
    return errorResult("patch must end with *** End Patch");
  }
  if (files.length === 0) {
    return errorResult("patch must update at least one file");
  }
  return { ok: true, patch: { files } };
}

function parsePatchContextHint(line: string): string | undefined {
  const match = /^@@(?:\s*(.*?)\s*)?@@$/u.exec(line);
  if (match === null) {
    return undefined;
  }
  const hint = match[1]?.trim() ?? "";
  return hint.length === 0 ? undefined : hint;
}

async function prepareWorkspacePatchFiles(
  root: string,
  patch: ParsedWorkspacePatch,
  fsAdapter: WorkspaceFsAdapter | undefined
): Promise<{ ok: true; files: PreparedWorkspacePatchFile[] } | ToolResult> {
  const prepared: PreparedWorkspacePatchFile[] = [];

  for (const file of patch.files) {
    const resolved = await resolveWorkspacePath(root, file.path);
    if (!resolved.ok) {
      return resolved;
    }

    const before = fsAdapter !== undefined
      ? await fsAdapter.readTextFile({ path: resolved.path })
      : await readFile(resolved.path, "utf8");
    const relativePath = relative(root, resolved.path);
    let after = before;

    for (const [index, hunk] of file.hunks.entries()) {
      const materialized = materializePatchHunk(hunk);
      if (!("oldString" in materialized)) {
        return errorResult(`${relativePath} hunk ${index + 1}: ${materialized.content}`, {
          path: relativePath,
          hunkIndex: index + 1
        });
      }

      const match = findPatchReplacementRanges(after, materialized.oldString, {
        path: relativePath,
        replaceAll: false,
        contextHint: hunk.contextHint
      });
      if (!match.ok) {
        return errorResult(`${relativePath} hunk ${index + 1}: ${match.content}`, {
          ...(match.metadata ?? {}),
          path: relativePath,
          hunkIndex: index + 1
        });
      }

      after = applyPatchReplacementRanges(after, match.ranges, materialized.newString);
    }

    prepared.push({
      path: relativePath,
      absolutePath: resolved.path,
      before,
      after,
      hunkCount: file.hunks.length
    });
  }

  return { ok: true, files: prepared };
}

function materializePatchHunk(
  hunk: ParsedWorkspacePatchHunk
): { ok: true; oldString: string; newString: string } | ToolResult {
  if (hunk.lines.length === 0) {
    return errorResult("hunk must contain at least one line");
  }

  const hasRemove = hunk.lines.some((line) => line.kind === "remove");
  const hasAdd = hunk.lines.some((line) => line.kind === "add");
  if (!hasRemove && !hasAdd) {
    return errorResult("hunk must add or remove at least one line");
  }

  const oldLines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "remove")
    .map((line) => line.text);
  const newLines = hunk.lines
    .filter((line) => line.kind === "context" || line.kind === "add")
    .map((line) => line.text);
  const oldString = oldLines.join("\n");
  if (oldString.length === 0) {
    return errorResult("hunk old content must include context or removed lines");
  }

  return {
    ok: true,
    oldString,
    newString: newLines.join("\n")
  };
}

function findPatchReplacementRanges(
  content: string,
  oldString: string,
  options: { path: string; replaceAll: boolean; contextHint?: string }
): PatchMatchResult {
  const strategies: Array<{
    strategy: PatchMatchStrategy;
    find: () => PatchMatchRange[];
  }> = [
    { strategy: "exact", find: () => findExactRanges(content, oldString, "exact") },
    { strategy: "line_trimmed", find: () => findLineTrimmedRanges(content, oldString) },
    { strategy: "whitespace_normalized", find: () => findWhitespaceNormalizedRanges(content, oldString, "whitespace_normalized") },
    { strategy: "indentation_flexible", find: () => findIndentationFlexibleRanges(content, oldString) },
    { strategy: "escape_normalized", find: () => findEscapeNormalizedRanges(content, oldString) },
    { strategy: "trimmed_boundary", find: () => findTrimmedBoundaryRanges(content, oldString) },
    { strategy: "unicode_normalized", find: () => findUnicodeNormalizedRanges(content, oldString) },
    { strategy: "block_anchor", find: () => findBlockAnchorRanges(content, oldString) },
    { strategy: "context_aware", find: () => findContextAwareRanges(content, oldString) }
  ];

  const attemptedStrategies = strategies.map(({ strategy }) => strategy);

  for (const { strategy, find } of strategies) {
    const ranges = filterPatchRangesByContextHint(
      uniquePatchRanges(find()).sort((left, right) => left.start - right.start || left.end - right.end),
      content,
      options.contextHint
    );
    if (ranges.length === 0) {
      continue;
    }

    if (hasOverlappingPatchRanges(ranges)) {
      return {
        ok: false,
        content: `old_string produced overlapping ${strategy} matches in ${options.path}; provide a more specific segment.`,
        metadata: {
          path: options.path,
          matchStrategy: strategy,
          matchCount: ranges.length,
          attemptedStrategies
        }
      };
    }

    if (!options.replaceAll && ranges.length > 1) {
      return {
        ok: false,
        content: `old_string matched ${ranges.length} locations in ${options.path} using ${strategy}; provide a more specific segment or set replace_all=true.`,
        metadata: {
          path: options.path,
          matchStrategy: strategy,
          matchCount: ranges.length,
          attemptedStrategies
        }
      };
    }

    return {
      ok: true,
      ranges: options.replaceAll ? ranges : [ranges[0]!],
      strategy
    };
  }

  return {
    ok: false,
    content: `old_string not found in ${options.path}. Use file.read to verify current content, or file.search to locate the text.`,
    metadata: {
      path: options.path,
      matchCount: 0,
      attemptedStrategies
    }
  };
}

function applyPatchReplacementRanges(content: string, ranges: PatchMatchRange[], newString: string): string {
  let next = content;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, range.start) + newString + next.slice(range.end);
  }
  return next;
}

function findExactRanges(content: string, oldString: string, strategy: PatchMatchStrategy): PatchMatchRange[] {
  const ranges: PatchMatchRange[] = [];
  let index = content.indexOf(oldString);
  while (index !== -1) {
    ranges.push({ start: index, end: index + oldString.length, strategy });
    index = content.indexOf(oldString, index + oldString.length);
  }
  return ranges;
}

function findLineTrimmedRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  const oldTrimmed = oldString.trim();
  if (oldLines.length !== 1 || oldTrimmed.length === 0) {
    return [];
  }
  return splitLinesWithRanges(content)
    .filter((line) => line.text.trim() === oldTrimmed)
    .map((line) => ({ start: line.start, end: line.end, strategy: "line_trimmed" }));
}

function findWhitespaceNormalizedRanges(
  content: string,
  oldString: string,
  strategy: PatchMatchStrategy
): PatchMatchRange[] {
  const haystack = normalizeWhitespaceWithMap(content);
  const needle = normalizeWhitespaceWithMap(oldString).text;
  if (needle.trim().length === 0) {
    return [];
  }
  return findAllIndexes(haystack.text, needle).map((index) => ({
    start: haystack.startMap[index] ?? 0,
    end: haystack.endMap[index + needle.length - 1] ?? content.length,
    strategy
  }));
}

function findIndentationFlexibleRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length === 0) {
    return [];
  }
  const oldNormalized = normalizeIndentBlock(oldString);
  if (oldNormalized.trim().length === 0) {
    return [];
  }

  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    const candidateLines = lines.slice(index, index + oldLines.length);
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (normalizeIndentBlock(candidate) === oldNormalized) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "indentation_flexible"
      });
    }
  }
  return ranges;
}

function findEscapeNormalizedRanges(content: string, oldString: string): PatchMatchRange[] {
  const decoded = decodeCommonEscapes(oldString);
  if (decoded === oldString || decoded.length === 0) {
    return [];
  }
  return findExactRanges(content, decoded, "escape_normalized");
}

function findTrimmedBoundaryRanges(content: string, oldString: string): PatchMatchRange[] {
  const trimmed = oldString.trim();
  if (trimmed.length === 0 || trimmed === oldString) {
    return [];
  }
  return findExactRanges(content, trimmed, "trimmed_boundary");
}

function findUnicodeNormalizedRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length === 0) {
    return [];
  }
  const oldNormalized = oldString.normalize("NFC");
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    const candidateLines = lines.slice(index, index + oldLines.length);
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (candidate !== oldString && candidate.normalize("NFC") === oldNormalized) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "unicode_normalized"
      });
    }
  }
  return ranges;
}

function findBlockAnchorRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  if (oldLines.length < 2) {
    return [];
  }
  const anchors = firstAndLastNonBlankTrimmedLines(oldLines);
  if (anchors === undefined) {
    return [];
  }

  const oldNormalized = normalizeWhitespaceValue(oldString).trim();
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]!.text.trim() !== anchors.first) {
      continue;
    }
    for (let end = start; end < lines.length; end += 1) {
      if (lines[end]!.text.trim() !== anchors.last) {
        continue;
      }
      const candidateLines = lines.slice(start, end + 1);
      const candidate = candidateLines.map((line) => line.text).join("\n");
      if (normalizeWhitespaceValue(candidate).trim() === oldNormalized) {
        ranges.push({
          start: candidateLines[0]!.start,
          end: candidateLines[candidateLines.length - 1]!.end,
          strategy: "block_anchor"
        });
      }
    }
  }
  return ranges;
}

function findContextAwareRanges(content: string, oldString: string): PatchMatchRange[] {
  const oldLines = splitBlockLines(oldString);
  const oldNonBlank = oldLines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (oldNonBlank.length < 3) {
    return [];
  }
  const first = oldNonBlank[0]!;
  const last = oldNonBlank[oldNonBlank.length - 1]!;
  const oldCompact = normalizeWhitespaceValue(oldString).trim();
  const lines = splitLinesWithRanges(content);
  const ranges: PatchMatchRange[] = [];

  for (let start = 0; start <= lines.length - oldLines.length; start += 1) {
    const candidateLines = lines.slice(start, start + oldLines.length);
    const candidateNonBlank = candidateLines.map((line) => line.text.trim()).filter((line) => line.length > 0);
    if (candidateNonBlank[0] !== first || candidateNonBlank[candidateNonBlank.length - 1] !== last) {
      continue;
    }
    const candidate = candidateLines.map((line) => line.text).join("\n");
    if (normalizeWhitespaceValue(candidate).trim() === oldCompact) {
      ranges.push({
        start: candidateLines[0]!.start,
        end: candidateLines[candidateLines.length - 1]!.end,
        strategy: "context_aware"
      });
    }
  }
  return ranges;
}

function uniquePatchRanges(ranges: PatchMatchRange[]): PatchMatchRange[] {
  const seen = new Set<string>();
  const unique: PatchMatchRange[] = [];
  for (const range of ranges) {
    if (range.start < 0 || range.end <= range.start) {
      continue;
    }
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(range);
  }
  return unique;
}

function filterPatchRangesByContextHint(
  ranges: PatchMatchRange[],
  content: string,
  contextHint: string | undefined
): PatchMatchRange[] {
  const hint = contextHint?.trim();
  if (hint === undefined || hint.length === 0 || ranges.length <= 1) {
    return ranges;
  }

  const hintIndexes = contextHintIndexes(content, hint);
  if (hintIndexes.length === 0) {
    return ranges;
  }

  const windowChars = 4_000;
  const atOrAfterHint = ranges.filter((range) =>
    hintIndexes.some((index) =>
      (index >= range.start && index <= range.end) ||
      (range.start >= index && range.start - index <= windowChars)
    )
  );
  if (atOrAfterHint.length > 0) {
    return atOrAfterHint;
  }

  const beforeHint = ranges.filter((range) =>
    hintIndexes.some((index) => range.end <= index && index - range.end <= windowChars)
  );
  return beforeHint.length === 0 ? ranges : beforeHint;
}

function contextHintIndexes(content: string, hint: string): number[] {
  const exact = findAllIndexes(content, hint);
  if (exact.length > 0) {
    return exact;
  }

  return splitLinesWithRanges(content)
    .filter((line) => line.text.trim() === hint)
    .map((line) => line.start);
}

function hasOverlappingPatchRanges(ranges: PatchMatchRange[]): boolean {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      return true;
    }
  }
  return false;
}

function findAllIndexes(content: string, search: string): number[] {
  const indexes: number[] = [];
  let index = content.indexOf(search);
  while (index !== -1) {
    indexes.push(index);
    index = content.indexOf(search, index + search.length);
  }
  return indexes;
}

function normalizeWhitespaceWithMap(content: string): { text: string; startMap: number[]; endMap: number[] } {
  let text = "";
  const startMap: number[] = [];
  const endMap: number[] = [];
  let inWhitespace = false;

  for (let index = 0; index < content.length;) {
    const codePoint = content.codePointAt(index);
    const char = String.fromCodePoint(codePoint ?? content.charCodeAt(index));
    const nextIndex = index + char.length;
    if (/\s/u.test(char)) {
      if (!inWhitespace) {
        text += " ";
        startMap.push(index);
        endMap.push(nextIndex);
        inWhitespace = true;
      } else {
        endMap[endMap.length - 1] = nextIndex;
      }
    } else {
      text += char;
      startMap.push(index);
      endMap.push(nextIndex);
      inWhitespace = false;
    }
    index = nextIndex;
  }

  return { text, startMap, endMap };
}

function normalizeWhitespaceValue(content: string): string {
  return normalizeWhitespaceWithMap(content).text;
}

function splitLinesWithRanges(content: string): Array<{ text: string; start: number; end: number }> {
  if (content.length === 0) {
    return [{ text: "", start: 0, end: 0 }];
  }

  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < content.length) {
    let end = start;
    while (end < content.length && content[end] !== "\n" && content[end] !== "\r") {
      end += 1;
    }
    lines.push({ text: content.slice(start, end), start, end });
    if (end >= content.length) {
      break;
    }
    start = content[end] === "\r" && content[end + 1] === "\n" ? end + 2 : end + 1;
  }
  return lines;
}

function splitBlockLines(content: string): string[] {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}

function normalizeIndentBlock(content: string): string {
  const lines = splitBlockLines(content).map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[0]!.trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
    lines.pop();
  }

  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/u)?.[0].length ?? 0);
  const commonIndent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(commonIndent, line.length))).join("\n");
}

function decodeCommonEscapes(content: string): string {
  return content
    .replace(/\\r\\n/gu, "\n")
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\"/gu, "\"")
    .replace(/\\'/gu, "'")
    .replace(/\\\\/gu, "\\");
}

function firstAndLastNonBlankTrimmedLines(lines: string[]): { first: string; last: string } | undefined {
  const nonBlank = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (nonBlank.length === 0) {
    return undefined;
  }
  return {
    first: nonBlank[0]!,
    last: nonBlank[nonBlank.length - 1]!
  };
}

async function ensureSafeParentDirectories(
  targetPath: string,
  workspaceRoot: string
): Promise<ToolResult | undefined> {
  const parent = dirname(targetPath);

  // Walk up to find deepest existing directory and collect missing segments
  const missingSegments: string[] = [];
  let current = parent;

  while (true) {
    try {
      const statResult = await lstat(current);
      if (statResult.isSymbolicLink()) {
        return errorResult("path contains a symlink in parent directories");
      }
      if (!statResult.isDirectory()) {
        return errorResult("path parent contains a non-directory segment");
      }
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return errorResult(error instanceof Error ? error.message : "failed to inspect path segment");
      }
      missingSegments.unshift(basename(current));
      const next = dirname(current);
      if (next === current) {
        return errorResult("unable to resolve parent directory");
      }
      current = next;
    }
  }

  // Verify deepest existing directory is inside workspace
  let resolvedCurrent: string;
  try {
    resolvedCurrent = await realpath(current);
  } catch {
    return errorResult("unable to resolve parent directory");
  }

  const resolvedRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const currentRel = relative(resolvedRoot, resolvedCurrent);
  if (currentRel.startsWith("..") || isAbsolute(currentRel)) {
    return errorResult("path is outside the trusted workspace");
  }

  // Create missing segments one by one
  for (const segment of missingSegments) {
    const nextPath = resolve(resolvedCurrent, segment);

    // Check again in case a symlink was created concurrently
    try {
      const nextStat = await lstat(nextPath);
      if (nextStat.isSymbolicLink()) {
        return errorResult("path contains a symlink in parent directories");
      }
      if (!nextStat.isDirectory()) {
        return errorResult("path parent contains a non-directory segment");
      }
      resolvedCurrent = await realpath(nextPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return errorResult(error instanceof Error ? error.message : "failed to inspect path segment");
      }

      await mkdir(nextPath);

      // Verify containment after creation
      const resolvedNext = await realpath(nextPath);
      const nextRel = relative(resolvedRoot, resolvedNext);
      if (nextRel.startsWith("..") || isAbsolute(nextRel)) {
        return errorResult("path is outside the trusted workspace");
      }
      resolvedCurrent = resolvedNext;
    }
  }

  // Final parent verification
  const finalParent = await realpath(parent);
  const finalRel = relative(resolvedRoot, finalParent);
  if (finalRel.startsWith("..") || isAbsolute(finalRel)) {
    return errorResult("path is outside the trusted workspace");
  }

  return undefined;
}

async function readWorkspaceFile(
  root: string,
  path: string,
  options: { maxReadBytes: number; lineStart?: number; lineEnd?: number }
): Promise<ToolResult> {
  if (!isTextyPath(path)) {
    return errorResult("file type is not included as text");
  }

  const bytes = await readFile(path);
  if (isLikelyBinary(bytes)) {
    return errorResult("file appears to be binary");
  }

  const truncated = bytes.length > options.maxReadBytes;
  const content = bytes.subarray(0, options.maxReadBytes).toString("utf8");
  const ranged = applyLineRange(content, options.lineStart, options.lineEnd);

  return renderWorkspaceFile(root, path, ranged, {
    maxReadBytes: options.maxReadBytes,
    originalBytes: bytes.length,
    alreadyRanged: true
  });
}

function renderWorkspaceFile(
  root: string,
  path: string,
  content: string,
  options: {
    maxReadBytes: number;
    lineStart?: number;
    lineEnd?: number;
    originalBytes?: number;
    alreadyRanged?: boolean;
  }
): ToolResult {
  const byteLength = options.originalBytes ?? Buffer.byteLength(content);
  const truncated = byteLength > options.maxReadBytes;
  const trimmed = truncated ? content.slice(0, options.maxReadBytes) : content;
  const ranged = options.alreadyRanged === true
    ? trimmed
    : applyLineRange(trimmed, options.lineStart, options.lineEnd);

  return {
    ok: true,
    content: [
      `# ${relative(root, path)}${truncated ? " (truncated)" : ""}`,
      ranged
    ].join("\n"),
    metadata: {
      path: relative(root, path),
      bytes: byteLength,
      truncated
    }
  };
}

async function searchDirectory(
  root: string,
  path: string,
  options: {
    query: string;
    matcher: RegExp | undefined;
    results: string[];
    maxSearchResults: number;
    visitedDirectories: Set<string>;
  }
): Promise<void> {
  if (options.results.length >= options.maxSearchResults) {
    return;
  }

  const canonicalPath = await realpath(path).catch(() => path);
  const targetStat = await stat(canonicalPath);
  if (targetStat.isFile()) {
    await searchFile(root, canonicalPath, options);
    return;
  }

  if (!targetStat.isDirectory()) {
    return;
  }

  if (options.visitedDirectories.has(canonicalPath)) {
    return;
  }
  options.visitedDirectories.add(canonicalPath);

  const entries = await readdir(canonicalPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (options.results.length >= options.maxSearchResults) {
      return;
    }

    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }

    await searchDirectory(root, join(canonicalPath, entry.name), options);
  }
}

async function searchFile(
  root: string,
  path: string,
  options: {
    query: string;
    matcher: RegExp | undefined;
    results: string[];
    maxSearchResults: number;
  }
): Promise<void> {
  if (!isTextyPath(path)) {
    return;
  }

  const bytes = await readFile(path);
  if (isLikelyBinary(bytes)) {
    return;
  }

  const lines = bytes.toString("utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    if (options.results.length >= options.maxSearchResults) {
      return;
    }

    const matched = options.matcher === undefined
      ? line.toLowerCase().includes(options.query.toLowerCase())
      : options.matcher.test(line);

    if (matched) {
      options.results.push(`${relative(root, path)}:${index + 1}: ${line}`);
    }
  }
}

async function readExistingWorkspaceText(
  path: string,
  fsAdapter: WorkspaceFsAdapter | undefined
): Promise<string | undefined> {
  if (fsAdapter !== undefined) {
    try {
      return await fsAdapter.readTextFile({ path });
    } catch {
      return undefined;
    }
  }

  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildFileWriteChangePreview(input: {
  path: string;
  before: string | undefined;
  after: string;
  bytes: number;
}): FileChangePreviewViewModel {
  const afterLines = splitPreviewLines(input.after);
  const previewLines = afterLines.slice(0, FILE_CHANGE_PREVIEW_LINES).map((line) => `+ ${line}`);
  const previousLineCount = input.before === undefined ? 0 : splitPreviewLines(input.before).length;
  const changeType = input.before === undefined ? "added" : "modified";
  const omittedLineCount = Math.max(0, afterLines.length - previewLines.length);
  const summary = input.before === undefined
    ? [`Added ${afterLines.length} line(s).`, `Wrote ${input.bytes} byte(s).`]
    : [`Replaced file content.`, `${previousLineCount} line(s) -> ${afterLines.length} line(s).`];

  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType,
    summary,
    diff: previewLines.join("\n"),
    omittedLineCount,
  };
}

function buildPatchModeChangePreview(input: {
  files: PreparedWorkspacePatchFile[];
  patch: string;
  oldBytes: number;
  newBytes: number;
}): FileChangePreviewViewModel {
  const fileCount = input.files.length;
  const hunkCount = input.files.reduce((total, file) => total + file.hunkCount, 0);
  const diffLines = input.patch
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .filter((line) =>
      line.startsWith("*** Update File: ") ||
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-")
    );
  const previewLines = diffLines.slice(0, FILE_CHANGE_PREVIEW_LINES);

  return {
    kind: "fileChangePreview",
    path: fileCount === 1 ? input.files[0]!.path : "multiple files",
    changeType: "modified",
    summary: [
      `Applied ${hunkCount} hunk(s) across ${fileCount} file(s).`,
      `${input.oldBytes} byte(s) -> ${input.newBytes} byte(s).`
    ],
    diff: previewLines.join("\n"),
    omittedLineCount: Math.max(0, diffLines.length - previewLines.length)
  };
}

function buildFileReplaceChangePreview(input: {
  path: string;
  oldString: string;
  newString: string;
  oldBytes: number;
  newBytes: number;
  matchCount: number;
  matchStrategy: PatchMatchStrategy;
}): FileChangePreviewViewModel {
  const removed = splitPreviewLines(input.oldString).map((line) => `- ${line}`);
  const added = splitPreviewLines(input.newString).map((line) => `+ ${line}`);
  const diffLines = ["@@ exact replacement @@", ...removed, ...added];
  const previewLines = diffLines.slice(0, FILE_CHANGE_PREVIEW_LINES);
  const omittedLineCount = Math.max(0, diffLines.length - previewLines.length);

  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType: "modified",
    summary: [
      `Replaced ${input.matchCount} segment(s) using ${input.matchStrategy}.`,
      `${input.oldBytes} byte(s) -> ${input.newBytes} byte(s).`
    ],
    diff: previewLines.join("\n"),
    omittedLineCount,
  };
}

function splitPreviewLines(content: string): string[] {
  if (content.length === 0) {
    return [""];
  }
  return content.replace(/\r\n/g, "\n").split("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function runCommand(
  root: string,
  command: string,
  timeoutMs: number,
  childProcessEnv: WorkspaceToolOptions["childProcessEnv"]
): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const shell = resolveShell();
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: root,
      env: buildTerminalRunEnv(root, childProcessEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let timedOut = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errorChunks).toString("utf8");
      const content = [
        stdout.trimEnd(),
        stderr.length === 0 ? undefined : `stderr:\n${stderr.trimEnd()}`
      ]
        .filter((line) => line !== undefined && line.length > 0)
        .join("\n\n");

      resolveResult({
        ok: code === 0 && signal === null,
        content: content.length === 0 ? "(no output)" : content.slice(0, 16_000),
        metadata: {
          command,
          code,
          signal,
          timeoutMs,
          timedOut,
          _estacoda_context_summary: terminalContextSummary({
            command,
            code,
            stdout,
            stderr
          })
        }
      });
    });
  });
}

function buildTerminalRunEnv(
  root: string,
  childProcessEnv: WorkspaceToolOptions["childProcessEnv"]
): NodeJS.ProcessEnv {
  if (childProcessEnv?.mode === "isolated") {
    return buildSafeChildEnv({
      homeDir: childProcessEnv.homeDir,
      extra: { PWD: root }
    });
  }

  return {
    ...process.env,
    PWD: root
  };
}

function terminalContextSummary(input: {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  return boundText([
    `Command ${terminalCommandLabel(input.command)} exited with code ${input.code ?? "signal"}.`,
    `stdout: ${lineCount(input.stdout)} lines / ${input.stdout.length} chars.`,
    `stderr: ${lineCount(input.stderr)} lines / ${input.stderr.length} chars.`
  ].join(" "), MAX_TERMINAL_CONTEXT_SUMMARY_CHARS);
}

function terminalCommandLabel(command: string): string {
  return boundText(JSON.stringify(command), MAX_TERMINAL_CONTEXT_COMMAND_CHARS);
}

function boundText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function lineCount(value: string): number {
  const trimmed = value.replace(/(?:\r\n|\r|\n)$/u, "");
  return trimmed.length === 0 ? 0 : trimmed.split(/\r\n|\r|\n/u).length;
}

function resolveShell(): { command: string; args: string[] } {
  const shell = process.env.SHELL;
  if (typeof shell === "string" && shell.trim().length > 0) {
    return {
      command: shell,
      args: ["-lc"]
    };
  }

  if (platform() === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c"]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc"]
  };
}

function applyLineRange(content: string, lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const start = Math.max(1, lineStart);
  const end = Math.min(lines.length, Math.max(start, lineEnd ?? start));

  return lines.slice(start - 1, end).join("\n");
}

function explainCommandBlock(command: string, environmentType?: EnvironmentType): string | undefined {
  return assessHardlineFloor(command, { environmentType })?.reason;
}
