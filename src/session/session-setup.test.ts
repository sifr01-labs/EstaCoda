import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSessionDbFile, createSQLiteSessionDB } from "./session-setup.js";

type ChildRunResult = {
  exitCode: number | null;
  stderr: string;
};

type ChildStartup = {
  ready: Promise<void>;
  result: Promise<ChildRunResult>;
};

function runSessionDbStartupChild(dbPath: string, startSignalPath: string, id: number): ChildStartup {
  const sessionSetupUrl = new URL("./session-setup.ts", import.meta.url).href;
  const code = `
    import { existsSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { createSQLiteSessionDB } from ${JSON.stringify(sessionSetupUrl)};
    process.stdout.write("ready\\n");
    const deadline = Date.now() + 5000;
    while (!existsSync(${JSON.stringify(startSignalPath)})) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for start signal");
      }
      await delay(1);
    }
    const db = await createSQLiteSessionDB({ path: ${JSON.stringify(dbPath)} });
    await db.createSession({ profileId: "parallel-startup", id: ${JSON.stringify(`parallel-session-${id}`)} });
    db.close();
  `;

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return {
    ready: new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Child ${id} did not become ready. stdout=${stdout} stderr=${stderr}`));
      }, 5_000);
      child.stdout.on("data", () => {
        if (stdout.includes("ready\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (exitCode) => {
        if (!stdout.includes("ready\n")) {
          clearTimeout(timer);
          reject(new Error(`Child ${id} exited before ready with ${exitCode}. stderr=${stderr}`));
        }
      });
    }),
    result: new Promise((resolve) => {
      child.on("exit", (exitCode) => {
        resolve({ exitCode, stderr });
      });
    })
  };
}

function summarizeChildFailures(results: ChildRunResult[]): string {
  return results
    .map((result, index) => ({ ...result, index }))
    .filter((result) => result.exitCode !== 0)
    .map((result) => `child ${result.index} exited ${result.exitCode}: ${result.stderr}`)
    .join("\n");
}

function countMigrationBackups(stateDir: string): number {
  return readdirSync(stateDir).filter((name) => name.includes(".backup.v")).length;
}

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

  it("supports parallel fresh-home session database startup across processes", async () => {
    const sessionPath = join(tempHome, ".estacoda", "sessions.sqlite");
    const startSignalPath = join(tempHome, "start-session-db-startup");
    const children = Array.from({ length: 16 }, (_, index) => runSessionDbStartupChild(sessionPath, startSignalPath, index));
    await Promise.all(children.map((child) => child.ready));
    writeFileSync(startSignalPath, "go", "utf8");
    const results = await Promise.all(children.map((child) => child.result));

    expect(results.map((result) => result.exitCode), summarizeChildFailures(results)).toEqual(
      Array.from({ length: 16 }, () => 0)
    );
  }, 30_000);

  it("supports repeated startup after initialization", async () => {
    const sessionPath = join(tempHome, ".estacoda", "sessions.sqlite");

    for (const index of Array.from({ length: 4 }, (_, value) => value)) {
      const db = await createSQLiteSessionDB({ path: sessionPath });
      try {
        const session = await db.createSession({ profileId: "repeat", id: `repeat-session-${index}` });
        expect(session.profileId).toBe("repeat");
      } finally {
        db.close();
      }
    }
  });

  it("does not rerun migrations or create new migration backups on repeated startup", async () => {
    const stateDir = join(tempHome, ".estacoda");
    const sessionPath = join(stateDir, "sessions.sqlite");
    const initial = await createSQLiteSessionDB({ path: sessionPath });
    try {
      expect(initial.db.query<{ version: number }>("select max(version) as version from schema_version").get()).toEqual({ version: 5 });
    } finally {
      initial.close();
    }

    const initialBackupCount = countMigrationBackups(stateDir);

    for (const _ of Array.from({ length: 3 })) {
      const reopened = await createSQLiteSessionDB({ path: sessionPath });
      try {
        expect(reopened.db.query<{ version: number }>("select max(version) as version from schema_version").get()).toEqual({ version: 5 });
      } finally {
        reopened.close();
      }
    }

    expect(countMigrationBackups(stateDir)).toBe(initialBackupCount);
  });
});
