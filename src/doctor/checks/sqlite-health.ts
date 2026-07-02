import { stat } from "node:fs/promises";
import { resolveGlobalStateHome } from "../../config/profile-home.js";
import { openSQLiteDatabase } from "../../storage/factory.js";
import type { SQLiteDatabase } from "../../storage/sqlite.js";

export type SQLiteHealthStatus = "ready" | "not-initialized" | "warning" | "blocked";

export type SQLiteRepairPlanReason = "schema" | "fts" | "write-probe" | "open" | "path";

export type SQLiteRepairPlan = {
  readonly reason: SQLiteRepairPlanReason;
  readonly backupRequired: true;
  readonly command: "estacoda doctor --repair-sessions";
  readonly details: readonly string[];
};

export type SQLiteWriteHealthProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type SQLiteWriteHealthProbe = (db: SQLiteDatabase) => SQLiteWriteHealthProbeResult;

export type SQLiteHealthDiagnostic = {
  readonly path: string;
  readonly status: SQLiteHealthStatus;
  readonly sessionsCount?: number;
  readonly walSizeBytes: number;
  readonly schemaValid: boolean;
  readonly ftsHealthy: boolean;
  readonly ftsWriteHealthy: boolean | "not-run";
  readonly missingTables: readonly string[];
  readonly missingColumns: readonly string[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly repairPlan?: SQLiteRepairPlan;
};

const WAL_INFO_THRESHOLD_BYTES = 10 * 1024 * 1024;
const WAL_WARNING_THRESHOLD_BYTES = 50 * 1024 * 1024;
const BLOCKING_TABLES = new Set(["sessions", "messages", "messages_fts"]);

const EXPECTED_TABLE_COLUMNS: Record<string, readonly string[]> = {
  sessions: ["id", "profile_id", "created_at", "updated_at"],
  messages: ["id", "session_id", "role", "content", "created_at"],
  messages_fts: ["message_id", "content"],
  session_events: ["id", "session_id", "created_at", "event_json"],
  trajectories: ["id", "session_id", "profile_id", "model_id", "created_at"],
  trajectory_failures: ["id", "trajectory_id", "session_id", "timestamp", "class"],
  workflow_runs: ["id", "session_id", "status", "created_at", "updated_at"],
  workflow_steps: ["id", "workflow_run_id", "step_index", "status"],
  workflow_events: ["id", "workflow_run_id", "kind", "timestamp"],
  workflow_operator_events: ["id", "workflow_run_id", "kind", "operator", "timestamp"],
  workflow_checkpoints: ["id", "workflow_run_id", "snapshot_json", "created_at"],
  workflow_approval_gates: ["id", "workflow_step_id", "workflow_run_id", "status"],
  workflow_locks: ["workflow_run_id", "owner_id", "heartbeat_at", "expires_at"],
  workflow_processes: ["id", "workflow_run_id", "workflow_step_id", "status"],
  workflow_artifacts: ["artifact_id", "workflow_step_id", "workflow_run_id", "kind"],
  workflow_agent_run_links: ["run_id", "workflow_step_id", "workflow_run_id", "turn_index"],
  workflow_event_summaries: ["id", "workflow_run_id", "from_workflow_event_id", "to_workflow_event_id"],
  pending_approvals: ["id", "session_id", "profile_id", "status"],
  cron_executions: ["id", "job_id", "started_at", "status"],
  schema_version: ["version"]
};

export async function diagnoseSQLiteHealth(options: {
  readonly homeDir?: string;
  readonly walInfoThresholdBytes?: number;
  readonly walWarningThresholdBytes?: number;
  readonly includeWriteProbe?: boolean;
  readonly writeHealthProbe?: SQLiteWriteHealthProbe;
} = {}): Promise<SQLiteHealthDiagnostic> {
  const globalPaths = resolveGlobalStateHome({ homeDir: options.homeDir });
  const path = globalPaths.sessionsSqlitePath;
  const warnings: string[] = [];
  const notes: string[] = [];
  const walSizeBytes = await fileSize(`${path}-wal`);
  const walInfoThresholdBytes = options.walInfoThresholdBytes ?? WAL_INFO_THRESHOLD_BYTES;
  const walWarningThresholdBytes = options.walWarningThresholdBytes ?? WAL_WARNING_THRESHOLD_BYTES;

  const dbFile = await statIfExists(path);
  if (dbFile === undefined) {
    return {
      path,
      status: "not-initialized",
      walSizeBytes,
      schemaValid: false,
      ftsHealthy: false,
      ftsWriteHealthy: "not-run",
      missingTables: [],
      missingColumns: [],
      warnings,
      notes: [`SQLite session DB is not initialized: ${path}`]
    };
  }

  if (!dbFile.isFile()) {
    return blocked(path, walSizeBytes, [`SQLite session DB path is not a file: ${path}`], notes, "path");
  }

  let db: SQLiteDatabase | undefined;
  try {
    db = await openSQLiteDatabase({ path, readonly: options.includeWriteProbe !== true, timeoutMs: 250 });
    db.query("select 1 as ok").get();
    const schema = inspectSchema(db);
    const sessionsCount = schema.missingTables.includes("sessions")
      ? undefined
      : db.query<{ count: number }>("select count(*) as count from sessions").get()?.count ?? 0;
    const ftsHealthy = checkFtsHealth(db, schema.missingTables);
    const missingRequiredTables = schema.missingTables.filter((table) => BLOCKING_TABLES.has(table));
    const missingAuxiliaryTables = schema.missingTables.filter((table) => !BLOCKING_TABLES.has(table));
    const missingRequiredColumns = schema.missingColumns.filter((column) => BLOCKING_TABLES.has(column.split(".")[0] ?? ""));
    const missingAuxiliaryColumns = schema.missingColumns.filter((column) => !BLOCKING_TABLES.has(column.split(".")[0] ?? ""));
    const schemaBlocked = missingRequiredTables.length > 0 || missingRequiredColumns.length > 0;

    if (missingRequiredTables.length > 0) {
      warnings.push(`SQLite session DB schema is missing required tables: ${missingRequiredTables.join(", ")}`);
    }
    if (missingAuxiliaryTables.length > 0) {
      warnings.push(`SQLite session DB schema is missing auxiliary tables: ${missingAuxiliaryTables.join(", ")}`);
    }
    if (missingRequiredColumns.length > 0) {
      warnings.push(`SQLite session DB schema is missing required columns: ${missingRequiredColumns.join(", ")}`);
    }
    if (missingAuxiliaryColumns.length > 0) {
      warnings.push(`SQLite session DB schema is missing auxiliary columns: ${missingAuxiliaryColumns.join(", ")}`);
    }
    if (!ftsHealthy) {
      warnings.push("SQLite session DB FTS index is unavailable.");
    }
    const writeHealth = options.includeWriteProbe === true && ftsHealthy && !schemaBlocked
      ? runWriteHealthProbe(db, options.writeHealthProbe ?? defaultWriteHealthProbe)
      : undefined;
    if (writeHealth?.ok === false) {
      warnings.push(`SQLite session DB FTS write probe failed: ${writeHealth.reason}`);
    }
    if (walSizeBytes >= walWarningThresholdBytes) {
      warnings.push(`SQLite session DB WAL is large: ${formatBytes(walSizeBytes)}`);
    } else if (walSizeBytes >= walInfoThresholdBytes) {
      notes.push(`SQLite session DB WAL is ${formatBytes(walSizeBytes)}.`);
    }

    const schemaValid = schema.missingTables.length === 0 && schema.missingColumns.length === 0;
    const blockedReason = schemaBlocked
      ? "schema"
      : !ftsHealthy
        ? "fts"
        : writeHealth?.ok === false
          ? "write-probe"
          : undefined;
    return {
      path,
      status: blockedReason !== undefined ? "blocked" : warnings.length > 0 ? "warning" : "ready",
      sessionsCount,
      walSizeBytes,
      schemaValid,
      ftsHealthy,
      ftsWriteHealthy: writeHealth === undefined ? "not-run" : writeHealth.ok,
      missingTables: schema.missingTables,
      missingColumns: schema.missingColumns,
      warnings,
      notes,
      repairPlan: blockedReason === undefined ? undefined : sqliteRepairPlan(blockedReason, warnings)
    };
  } catch (error) {
    return blocked(path, walSizeBytes, [`SQLite session DB could not be opened: ${errorMessage(error)}`], notes, "open");
  } finally {
    db?.close();
  }
}

function inspectSchema(db: SQLiteDatabase): {
  readonly missingTables: readonly string[];
  readonly missingColumns: readonly string[];
} {
  const tables = new Set(db
    .query<{ name: string }>("select name from sqlite_master where type in ('table', 'view')")
    .all()
    .map((row) => row.name));
  const missingTables: string[] = [];
  const missingColumns: string[] = [];

  for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    if (!tables.has(table)) {
      missingTables.push(table);
      continue;
    }
    const columns = new Set(db.query<{ name: string }>(`pragma table_info(${quoteIdentifier(table)})`).all().map((row) => row.name));
    for (const column of expectedColumns) {
      if (!columns.has(column)) {
        missingColumns.push(`${table}.${column}`);
      }
    }
  }

  return {
    missingTables,
    missingColumns
  };
}

