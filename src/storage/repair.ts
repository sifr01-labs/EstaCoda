import { copyFile, open, stat } from "node:fs/promises";
import { openSQLiteDatabase } from "./factory.js";
import type { SQLiteDatabase } from "./sqlite.js";

export type SQLiteRepairStrategy = "fts-rebuild" | "none";

export type SQLiteRepairStatus = "repaired" | "not-needed" | "blocked";

export type SQLiteRepairReport = {
  readonly path: string;
  readonly status: SQLiteRepairStatus;
  readonly repaired: boolean;
  readonly strategy: SQLiteRepairStrategy;
  readonly backupPath?: string;
  readonly error?: string;
  readonly notes: readonly string[];
};

export async function repairSQLiteSchema(options: {
  readonly path: string;
  readonly now?: () => Date;
  readonly writeHealthProbe?: (db: SQLiteDatabase) => SQLiteWriteRepairProbeResult;
}): Promise<SQLiteRepairReport> {
  const path = options.path;
  const notes: string[] = [];
  if (await statIfFile(path) === undefined) {
    return blocked(path, `SQLite session DB does not exist: ${path}`, notes);
  }
  if (!await hasSQLiteHeader(path)) {
    return blocked(path, `SQLite session DB header is invalid: ${path}`, notes);
  }

  let db: SQLiteDatabase | undefined;
  try {
    db = await openSQLiteDatabase({ path, readonly: true, timeoutMs: 1_000 });
    if (!hasSafeFtsRepairSchema(db)) {
      return blocked(path, "SQLite session DB cannot be safely repaired: required session/message tables are missing.", notes);
    }
    if (isFtsSearchHealthy(db)) {
      const writeProbe = await probeFtsWriteHealth(path, options.writeHealthProbe);
      if (writeProbe.ok) {
        notes.push("SQLite session DB FTS index is already healthy.");
        return {
          path,
          status: "not-needed",
          repaired: false,
          strategy: "none",
          notes
        };
      }
      notes.push(`SQLite session DB FTS write probe failed before repair: ${writeProbe.reason}`);
    }
  } catch (error) {
    return blocked(path, `SQLite session DB could not be opened for repair: ${errorMessage(error)}`, notes);
  } finally {
    db?.close();
  }

  const backupPath = backupPathFor(path, options.now?.() ?? new Date());
  await backupSQLiteFiles(path, backupPath);

  try {
    db = await openSQLiteDatabase({ path, readonly: false, timeoutMs: 1_000 });
    rebuildMessageFts(db);
    notes.push("Rebuilt SQLite session DB FTS index from existing messages.");
    return {
      path,
      status: "repaired",
      repaired: true,
      strategy: "fts-rebuild",
      backupPath,
      notes
    };
  } catch (error) {
    return {
      path,
      status: "blocked",
      repaired: false,
      strategy: "fts-rebuild",
      backupPath,
      error: `SQLite session DB repair failed after backup: ${errorMessage(error)}`,
      notes
    };
  } finally {
    db?.close();
  }
}

function hasSafeFtsRepairSchema(db: SQLiteDatabase): boolean {
  return tableExists(db, "sessions") &&
    tableExists(db, "messages") &&
    columnExists(db, "messages", "id") &&
    columnExists(db, "messages", "content");
}

function isFtsSearchHealthy(db: SQLiteDatabase): boolean {
  if (!tableExists(db, "messages_fts")) return false;
  try {
    db.query<{ count: number }>("select count(*) as count from messages_fts").get();
    db.query<{ count: number }>(
      "select count(*) as count from messages_fts join messages on messages.rowid = messages_fts.rowid"
    ).get();
    db.query<{ rowid: number }>("select rowid from messages_fts where messages_fts match ? limit 1").all("doctor");
    return true;
  } catch {
    return false;
  }
}

type SQLiteWriteRepairProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

async function probeFtsWriteHealth(
  path: string,
  probe: ((db: SQLiteDatabase) => SQLiteWriteRepairProbeResult) | undefined
): Promise<SQLiteWriteRepairProbeResult> {
  let db: SQLiteDatabase | undefined;
  try {
    db = await openSQLiteDatabase({ path, readonly: false, timeoutMs: 1_000 });
    return (probe ?? defaultWriteHealthProbe)(db);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  } finally {
    db?.close();
  }
}

function defaultWriteHealthProbe(db: SQLiteDatabase): SQLiteWriteRepairProbeResult {
  const now = new Date().toISOString();
  const id = `doctor-sqlite-repair-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    db.exec("savepoint doctor_sqlite_repair_probe");
    db.query(
      `insert into sessions (
        id,
        profile_id,
        created_at,
        updated_at
      ) values (?, ?, ?, ?)`
    ).run(id, "__doctor__", now, now);
    db.query(
      `insert into messages (
        id,
        session_id,
        role,
        content,
        created_at
      ) values (?, ?, ?, ?, ?)`
    ).run(`${id}-message`, id, "system", "doctor sqlite repair probe", now);
    db.query("insert into messages_fts(rowid, message_id, content) values ((select rowid from messages where id = ?), ?, ?)")
      .run(`${id}-message`, `${id}-message`, "doctor sqlite repair probe");
    db.exec("rollback to doctor_sqlite_repair_probe");
    db.exec("release doctor_sqlite_repair_probe");
    return { ok: true };
  } catch (error) {
    rollbackWriteProbe(db);
    return { ok: false, reason: errorMessage(error) };
  }
}

function rollbackWriteProbe(db: SQLiteDatabase): void {
  try {
    db.exec("rollback to doctor_sqlite_repair_probe");
  } catch {
    // The savepoint may not exist if the probe failed before it was created.
  }
  try {
    db.exec("release doctor_sqlite_repair_probe");
  } catch {
    // Preserve the original probe failure as the actionable repair reason.
  }
}

function rebuildMessageFts(db: SQLiteDatabase): void {
  db.exec("begin immediate");
  try {
    db.exec("drop table if exists messages_fts");
    db.exec(`
      create virtual table messages_fts using fts5(
        message_id unindexed,
        content,
        tokenize = 'unicode61'
      );
    `);
    db.exec(`
      insert into messages_fts(rowid, message_id, content)
      select rowid, id, content from messages;
    `);
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // Preserve the original repair failure.
    }
    throw error;
  }
}

function tableExists(db: SQLiteDatabase, table: string): boolean {
  return db.query<{ name: string }>(
    "select name from sqlite_master where type in ('table', 'view') and name = ?"
  ).get(table) !== null;
}

function columnExists(db: SQLiteDatabase, table: string, column: string): boolean {
  try {
    return db.query<{ name: string }>(`pragma table_info(${quoteIdentifier(table)})`)
      .all()
      .some((row) => row.name === column);
  } catch {
    return false;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

async function statIfFile(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    const file = await stat(path);
    return file.isFile() ? file : undefined;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function hasSQLiteHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const result = await handle.read(header, 0, header.length, 0);
    return result.bytesRead === 16 && header.toString("binary") === "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

function backupPathFor(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${path}.bak-${stamp}`;
}

async function backupSQLiteFiles(path: string, backupPath: string): Promise<void> {
  await copyFile(path, backupPath);
  await copyFileIfExists(`${path}-wal`, `${backupPath}-wal`);
  await copyFileIfExists(`${path}-shm`, `${backupPath}-shm`);
}

async function copyFileIfExists(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function blocked(path: string, error: string, notes: readonly string[]): SQLiteRepairReport {
  return {
    path,
    status: "blocked",
    repaired: false,
    strategy: "none",
    error,
    notes
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
