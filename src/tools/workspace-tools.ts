import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { EnvironmentType } from "../contracts/security.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import { explainPathBlock, isLikelyBinary, isTextyPath } from "../context/context-security.js";
import { assessCommandSafety } from "../security/command-safety.js";

export type WorkspaceToolOptions = {
  workspaceRoot: string;
  maxReadBytes?: number;
  maxSearchResults?: number;
  commandTimeoutMs?: number;
  fsAdapter?: WorkspaceFsAdapter;
};

export type WorkspaceFsAdapter = {
  readTextFile(input: { path: string; lineStart?: number; lineEnd?: number }): Promise<string>;
  writeTextFile?(input: { path: string; content: string }): Promise<void>;
};

const DEFAULT_MAX_READ_BYTES = 48_000;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const FILE_CHANGE_PREVIEW_LINES = 8;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

type ResolvedWorkspacePath =
  | { ok: true; content: ""; path: string }
  | { ok: false; content: string; metadata?: Record<string, unknown> };

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

        if (fsAdapter !== undefined) {
          const content = await fsAdapter.readTextFile({
            path: path.path,
            lineStart: input.lineStart,
            lineEnd: input.lineEnd
          });
          return renderWorkspaceFile(canonicalRoot, path.path, content, {
            maxReadBytes,
            lineStart: input.lineStart,
            lineEnd: input.lineEnd
          });
        }

        return readWorkspaceFile(canonicalRoot, path.path, {
          maxReadBytes,
          lineStart: input.lineStart,
          lineEnd: input.lineEnd
        });
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

        return {
          ok: true,
          content: `Wrote ${relativePath} (${Buffer.byteLength(input.content)} bytes).`,
          metadata: {
            path: relativePath,
            bytes: Buffer.byteLength(input.content),
            fileChangePreview: buildFileWriteChangePreview({
              path: relativePath,
              before: existing,
              after: input.content,
              bytes: Buffer.byteLength(input.content)
            })
          }
        };
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

        return {
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
      }
    },
    {
      name: "file.search",
      description: "Search text files inside the active workspace with a literal or regex query.",
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

async function resolveWorkspacePath(
  root: string,
  path: string | undefined,
  options: { allowMissingLeaf?: boolean; allowDirectory?: boolean; forbidSymlinks?: boolean } = {}
): Promise<ResolvedWorkspacePath> {
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
    content: "",
    path: canonical
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
          timedOut
        }
      });
    });
  });
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
  const assessment = assessCommandSafety(command, { environmentType });
  if (assessment.hardBlock !== undefined) {
    return assessment.hardBlock.reason;
  }
  if (assessment.riskClass === "destructive-local") {
    return "command matches a destructive or privilege-escalating pattern";
  }
  return undefined;
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}

function pathError(content: string): ResolvedWorkspacePath {
  return {
    ok: false,
    content
  };
}
