import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, rename, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFileCronJobLock } from "../cron/cron-lock.js";
import type { CronJobLock } from "../cron/cron-lock.js";
import type { ManagedPythonCapabilityEnvSpec } from "./capability-registry.js";
import { requireRegisteredPythonCapabilitySpec } from "./capability-registry.js";
import { resolveManagedPythonCapabilityPaths } from "./capability-paths.js";
import { boundDiagnostic } from "./diagnostics.js";
import type { ManagedPythonCapabilityEnvManifest } from "./manifest.js";
import {
  readManagedPythonCapabilityManifest,
  writeManagedPythonCapabilityManifest
} from "./manifest.js";
import { fingerprintManagedPythonCapabilitySpec } from "./spec-hash.js";

export type ManagedPythonCapabilityFailureReason =
  | "not_configured"
  | "python_missing"
  | "venv_missing"
  | "venv_create_failed"
  | "install_required"
  | "upgrade_required"
  | "pip_install_failed"
  | "import_verify_failed"
  | "permission_denied"
  | "disk_insufficient"
  | "broken_manifest"
  | "broken_env";

export type ManagedPythonCapabilityFailure = {
  reason: ManagedPythonCapabilityFailureReason;
  message: string;
  diagnostic?: string;
};

export type ManagedPythonCapabilityInstallStatus =
  | {
      ok: true;
      status: "installed" | "verified";
      capabilityId: string;
      version: string;
      specHash: string;
      installedGroups: string[];
      installedPackages: string[];
      pythonPath: string;
      envPath: string;
      manifest: ManagedPythonCapabilityEnvManifest;
    }
  | ({
      ok: false;
      capabilityId: string;
      expectedSpecHash?: string;
      manifest?: ManagedPythonCapabilityEnvManifest;
    } & ManagedPythonCapabilityFailure);

export type ManagedPythonCapabilityInstallResult =
  | {
      ok: true;
      capabilityId: string;
      version: string;
      specHash: string;
      installedGroups: string[];
      installedPackages: string[];
      pythonPath: string;
      envPath: string;
      manifest: ManagedPythonCapabilityEnvManifest;
    }
  | ({
      ok: false;
      capabilityId: string;
    } & ManagedPythonCapabilityFailure);

export type ManagedPythonCapabilityInstallOptions = {
  stateRoot: string;
  capabilityId: string;
  groups?: string[];
  now?: () => Date;
  runner?: PythonEnvCommandRunner;
  diskInfo?: PythonEnvDiskInfoProvider;
  onProgress?: (message: string, stage?: "preparing"|"installing"|"verifying") => void;
};

export type PythonEnvCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; reason: string; code?: string };

export type PythonEnvCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<PythonEnvCommandResult>;

export type PythonEnvDiskInfo = {
  freeBytes: number;
};

export type PythonEnvDiskInfoProvider = (path: string) => Promise<PythonEnvDiskInfo>;

type EffectiveCapabilitySpec = {
  spec: ManagedPythonCapabilityEnvSpec;
  specHash: string;
  packages: string[];
  verifyImports: string[];
  selectedGroups: string[];
  estimatedInstallSizeMb?: number;
};

const COMMAND_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_STALE_TIMEOUT_MS = 1_800_000;
const INSTALL_LOCK_POLL_INTERVAL_MS = 500;
const activeCapabilityInstalls = new Map<string, Promise<ManagedPythonCapabilityInstallResult>>();

