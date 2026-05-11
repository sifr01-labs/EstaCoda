import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSessionDbFile, createSQLiteSessionDB } from "./session-setup.js";

describe("prepareSessionDbFile", () => {
  let tempHome: string;
  let sessionPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-test-"));
    sessionPath = join(tempHome, ".estacoda", "sessions.sqlite");
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates missing sessions.sqlite", async () => {
    expect(existsSync(sessionPath)).toBe(false);
    await prepareSessionDbFile(sessionPath);
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("creates parent state directory with restrictive permissions where supported", async () => {
    await prepareSessionDbFile(sessionPath);
    const dirPath = join(tempHome, ".estacoda");
    if (process.platform !== "win32") {
      const stats = statSync(dirPath);
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("sets sessions.sqlite to 0600 where supported", async () => {
    await prepareSessionDbFile(sessionPath);
    if (process.platform !== "win32") {
      const stats = statSync(sessionPath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it("chmod existing sessions.sqlite to 0600 where supported", async () => {
    const dirPath = join(tempHome, ".estacoda");
    mkdirSync(dirPath, { recursive: true });
    // Create file with broader permissions
    const fd = openSync(sessionPath, "w", 0o644);
    closeSync(fd);
    expect(existsSync(sessionPath)).toBe(true);
    await prepareSessionDbFile(sessionPath);
    if (process.platform !== "win32") {
      const stats = statSync(sessionPath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });
});

describe("createSQLiteSessionDB", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns a SQLiteSessionDB instance with valid schema", async () => {
    const sessionPath = join(tempHome, ".estacoda", "sessions.sqlite");
    const db = await createSQLiteSessionDB({ path: sessionPath });
    const session = await db.createSession({ profileId: "test" });
    expect(session.id).toBeDefined();
    expect(session.profileId).toBe("test");
    db.close();
  });
});
