import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  open,
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rm as nodeRm,
  writeFile as nodeWriteFile
} from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, tmpdir as nodeTmpdir } from "node:os";

export interface ChromeLauncherOptions {
  launchExecutable: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  headless?: boolean;
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  getuid?: () => number;
  readFile?: typeof nodeReadFile;
  writeFile?: typeof nodeWriteFile;
  rm?: typeof nodeRm;
  mkdir?: typeof nodeMkdir;
  mkdtemp?: typeof nodeMkdtemp;
  tmpdir?: () => string;
  spawn?: typeof nodeSpawn;
  fetch?: typeof globalThis.fetch;
  pathExists?: (path: string) => boolean | Promise<boolean>;
  readAppArmorUsernsRestriction?: () => Promise<string | undefined>;
  timeoutMs?: number;
}

export interface LaunchedChrome {
  endpoint: string;
  port: number;
  processId?: number;
  userDataDir: string;
  kill: () => Promise<void>;
}

const PORT_TIMEOUT = "Timed out waiting for Chrome DevToolsActivePort";
const SNAP_EXECUTABLE_HINT = "Set browser.launchExecutable to a working non-Snap Chrome or Chromium binary.";
const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const HTTP_RETRY_INTERVAL_MS = 100;
const APPARMOR_RESTRICT_USERNS_PATH = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const DEFAULT_CHROME_FLAGS = [
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows"
];
const BLOCKED_USER_FLAG_PREFIXES = [
  "--remote-debugging-port",
  "--remote-debugging-address",
  "--user-data-dir",
  "--profile-directory"
];