function checkFtsHealth(db: SQLiteDatabase, missingTables: readonly string[]): boolean {
  if (missingTables.includes("messages_fts")) return false;
  try {
    db.query<{ count: number }>("select count(*) as count from messages_fts").get();
    db.query<{ count: number }>(
      "select count(*) as count from messages_fts join messages on messages.rowid = messages_fts.rowid"
    ).get();
    return true;
  } catch {
    return false;
  }
}

function defaultWriteHealthProbe(db: SQLiteDatabase): SQLiteWriteHealthProbeResult {
  const now = new Date().toISOString();
  const id = `doctor-sqlite-write-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    db.exec("savepoint doctor_sqlite_write_probe");
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
    ).run(`${id}-message`, id, "system", "doctor sqlite write probe", now);
    db.query("insert into messages_fts(rowid, message_id, content) values ((select rowid from messages where id = ?), ?, ?)")
      .run(`${id}-message`, `${id}-message`, "doctor sqlite write probe");
    db.exec("rollback to doctor_sqlite_write_probe");
    db.exec("release doctor_sqlite_write_probe");
    return { ok: true };
  } catch (error) {
    rollbackWriteProbe(db);
    return { ok: false, reason: errorMessage(error) };
  }
}

function runWriteHealthProbe(db: SQLiteDatabase, probe: SQLiteWriteHealthProbe): SQLiteWriteHealthProbeResult {
  try {
    return probe(db);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function rollbackWriteProbe(db: SQLiteDatabase): void {
  try {
    db.exec("rollback to doctor_sqlite_write_probe");
  } catch {
    // The savepoint may not exist if the probe failed before it was created.
  }
  try {
    db.exec("release doctor_sqlite_write_probe");
  } catch {
    // Keep the original probe failure as the actionable diagnostic.
  }
}

function blocked(
  path: string,
  walSizeBytes: number,
  warnings: readonly string[],
  notes: readonly string[],
  reason: SQLiteRepairPlanReason
): SQLiteHealthDiagnostic {
  return {
    path,
    status: "blocked",
    walSizeBytes,
    schemaValid: false,
    ftsHealthy: false,
    ftsWriteHealthy: "not-run",
    missingTables: [],
    missingColumns: [],
    warnings,
    notes,
    repairPlan: sqliteRepairPlan(reason, warnings)
  };
}

function sqliteRepairPlan(reason: SQLiteRepairPlanReason, details: readonly string[]): SQLiteRepairPlan {
  return {
    reason,
    backupRequired: true,
    command: "estacoda doctor --repair-sessions",
    details
  };
}

async function fileSize(path: string): Promise<number> {
  const file = await statIfExists(path);
  return file?.isFile() === true ? Number(file.size) : 0;
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
