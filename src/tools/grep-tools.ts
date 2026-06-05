import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { errorResult, resolveWorkspacePath } from "./workspace-paths.js";

export type FileGrepInput = {
  pattern?: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files" | "count";
  before?: number;
  after?: number;
  context?: number;
  line_numbers?: boolean;
  ignore_case?: boolean;
  type?: string;
  limit?: number;
  offset?: number;
  multiline?: boolean;
  include_hidden?: boolean;
  max_result_chars?: number;
  max_line_chars?: number;
  max_filesize?: string;
};

export type GrepToolOptions = {
  workspaceRoot: string;
  rgCommand?: string;
  rgArgsPrefix?: readonly string[];
  commandTimeoutMs?: number;
};

const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 500;
const DEFAULT_GREP_RESULT_CHARS = 100_000;
const MAX_GREP_RESULT_CHARS = 150_000;
const DEFAULT_GREP_LINE_CHARS = 500;
const MAX_GREP_LINE_CHARS = 2_000;
const DEFAULT_RG_MAX_FILESIZE = "2M";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const TRUNCATION_HINT = "Results truncated. Narrow path/glob/pattern, increase offset, or use output_mode: \"files\".";
const SENSITIVE_BASENAMES = new Set([".env", "id_rsa", "id_ed25519"]);
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SENSITIVE_GLOBS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519", "*.p12", "*.pfx"];
const EXCLUDED_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "node_modules", "dist", "build", ".next", ".turbo"]);
const EXCLUDED_DIR_GLOBS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "node_modules", "dist", "build", ".next", ".turbo"];

type GrepOutputMode = "content" | "files" | "count";
type TruncationReason = "limit" | "result_size" | "line_length" | "timeout" | "abort";
type OutputStopReason = Extract<TruncationReason, "limit" | "result_size">;
type OptionalIntegerValidation =
  | { ok: true; value?: number }
  | {
    ok: false;
    content: string;
    metadata?: ToolResult["metadata"];
  };

type GrepValidation =
  | {
    ok: true;
    pattern: string;
    outputMode: GrepOutputMode;
    limit: number;
    offset: number;
    maxResultChars: number;
    maxLineChars: number;
    maxFilesize: string;
    includeHidden: boolean;
    lineNumbers: boolean;
    before?: number;
    after?: number;
    context?: number;
  }
  | {
    ok: false;
    content: string;
    metadata?: ToolResult["metadata"];
  };

type GrepMetadata = {
  pattern: string;
  path: string;
  glob?: string;
  outputMode: GrepOutputMode;
  returned: number;
  offset: number;
  limit: number;
  truncated: boolean;
  truncatedReason?: TruncationReason;
  maxResultChars: number;
  maxLineChars: number;
  linesTruncated: number;
  binaryFilesSkipped: "rg-default";
  maxFilesize: string;
  durationMs: number;
};

export function createGrepTools(options: GrepToolOptions): readonly RegisteredTool[] {
  const root = resolve(options.workspaceRoot);
  const rgCommand = options.rgCommand ?? "rg";
  const rgArgsPrefix = options.rgArgsPrefix ?? [];
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  return [
    {
      name: "file.grep",
      description: "Search text file contents in the active workspace with ripgrep. Binary files are skipped by ripgrep by default.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          output_mode: { type: "string", enum: ["content", "files", "count"] },
          before: { type: "number" },
          after: { type: "number" },
          context: { type: "number" },
          line_numbers: { type: "boolean" },
          ignore_case: { type: "boolean" },
          type: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          multiline: { type: "boolean" },
          include_hidden: { type: "boolean" },
          max_result_chars: { type: "number" },
          max_line_chars: { type: "number" },
          max_filesize: { type: "string" }
        },
        required: ["pattern"]
      },
      riskClass: "read-only-local",
      toolsets: ["files", "coding", "research"],
      progressLabel: "grepping files",
      maxResultSizeChars: MAX_GREP_RESULT_CHARS,
      isAvailable: () => true,
      run: async (input: FileGrepInput, context?: ToolExecutionContext) => {
        const validation = validateInput(input);
        if (!validation.ok) {
          return validation;
        }

        const canonicalRoot = await realpath(root);
        const start = await resolveWorkspacePath(canonicalRoot, input.path ?? ".", { allowDirectory: true });
        if (!start.ok) {
          return start;
        }

        const startStat = await stat(start.path);
        if (!startStat.isFile() && !startStat.isDirectory()) {
          return errorResult("path must point to a file or directory");
        }

        const scopedPath = toWorkspaceRelative(canonicalRoot, start.path) || ".";
        return runRipgrep({
          root: canonicalRoot,
          rgCommand,
          rgArgsPrefix,
          input,
          validation,
          scopedPath,
          timeoutMs: commandTimeoutMs,
          signal: context?.signal
        });
      }
    }
  ];
}

