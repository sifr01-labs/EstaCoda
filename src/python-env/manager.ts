import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFileCronJobLock } from "../cron/cron-lock.js";
import type { CronJobLock } from "../cron/cron-lock.js";
import { redactString } from "../utils/redaction.js";

export type PythonEnvironmentStatus =
  | { kind: "missing" }
  | { kind: "corrupted"; reason: string }
  | { kind: "ready"; pythonBinary: string };

export type PythonEnvironmentOptions = {
  stateRoot: string;
};

type ManagedEnvironmentResult =
  | { ok: true; pythonBinary: string }
  | { ok: false; reason: string };

type CommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; reason: string };

const PINNED_FASTER_WHISPER = "faster-whisper==1.2.1";
const VENV_DIR_NAME = "python-env";
const INSTALL_LOCK_STALE_TIMEOUT_MS = 1_800_000;
const INSTALL_LOCK_ID = "managed-python-env";
const COMMAND_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_POLL_INTERVAL_MS = 500;
const DIAGNOSTIC_LIMIT_CHARS = 1_200;

const createPromises = new Map<string, Promise<ManagedEnvironmentResult>>();

export function resolveManagedVenvPath(stateRoot: string): string {
  return join(stateRoot, VENV_DIR_NAME);
}

export async function checkManagedEnvironment(
  options: PythonEnvironmentOptions
): Promise<PythonEnvironmentStatus> {
  const pythonBinary = venvPythonBinary(resolveManagedVenvPath(options.stateRoot));
  if (!existsSync(pythonBinary)) {
    return { kind: "missing" };
  }
  const verified = await verifyFasterWhisperImport(pythonBinary);
  if (verified.ok) {
    return { kind: "ready", pythonBinary };
  }
  return { kind: "corrupted", reason: verified.reason };
}

export async function findSystemPython(): Promise<string | undefined> {
  for (const candidate of ["python3", "python"]) {
    const result = await runCommand(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)"], {
      timeoutMs: VERIFY_TIMEOUT_MS
    });
    if (result.ok) {
      return candidate;
    }
  }
  return undefined;
}

export async function createManagedEnvironment(
  options: PythonEnvironmentOptions,
  onProgress?: (message: string) => void
): Promise<ManagedEnvironmentResult> {
  const key = options.stateRoot;
  const active = createPromises.get(key);
  if (active !== undefined) {
    return await active;
  }
  const promise = doCreateManagedEnvironment(options, onProgress);
  createPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    createPromises.delete(key);
  }
}

export function resolvePythonBinary(
  options: PythonEnvironmentOptions & { configOverride?: string }
): string {
  if (options.configOverride !== undefined && options.configOverride.trim().length > 0) {
    return options.configOverride;
  }
  return venvPythonBinary(resolveManagedVenvPath(options.stateRoot));
}

async function doCreateManagedEnvironment(
  options: PythonEnvironmentOptions,
  onProgress?: (message: string) => void
): Promise<ManagedEnvironmentResult> {
  await mkdir(options.stateRoot, { recursive: true });
  const lock = createFileCronJobLock({
    lockDir: join(options.stateRoot, "locks"),
    staleTimeoutMs: INSTALL_LOCK_STALE_TIMEOUT_MS
  });
  const lockResult = await lock.acquire(INSTALL_LOCK_ID);
  if (!lockResult.acquired) {
    return await waitForConcurrentInstall(options, lock, onProgress);
  }

  return await createWithAcquiredLock(options, lock, onProgress);
}

