import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
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
        const path = await resolveWorkspacePath(canonicalRoot, input.path, { allowMissingLeaf: true });
        if (!path.ok) {
          return path;
        }

        if (fsAdapter?.writeTextFile !== undefined) {
          await fsAdapter.writeTextFile({
            path: path.path,
            content: input.content
          });
        } else {
          await mkdir(dirname(path.path), { recursive: true });
          await writeFile(path.path, input.content, "utf8");
        }

        return {
          ok: true,
          content: `Wrote ${relative(canonicalRoot, path.path)} (${Buffer.byteLength(input.content)} bytes).`,
          metadata: {
            path: relative(canonicalRoot, path.path),
            bytes: Buffer.byteLength(input.content)
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
          content: `Updated ${relative(canonicalRoot, path.path)}.`,
          metadata: {
            path: relative(canonicalRoot, path.path),
            oldBytes: Buffer.byteLength(existing),
            newBytes: Buffer.byteLength(next)
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

        const matcher = input.regex === true
          ? new RegExp(input.query, "i")
          : undefined;
        const results: string[] = [];

        await searchDirectory(canonicalRoot, start.path, {
          matcher,
          query: input.query,
          results,
          maxSearchResults
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
      run: async (input: { command?: string; timeoutMs?: number }) => {
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
          return errorResult("command must be a non-empty string");
        }

        const blockedReason = explainCommandBlock(input.command);
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
  options: { allowMissingLeaf?: boolean; allowDirectory?: boolean } = {}
): Promise<ResolvedWorkspacePath> {
  if (typeof path !== "string" || path.length === 0) {
    return pathError("path must be a non-empty string");
  }

  const candidate = resolve(root, path);
  let canonical = candidate;

  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (options.allowMissingLeaf !== true) {
      return pathError(error instanceof Error ? error.message : "path does not exist");
    }

    const parent = await realpath(dirname(candidate));
    canonical = join(parent, basename(candidate));
  }

  const blockedReason = explainPathBlock(root, canonical);
  if (blockedReason !== undefined) {
    return pathError(blockedReason);
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
  }
): Promise<void> {
  if (options.results.length >= options.maxSearchResults) {
    return;
  }

  const targetStat = await stat(path);
  if (targetStat.isFile()) {
    await searchFile(root, path, options);
    return;
  }

  if (!targetStat.isDirectory()) {
    return;
  }

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (options.results.length >= options.maxSearchResults) {
      return;
    }

    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }

    await searchDirectory(root, join(path, entry.name), options);
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

async function runCommand(root: string, command: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: root,
      env: {
        ...process.env,
        PWD: root
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
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
          timeoutMs
        }
      });
    });
  });
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

function explainCommandBlock(command: string): string | undefined {
  const assessment = assessCommandSafety(command);
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
