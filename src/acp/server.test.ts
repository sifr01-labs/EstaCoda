import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AcpServer } from "./server.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

describe("AcpServer SQLite lifecycle", () => {
  let tempHome: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-acp-test-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "estacoda-acp-workspace-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("opens ACP persistence under the configured state home and closes it explicitly", async () => {
    const server = new AcpServer({
      workspaceRoot,
      homeDir: tempHome,
      input: new PassThrough(),
      output: new PassThrough()
    });

    const dbPath = join(tempHome, ".estacoda", "sessions.sqlite");
    expect(existsSync(dbPath)).toBe(true);

    await server.close();

    const db = openDefaultSQLiteDatabase({ path: dbPath });
    try {
      expect(db.query<{ count: number }>("select count(*) as count from sessions").get()?.count).toBe(0);
    } finally {
      db.close();
    }
  });
});
