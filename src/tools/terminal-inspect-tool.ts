import { spawn, type ChildProcessByStdio } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Readable } from "node:stream";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { errorResult, resolveWorkspacePath } from "./workspace-paths.js";

export type TerminalInspectToolOptions = {
  workspaceRoot: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxOutputLines?: number;
  spawnImpl?: typeof spawn;
};

type TerminalInspectInput = {
  argv?: unknown;
};

type ValidatedArgv = {
  argv: string[];
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_MAX_OUTPUT_LINES = 500;
const KILL_GRACE_MS = 1_000;
const MAX_ARGV_LENGTH = 32;
const MAX_ARG_CHARS = 500;
const ALLOWED_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "git"
]);
const SAFE_GIT_CONFIG_ARGS = [
  "-c", "diff.external=",
  "-c", "core.externalDiff=",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "pager.status=false",
  "-c", "pager.diff=false",
  "-c", "pager.log=false",
  "-c", "pager.branch=false",
  "-c", "pager.grep=false",
  "-c", "interactive.diffFilter="
];
const SHELL_SYNTAX_PATTERN = /[;&|<>`]/u;
const COMMAND_SUBSTITUTION_PATTERN = /\$\(/u;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const GLOB_PATTERN = /[*?[\]{}]/u;

export function createTerminalInspectTool(options: TerminalInspectToolOptions): RegisteredTool<TerminalInspectInput> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
  const maxOutputChars = Math.max(1_000, Math.min(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS));
  const maxOutputLines = Math.max(50, Math.min(options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES, DEFAULT_MAX_OUTPUT_LINES));
  const spawnProcess = options.spawnImpl ?? spawn;

  return {
    name: "terminal.inspect",
    description: "Run a bounded read-only inspection command in the active workspace using argv only. No shell, pipes, redirection, command substitution, environment assignments, or arbitrary binaries are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Command argv. First item must be one of: pwd, ls, cat, head, tail, wc, stat, file, git."
        }
      },
      required: ["argv"],
      additionalProperties: false
    },
    riskClass: "read-only-local",
    toolsets: ["shell-readonly", "coding", "research"],
    progressLabel: "inspecting terminal",
    maxResultSizeChars: maxOutputChars,
    isAvailable: () => true,
    run: async (input) => {
      const canonicalRoot = await realpath(options.workspaceRoot);
      const validation = await validateArgv(canonicalRoot, input.argv);
      if (!validation.ok) {
        return validation;
      }

      return runInspectionCommand({
        argv: validation.argv,
        root: canonicalRoot,
        timeoutMs,
        maxOutputChars,
        maxOutputLines,
        spawnProcess
      });
    }
  };
}

async function validateArgv(root: string, rawArgv: unknown): Promise<(ToolResult & { ok: false }) | (ValidatedArgv & { ok: true })> {
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
    return errorResult("argv must be a non-empty string array") as ToolResult & { ok: false };
  }
  if (rawArgv.length > MAX_ARGV_LENGTH) {
    return errorResult(`argv must contain at most ${MAX_ARGV_LENGTH} entries`) as ToolResult & { ok: false };
  }
  if (!rawArgv.every((value): value is string => typeof value === "string")) {
    return errorResult("argv entries must be strings") as ToolResult & { ok: false };
  }

  const argv = rawArgv.map((arg) => arg.trim());
  const structuralError = validateStructuralArgv(argv);
  if (structuralError !== undefined) {
    return errorResult(structuralError) as ToolResult & { ok: false };
  }

  const command = argv[0];
  if (!ALLOWED_COMMANDS.has(command)) {
    return errorResult(`command is not allowed for terminal.inspect: ${command}`) as ToolResult & { ok: false };
  }

  const commandError = await validateCommandArgs(root, argv);
  if (commandError !== undefined) {
    return errorResult(commandError) as ToolResult & { ok: false };
  }

  return { ok: true, argv };
}

function validateStructuralArgv(argv: string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg.length === 0) {
      return "argv entries must be non-empty strings";
    }
    if (arg.length > MAX_ARG_CHARS) {
      return `argv entry ${index} exceeds ${MAX_ARG_CHARS} characters`;
    }
    if (CONTROL_CHAR_PATTERN.test(arg)) {
      return "argv entries must not contain control characters";
    }
    if (SHELL_SYNTAX_PATTERN.test(arg) || COMMAND_SUBSTITUTION_PATTERN.test(arg)) {
      return "terminal.inspect does not allow shell syntax";
    }
    if (ENV_ASSIGNMENT_PATTERN.test(arg)) {
      return "terminal.inspect does not allow environment assignments";
    }
  }

  const command = argv[0];
  if (command.includes("/") || command.includes("\\")) {
    return "terminal.inspect does not allow executable paths";
  }

  return undefined;
}

async function validateCommandArgs(root: string, argv: string[]): Promise<string | undefined> {
  const [command, ...args] = argv;
  switch (command) {
    case "pwd":
      return args.length === 0 ? undefined : "pwd does not accept arguments";
    case "ls":
      return validateLsArgs(root, args);
    case "cat":
      return validateExistingPathCommand(root, "cat", args);
    case "head":
    case "tail":
      return validateHeadTailArgs(root, command, args);
    case "wc":
      return validateWcArgs(root, args);
    case "stat":
    case "file":
      return validateExistingPathCommand(root, command, args);
    case "git":
      return validateGitArgs(root, args);
    default:
      return `command is not allowed for terminal.inspect: ${command}`;
  }
}

async function validateLsArgs(root: string, args: string[]): Promise<string | undefined> {
  const pathArgs: string[] = [];
  let optionsDone = false;
  for (const arg of args) {
    if (!optionsDone && arg === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith("-")) {
      if (!["-1", "-a", "-l", "-la", "-al", "-lh", "-lah", "-alh", "--color=never"].includes(arg)) {
        return `ls option is not allowed: ${arg}`;
      }
      continue;
    }
    pathArgs.push(arg);
  }

  return validatePathArgs(root, pathArgs.length === 0 ? ["."] : pathArgs, { command: "ls", allowMissing: false });
}

async function validateExistingPathCommand(root: string, command: string, args: string[]): Promise<string | undefined> {
  if (args.length === 0) {
    return `${command} requires at least one workspace path`;
  }
  if (args.some((arg) => arg.startsWith("-"))) {
    return `${command} options are not allowed`;
  }
  return validatePathArgs(root, args, { command, allowMissing: false });
}

async function validateHeadTailArgs(root: string, command: "head" | "tail", args: string[]): Promise<string | undefined> {
  const pathArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-n") {
      const count = args[++index];
      if (!isPositiveIntegerText(count)) {
        return `${command} -n requires a positive line count`;
      }
      continue;
    }
    if (/^-n\d+$/u.test(arg) || /^--lines=\d+$/u.test(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return `${command} option is not allowed: ${arg}`;
    }
    pathArgs.push(arg);
  }
  if (pathArgs.length === 0) {
    return `${command} requires at least one workspace path`;
  }
  return validatePathArgs(root, pathArgs, { command, allowMissing: false });
}

async function validateWcArgs(root: string, args: string[]): Promise<string | undefined> {
  const pathArgs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!/^-[lwcmb]+$/u.test(arg)) {
        return `wc option is not allowed: ${arg}`;
      }
      continue;
    }
    pathArgs.push(arg);
  }
  if (pathArgs.length === 0) {
    return "wc requires at least one workspace path";
  }
  return validatePathArgs(root, pathArgs, { command: "wc", allowMissing: false });
}

async function validateGitArgs(root: string, args: string[]): Promise<string | undefined> {
  const [subcommand, ...subArgs] = args;
  if (subcommand === undefined) {
    return "git requires an allowed read-only subcommand";
  }
  if (subcommand.startsWith("-")) {
    return "git global options are not allowed";
  }

  switch (subcommand) {
    case "status":
      return validateGitStatusArgs(root, subArgs);
    case "diff":
      return validateGitPathspecArgs(root, "git diff", subArgs, new Set([
        "--stat",
        "--name-only",
        "--name-status",
        "--cached",
        "--staged",
        "--color=never",
        "--no-color"
      ]));
    case "log":
      return validateGitLogArgs(root, subArgs);
    case "branch":
      return validateGitSimpleOptions("git branch", subArgs, new Set(["--show-current", "--list", "-a", "-r", "-v", "--color=never", "--no-color"]));
    case "remote":
      return subArgs.length === 0 || (subArgs.length === 1 && subArgs[0] === "-v")
        ? undefined
        : "git remote only allows no arguments or -v";
    case "ls-files":
      return validateGitPathspecArgs(root, "git ls-files", subArgs, new Set([
        "--stage",
        "--others",
        "--cached",
        "--deleted",
        "--modified",
        "--exclude-standard"
      ]));
    case "grep":
      return validateGitGrepArgs(root, subArgs);
    default:
      return `git subcommand is not allowed: ${subcommand}`;
  }
}

async function validateGitStatusArgs(root: string, args: string[]): Promise<string | undefined> {
  return validateGitPathspecArgs(root, "git status", args, new Set([
    "--short",
    "--porcelain",
    "--porcelain=v1",
    "--branch",
    "--untracked-files=all",
    "--untracked-files=no",
    "--ignored=no",
    "--no-renames"
  ]));
}

async function validateGitLogArgs(root: string, args: string[]): Promise<string | undefined> {
  const pathArgs: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash) {
      pathArgs.push(arg);
      continue;
    }
    if (["--oneline", "--decorate", "--stat", "--name-only", "--color=never", "--no-color"].includes(arg)) {
      continue;
    }
    if (/^--max-count=\d+$/u.test(arg) || /^-n\d+$/u.test(arg)) {
      continue;
    }
    if (arg === "-n") {
      const count = args[++index];
      if (!isPositiveIntegerText(count)) {
        return "git log -n requires a positive count";
      }
      continue;
    }
    return `git log argument is not allowed: ${arg}`;
  }
  return validatePathArgs(root, pathArgs, { command: "git log", allowMissing: true, rejectColon: true });
}

function validateGitSimpleOptions(command: string, args: string[], allowedOptions: ReadonlySet<string>): string | undefined {
  for (const arg of args) {
    if (!allowedOptions.has(arg)) {
      return `${command} argument is not allowed: ${arg}`;
    }
  }
  return undefined;
}

async function validateGitPathspecArgs(
  root: string,
  command: string,
  args: string[],
  allowedOptions: ReadonlySet<string>
): Promise<string | undefined> {
  const pathArgs: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (!allowedOptions.has(arg)) {
        return `${command} option is not allowed: ${arg}`;
      }
      continue;
    }
    if (!afterDoubleDash && !arg.startsWith("-")) {
      return `${command} path arguments must follow --`;
    }
    pathArgs.push(arg);
  }
  return validatePathArgs(root, pathArgs, { command, allowMissing: true, rejectColon: true });
}

async function validateGitGrepArgs(root: string, args: string[]): Promise<string | undefined> {
  const pathArgs: string[] = [];
  let patternSeen = false;
  let afterDoubleDash = false;
  for (const arg of args) {
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!patternSeen && !afterDoubleDash && ["-n", "-i", "-F", "--line-number", "--ignore-case", "--fixed-strings", "--color=never", "--no-color"].includes(arg)) {
      continue;
    }
    if (!patternSeen) {
      if (arg.startsWith("-") && !afterDoubleDash) {
        return `git grep option is not allowed: ${arg}`;
      }
      patternSeen = true;
      continue;
    }
    pathArgs.push(arg);
  }
  if (!patternSeen) {
    return "git grep requires a pattern";
  }
  return validatePathArgs(root, pathArgs, { command: "git grep", allowMissing: true, rejectColon: true });
}

async function validatePathArgs(
  root: string,
  paths: string[],
  options: { command: string; allowMissing: boolean; rejectColon?: boolean }
): Promise<string | undefined> {
  for (const path of paths) {
    if (path.length === 0) {
      return `${options.command} path arguments must be non-empty`;
    }
    if (path.startsWith("-")) {
      return `${options.command} path arguments must not start with -`;
    }
    if (GLOB_PATTERN.test(path)) {
      return `${options.command} path globs are not allowed`;
    }
    if (options.rejectColon === true && path.includes(":")) {
      return `${options.command} revision or magic pathspec syntax is not allowed`;
    }
    const resolved = await resolveWorkspacePath(root, path, {
      allowDirectory: true,
      allowMissingLeaf: options.allowMissing
    });
    if (!resolved.ok) {
      return resolved.content;
    }
    const resolvedRoot = await realpath(root).catch(() => root);
    const rel = relative(resolvedRoot, resolved.path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return "path is outside the trusted workspace";
    }
    if (!options.allowMissing) {
      const stats = await stat(resolved.path).catch(() => undefined);
      if (stats === undefined) {
        return `${options.command} path does not exist: ${path}`;
      }
    }
  }
  return undefined;
}

function isPositiveIntegerText(value: string | undefined): boolean {
  return typeof value === "string" && /^[1-9]\d{0,5}$/u.test(value);
}

function runInspectionCommand(input: {
  argv: string[];
  root: string;
  timeoutMs: number;
  maxOutputChars: number;
  maxOutputLines: number;
  spawnProcess: typeof spawn;
}): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const executableArgv = buildExecutableArgv(input.argv);
    const [command, ...args] = executableArgv;
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = input.spawnProcess(command!, args, {
        cwd: input.root,
        env: command === "git" ? safeGitEnv() : safeInspectEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolveResult(errorResult(error instanceof Error ? error.message : "failed to start inspection command"));
      return;
    }

    const stdout = createBoundedCollector(input.maxOutputChars, input.maxOutputLines);
    const stderr = createBoundedCollector(Math.min(4_000, input.maxOutputChars), Math.min(200, input.maxOutputLines));
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
      }, KILL_GRACE_MS);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => {
      closed = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      resolveResult(errorResult(error.message));
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }

      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      const content = renderInspectionContent(stdoutResult.text, stderrResult.text);
      const commandLabel = redactSensitiveText(JSON.stringify(input.argv));

      resolveResult({
        ok: code === 0 && signal === null,
        content,
        metadata: {
          argv: input.argv.map((arg) => redactSensitiveText(arg)),
          code,
          signal,
          timeoutMs: input.timeoutMs,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdoutLines: stdoutResult.lines,
          stderrLines: stderrResult.lines,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
          _estacoda_context_summary: terminalInspectContextSummary({
            command: commandLabel,
            code,
            stdoutLines: stdoutResult.lines,
            stderrLines: stderrResult.lines,
            timedOut
          })
        }
      });
    });
  });
}

function buildExecutableArgv(argv: string[]): string[] {
  if (argv[0] !== "git") {
    return argv;
  }

  const [, subcommand, ...rest] = argv;
  const hardenedRest = subcommand === "diff"
    ? ["--no-ext-diff", "--no-textconv", ...rest]
    : subcommand === "grep"
      ? buildGitGrepExecutableRest(rest)
    : rest;
  return ["git", "--no-pager", ...SAFE_GIT_CONFIG_ARGS, subcommand!, ...hardenedRest];
}

function buildGitGrepExecutableRest(rest: string[]): string[] {
  const options: string[] = [];
  const paths: string[] = [];
  let pattern: string | undefined;
  let afterDoubleDash = false;

  for (const arg of rest) {
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (pattern === undefined && !afterDoubleDash && ["-n", "-i", "-F", "--line-number", "--ignore-case", "--fixed-strings", "--color=never", "--no-color"].includes(arg)) {
      options.push(arg);
      continue;
    }
    if (pattern === undefined) {
      pattern = arg;
      continue;
    }
    paths.push(arg);
  }

  return [...options, pattern!, "--", ...paths];
}

function safeGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    LC_ALL: "C",
    LANG: "C"
  };
}

function safeInspectEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C"
  };
}

function createBoundedCollector(maxChars: number, maxLines: number) {
  let text = "";
  let truncated = false;

  return {
    append(chunk: Buffer) {
      if (text.length >= maxChars * 2) {
        truncated = true;
        return;
      }
      text += chunk.toString("utf8");
      if (text.length > maxChars * 2) {
        text = text.slice(0, maxChars * 2);
        truncated = true;
      }
    },
    result() {
      const redacted = redactSensitiveText(text);
      const bounded = boundOutput(redacted, maxChars, maxLines);
      return {
        text: bounded.text,
        lines: lineCount(bounded.text),
        truncated: truncated || bounded.truncated
      };
    }
  };
}

function boundOutput(value: string, maxChars: number, maxLines: number): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const lineBounded = lines.length > maxLines
    ? lines.slice(0, maxLines).join("\n")
    : normalized;
  const lineTruncated = lines.length > maxLines;
  if (lineBounded.length <= maxChars) {
    return {
      text: lineTruncated ? `${lineBounded}\n[output truncated]` : lineBounded,
      truncated: lineTruncated
    };
  }
  return {
    text: `${lineBounded.slice(0, Math.max(0, maxChars - 19)).trimEnd()}\n[output truncated]`,
    truncated: true
  };
}

function renderInspectionContent(stdout: string, stderr: string): string {
  const sections = [
    stdout.trimEnd().length === 0 ? undefined : `stdout:\n${stdout.trimEnd()}`,
    stderr.trimEnd().length === 0 ? undefined : `stderr:\n${stderr.trimEnd()}`
  ].filter((section): section is string => section !== undefined);
  return sections.length === 0 ? "(no output)" : sections.join("\n\n");
}

function terminalInspectContextSummary(input: {
  command: string;
  code: number | null;
  stdoutLines: number;
  stderrLines: number;
  timedOut: boolean;
}): string {
  return [
    `Inspection ${input.command} exited with code ${input.code ?? "signal"}.`,
    `stdout: ${input.stdoutLines} lines.`,
    `stderr: ${input.stderrLines} lines.`,
    input.timedOut ? "Timed out." : undefined
  ].filter((part): part is string => part !== undefined).join(" ").slice(0, 500);
}

function lineCount(value: string): number {
  const trimmed = value.replace(/(?:\r\n|\r|\n)$/u, "");
  return trimmed.length === 0 ? 0 : trimmed.split(/\r\n|\r|\n/u).length;
}
