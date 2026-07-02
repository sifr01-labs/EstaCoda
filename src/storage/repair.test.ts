import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { openSQLiteDatabase } from "./factory.js";
import { repairSQLiteSchema } from "./repair.js";

const tempDirs: string[] = [];

async function tempPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-sqlite-repair-"));
  tempDirs.push(directory);
  return join(directory, "sessions.sqlite");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("repairSQLiteSchema", () => {
  it("backs up and rebuilds a broken messages FTS index", async () => {
    const path = await tempPath();
    await createSessionDb(path);
    await replaceFtsWithBrokenTable(path);

    const report = await repairSQLiteSchema({
      path,
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });

    expect(report).toEqual(expect.objectContaining({
      path,
      status: "repaired",
      repaired: true,
      strategy: "fts-rebuild",
      backupPath: `${path}.bak-2026-07-02T00-00-00-000Z`
    }));
    await expect(stat(report.backupPath!)).resolves.toMatchObject({});
    await expect(ftsSearch(path, "repairable")).resolves.toEqual(["message-1"]);
  });

  it("returns not-needed without creating a backup for a healthy session DB", async () => {
    const path = await tempPath();
    await createSessionDb(path);

    const report = await repairSQLiteSchema({
      path,
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });

    expect(report).toEqual(expect.objectContaining({
      path,
      status: "not-needed",
      repaired: false,
      strategy: "none"
    }));
    expect(report.backupPath).toBeUndefined();
    await expect(stat(`${path}.bak-2026-07-02T00-00-00-000Z`)).rejects.toThrow();
  });

  it("rebuilds FTS when search is healthy but the write probe fails", async () => {
    const path = await tempPath();
    await createSessionDb(path);

    const report = await repairSQLiteSchema({
      path,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      writeHealthProbe: () => ({ ok: false, reason: "synthetic write failure" })
    });

    expect(report).toEqual(expect.objectContaining({
      path,
      status: "repaired",
      repaired: true,
      strategy: "fts-rebuild",
      backupPath: `${path}.bak-2026-07-02T00-00-00-000Z`
    }));
    expect(report.notes).toContain("SQLite session DB FTS write probe failed before repair: synthetic write failure");
    await expect(ftsSearch(path, "repairable")).resolves.toEqual(["message-1"]);
  });

  it("blocks bad SQLite files without deleting or rewriting the original", async () => {
    const path = await tempPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not sqlite", "utf8");

    const report = await repairSQLiteSchema({ path });

    expect(report.status).toBe("blocked");
    expect(report.repaired).toBe(false);
    expect(report.backupPath).toBeUndefined();
    expect(report.error).toContain("header is invalid");
    await expect(readFile(path, "utf8")).resolves.toBe("not sqlite");
  });
});

async function createSessionDb(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new SQLiteSessionDB({ path });
  try {
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.appendMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "repairable search needle"
    });
  } finally {
    db.close();
  }
}

async function replaceFtsWithBrokenTable(path: string): Promise<void> {
  const db = await openSQLiteDatabase({ path });
  try {
    db.exec(`
      drop table messages_fts;
      create table messages_fts (
        message_id text,
        content text
      );
    `);
  } finally {
    db.close();
  }
}

async function ftsSearch(path: string, query: string): Promise<readonly string[]> {
  const db = await openSQLiteDatabase({ path, readonly: true });
  try {
    return db.query<{ message_id: string }>(
      "select message_id from messages_fts where messages_fts match ? order by rowid"
    ).all(query).map((row) => row.message_id);
  } finally {
    db.close();
  }
}