async function createWithAcquiredLock(
  options: PythonEnvironmentOptions,
  lock: CronJobLock,
  onProgress?: (message: string) => void
): Promise<ManagedEnvironmentResult> {
  try {
    const existing = await checkManagedEnvironment(options);
    if (existing.kind === "ready") {
      return { ok: true, pythonBinary: existing.pythonBinary };
    }

    const systemPython = await findSystemPython();
    if (systemPython === undefined) {
      return { ok: false, reason: "Python 3 is required for local STT but was not found." };
    }

    const venvPath = resolveManagedVenvPath(options.stateRoot);
    const pythonBinary = venvPythonBinary(venvPath);

    onProgress?.("Creating managed Python environment...");
    const venv = await runCommand(systemPython, ["-m", "venv", venvPath], {
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    if (!venv.ok) {
      return { ok: false, reason: formatVenvCreationFailure(venv) };
    }

    onProgress?.(`Installing ${PINNED_FASTER_WHISPER}...`);
    const pipCacheDir = join(options.stateRoot, "cache", "pip");
    await mkdir(pipCacheDir, { recursive: true });
    const install = await runCommand(pythonBinary, ["-m", "pip", "install", PINNED_FASTER_WHISPER], {
      cwd: venvPath,
      env: {
        ...process.env,
        PIP_CACHE_DIR: pipCacheDir
      },
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    if (!install.ok) {
      return { ok: false, reason: `Could not install faster-whisper. ${formatCommandFailure(install)}` };
    }

    onProgress?.("Verifying faster-whisper import...");
    const verified = await verifyFasterWhisperImport(pythonBinary);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }

    onProgress?.("Managed Python environment ready.");
    return { ok: true, pythonBinary };
  } finally {
    await lock.release(INSTALL_LOCK_ID);
  }
}

async function waitForConcurrentInstall(
  options: PythonEnvironmentOptions,
  lock: CronJobLock,
  onProgress?: (message: string) => void
): Promise<ManagedEnvironmentResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < INSTALL_LOCK_STALE_TIMEOUT_MS) {
    const status = await checkManagedEnvironment(options);
    if (status.kind === "ready") {
      return { ok: true, pythonBinary: status.pythonBinary };
    }
    const lockResult = await lock.acquire(INSTALL_LOCK_ID);
    if (lockResult.acquired) {
      return await createWithAcquiredLock(options, lock, onProgress);
    }
    await delay(INSTALL_LOCK_POLL_INTERVAL_MS);
  }
  return { ok: false, reason: "Timed out waiting for another EstaCoda process to finish Python environment setup." };
}

function venvPythonBinary(venvPath: string): string {
  return process.platform === "win32"
    ? join(venvPath, "Scripts", "python.exe")
    : join(venvPath, "bin", "python");
}

async function verifyFasterWhisperImport(pythonBinary: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runCommand(pythonBinary, ["-c", "import faster_whisper"], {
    timeoutMs: VERIFY_TIMEOUT_MS
  });
  if (result.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Managed Python exists but faster-whisper could not be imported. ${formatCommandFailure(result)}`
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        stdout,
        stderr,
        reason: `command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms`
      });
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        stdout,
        stderr,
        reason: error.message
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      resolve({
        ok: false,
        stdout,
        stderr,
        reason: `exit code ${code ?? "unknown"}`
      });
    });
  });
}

function appendBounded(existing: string, chunk: string): string {
  return truncateDiagnostic(`${existing}${chunk}`);
}

function formatCommandFailure(result: Extract<CommandResult, { ok: false }>): string {
  const details = truncateDiagnostic([result.reason, result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n"));
  return details.length === 0 ? "No diagnostic output was captured." : details;
}

function formatVenvCreationFailure(result: Extract<CommandResult, { ok: false }>): string {
  const diagnostic = formatCommandFailure(result);
  if (!looksLikeMissingVenvSupport(diagnostic)) {
    return `Failed to create Python environment. ${diagnostic}`;
  }
  return [
    "Failed to create Python environment because Python venv/ensurepip support is missing.",
    "EstaCoda can still run; only local faster-whisper transcription is unavailable until Python venv support is installed.",
    "Install Python venv support for your system Python, for example `sudo apt install python3.13-venv` or `sudo apt install python3-venv`, then retry `estacoda voice setup --stt-provider local`.",
    "Alternatively configure a Python that already has faster-whisper installed: `estacoda voice setup --stt-provider local --python-binary /path/to/python3`.",
    `Diagnostic: ${diagnostic}`
  ].join("\n");
}

function looksLikeMissingVenvSupport(diagnostic: string): boolean {
  return /ensurepip|python3(?:\.\d+)?-venv|No module named ensurepip|venv support/iu.test(diagnostic);
}

function truncateDiagnostic(value: string): string {
  const redacted = redactSensitive(value);
  if (redacted.length <= DIAGNOSTIC_LIMIT_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, DIAGNOSTIC_LIMIT_CHARS)}...[truncated]`;
}

function redactSensitive(value: string): string {
  return redactString(value, { strict: true, additionalKeys: ["key"] });
}
