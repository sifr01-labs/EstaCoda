import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeAdapterRuntimeState,
  readAdapterRuntimeState,
  isRuntimeStateFresh,
  isRuntimeStatePidMatch,
  RUNTIME_STATE_STALE_MS,
} from "./adapter-runtime-state.js";
import type { PersistedRuntimeState } from "./adapter-runtime-state.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-runtime-state-test-"));
}

function fakeState(overrides?: Partial<PersistedRuntimeState>): PersistedRuntimeState {
  return {
    supervisorPid: process.pid,
    supervisorStartedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    adapters: [],
    ...overrides,
  };
}

describe("adapter-runtime-state persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("write then read roundtrip", async () => {
    const state = fakeState({
      adapters: [
        {
          kind: "telegram",
          state: "healthy",
          pollsTotal: 3,
          pollsFailed: 0,
          pollMessagesProcessed: 7,
        },
      ],
    });
    await writeAdapterRuntimeState(tmpDir, state);
    const read = await readAdapterRuntimeState(tmpDir);
    expect(read).toEqual(state);
  });

  it("adapter runtime state file is created with 0o600 permissions", async () => {
    if (process.platform === "win32") {
      console.log("Skipping permission test on Windows");
      return;
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.log("Skipping permission test when running as root");
      return;
    }
    await writeAdapterRuntimeState(tmpDir, fakeState());
    const stats = await stat(join(tmpDir, ".estacoda", "gateway", "adapter-runtime-state.json"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("adapter runtime state file corrects existing 0o644 permissions to 0o600", async () => {
    if (process.platform === "win32") {
      console.log("Skipping permission test on Windows");
      return;
    }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.log("Skipping permission test when running as root");
      return;
    }
    const path = join(tmpDir, ".estacoda", "gateway", "adapter-runtime-state.json");
    await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
    await writeFile(path, JSON.stringify(fakeState()), { encoding: "utf8", mode: 0o644 });
    await chmod(path, 0o644);
    await writeAdapterRuntimeState(tmpDir, fakeState());
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("missing file returns undefined", async () => {
    const read = await readAdapterRuntimeState(tmpDir);
    expect(read).toBeUndefined();
  });

  it("corrupt file returns undefined", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = join(tmpDir, ".estacoda", "gateway", "adapter-runtime-state.json");
    await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
    await writeFile(path, "not json");
    const read = await readAdapterRuntimeState(tmpDir);
    expect(read).toBeUndefined();
  });

  it("isFresh returns true for recent file", () => {
    const state = fakeState();
    expect(isRuntimeStateFresh(state)).toBe(true);
  });

  it("isFresh returns false for old file", () => {
    const state = fakeState({
      updatedAt: new Date(Date.now() - RUNTIME_STATE_STALE_MS - 1000).toISOString(),
    });
    expect(isRuntimeStateFresh(state)).toBe(false);
  });

  it("read rejects stale supervisorPid", () => {
    const state = fakeState({ supervisorPid: 12345 });
    expect(isRuntimeStatePidMatch(state, 99999)).toBe(false);
  });

  it("read accepts matching supervisorPid", () => {
    const state = fakeState({ supervisorPid: 12345 });
    expect(isRuntimeStatePidMatch(state, 12345)).toBe(true);
  });
});
