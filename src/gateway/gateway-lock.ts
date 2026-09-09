import { readFile } from "node:fs/promises";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { processDefinitelyAbsent } from "../session/execution-ownership.js";
import { join } from "node:path";

export type GatewayLockResult = {
  acquired: boolean;
  stale?: boolean;
  instanceId?: string;
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
  instanceId?: string;
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
        return { content: { pid: parsed.pid, startedAt: parsed.startedAt, instanceId: parsed.instanceId }, lockedAt: new Date(lockedAt) };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const ownedInstances = new Map<string, string>();
function openOwnership(stateHome: GatewayStateHome) {
  const directory = gatewayDir(stateHome);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Gateway state must not be a symbolic link.");
  chmodSync(directory, 0o700);
  const path = join(directory, "singleton.sqlite");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, lockPath(stateHome)]) {
    try { if (lstatSync(candidate).isSymbolicLink()) throw new Error("Gateway ownership files must not be symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = openDefaultSQLiteDatabase({ path });
  chmodSync(path, 0o600);
  db.exec("create table if not exists singleton (id integer primary key check(id=1), instance_id text not null, pid integer not null)");
  return db;
}

export async function acquireGatewayLock(
  stateHome: GatewayStateHome,
  _staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS
): Promise<GatewayLockResult> {
  const db = openOwnership(stateHome);
  db.exec("begin immediate");
  try {
    const row = db.query<{ instance_id: string; pid: number }>("select * from singleton where id=1").get();
    if (row && !processDefinitelyAbsent(row.pid)) { db.exec("commit"); return { acquired: false, stale: false }; }
    let legacy: LockFileContent | undefined;
    try {
      legacy = JSON.parse(readFileSync(lockPath(stateHome), "utf8"));
      if (!legacy || !processDefinitelyAbsent(legacy.pid)) { db.exec("commit"); return { acquired: false, stale: false }; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { db.exec("commit"); return { acquired: false, stale: false }; }
    }
    const instanceId = randomUUID();
    db.query("insert or replace into singleton values (1, ?, ?)").run(instanceId, process.pid);
    // Short local discovery publication is serialized with claim/cleanup. No
    // provider, process launch or asynchronous work runs inside this transaction.
    writeFileSync(lockPath(stateHome), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), instanceId }), { mode: 0o600 });
    chmodSync(lockPath(stateHome), 0o600);
    db.exec("commit");
    ownedInstances.set(lockPath(stateHome), instanceId);
    return { acquired: true, stale: Boolean(row || legacy), instanceId };
  } catch (error) { db.exec("rollback"); throw error; }
  finally { db.close(); }
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

  if (processDefinitelyAbsent(content.pid)) {
    return { state: "stale", pid: content.pid, startedAt: content.startedAt, reason: "pid-dead" };
  }

  return { state: "active", pid: content.pid, startedAt: content.startedAt };
}

export async function releaseGatewayLock(stateHome: GatewayStateHome, instanceId = ownedInstances.get(lockPath(stateHome))): Promise<void> {
  const db = openOwnership(stateHome);
  db.exec("begin immediate");
  try {
    const row = db.query<{ instance_id: string; pid: number }>("select instance_id, pid from singleton where id=1").get();
    let discovery: LockFileContent | undefined;
    try { discovery = JSON.parse(readFileSync(lockPath(stateHome), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const owned = instanceId !== undefined && row?.instance_id === instanceId;
    const dead = instanceId === undefined && (!row || processDefinitelyAbsent(row.pid)) &&
      discovery !== undefined && processDefinitelyAbsent(discovery.pid);
    if (owned || dead) {
      if (discovery && (dead || discovery.instanceId === instanceId)) unlinkSync(lockPath(stateHome));
      db.query("delete from singleton where id=1 and instance_id=?").run(row?.instance_id ?? "");
      if (ownedInstances.get(lockPath(stateHome)) === instanceId) ownedInstances.delete(lockPath(stateHome));
    }
    db.exec("commit");
  } catch (error) { db.exec("rollback"); throw error; }
  finally { db.close(); }
}

export async function isStaleLock(stateHome: GatewayStateHome, _staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS): Promise<boolean> {
  const lock = await readLock(stateHome);
  return lock !== undefined && processDefinitelyAbsent(lock.content.pid);
}

/** Serialize stale metadata cleanup with singleton acquisition. A stale PID
 * snapshot must never authorize unlinking a newly published owner's files. */
export async function cleanupDeadGatewayMetadata(stateHome: GatewayStateHome, expectedPid?: number): Promise<boolean> {
  const db = openOwnership(stateHome);
  db.exec("begin immediate");
  try {
    const row = db.query<{ instance_id: string; pid: number }>("select * from singleton where id=1").get();
    if (row && (!processDefinitelyAbsent(row.pid) || (expectedPid !== undefined && row.pid !== expectedPid))) { db.exec("commit"); return false; }
    const removable: string[] = [];
    for (const name of ["gateway.lock", "gateway.pid", "gateway-state.json"]) {
      const path = join(gatewayDir(stateHome), name);
      try {
        if (lstatSync(path).isSymbolicLink()) { db.exec("commit"); return false; }
        const content = JSON.parse(readFileSync(path, "utf8"));
        if (!processDefinitelyAbsent(content.pid) || (expectedPid !== undefined && content.pid !== expectedPid)) { db.exec("commit"); return false; }
        removable.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { db.exec("commit"); return false; }
      }
    }
    for (const path of removable) unlinkSync(path);
    if (row) db.query("delete from singleton where id=1 and instance_id=?").run(row.instance_id);
    db.exec("commit"); return removable.length > 0;
  } catch (error) { db.exec("rollback"); throw error; }
  finally { db.close(); }
}