export async function checkManagedPythonCapabilityStatus(
  options: ManagedPythonCapabilityInstallOptions
): Promise<ManagedPythonCapabilityInstallStatus> {
  const effective = resolveEffectiveSpec(options.capabilityId, options.groups ?? []);
  if (!effective.ok) {
    return { ok: false, capabilityId: options.capabilityId, ...effective.failure };
  }
  const paths = resolveManagedPythonCapabilityPaths({
    stateRoot: options.stateRoot,
    capabilityId: options.capabilityId
  });
  let manifest: ManagedPythonCapabilityEnvManifest | undefined;
  try {
    manifest = await readManagedPythonCapabilityManifest({
      stateRoot: options.stateRoot,
      capabilityId: options.capabilityId
    });
  } catch (error) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "broken_manifest",
      message: "Managed Python capability manifest could not be read.",
      diagnostic: boundDiagnostic(formatUnknownError(error)),
      expectedSpecHash: effective.value.specHash
    };
  }
  if (manifest === undefined) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
      expectedSpecHash: effective.value.specHash
    };
  }
  if (manifest.specHash !== effective.value.specHash) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "upgrade_required",
      message: "Managed Python capability spec changed since this environment was installed.",
      expectedSpecHash: effective.value.specHash,
      manifest
    };
  }
  if (!existsSync(paths.pythonPath)) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "venv_missing",
      message: "Managed Python capability manifest exists but the virtualenv Python is missing.",
      expectedSpecHash: effective.value.specHash,
      manifest
    };
  }
  if (manifest.status === "broken") {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "broken_env",
      message: "Managed Python capability manifest marks this environment as broken.",
      expectedSpecHash: effective.value.specHash,
      manifest
    };
  }
  if (manifest.status === "installing") {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: "broken_env",
      message: "Managed Python capability installation did not complete.",
      expectedSpecHash: effective.value.specHash,
      manifest
    };
  }
  return {
    ok: true,
    status: manifest.status,
    capabilityId: options.capabilityId,
    version: manifest.version,
    specHash: manifest.specHash,
    installedGroups: [...manifest.installedGroups],
    installedPackages: [...manifest.installedPackages],
    pythonPath: paths.pythonPath,
    envPath: paths.envPath,
    manifest
  };
}

export async function installManagedPythonCapabilityEnvironment(
  options: ManagedPythonCapabilityInstallOptions
): Promise<ManagedPythonCapabilityInstallResult> {
  const key = `${options.stateRoot}:${options.capabilityId}`;
  const active = activeCapabilityInstalls.get(key);
  if (active !== undefined) {
    await active;
    const status = await checkManagedPythonCapabilityStatus(options);
    if (status.ok) {
      return status;
    }
  }
  const promise = doInstallManagedPythonCapabilityEnvironment(options);
  activeCapabilityInstalls.set(key, promise);
  try {
    return await promise;
  } finally {
    activeCapabilityInstalls.delete(key);
  }
}

export async function verifyManagedPythonCapabilityEnvironment(
  options: ManagedPythonCapabilityInstallOptions
): Promise<ManagedPythonCapabilityInstallResult> {
  const effective = resolveEffectiveSpec(options.capabilityId, options.groups ?? []);
  if (!effective.ok) {
    return { ok: false, capabilityId: options.capabilityId, ...effective.failure };
  }
  const status = await checkManagedPythonCapabilityStatus(options);
  if (!status.ok) {
    const { ok: _ok, capabilityId: _capabilityId, ...failure } = status;
    return { ok: false, capabilityId: options.capabilityId, ...failure };
  }
  const runner = options.runner ?? runCommand;
  const verified = await verifyImports(status.pythonPath, effective.value.verifyImports, runner);
  if (!verified.ok) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      ...commandFailure(
        "import_verify_failed",
        "Managed Python capability import verification failed.",
        verified
      )
    };
  }
  const now = options.now ?? (() => new Date());
  const verifiedAt = now().toISOString();
  const manifest = await writeManifest(options, effective.value, {
    envPath: status.envPath,
    pythonPath: status.pythonPath
  }, {
    createdAt: status.manifest.createdAt,
    updatedAt: verifiedAt,
    verifiedAt,
    status: "verified"
  });
  return {
    ok: true,
    capabilityId: options.capabilityId,
    version: manifest.version,
    specHash: manifest.specHash,
    installedGroups: [...manifest.installedGroups],
    installedPackages: [...manifest.installedPackages],
    pythonPath: status.pythonPath,
    envPath: status.envPath,
    manifest
  };
}

