import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive } from "./pid-file.js";

export type GatewayLockResult = {
  acquired: boolean;
  stale?: boolean;
};

export type GatewayLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number; startedAt: string }
  | { state: "stale"; pid: number; startedAt: string; reason: "expired" | "pid-dead" }
  | { state: "malformed"; error: string }
  | { state: "inaccessible"; error: string };

const DEFAULT_STALE_TIMEOUT_MS = 30_000; // 30 seconds

type LockFileContent = {
  pid: number;
  startedAt: string;
};

type GatewayStateHome = string | { gatewayStatePath: string };

function gatewayDir(stateHome: GatewayStateHome): string {
  return typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
}

function lockPath(stateHome: GatewayStateHome): string {
  return join(gatewayDir(stateHome), "gateway.lock");
}

async function readLock(stateHome: GatewayStateHome): Promise<{ content: LockFileContent; lockedAt: Date } | undefined> {
  try {
    const raw = await readFile(lockPath(stateHome), "utf8");
    const trimmed = raw.trim();
    const parsed = JSON.parse(trimmed) as Partial<LockFileContent>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      const lockedAt = Date.parse(parsed.startedAt);
      if (!Number.isNaN(lockedAt)) {
        return { content: { pid: parsed.pid, startedAt: parsed.startedAt }, lockedAt: new Date(lockedAt) };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function acquireGatewayLock(
  stateHome: GatewayStateHome,
  staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS
): Promise<GatewayLockResult> {
  const path = lockPath(stateHome);
  await mkdir(gatewayDir(stateHome), { recursive: true });

  try {
    // Try to create the lock file exclusively (atomic)
    const handle = await open(path, "wx", 0o600);
    const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(content), "utf8");
    await handle.close();
    await chmod(path, 0o600);
    return { acquired: true, stale: false };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "EEXIST") {
      throw error;
    }

    // Lock exists - check if stale
    const lock = await readLock(stateHome);
    if (lock === undefined) {
      // Corrupt lock file - treat as stale and reclaim
      await rm(path, { force: true });
      const handle = await open(path, "wx", 0o600);
      const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(content), "utf8");
      await handle.close();
      await chmod(path, 0o600);
      return { acquired: true, stale: true };
    }

    const elapsed = Date.now() - lock.lockedAt.getTime();
    const pidDead = !isPidAlive(lock.content.pid);

    if (elapsed > staleTimeoutMs || pidDead) {
      // Stale lock - reclaim
      await rm(path, { force: true });
      const handle = await open(path, "wx", 0o600);
      const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(content), "utf8");
      await handle.close();
      await chmod(path, 0o600);
      return { acquired: true, stale: true };
    }

    // Lock is still fresh
    return { acquired: false, stale: false };
  }
}

export async function readGatewayLockContent(stateHome: GatewayStateHome): Promise<LockFileContent | undefined> {
  const lock = await readLock(stateHome);
  return lock?.content;
}

export async function inspectGatewayLockState(
  stateHome: { gatewayStatePath: string },
  staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS
): Promise<GatewayLockInspection> {
  const path = join(stateHome.gatewayStatePath, "gateway.lock");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return { state: "missing" };
    const message = error instanceof Error ? error.message : String(error);
    return { state: "inaccessible", error: message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "malformed", error: message };
  }

  const content = parsed as Partial<LockFileContent>;
  if (typeof content.pid !== "number" || typeof content.startedAt !== "string") {
    return { state: "malformed", error: "missing pid or startedAt" };
  }

  const lockedAt = Date.parse(content.startedAt);
  if (Number.isNaN(lockedAt)) {
    return { state: "malformed", error: "invalid startedAt" };
  }

  const elapsed = Date.now() - lockedAt;
  if (elapsed > staleTimeoutMs) {
    return { state: "stale", pid: content.pid, startedAt: content.startedAt, reason: "expired" };
  }

  if (!isPidAlive(content.pid)) {
    return { state: "stale", pid: content.pid, startedAt: content.startedAt, reason: "pid-dead" };
  }

  return { state: "active", pid: content.pid, startedAt: content.startedAt };
}

export async function releaseGatewayLock(stateHome: GatewayStateHome): Promise<void> {
  await rm(lockPath(stateHome), { force: true });
}

export async function isStaleLock(stateHome: GatewayStateHome, staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS): Promise<boolean> {
  try {
    await stat(lockPath(stateHome));
  } catch {
    return false;
  }

  const lock = await readLock(stateHome);
  if (lock === undefined) return true; // corrupt = stale

  const elapsed = Date.now() - lock.lockedAt.getTime();
  const pidDead = !isPidAlive(lock.content.pid);
  return elapsed > staleTimeoutMs || pidDead;
}
