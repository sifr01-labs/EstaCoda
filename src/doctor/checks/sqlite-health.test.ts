import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGlobalStateHome } from "../../config/profile-home.js";
import { SQLiteSessionDB } from "../../session/sqlite-session-db.js";
import { openSQLiteDatabase } from "../../storage/factory.js";
import { diagnoseSQLiteHealth } from "./sqlite-health.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-sqlite-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseSQLiteHealth", () => {
  it("treats a missing sessions database as not initialized without creating it", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("not-initialized");
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toContain(`SQLite session DB is not initialized: ${sessionPath}`);
  });

  it("reports a migrated session database as ready with session count and healthy FTS", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const db = new SQLiteSessionDB({ path: sessionPath });
    try {
      await db.createSession({ id: "session-1", profileId: "default" });
      await db.appendMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "doctor sqlite health"
      });
    } finally {
      db.close();
    }

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.sessionsCount).toBe(1);
    expect(diagnostic.schemaValid).toBe(true);
    expect(diagnostic.ftsHealthy).toBe(true);
    expect(diagnostic.ftsWriteHealthy).toBe("not-run");
    expect(diagnostic.warnings).toEqual([]);
  });

  it("keeps normal diagnostics read-only for an existing session database", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const sessionDb = new SQLiteSessionDB({ path: sessionPath });
    try {
      await sessionDb.createSession({ id: "session-1", profileId: "default" });
      await sessionDb.appendMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "doctor sqlite health"
      });
    } finally {
      sessionDb.close();
    }
    const before = await sessionCounts(sessionPath);

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.ftsWriteHealthy).toBe("not-run");
    await expect(sessionCounts(sessionPath)).resolves.toEqual(before);
  });

  it("blocks and plans repair when the opt-in FTS write probe fails", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const sessionDb = new SQLiteSessionDB({ path: sessionPath });
    try {
      await sessionDb.createSession({ id: "session-1", profileId: "default" });
      await sessionDb.appendMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "doctor sqlite health"
      });
    } finally {
      sessionDb.close();
    }

    const diagnostic = await diagnoseSQLiteHealth({
      homeDir,
      includeWriteProbe: true,
      writeHealthProbe: () => ({ ok: false, reason: "synthetic write failure" })
    });

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.schemaValid).toBe(true);
    expect(diagnostic.ftsHealthy).toBe(true);
    expect(diagnostic.ftsWriteHealthy).toBe(false);
    expect(diagnostic.warnings).toContain("SQLite session DB FTS write probe failed: synthetic write failure");
    expect(diagnostic.repairPlan).toEqual({
      reason: "write-probe",
      backupRequired: true,
      command: "estacoda doctor --repair-sessions",
      details: ["SQLite session DB FTS write probe failed: synthetic write failure"]
    });
  });

  it("blocks when an existing sessions database is missing core tables", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const db = await openSQLiteDatabase({ path: sessionPath });
    try {
      db.exec("create table sessions (id text primary key)");
    } finally {
      db.close();
    }

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.schemaValid).toBe(false);
    expect(diagnostic.missingTables).toContain("messages");
    expect(diagnostic.missingColumns).toContain("sessions.profile_id");
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("SQLite session DB schema is missing required tables:"),
      expect.stringContaining("SQLite session DB schema is missing required columns:")
    ]));
    expect(diagnostic.repairPlan).toEqual(expect.objectContaining({
      reason: "schema",
      backupRequired: true,
      command: "estacoda doctor --repair-sessions"
    }));
  });

  it("reports a missing sessions table as schema failure instead of generic open failure", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const db = await openSQLiteDatabase({ path: sessionPath });
    try {
      db.exec("create table unrelated (id text primary key)");
    } finally {
      db.close();
    }

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.missingTables).toContain("sessions");
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("SQLite session DB schema is missing required tables:")
    ]));
    expect(diagnostic.warnings.join("\n")).not.toContain("could not be opened");
  });

  it("warns when an existing sessions database only lacks newer auxiliary tables", async () => {
    const homeDir = await tempHome();
    const sessionPath = resolveGlobalStateHome({ homeDir }).sessionsSqlitePath;
    await mkdir(dirname(sessionPath), { recursive: true });
    const db = await openSQLiteDatabase({ path: sessionPath });
    try {
      db.exec(`
        create table sessions (
          id text primary key,
          profile_id text not null default 'default',
          created_at text not null,
          updated_at text not null
        );
        create table messages (
          id text primary key,
          session_id text not null,
          role text not null,
          content text not null,
          created_at text not null
        );
        create virtual table messages_fts using fts5(message_id unindexed, content, tokenize = 'unicode61');
        create table session_events (
          id text primary key,
          session_id text not null,
          created_at text not null,
          event_json text not null
        );
        create table schema_version (version integer primary key);
      `);
    } finally {
      db.close();
    }

    const diagnostic = await diagnoseSQLiteHealth({ homeDir });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.schemaValid).toBe(false);
    expect(diagnostic.ftsHealthy).toBe(true);
    expect(diagnostic.missingTables).toContain("tasks");
    expect(diagnostic.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("SQLite session DB schema is missing auxiliary tables:")
    ]));
    expect(diagnostic.repairPlan).toBeUndefined();
  });
});

async function sessionCounts(path: string): Promise<{ sessions: number; messages: number; fts: number }> {
  const db = await openSQLiteDatabase({ path, readonly: true });
  try {
    return {
      sessions: db.query<{ count: number }>("select count(*) as count from sessions").get()?.count ?? 0,
      messages: db.query<{ count: number }>("select count(*) as count from messages").get()?.count ?? 0,
      fts: db.query<{ count: number }>("select count(*) as count from messages_fts").get()?.count ?? 0
    };
  } finally {
    db.close();
  }
}
