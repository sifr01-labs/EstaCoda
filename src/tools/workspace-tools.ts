import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { EnvironmentType } from "../contracts/security.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import type { FileStateOperationKind, FileStateTracker } from "../delegation/file-state-tracker.js";
import { isLikelyBinary, isTextyPath } from "../context/context-security.js";
import { assessHardlineFloor } from "../security/command-safety.js";
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

export function createWorkspaceTools(options: WorkspaceToolOptions): readonly RegisteredTool[] {
  const root = resolve(options.workspaceRoot);
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const fsAdapter = options.fsAdapter;

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
      name: "file.replace",
      description: "Replace an exact text segment in a workspace file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" }
        },
        required: ["path", "oldText", "newText"]
      },
      riskClass: "workspace-write",
      toolsets: ["files", "coding"],
      progressLabel: "patching file",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { path?: string; oldText?: string; newText?: string }) => {
        if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
          return errorResult("oldText and newText must be strings");
        }

        const canonicalRoot = await realpath(root);
        const path = await resolveWorkspacePath(canonicalRoot, input.path);
        if (!path.ok) {
          return path;
        }

        const existing = fsAdapter !== undefined
          ? await fsAdapter.readTextFile({ path: path.path })
          : await readFile(path.path, "utf8");
        const index = existing.indexOf(input.oldText);

        if (index === -1) {
          return errorResult(`Could not find oldText in ${relative(canonicalRoot, path.path)}.`);
        }

        if (existing.indexOf(input.oldText, index + input.oldText.length) !== -1) {
          return errorResult("oldText appears more than once; provide a more specific segment.");
        }

        const next = existing.slice(0, index) + input.newText + existing.slice(index + input.oldText.length);
        const relativePath = relative(canonicalRoot, path.path);
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
            fileChangePreview: buildFileReplaceChangePreview({
              path: relativePath,
              oldText: input.oldText,
              newText: input.newText,
              oldBytes: Buffer.byteLength(existing),
              newBytes: Buffer.byteLength(next)
            })
          }
        };
        recordFileStateOperation(options, {
          operation: "replace",
          sourceTool: "file.replace",
          path: relativePath,
          bytes: Buffer.byteLength(next),
          changed: next !== existing,
          previewAvailable: result.metadata?.fileChangePreview !== undefined
        });
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

        return runCommand(await realpath(root), input.command, Math.min(input.timeoutMs ?? commandTimeoutMs, commandTimeoutMs));
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
      childSessionId: ctx.childSessionId
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

function buildFileReplaceChangePreview(input: {
  path: string;
  oldText: string;
  newText: string;
  oldBytes: number;
  newBytes: number;
}): FileChangePreviewViewModel {
  const removed = splitPreviewLines(input.oldText).map((line) => `- ${line}`);
  const added = splitPreviewLines(input.newText).map((line) => `+ ${line}`);
  const diffLines = ["@@ exact replacement @@", ...removed, ...added];
  const previewLines = diffLines.slice(0, FILE_CHANGE_PREVIEW_LINES);
  const omittedLineCount = Math.max(0, diffLines.length - previewLines.length);

  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType: "modified",
    summary: [
      `Replaced one exact segment.`,
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

async function runCommand(root: string, command: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const shell = resolveShell();
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: root,
      env: {
        ...process.env,
        PWD: root
      },
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
