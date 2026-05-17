import { chmod, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readGatewayPid,
  removeGatewayPid,
  isPidAlive,
  type GatewayPidContent,
} from "./pid-file.js";
import {
  readGatewayState,
  removeGatewayState,
  cleanupStaleGatewayState,
} from "./supervisor-state.js";
import {
  isStaleLock,
  releaseGatewayLock,
  readGatewayLockContent,
} from "./gateway-lock.js";

export const CLEAN_SHUTDOWN_FILE_NAME = ".clean_shutdown";

type GatewayStateHome = string | { gatewayStatePath: string };

function gatewayDir(stateHome: GatewayStateHome): string {
  return typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
}

export async function writeCleanShutdownMarker(stateHome: GatewayStateHome, marker: CleanShutdownMarker): Promise<void> {
  const dir = gatewayDir(stateHome);
  await mkdir(dir, { recursive: true });
  const path = join(dir, CLEAN_SHUTDOWN_FILE_NAME);
  await writeFile(path, JSON.stringify(marker) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readCleanShutdownMarker(stateHome: GatewayStateHome): Promise<CleanShutdownMarker | undefined> {
  try {
    const raw = await readFile(join(gatewayDir(stateHome), CLEAN_SHUTDOWN_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<CleanShutdownMarker>;
    if (
      typeof parsed.stoppedAt === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.version === "string" &&
      typeof parsed.reason === "string"
    ) {
      return {
        stoppedAt: parsed.stoppedAt,
        pid: parsed.pid,
        version: parsed.version,
        reason: parsed.reason as CleanShutdownMarker["reason"],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function removeCleanShutdownMarker(stateHome: GatewayStateHome): Promise<void> {
  try {
    await rm(join(gatewayDir(stateHome), CLEAN_SHUTDOWN_FILE_NAME), { force: true });
  } catch {
    // ignore
  }
}

export async function isCleanShutdownTrustworthy(stateHome: GatewayStateHome, marker: CleanShutdownMarker): Promise<boolean> {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const stoppedAt = new Date(marker.stoppedAt).getTime();
  if (Number.isNaN(stoppedAt) || stoppedAt < fiveMinutesAgo) {
    return false;
  }

  const pidContent = await readGatewayPid(stateHome);
  if (pidContent !== undefined) {
    return false;
  }

  const state = await readGatewayState(stateHome);
  if (state !== undefined) {
    return false;
  }

  const lockContent = await readGatewayLockContent(stateHome);
  if (lockContent !== undefined) {
    return false;
  }

  return true;
}

/**
 * CLEAN_SHUTDOWN_MARKER_SCHEMA — prepared for Stage 6 (Graceful Restart and Drain)
 * File path: ~/.estacoda/gateway/.clean_shutdown
 * Content shape: { stoppedAt: ISOString; pid: number; version: string; reason: "drain" | "manual" | "restart" }
 * Semantics:
 *   - Written by the supervisor AFTER adapters and stores close successfully.
 *   - Consumed (read then deleted) on next startup to skip crash recovery.
 *   - Absence means previous shutdown was unclean → next startup runs crash recovery.
 *   - Must NOT be written if drain times out or SIGKILL is required.
 *
 * NOTE: Stage 1B does NOT read or write this marker. This type exists for
 * documentation and forward-compatibility only.
 */
export type CleanShutdownMarker = {
  stoppedAt: string;
  pid: number;
  version: string;
  reason: "drain" | "manual" | "restart";
};

export type StopResult =
  | { ok: true; action: "stopped" | "was_not_running"; pid?: number; forced?: boolean; liveLock?: boolean }
  | { ok: false; error: string; pid?: number };

export type SignalResult =
  | { ok: true }
  | { ok: false; reason: "not_running" | "permission_denied" };

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return !isPidAlive(pid);
}

async function removeLockIfSafe(stateHome: GatewayStateHome, stoppedPid: number): Promise<void> {
  const lockContent = await readGatewayLockContent(stateHome);
  if (lockContent === undefined) {
    // Corrupt or missing lock — safe to remove via releaseGatewayLock (rm -f)
    await releaseGatewayLock(stateHome);
    return;
  }
  const stale = await isStaleLock(stateHome);
  if (stale || lockContent.pid === stoppedPid) {
    await releaseGatewayLock(stateHome);
  }
  // Otherwise: healthy lock owned by a different PID — do NOT remove.
}

async function cleanupNoPidFile(stateHome: GatewayStateHome): Promise<StopResult> {
  const lockContent = await readGatewayLockContent(stateHome);
  const stale = await isStaleLock(stateHome);

  if (lockContent !== undefined && !stale) {
    // Live lock held by another process — preserve state and lock.
    return { ok: true, action: "was_not_running", liveLock: true };
  }

  // No lock or stale/corrupt lock — safe to clean up stray state.
  await removeGatewayState(stateHome);
  if (stale) {
    await releaseGatewayLock(stateHome);
  }
  return { ok: true, action: "was_not_running" };
}

async function cleanupInvalidPidFile(stateHome: GatewayStateHome): Promise<StopResult> {
  const lockContent = await readGatewayLockContent(stateHome);
  const stale = await isStaleLock(stateHome);

  // Always remove the corrupt PID file.
  await removeGatewayPid(stateHome);

  if (lockContent !== undefined && !stale) {
    // Live lock held by another process — preserve state and lock.
    return { ok: true, action: "was_not_running", liveLock: true };
  }

  // No lock or stale/corrupt lock — safe to clean up state.
  await removeGatewayState(stateHome);
  if (stale) {
    await releaseGatewayLock(stateHome);
  }
  return { ok: true, action: "was_not_running" };
}

export async function signalGateway(
  stateHome: GatewayStateHome,
  signal: NodeJS.Signals | number
): Promise<SignalResult> {
  const pidContent = await readGatewayPid(stateHome);
  if (pidContent === undefined || !isPidAlive(pidContent.pid)) {
    return { ok: false, reason: "not_running" };
  }

  try {
    process.kill(pidContent.pid, signal);
    return { ok: true };
  } catch (err: any) {
    if (err.code === "EPERM") {
      return { ok: false, reason: "permission_denied" };
    }
    if (err.code === "ESRCH") {
      return { ok: false, reason: "not_running" };
    }
    throw err;
  }
}

export async function stopGateway(
  stateHome: GatewayStateHome,
  options?: {
    force?: boolean;
    gracefulTimeoutMs?: number;
    killTimeoutMs?: number;
  }
): Promise<StopResult> {
  const gracefulTimeoutMs = options?.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  const killTimeoutMs = options?.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

  const pidContent = await readGatewayPid(stateHome);

  // Case 1: No PID file at all.
  if (pidContent === undefined) {
    return cleanupNoPidFile(stateHome);
  }

  // Case 2: PID file exists but process is dead (stale).
  if (!isPidAlive(pidContent.pid)) {
    await cleanupStaleGatewayState(stateHome);
    return {
      ok: true,
      action: "was_not_running",
      pid: pidContent.pid,
    };
  }

  // Case 3: Alive process — attempt graceful stop.
  const sigResult = await signalGateway(stateHome, "SIGTERM");
  if (!sigResult.ok) {
    if (sigResult.reason === "permission_denied") {
      return {
        ok: false,
        error: `Permission denied to signal gateway (PID ${pidContent.pid})`,
        pid: pidContent.pid,
      };
    }
    // not_running — process died between read and signal
    await removeGatewayPid(stateHome);
    await removeGatewayState(stateHome);
    await removeLockIfSafe(stateHome, pidContent.pid);
    return { ok: true, action: "was_not_running", pid: pidContent.pid };
  }

  const exited = await waitForPidExit(pidContent.pid, gracefulTimeoutMs);

  if (exited) {
    await removeGatewayPid(stateHome);
    await removeGatewayState(stateHome);
    await removeLockIfSafe(stateHome, pidContent.pid);
    return { ok: true, action: "stopped", pid: pidContent.pid };
  }

  // Graceful timeout expired.
  if (!options?.force) {
    return {
      ok: false,
      error: `Gateway did not stop gracefully within ${gracefulTimeoutMs / 1000}s. Use --force to send SIGKILL.`,
      pid: pidContent.pid,
    };
  }

  // Force: send SIGKILL.
  const killResult = await signalGateway(stateHome, "SIGKILL");
  if (!killResult.ok) {
    if (killResult.reason === "permission_denied") {
      return {
        ok: false,
        error: `Permission denied to signal gateway (PID ${pidContent.pid})`,
        pid: pidContent.pid,
      };
    }
    // not_running — process died between graceful check and SIGKILL
    await removeGatewayPid(stateHome);
    await removeGatewayState(stateHome);
    await removeLockIfSafe(stateHome, pidContent.pid);
    return { ok: true, action: "stopped", pid: pidContent.pid, forced: true };
  }

  const killed = await waitForPidExit(pidContent.pid, killTimeoutMs);

  if (killed) {
    await removeGatewayPid(stateHome);
    await removeGatewayState(stateHome);
    await removeLockIfSafe(stateHome, pidContent.pid);
    return { ok: true, action: "stopped", pid: pidContent.pid, forced: true };
  }

  return {
    ok: false,
    error: `Failed to stop gateway: PID ${pidContent.pid} still alive after SIGKILL`,
    pid: pidContent.pid,
  };
}