export const grepToolProvider: SessionToolProvider = {
  name: "grep",
  kind: "session",
  createTools(ctx) {
    return createGrepTools({
      workspaceRoot: ctx.workspaceRoot
    });
  }
};

function validateInput(input: FileGrepInput): GrepValidation {
  if (typeof input.pattern !== "string" || input.pattern.trim().length === 0) {
    return validationError("pattern must be a non-empty string");
  }

  if (input.output_mode !== undefined && input.output_mode !== "content" && input.output_mode !== "files" && input.output_mode !== "count") {
    return validationError("output_mode must be \"content\", \"files\", or \"count\"");
  }

  const before = optionalNonNegativeInteger(input.before, "before");
  if (!before.ok) {
    return before;
  }
  const after = optionalNonNegativeInteger(input.after, "after");
  if (!after.ok) {
    return after;
  }
  const context = optionalNonNegativeInteger(input.context, "context");
  if (!context.ok) {
    return context;
  }

  return {
    ok: true,
    pattern: input.pattern,
    outputMode: input.output_mode ?? "content",
    limit: clampInteger(input.limit ?? DEFAULT_GREP_LIMIT, 1, MAX_GREP_LIMIT),
    offset: Math.max(0, integerOrDefault(input.offset, 0)),
    maxResultChars: clampInteger(input.max_result_chars ?? DEFAULT_GREP_RESULT_CHARS, 1, MAX_GREP_RESULT_CHARS),
    maxLineChars: clampInteger(input.max_line_chars ?? DEFAULT_GREP_LINE_CHARS, 80, MAX_GREP_LINE_CHARS),
    maxFilesize: input.max_filesize ?? DEFAULT_RG_MAX_FILESIZE,
    includeHidden: input.include_hidden === true,
    lineNumbers: input.line_numbers !== false,
    ...(before.value === undefined ? {} : { before: before.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(context.value === undefined ? {} : { context: context.value })
  };
}

function validationError(content: string): GrepValidation {
  return {
    ok: false,
    content
  };
}

function optionalNonNegativeInteger(value: number | undefined, name: string): OptionalIntegerValidation {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Number.isFinite(value) || value < 0) {
    return validationError(`${name} must be a non-negative integer`);
  }
  return {
    ok: true,
    value: Math.floor(value)
  };
}

function integerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function runRipgrep(input: {
  root: string;
  rgCommand: string;
  rgArgsPrefix: readonly string[];
  input: FileGrepInput;
  validation: Extract<GrepValidation, { ok: true }>;
  scopedPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const args = buildRipgrepArgs(input);
    const rows: string[] = [];
    const stderrChunks: Buffer[] = [];
    let pending = "";
    let seenRows = 0;
    let returned = 0;
    let renderedChars = 0;
    let linesTruncated = 0;
    let truncatedReason: TruncationReason | undefined;
    let spawnFailed = false;
    let closed = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const targetRows = input.validation.offset + input.validation.limit;

    const child = spawn(input.rgCommand, args, {
      cwd: input.root,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (result: ToolResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      input.signal?.removeEventListener("abort", abortHandler);
      resolveResult(result);
    };

    const terminate = (reason: TruncationReason) => {
      if (closed) {
        return;
      }
      truncatedReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("timeout");
    }, input.timeoutMs);

    const abortHandler = () => {
      aborted = true;
      terminate("abort");
    };

    if (input.signal?.aborted === true) {
      aborted = true;
      terminate("abort");
    } else {
      input.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (isOutputStopReason(truncatedReason)) {
        return;
      }
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        processOutputLine(line);
        if (isOutputStopReason(truncatedReason)) {
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      if (error.code === "ENOENT") {
        finish(errorResult("ripgrep (rg) is not installed; use file.search as a fallback or install rg."));
        return;
      }
      finish(errorResult(error.message));
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (spawnFailed) {
        return;
      }

      if (pending.length > 0 && truncatedReason !== "limit" && truncatedReason !== "result_size" && !timedOut && !aborted) {
        processOutputLine(pending);
      }

      const durationMs = Date.now() - startedAt;
      if (aborted) {
        finish(errorResult("file.grep aborted.", buildMetadata(input, {
          returned,
          truncated: true,
          truncatedReason: "abort",
          linesTruncated,
          durationMs
        })));
        return;
      }

      if (timedOut) {
        finish(errorResult("file.grep timed out.", buildMetadata(input, {
          returned,
          truncated: true,
          truncatedReason: "timeout",
          linesTruncated,
          durationMs
        })));
        return;
      }

      if (truncatedReason === "limit" || truncatedReason === "result_size") {
        const contentLines = [...rows, TRUNCATION_HINT];
        finish({
          ok: true,
          content: contentLines.join("\n"),
          metadata: buildMetadata(input, {
            returned,
            truncated: true,
            truncatedReason,
            linesTruncated,
            durationMs
          })
        });
        return;
      }

      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish(errorResult(stderr.length === 0 ? `rg failed with ${signal ?? `exit code ${code}`}` : stderr, {
          code,
          signal
        }));
        return;
      }

      const lineLengthTruncated = linesTruncated > 0;
      const finalTruncatedReason = truncatedReason ?? (lineLengthTruncated ? "line_length" : undefined);
      const truncated = finalTruncatedReason !== undefined;
      const contentLines = [...rows];
      if (truncated) {
        contentLines.push(TRUNCATION_HINT);
      }
      const content = contentLines.length === 0
        ? "No matches found."
        : contentLines.join("\n");

      finish({
        ok: true,
        content,
        metadata: buildMetadata(input, {
          returned,
          truncated,
          truncatedReason: finalTruncatedReason,
          linesTruncated,
          durationMs
        })
      });
    });

    function processOutputLine(line: string) {
      if (!isAllowedOutputLine(line, input.validation.outputMode)) {
        return;
      }

      seenRows += 1;
      if (seenRows <= input.validation.offset) {
        return;
      }
      if (seenRows > targetRows) {
        terminate("limit");
        return;
      }

      let rendered = line;
      if (rendered.length > input.validation.maxLineChars) {
        rendered = rendered.slice(0, input.validation.maxLineChars);
        linesTruncated += 1;
      }

      const nextLength = renderedChars + rendered.length + (rows.length === 0 ? 0 : 1);
      if (nextLength > input.validation.maxResultChars) {
        terminate("result_size");
        return;
      }

      rows.push(rendered);
      renderedChars = nextLength;
      returned += 1;
    }
  });
}

