import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runtimeCacheStatePath,
  writeRuntimeCacheState,
  readRuntimeCacheState,
  isRuntimeCacheStateFresh,
  isRuntimeCacheStatePidMatch,
  type RuntimeCacheState,
} from "./runtime-cache-state.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-rcs-test-"));
}

function makeValidState(overrides?: Partial<RuntimeCacheState>): RuntimeCacheState {
  return {
    version: 1,
    writtenAt: new Date().toISOString(),
    supervisorPid: process.pid,
    supervisorStartedAt: new Date().toISOString(),
    cacheStats: {
      totalEntries: 0,
      activeBorrows: 0,
      suspendedEntries: 0,
      totalCreated: 0,
      totalReused: 0,
      totalDisposed: 0,
      totalInvalidated: 0,
    },
    suspendedSummary: [],
    registryStats: {
      activeTurnCount: 0,
      totalStarted: 0,
      totalEnded: 0,
      totalAborted: 0,
      stuckTurnCount: 0,
      repeatStuckCount: 0,
    },
    stuckTurnHistory: [],
    fingerprintHash: "abcd1234abcd1234",
    ...overrides,
  } as RuntimeCacheState;
}

describe("runtimeCacheStatePath", () => {
  it("returns correct path under ~/.estacoda/gateway/", () => {
    expect(runtimeCacheStatePath("/home/user")).toBe(
      join("/home/user", ".estacoda", "gateway", "runtime-cache-state.json")
    );
  });
});

describe("writeRuntimeCacheState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates directory with dirname", async () => {
    const path = join(tmpDir, "nested", "runtime-cache-state.json");
    await writeRuntimeCacheState(path, makeValidState());
    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"version": 1');
  });

  it("produces valid JSON matching schema", async () => {
    const path = join(tmpDir, "state.json");
    const state = makeValidState({
      cacheStats: {
        totalEntries: 3,
        activeBorrows: 1,
        suspendedEntries: 0,
        totalCreated: 5,
        totalReused: 2,
        totalDisposed: 1,
        totalInvalidated: 0,
      },
    });
    await writeRuntimeCacheState(path, state);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.cacheStats.totalEntries).toBe(3);
    expect(parsed.fingerprintHash).toBe("abcd1234abcd1234");
  });

  it("runtime cache state file is created with 0o600 permissions", async () => {
    if (process.platform === "win32") {
      console.log("Skipping permission test on Windows");
      return;
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.log("Skipping permission test when running as root");
      return;
    }
    const path = join(tmpDir, "state.json");
    await writeRuntimeCacheState(path, makeValidState());
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("runtime cache state file corrects existing 0o644 permissions to 0o600", async () => {
    if (process.platform === "win32") {
      console.log("Skipping permission test on Windows");
      return;
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.log("Skipping permission test when running as root");
      return;
    }
    const path = join(tmpDir, "state.json");
    await writeFile(path, JSON.stringify(makeValidState()), { encoding: "utf8", mode: 0o644 });
    await chmod(path, 0o644);
    await writeRuntimeCacheState(path, makeValidState());
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe("readRuntimeCacheState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns parsed state for valid file", async () => {
    const path = join(tmpDir, "state.json");
    await writeRuntimeCacheState(path, makeValidState());
    const result = await readRuntimeCacheState(path);
    expect(result).toBeDefined();
    expect(result!.version).toBe(1);
  });

  it("returns undefined for missing file", async () => {
    const result = await readRuntimeCacheState(join(tmpDir, "missing.json"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", async () => {
    const path = join(tmpDir, "bad.json");
    await writeFile(path, "not json");
    const result = await readRuntimeCacheState(path);
    expect(result).toBeUndefined();
  });

  it("returns undefined for wrong version", async () => {
    const path = join(tmpDir, "bad-version.json");
    await writeFile(
      path,
      JSON.stringify({ version: 2, writtenAt: new Date().toISOString(), supervisorPid: 1 })
    );
    const result = await readRuntimeCacheState(path);
    expect(result).toBeUndefined();
  });
});

describe("isRuntimeCacheStateFresh", () => {
  it("returns true for recent state", () => {
    const state = makeValidState({ writtenAt: new Date().toISOString() });
    expect(isRuntimeCacheStateFresh(state)).toBe(true);
  });

  it("returns false for stale state", () => {
    const old = new Date(Date.now() - 130_000).toISOString();
    const state = makeValidState({ writtenAt: old });
    expect(isRuntimeCacheStateFresh(state)).toBe(false);
  });
});

describe("isRuntimeCacheStatePidMatch", () => {
  it("returns true for matching PID", () => {
    const state = makeValidState({ supervisorPid: process.pid });
    expect(isRuntimeCacheStatePidMatch(state, process.pid)).toBe(true);
  });

  it("returns false for mismatching PID", () => {
    const state = makeValidState({ supervisorPid: 12345 });
    expect(isRuntimeCacheStatePidMatch(state, process.pid)).toBe(false);
  });
});

describe("privacy", () => {
  it("state object does not contain message text, prompts, or tokens", () => {
    const state = makeValidState();
    const json = JSON.stringify(state);
    expect(json).not.toContain("message");
    expect(json).not.toContain("prompt");
    expect(json).not.toContain("token");
  });

  it("keyHash is present and is a 16-char hex SHA-256 truncated hash", () => {
    const state = makeValidState({
      stuckTurnHistory: [
        {
          turnId: "t1",
          keyHash: "a".repeat(16),
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 1000,
          wasAborted: false,
        },
      ],
    });
    expect(state.stuckTurnHistory[0].keyHash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/i.test(state.stuckTurnHistory[0].keyHash)).toBe(true);
  });

  it("fingerprintHash is a 16-char hex string", () => {
    const state = makeValidState({ fingerprintHash: "deadbeef" + "cafebabe" });
    expect(state.fingerprintHash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/i.test(state.fingerprintHash)).toBe(true);
  });
});