async function doInstallManagedPythonCapabilityEnvironment(
  options: ManagedPythonCapabilityInstallOptions
): Promise<ManagedPythonCapabilityInstallResult> {
  const effective = resolveEffectiveSpec(options.capabilityId, options.groups ?? []);
  if (!effective.ok) {
    return { ok: false, capabilityId: options.capabilityId, ...effective.failure };
  }
  try {
    await mkdir(options.stateRoot, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: isPermissionError(error) ? "permission_denied" : "broken_env",
      message: "Could not create EstaCoda state root for managed Python capability.",
      diagnostic: boundDiagnostic(formatUnknownError(error))
    };
  }
  const lock = createFileCronJobLock({
    lockDir: join(options.stateRoot, "locks", "python-envs"),
    staleTimeoutMs: INSTALL_LOCK_STALE_TIMEOUT_MS
  });
  const lockId = `python-env:${options.capabilityId}`;
  let lockResult: Awaited<ReturnType<CronJobLock["acquire"]>>;
  try {
    lockResult = await lock.acquire(lockId);
  } catch (error) {
    return {
      ok: false,
      capabilityId: options.capabilityId,
      reason: isPermissionError(error) ? "permission_denied" : "broken_env",
      message: "Could not acquire managed Python capability install lock.",
      diagnostic: boundDiagnostic(formatUnknownError(error))
    };
  }
  if (!lockResult.acquired) {
    return await waitForConcurrentCapabilityInstall(options, lock, lockId);
  }
  return await installWithAcquiredLock(options, effective.value, lock, lockId);
}