export async function launchChrome(options: ChromeLauncherOptions): Promise<LaunchedChrome> {
  const launchExecutable = normalizeExecutable(options.launchExecutable);
  const pathExists = options.pathExists;
  if (pathExists !== undefined && !(await pathExists(launchExecutable))) {
    throw new Error(`Chrome executable was not found: ${launchExecutable}`);
  }

  const launchArgs = browserDisplayArgs(normalizeUserArgs(options.launchArgs, "launchArgs"), options.headless);
  const chromeFlags = browserDisplayArgs(normalizeUserArgs(options.chromeFlags, "chromeFlags"), options.headless);
  const mkdir = options.mkdir ?? nodeMkdir;
  const mkdtemp = options.mkdtemp ?? nodeMkdtemp;
  const rm = options.rm ?? nodeRm;
  const tmpdir = options.tmpdir ?? nodeTmpdir;
  const readFile = options.readFile ?? nodeReadFile;
  const writeFile = options.writeFile ?? nodeWriteFile;
  const spawn = options.spawn ?? nodeSpawn;
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createdUserDataDir = options.userDataDir === undefined;
  const snap = createdUserDataDir && (options.platform ?? process.platform) === "linux"
    && await isSnapChromium(launchExecutable);
  const createProfile = async () => {
    if (!snap) return mkdtemp(join(tmpdir(), "estacoda-chrome-"));

    // Snap's /tmp is private. Keep preferences, downloads and the handshake
    // in a fresh profile visible to both Chromium and the host.
    const shared = join(options.homeDir ?? homedir(), "snap", "chromium", "common");
    try {
      await mkdir(shared, { recursive: true, mode: 0o700 });
      return await mkdtemp(join(shared, "estacoda-chrome-"));
    } catch (error) {
      throw new Error("Cannot create a shared Snap Chromium profile. " + SNAP_EXECUTABLE_HINT, { cause: error });
    }
  };
  const userDataDir = options.userDataDir ?? await createProfile();
  let child: ChildProcess | undefined;
  let startupOutput = "";
  const captureStartup = (chunk: Buffer | string) => { startupOutput = (startupOutput + String(chunk)).slice(-4096); };

  try {
    if (!createdUserDataDir) {
      await mkdir(userDataDir, { recursive: true });
    } else {
      await writeManagedDownloadPreferences({ userDataDir, mkdir, writeFile });
    }

    const args = [
      ...launchArgs,
      ...chromeFlags,
      ...(options.headless === false ? [] : ["--headless=new"]),
      ...DEFAULT_CHROME_FLAGS,
      `--user-data-dir=${userDataDir}`
    ];
    if (await shouldUseNoSandbox(options, [...launchArgs, ...chromeFlags])) {
      args.push("--no-sandbox");
    }

    child = spawn(launchExecutable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr?.on("data", captureStartup);

    const errorPromise = childErrorPromise(child);
    const port = await Promise.race([
      waitForDevToolsPort({
        child,
        readFile,
        userDataDir,
        timeoutMs
      }),
      errorPromise
    ]);
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForDevToolsHttp(endpoint, child, fetch, timeoutMs);
    child.stderr?.off("data", captureStartup);
    child.stderr?.resume();

    return {
      endpoint,
      port,
      processId: child.pid,
      userDataDir,
      kill: async () => {
        await cleanupChrome({
          child,
          userDataDir,
          deleteUserDataDir: createdUserDataDir,
          rm
        });
      }
    };
  } catch (error) {
    child?.stderr?.off("data", captureStartup);
    child?.stderr?.resume();
    // Classify the bounded stderr buffer rather than exposing arbitrary process
    // output (which can contain profile paths, URLs or credentials).
    const diagnostic = /(?:missing x server|\$DISPLAY|cannot open display)/iu.test(startupOutput) ? "display-server-unavailable"
      : /(?:singletonlock|profile.*in use|processsingleton)/iu.test(startupOutput) ? "profile-in-use"
      : /(?:no usable sandbox|sandbox.*(?:failed|not supported)|operation not permitted)/iu.test(startupOutput) ? "sandbox-startup-failed"
      : /permission denied/iu.test(startupOutput) ? "permission-denied" : undefined;
    const exit = child?.exitCode == null ? undefined : `exitCode=${child.exitCode}`;
    const signal = child?.signalCode == null ? undefined : `signal=${child.signalCode}`;
    await cleanupChrome({
      child,
      userDataDir,
      deleteUserDataDir: createdUserDataDir,
      rm
    });
    const snapHint = snap && error instanceof Error && error.message === PORT_TIMEOUT
      ? "Snap Chromium did not publish a visible handshake. " + SNAP_EXECUTABLE_HINT : undefined;
    const details = [exit, signal, diagnostic, snapHint].filter(Boolean).join(", ");
    if (details && error instanceof Error) throw new Error(`${error.message} (${details})`, { cause: error });
    throw error;
  }
}

async function isSnapChromium(executable: string): Promise<boolean> {
  if (executable === "/snap/bin/chromium" || executable === "/var/lib/snapd/snap/bin/chromium") return true;
  if (basename(executable) !== "chromium-browser") return false;

  // Ubuntu's transitional package installs a shell wrapper. A native Chromium
  // binary can have the same name, so inspect only a bounded prefix.
  try {
    const file = await open(executable, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.toString("utf8", 0, bytesRead);
      return prefix.startsWith("#!") && /^[ \t]*(?:exec[ \t]+)?["']?\/snap\/bin\/chromium["']?(?:[ \t]|$)/mu.test(prefix);
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

async function writeManagedDownloadPreferences(input: {
  userDataDir: string;
  mkdir: typeof nodeMkdir;
  writeFile: typeof nodeWriteFile;
}): Promise<void> {
  const profileDirectory = join(input.userDataDir, "Default");
  const defaultDownloadDirectory = join(input.userDataDir, "Downloads");
  await input.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await input.mkdir(defaultDownloadDirectory, { recursive: true, mode: 0o700 });
  await input.writeFile(join(profileDirectory, "Preferences"), JSON.stringify({
    download: {
      default_directory: defaultDownloadDirectory,
      directory_upgrade: true,
      prompt_for_download: false
    }
  }), { encoding: "utf8", mode: 0o600 });
}

function browserDisplayArgs(args: string[], headless: boolean | undefined): string[] {
  return headless === false
    ? args.filter((arg) => arg !== "--headless" && !arg.startsWith("--headless="))
    : args;
}

function normalizeExecutable(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("launchExecutable must be a non-empty string");
  }
  return value.trim();
}

function normalizeUserArgs(value: string[] | undefined, path: "launchArgs" | "chromeFlags"): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value.map((entry, index) => normalizeUserArg(entry, `${path}[${index}]`));
}

function normalizeUserArg(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (hasShellSyntax(normalized) || /\s/.test(normalized)) {
    throw new Error(`${path} must not contain shell syntax or embedded whitespace; pass each argument separately`);
  }
  if (isBlockedIsolationFlag(normalized)) {
    throw new Error(`${path} is not allowed because Chrome launcher manages ${blockedFlagName(normalized)} internally`);
  }
  if (hasProxyCredentials(normalized)) {
    throw new Error(`${path} must not include proxy credentials`);
  }
  return normalized;
}

function hasShellSyntax(value: string): boolean {
  return /[;&|<>`$\\\r\n"'()]/.test(value);
}

function isBlockedIsolationFlag(value: string): boolean {
  return BLOCKED_USER_FLAG_PREFIXES.some((flag) => value === flag || value.startsWith(`${flag}=`));
}

function blockedFlagName(value: string): string {
  return BLOCKED_USER_FLAG_PREFIXES.find((flag) => value === flag || value.startsWith(`${flag}=`)) ?? "this flag";
}

function hasProxyCredentials(value: string): boolean {
  if (!value.startsWith("--proxy-server=")) {
    return false;
  }
  return /^--proxy-server=https?:\/\/[^:@/\s]+:[^@/\s]+@/u.test(value);
}

async function shouldUseNoSandbox(options: ChromeLauncherOptions, userArgs: string[]): Promise<boolean> {
  if (userArgs.includes("--no-sandbox")) {
    return false;
  }
  if (options.getuid?.() === 0) {
    return true;
  }
  const restriction = options.readAppArmorUsernsRestriction !== undefined
    ? await options.readAppArmorUsernsRestriction()
    : await readDefaultAppArmorUsernsRestriction(options.readFile);
  return restriction?.trim() === "1";
}

async function readDefaultAppArmorUsernsRestriction(
  readFile: typeof nodeReadFile | undefined
): Promise<string | undefined> {
  try {
    const value = await (readFile ?? nodeReadFile)(APPARMOR_RESTRICT_USERNS_PATH, "utf8");
    return value;
  } catch {
    return undefined;
  }
}

function childErrorPromise(child: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    child.once("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function waitForDevToolsPort(options: {
  child: ChildProcess;
  readFile: typeof nodeReadFile;
  userDataDir: string;
  timeoutMs: number;
}): Promise<number> {
  const deadline = Date.now() + options.timeoutMs;
  const activePortPath = join(options.userDataDir, "DevToolsActivePort");
  let lastInvalidPort: string | undefined;

  while (Date.now() <= deadline) {
    if (childHasExited(options.child)) {
      throw new Error("Chrome exited before DevToolsActivePort was available");
    }
    try {
      const content = await options.readFile(activePortPath, "utf8");
      const firstLine = String(content).split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        return port;
      }
      lastInvalidPort = firstLine;
    } catch (error) {
      if (!isFileMissingError(error)) {
        throw error;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }

  if (lastInvalidPort !== undefined) {
    throw new Error(`Chrome DevToolsActivePort contained an invalid port: ${lastInvalidPort}`);
  }
  throw new Error(PORT_TIMEOUT);
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function waitForDevToolsHttp(
  endpoint: string,
  child: ChildProcess,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): Promise<void> {
  const url = `${endpoint}/json/version`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let lastSocketCode: string | undefined;

  while (!timeout.aborted) {
    if (childHasExited(child)) throw new Error(`Chrome exited before ${url} was ready`);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", redirect: "manual", signal: timeout });
    } catch (error) {
      if (timeout.aborted) break;
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "UND_ERR_SOCKET" && code !== "ECONNRESET" && code !== "ECONNREFUSED") throw error;
      lastSocketCode = code;
      await delay(Math.min(timeoutMs, HTTP_RETRY_INTERVAL_MS));
      continue;
    }

    // Only the headers are needed here. The target manager reads the version payload on attach.
    await response.body?.cancel();
    if (!response.ok && !(response.status >= 200 && response.status < 300)) {
      throw new Error(`Chrome DevTools endpoint health check failed for ${url} (HTTP ${response.status})`);
    }
    return;
  }
  if (childHasExited(child)) throw new Error(`Chrome exited before ${url} was ready`);
  const detail = lastSocketCode ? ` (last socket error: ${lastSocketCode})` : "";
  throw new Error(`Timed out waiting for Chrome DevTools HTTP at ${url}${detail}`);
}

async function cleanupChrome(options: {
  child: ChildProcess | undefined;
  userDataDir: string;
  deleteUserDataDir: boolean;
  rm: typeof nodeRm;
}): Promise<void> {
  const child = options.child;
  if (child !== undefined && !childHasExited(child) && !child.killed) {
    child.kill("SIGTERM");
  }
  if(child!==undefined&&!childHasExited(child)){
    for(let attempt=0;attempt<80&&!childHasExited(child);attempt++)await delay(25);
    if(!childHasExited(child)){child.kill('SIGKILL');for(let attempt=0;attempt<80&&!childHasExited(child);attempt++)await delay(25);}
    if(!childHasExited(child))throw new Error('Browser shutdown is unconfirmed; its temporary profile was retained.');
  }
  if (options.deleteUserDataDir) {
    await options.rm(options.userDataDir, { recursive: true, force: true, maxRetries:3, retryDelay:100 });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