function buildRipgrepArgs(input: {
  rgArgsPrefix: readonly string[];
  input: FileGrepInput;
  validation: Extract<GrepValidation, { ok: true }>;
  scopedPath: string;
}): string[] {
  const args = [
    ...input.rgArgsPrefix,
    "--max-filesize",
    input.validation.maxFilesize
  ];

  if (input.validation.includeHidden) {
    args.push("--hidden");
  }
  if (input.input.glob !== undefined) {
    args.push("--glob", input.input.glob);
  }
  args.push(...exclusionArgs());
  if (input.input.type !== undefined) {
    args.push("--type", input.input.type);
  }
  if (input.input.ignore_case === true) {
    args.push("-i");
  }
  if (input.input.multiline === true) {
    args.push("-U", "--multiline-dotall");
  }

  if (input.validation.outputMode === "files") {
    args.push("-l");
  } else if (input.validation.outputMode === "count") {
    args.push("-c");
  } else {
    args.push("--with-filename");
    if (input.validation.lineNumbers) {
      args.push("-n");
    }
    if (input.validation.context !== undefined) {
      args.push("-C", String(input.validation.context));
    } else {
      if (input.validation.before !== undefined) {
        args.push("-B", String(input.validation.before));
      }
      if (input.validation.after !== undefined) {
        args.push("-A", String(input.validation.after));
      }
    }
  }

  args.push("-e", input.validation.pattern, input.scopedPath);
  return args;
}