async function installWithAcquiredLock(
  options: ManagedPythonCapabilityInstallOptions,
  effective: EffectiveCapabilitySpec,
  lock: CronJobLock,
  lockId: string
): Promise<ManagedPythonCapabilityInstallResult> {
  try {
    const existing = await checkManagedPythonCapabilityStatus(options);
    if (existing.ok && existing.status === "verified") {
      return existing;
    }
    const paths = resolveManagedPythonCapabilityPaths({
      stateRoot: options.stateRoot,
      capabilityId: options.capabilityId
    });
    const runner = options.runner ?? runCommand;
    const now = options.now ?? (() => new Date());

    const systemPython = await findSystemPython(runner, effective.spec.pythonVersion);
    if (systemPython === undefined) {
      return {
        ok: false,
        capabilityId: options.capabilityId,
        reason: "python_missing",
        message: `Python ${effective.spec.pythonVersion ?? "3"} or newer is required. Install a compatible Python interpreter, then retry setup.`
      };
    }

    const diskCheck = await checkDiskRequirement(options, effective);
    if (!diskCheck.ok) {
      return { ok: false, capabilityId: options.capabilityId, ...diskCheck.failure };
    }

    const existingManifest = existing.ok ? existing.manifest : existing.manifest;
    const createdAt = existingManifest?.createdAt ?? now().toISOString();

    // A venv cannot safely change its base interpreter in place. Preserve the
    // previous managed environment for inspection and create a clean replacement.
    // Never follow a linked environment or a path supplied by its manifest.
    if (existsSync(paths.envPath)) {
      const info = await lstat(paths.envPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid managed environment directory");
      await rename(paths.envPath, `${paths.envPath}.previous-${randomUUID()}`);
    }
    options.onProgress?.(`Creating managed Python environment for ${options.capabilityId}...`, "preparing");
    const venv = await runner(systemPython, ["-m", "venv", paths.envPath], {
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    if (!venv.ok) {
      const failure = commandFailure("venv_create_failed", "Could not create managed Python capability virtualenv.", venv);
      await writeBrokenManifest(options, effective, paths, createdAt, now, failure).catch(() => undefined);
      return { ok: false, capabilityId: options.capabilityId, ...failure };
    }

    await writeManifest(options, effective, paths, {
      createdAt,
      updatedAt: now().toISOString(),
      status: "installing"
    });

    if (effective.packages.length > 0) {
      options.onProgress?.(`Installing managed Python packages for ${options.capabilityId}...`, "installing");
      await mkdir(paths.pipCacheDir, { recursive: true }).catch((error) => {
        throw permissionAwareError(error, "Could not create pip cache for managed Python capability.");
      });
      const install = await runner(paths.pythonPath, ["-m", "pip", "install", ...effective.packages], {
        cwd: paths.envPath,
        env: {
          ...process.env,
          PIP_CACHE_DIR: paths.pipCacheDir
        },
        timeoutMs: COMMAND_TIMEOUT_MS
      });
      if (!install.ok) {
        const failure = commandFailure("pip_install_failed", "Could not install managed Python capability packages.", install);
        await writeBrokenManifest(options, effective, paths, createdAt, now, failure).catch(() => undefined);
        return { ok: false, capabilityId: options.capabilityId, ...failure };
      }
    }

    await writeManifest(options, effective, paths, {
      createdAt,
      updatedAt: now().toISOString(),
      status: "installed"
    });

    options.onProgress?.(`Verifying managed Python capability ${options.capabilityId}...`, "verifying");
    const verified = await verifyImports(paths.pythonPath, effective.verifyImports, runner);
    if (!verified.ok) {
      const failure = commandFailure("import_verify_failed", "Managed Python capability import verification failed.", verified);
      await writeBrokenManifest(options, effective, paths, createdAt, now, failure).catch(() => undefined);
      return { ok: false, capabilityId: options.capabilityId, ...failure };
    }

    const verifiedAt = now().toISOString();
    const manifest = await writeManifest(options, effective, paths, {
      createdAt,
      updatedAt: verifiedAt,
      verifiedAt,
      status: "verified"
    });
    options.onProgress?.(`Managed Python capability ${options.capabilityId} ready.`);
    return {
      ok: true,
      capabilityId: options.capabilityId,
      version: manifest.version,
      specHash: manifest.specHash,
      installedGroups: [...manifest.installedGroups],
      installedPackages: [...manifest.installedPackages],
      pythonPath: paths.pythonPath,
      envPath: paths.envPath,
      manifest
    };
  } catch (error) {
    const failure = error instanceof PythonEnvPermissionError
      ? {
          reason: "permission_denied" as const,
          message: error.message,
          diagnostic: boundDiagnostic(formatUnknownError(error.cause ?? error))
        }
      : {
          reason: "broken_env" as const,
          message: "Managed Python capability setup failed unexpectedly.",
          diagnostic: boundDiagnostic(formatUnknownError(error))
        };
    return { ok: false, capabilityId: options.capabilityId, ...failure };
  } finally {
    await lock.release(lockId);
  }
}

async function waitForConcurrentCapabilityInstall(
  options: ManagedPythonCapabilityInstallOptions,
  lock: CronJobLock,
  lockId: string
): Promise<ManagedPythonCapabilityInstallResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < INSTALL_LOCK_STALE_TIMEOUT_MS) {
    const status = await checkManagedPythonCapabilityStatus(options);
    if (status.ok && status.status === "verified") {
      return status;
    }
    const lockResult = await lock.acquire(lockId);
    if (lockResult.acquired) {
      const effective = resolveEffectiveSpec(options.capabilityId, options.groups ?? []);
      if (!effective.ok) {
        await lock.release(lockId);
        return { ok: false, capabilityId: options.capabilityId, ...effective.failure };
      }
      return await installWithAcquiredLock(options, effective.value, lock, lockId);
    }
    await delay(INSTALL_LOCK_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    capabilityId: options.capabilityId,
    reason: "broken_env",
    message: "Timed out waiting for another EstaCoda process to finish managed Python capability setup."
  };
}

export async function findSystemPython(runner: PythonEnvCommandRunner, minimum?: string): Promise<string | undefined> {
  if (minimum !== undefined && !/^3\.\d{1,2}$/.test(minimum)) throw new Error("Invalid registered Python version requirement");
  const script = minimum === undefined
    ? "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)"
    : `import sys; raise SystemExit(0 if sys.version_info[0] == 3 and sys.version_info[:2] >= (3, ${Number(minimum.split(".")[1])}) else 1)`;
  // Explicit operator installation locations, without broadening the bridge's
  // PATH for other tools or accepting model-supplied executable paths.
  const candidates = ["python3", "python", ...(process.platform === "darwin" ? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", ...[14,13,12,11,10].flatMap(minor => [`/opt/homebrew/bin/python3.${minor}`, `/usr/local/bin/python3.${minor}`])] : [])];
  for (const candidate of candidates) {
    const result = await runner(candidate, ["-c", script], {
      timeoutMs: VERIFY_TIMEOUT_MS
    });
    if (result.ok) {
      return candidate;
    }
  }
  return undefined;
}

async function verifyImports(
  pythonPath: string,
  imports: string[],
  runner: PythonEnvCommandRunner
): Promise<PythonEnvCommandResult> {
  if (imports.length === 0) {
    return { ok: true, stdout: "", stderr: "" };
  }
  const script = [
    "import importlib",
    `for name in ${JSON.stringify(imports)}:`,
    "    importlib.import_module(name)"
  ].join("\n");
  return await runner(pythonPath, ["-c", script], {
    timeoutMs: VERIFY_TIMEOUT_MS
  });
}

async function checkDiskRequirement(
  options: ManagedPythonCapabilityInstallOptions,
  effective: EffectiveCapabilitySpec
): Promise<{ ok: true } | { ok: false; failure: ManagedPythonCapabilityFailure }> {
  const estimatedInstallSizeMb = effective.estimatedInstallSizeMb;
  if (estimatedInstallSizeMb === undefined || estimatedInstallSizeMb <= 0) {
    return { ok: true };
  }
  try {
    const diskInfo = await (options.diskInfo ?? getDiskInfo)(options.stateRoot);
    const requiredBytes = estimatedInstallSizeMb * 1024 * 1024;
    if (diskInfo.freeBytes < requiredBytes) {
      return {
        ok: false,
        failure: {
          reason: "disk_insufficient",
          message: "Insufficient free disk space for managed Python capability setup.",
          diagnostic: boundDiagnostic(`required=${requiredBytes} free=${diskInfo.freeBytes}`)
        }
      };
    }
  } catch (error) {
    if (isPermissionError(error)) {
      return {
        ok: false,
        failure: {
          reason: "permission_denied",
          message: "Could not inspect free disk space for managed Python capability setup.",
          diagnostic: boundDiagnostic(formatUnknownError(error))
        }
      };
    }
    return {
      ok: false,
      failure: {
        reason: "broken_env",
        message: "Could not inspect free disk space for managed Python capability setup.",
        diagnostic: boundDiagnostic(formatUnknownError(error))
      }
    };
  }
  return { ok: true };
}

async function getDiskInfo(path: string): Promise<PythonEnvDiskInfo> {
  const stats = await statfs(path);
  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize)
  };
}

async function writeManifest(
  options: ManagedPythonCapabilityInstallOptions,
  effective: EffectiveCapabilitySpec,
  paths: { envPath: string; pythonPath: string },
  fields: {
    createdAt: string;
    updatedAt: string;
    verifiedAt?: string;
    status: ManagedPythonCapabilityEnvManifest["status"];
  }
): Promise<ManagedPythonCapabilityEnvManifest> {
  const manifest: ManagedPythonCapabilityEnvManifest = {
    id: effective.spec.id,
    version: effective.spec.version,
    specHash: effective.specHash,
    installedPackages: [...effective.packages],
    installedGroups: [...effective.selectedGroups],
    pythonPath: paths.pythonPath,
    envPath: paths.envPath,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    status: fields.status
  };
  if (fields.verifiedAt !== undefined) {
    manifest.verifiedAt = fields.verifiedAt;
  }
  await writeManagedPythonCapabilityManifest({
    stateRoot: options.stateRoot,
    capabilityId: options.capabilityId
  }, manifest);
  return manifest;
}

async function writeBrokenManifest(
  options: ManagedPythonCapabilityInstallOptions,
  effective: EffectiveCapabilitySpec,
  paths: { envPath: string; pythonPath: string },
  createdAt: string,
  now: () => Date,
  _failure: ManagedPythonCapabilityFailure
): Promise<void> {
  await writeManifest(options, effective, paths, {
    createdAt,
    updatedAt: now().toISOString(),
    status: "broken"
  });
}

function resolveEffectiveSpec(
  capabilityId: string,
  selectedGroups: string[]
): { ok: true; value: EffectiveCapabilitySpec } | { ok: false; failure: ManagedPythonCapabilityFailure } {
  let spec: ManagedPythonCapabilityEnvSpec;
  try {
    spec = requireRegisteredPythonCapabilitySpec(capabilityId);
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: "not_configured",
        message: "Managed Python capability is not registered by the runtime.",
        diagnostic: boundDiagnostic(formatUnknownError(error))
      }
    };
  }
  const optionalGroups = spec.optionalGroups ?? {};
  const normalizedGroups = [...new Set(selectedGroups)];
  normalizedGroups.sort();
  for (const groupId of normalizedGroups) {
    if (optionalGroups[groupId] === undefined) {
      return {
        ok: false,
        failure: {
          reason: "not_configured",
          message: `Unknown optional group '${groupId}' for managed Python capability '${spec.id}'.`
        }
      };
    }
  }
  let estimatedInstallSizeMb = spec.estimatedInstallSizeMb;
  const groupPackages: string[] = [];
  const groupImports: string[] = [];
  for (const groupId of normalizedGroups) {
    const group = optionalGroups[groupId];
    if (group === undefined) {
      continue;
    }
    groupPackages.push(...group.packages);
    groupImports.push(...group.verifyImports);
    if (group.estimatedInstallSizeMb !== undefined) {
      estimatedInstallSizeMb = (estimatedInstallSizeMb ?? 0) + group.estimatedInstallSizeMb;
    }
  }
  return {
    ok: true,
    value: {
      spec,
      specHash: fingerprintManagedPythonCapabilitySpec(spec, normalizedGroups),
      packages: [...spec.packages, ...groupPackages],
      verifyImports: [...spec.verifyImports, ...groupImports],
      selectedGroups: normalizedGroups,
      estimatedInstallSizeMb
    }
  };
}

