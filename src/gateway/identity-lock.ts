import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive } from "./pid-file.js";
import type { ChannelKind } from "../contracts/channel.js";

export type IdentityLockResult = {
  acquired: boolean;
  stale?: boolean;
  holderPid?: number;
};

export type IdentityLockReleaseResult = {
  released: boolean;
  reason: "missing" | "released" | "not_owner" | "stale";
};

export type IdentityLockInfo = {
  kind: ChannelKind;
  identityHash: string;
  pid: number;
  startedAt: Date;
  stale: boolean;
};

type LockFileContent = {
  pid: number;
  startedAt: string;
};

const KEY_FILE_NAME = "identity-lock-key";
const LOCKS_DIR_NAME = "locks";
const LOCK_FILE_PREFIX = "identity-";
const LOCK_FILE_SUFFIX = ".lock";
const KEY_PERMISSIONS = 0o600;

type GatewayStateHome = string | { gatewayStatePath: string };

function gatewayDir(stateHome: GatewayStateHome): string {
  return typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
}

function keyPath(stateHome: GatewayStateHome): string {
  return join(gatewayDir(stateHome), KEY_FILE_NAME);
}

function locksDir(stateHome: GatewayStateHome): string {
  return join(gatewayDir(stateHome), LOCKS_DIR_NAME);
}

export function identityLockPath(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityHash: string
): string {
  return join(locksDir(stateHome), `${LOCK_FILE_PREFIX}${kind}-${identityHash}${LOCK_FILE_SUFFIX}`);
}

async function ensureHmacKey(stateHome: GatewayStateHome): Promise<Buffer> {
  const path = keyPath(stateHome);

  try {
    const stats = await stat(path);
    if ((stats.mode & 0o777) !== KEY_PERMISSIONS) {
      throw new Error(
        `Identity lock key file at ${path} has permissions ${(stats.mode & 0o777).toString(8)}; expected ${KEY_PERMISSIONS.toString(8)}. Fix permissions and retry.`
      );
    }
    const raw = await readFile(path, "utf8");
    const decoded = Buffer.from(raw.trim(), "base64");
    if (decoded.length !== 32) {
      throw new Error(`Identity lock key at ${path} is invalid (expected 32 bytes, got ${decoded.length}). Remove it and retry.`);
    }
    return decoded;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      // Create new key
      await mkdir(gatewayDir(stateHome), { recursive: true });
      const key = randomBytes(32);
      await writeFile(path, key.toString("base64") + "\n", { mode: KEY_PERMISSIONS, encoding: "utf8" });
      return key;
    }
    throw error;
  }
}

export async function deriveIdentityHash(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityString: string
): Promise<string> {
  const key = await ensureHmacKey(stateHome);
  const hmac = createHmac("sha256", key);
  hmac.update(`${kind}:${identityString}`);
  return hmac.digest("hex");
}

async function readLockFile(path: string): Promise<{ content: LockFileContent; startedAt: Date } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();
    const parsed = JSON.parse(trimmed) as Partial<LockFileContent>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      const startedAt = Date.parse(parsed.startedAt);
      if (!Number.isNaN(startedAt)) {
        return { content: { pid: parsed.pid, startedAt: parsed.startedAt }, startedAt: new Date(startedAt) };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isLockStale(lock: { content: LockFileContent } | undefined): boolean {
  if (lock === undefined) return true; // corrupt = stale
  return !isPidAlive(lock.content.pid);
}

export async function acquireAdapterIdentityLock(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityHash: string
): Promise<IdentityLockResult> {
  const path = identityLockPath(stateHome, kind, identityHash);
  await mkdir(locksDir(stateHome), { recursive: true });

  try {
    const handle = await open(path, "wx");
    const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(content), "utf8");
    await handle.close();
    return { acquired: true, stale: false };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "EEXIST") {
      throw error;
    }

    const existing = await readLockFile(path);
    if (isLockStale(existing)) {
      // Stale lock - reclaim automatically during acquire
      await rm(path, { force: true });
      const handle = await open(path, "wx");
      const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(content), "utf8");
      await handle.close();
      return { acquired: true, stale: true };
    }

    return {
      acquired: false,
      stale: false,
      holderPid: existing?.content.pid,
    };
  }
}

export async function releaseAdapterIdentityLock(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityHash: string,
  expectedPid: number = process.pid
): Promise<IdentityLockReleaseResult> {
  const path = identityLockPath(stateHome, kind, identityHash);

  let fileExists: boolean;
  try {
    await stat(path);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    return { released: true, reason: "missing" };
  }

  const existing = await readLockFile(path);
  if (existing === undefined) {
    return { released: false, reason: "stale" };
  }

  if (existing.content.pid !== expectedPid) {
    return { released: false, reason: "not_owner" };
  }

  await rm(path, { force: true });
  return { released: true, reason: "released" };
}

export async function isAdapterIdentityLocked(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityHash: string
): Promise<boolean> {
  const path = identityLockPath(stateHome, kind, identityHash);
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function reclaimStaleAdapterIdentityLock(
  stateHome: GatewayStateHome,
  kind: ChannelKind,
  identityHash: string
): Promise<IdentityLockResult> {
  const path = identityLockPath(stateHome, kind, identityHash);

  let existing: Awaited<ReturnType<typeof readLockFile>>;
  try {
    existing = await readLockFile(path);
  } catch {
    return { acquired: false };
  }

  if (!isLockStale(existing)) {
    return {
      acquired: false,
      stale: false,
      holderPid: existing?.content.pid,
    };
  }

  await rm(path, { force: true });

  try {
    const handle = await open(path, "wx");
    const content: LockFileContent = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(content), "utf8");
    await handle.close();
    return { acquired: true, stale: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST") {
      // Race - someone else acquired
      const raced = await readLockFile(path);
      return {
        acquired: false,
        stale: false,
        holderPid: raced?.content.pid,
      };
    }
    throw error;
  }
}

export async function listAdapterIdentityLocks(
  stateHome: GatewayStateHome
): Promise<IdentityLockInfo[]> {
  const dir = locksDir(stateHome);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const results: IdentityLockInfo[] = [];
  for (const file of files) {
    if (!file.startsWith(LOCK_FILE_PREFIX) || !file.endsWith(LOCK_FILE_SUFFIX)) continue;

    const inner = file.slice(LOCK_FILE_PREFIX.length, -LOCK_FILE_SUFFIX.length);
    const firstDash = inner.indexOf("-");
    if (firstDash === -1) continue;

    const kind = inner.slice(0, firstDash) as ChannelKind;
    const identityHash = inner.slice(firstDash + 1);

    const lock = await readLockFile(join(dir, file));
    if (lock === undefined) {
      results.push({
        kind,
        identityHash,
        pid: -1,
        startedAt: new Date(0),
        stale: true,
      });
      continue;
    }

    results.push({
      kind,
      identityHash,
      pid: lock.content.pid,
      startedAt: lock.startedAt,
      stale: isLockStale(lock),
    });
  }

  return results;
}