function isOutputStopReason(reason: TruncationReason | undefined): reason is OutputStopReason {
  return reason === "limit" || reason === "result_size";
}

function exclusionArgs(): string[] {
  const args: string[] = [];
  for (const pattern of SENSITIVE_GLOBS) {
    args.push("--glob", `!${pattern}`, "--glob", `!**/${pattern}`);
  }
  for (const dir of EXCLUDED_DIR_GLOBS) {
    args.push("--glob", `!${dir}/**`, "--glob", `!**/${dir}/**`);
  }
  return args;
}

function buildMetadata(input: {
  input: FileGrepInput;
  validation: Extract<GrepValidation, { ok: true }>;
  scopedPath: string;
}, result: {
  returned: number;
  truncated: boolean;
  truncatedReason?: TruncationReason;
  linesTruncated: number;
  durationMs: number;
}): GrepMetadata {
  return {
    pattern: input.validation.pattern,
    path: input.scopedPath,
    ...(input.input.glob === undefined ? {} : { glob: input.input.glob }),
    outputMode: input.validation.outputMode,
    returned: result.returned,
    offset: input.validation.offset,
    limit: input.validation.limit,
    truncated: result.truncated,
    ...(result.truncatedReason === undefined ? {} : { truncatedReason: result.truncatedReason }),
    maxResultChars: input.validation.maxResultChars,
    maxLineChars: input.validation.maxLineChars,
    linesTruncated: result.linesTruncated,
    binaryFilesSkipped: "rg-default",
    maxFilesize: input.validation.maxFilesize,
    durationMs: result.durationMs
  };
}

function isAllowedOutputLine(line: string, outputMode: GrepOutputMode): boolean {
  const path = extractPathFromOutputLine(line, outputMode);
  if (path === undefined) {
    return true;
  }
  return isAllowedWorkspacePath(path);
}

function extractPathFromOutputLine(line: string, outputMode: GrepOutputMode): string | undefined {
  if (line.length === 0 || line === "--") {
    return undefined;
  }
  if (outputMode === "files") {
    return line;
  }
  if (outputMode === "count") {
    return line.split(":")[0];
  }
  const withLineNumber = /^(.+?)(?::|-)\d+(?::|-)/u.exec(line);
  if (withLineNumber !== null) {
    return withLineNumber[1];
  }
  return line.split(":")[0];
}

function isAllowedWorkspacePath(path: string): boolean {
  const normalized = normalizeSlashes(path);
  if (normalized.length === 0 || normalized.startsWith("..") || isAbsolute(normalized)) {
    return false;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) {
    return false;
  }
  const name = segments.at(-1) ?? "";
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith(".env.")) {
    return false;
  }
  return !SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function toWorkspaceRelative(root: string, path: string): string {
  return normalizeSlashes(relative(root, path));
}

function normalizeSlashes(path: string): string {
  return path.split(sep).join("/");
}