function commandFailure(
  reason: Extract<ManagedPythonCapabilityFailureReason, "venv_create_failed" | "pip_install_failed" | "import_verify_failed">,
  message: string,
  result: Extract<PythonEnvCommandResult, { ok: false }>
): ManagedPythonCapabilityFailure {
  const diagnostic = [result.reason, result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  if (result.code === "EACCES" || result.code === "EPERM") {
    return {
      reason: "permission_denied",
      message,
      diagnostic: boundDiagnostic(diagnostic.length === 0 ? "No diagnostic output was captured." : diagnostic)
    };
  }
  return {
    reason,
    message,
    diagnostic: boundDiagnostic(diagnostic.length === 0 ? "No diagnostic output was captured." : diagnostic)
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<PythonEnvCommandResult> {
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
      stdout = boundDiagnostic(`${stdout}${String(chunk)}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundDiagnostic(`${stderr}${String(chunk)}`);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        stdout,
        stderr,
        reason: error.message,
        code: error.code
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

function permissionAwareError(error: unknown, message: string): Error {
  if (isPermissionError(error)) {
    return new PythonEnvPermissionError(message, error);
  }
  return error instanceof Error ? error : new Error(formatUnknownError(error));
}

class PythonEnvPermissionError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = "PythonEnvPermissionError";
  }
}

function isPermissionError(error: unknown): boolean {
  return isErrno(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
