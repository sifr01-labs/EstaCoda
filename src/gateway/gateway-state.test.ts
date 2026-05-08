import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readGatewayPid,
  writeGatewayPid,
  removeGatewayPid,
  isPidAlive,
  isStalePid,
} from "./pid-file.js";
import {
  readGatewayState,
  writeGatewayState,
  removeGatewayState,
  cleanupStaleGatewayState,
} from "./supervisor-state.js";
import {
  acquireGatewayLock,
  releaseGatewayLock,
  isStaleLock,
} from "./gateway-lock.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-gateway-test-"));
}

describe("gateway state primitives", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────
  // PID file
  // ─────────────────────────────────────────────────────────────

  describe("PID file", () => {
    it("write/read roundtrip", async () => {
      const content = { pid: 12345, startedAt: "2026-05-07T10:00:00.000Z", version: "0.0.5" };
      await writeGatewayPid(tmpDir, content);
      const read = await readGatewayPid(tmpDir);
      expect(read).toEqual(content);
    });

    it("returns undefined when PID file missing", async () => {
      const read = await readGatewayPid(tmpDir);
      expect(read).toBeUndefined();
    });

    it("remove deletes PID file", async () => {
      await writeGatewayPid(tmpDir, { pid: 1, startedAt: new Date().toISOString(), version: "0.0.1" });
      await removeGatewayPid(tmpDir);
      const read = await readGatewayPid(tmpDir);
      expect(read).toBeUndefined();
    });

    it("isPidAlive returns true for current process", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("isPidAlive returns false for non-existent PID", () => {
      // PID 99999 is extremely unlikely to exist
      expect(isPidAlive(99999)).toBe(false);
    });

    it("isStalePid returns false when no PID file", async () => {
      expect(await isStalePid(tmpDir)).toBe(false);
    });

    it("isStalePid returns true when PID file points to dead process", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      expect(await isStalePid(tmpDir)).toBe(true);
    });

    it("isStalePid returns false when PID file points to live process", async () => {
      await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.1" });
      expect(await isStalePid(tmpDir)).toBe(false);
    });

    it("PID file is created with 0o600 permissions", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      await writeGatewayPid(tmpDir, { pid: 12345, startedAt: new Date().toISOString(), version: "0.0.1" });
      const stats = await stat(join(tmpDir, ".estacoda", "gateway", "gateway.pid"));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("PID file corrects existing 0o644 permissions to 0o600", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      const path = join(tmpDir, ".estacoda", "gateway", "gateway.pid");
      await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
      await writeFile(path, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString(), version: "0.0.1" }), { encoding: "utf8", mode: 0o644 });
      await chmod(path, 0o644);
      await writeGatewayPid(tmpDir, { pid: 12345, startedAt: new Date().toISOString(), version: "0.0.1" });
      const stats = await stat(path);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // State file
  // ─────────────────────────────────────────────────────────────

  describe("State file", () => {
    it("write/read roundtrip", async () => {
      const state = { lifecycle: "running" as const, startedAt: "2026-05-07T10:00:00.000Z", pid: 12345, version: "0.0.5" };
      await writeGatewayState(tmpDir, state);
      const read = await readGatewayState(tmpDir);
      expect(read).toEqual(state);
    });

    it("returns undefined when state file missing", async () => {
      const read = await readGatewayState(tmpDir);
      expect(read).toBeUndefined();
    });

    it("remove deletes state file", async () => {
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 1, version: "0.0.1" });
      await removeGatewayState(tmpDir);
      const read = await readGatewayState(tmpDir);
      expect(read).toBeUndefined();
    });

    it("state file is created with 0o600 permissions", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 12345, version: "0.0.1" });
      const stats = await stat(join(tmpDir, ".estacoda", "gateway", "gateway-state.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("state file corrects existing 0o644 permissions to 0o600", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      const path = join(tmpDir, ".estacoda", "gateway", "gateway-state.json");
      await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
      await writeFile(path, JSON.stringify({ lifecycle: "running", startedAt: new Date().toISOString(), pid: 12345, version: "0.0.1" }), { encoding: "utf8", mode: 0o644 });
      await chmod(path, 0o644);
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 12345, version: "0.0.1" });
      const stats = await stat(path);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Lock file
  // ─────────────────────────────────────────────────────────────

  describe("Lock file", () => {
    it("acquire returns true when no lock exists", async () => {
      const result = await acquireGatewayLock(tmpDir);
      expect(result.acquired).toBe(true);
    });

    it("acquire returns false when lock is held by live process", async () => {
      await acquireGatewayLock(tmpDir);
      const result = await acquireGatewayLock(tmpDir);
      expect(result.acquired).toBe(false);
    });

    it("release allows re-acquire", async () => {
      await acquireGatewayLock(tmpDir);
      await releaseGatewayLock(tmpDir);
      const result = await acquireGatewayLock(tmpDir);
      expect(result.acquired).toBe(true);
    });

    it("isStaleLock returns false when no lock", async () => {
      expect(await isStaleLock(tmpDir)).toBe(false);
    });

    it("isStaleLock returns false for live lock holder", async () => {
      await acquireGatewayLock(tmpDir);
      expect(await isStaleLock(tmpDir)).toBe(false);
    });

    it("isStaleLock returns true for dead lock holder (short timeout)", async () => {
      // Write a lock with a dead PID and tiny timeout so it goes stale immediately
      await acquireGatewayLock(tmpDir);
      await releaseGatewayLock(tmpDir);
      // Manually write a lock with a dead PID
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(tmpDir, ".estacoda", "gateway");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "gateway.lock"),
        JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
        "utf8"
      );
      expect(await isStaleLock(tmpDir, 1)).toBe(true);
    });

    it("acquire reclaims stale lock from dead process", async () => {
      // Manually write a stale lock
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(tmpDir, ".estacoda", "gateway");
      await mkdir(dir, { recursive: true });
      const staleStart = new Date(Date.now() - 60_000).toISOString();
      await writeFile(
        join(dir, "gateway.lock"),
        JSON.stringify({ pid: 99999, startedAt: staleStart }),
        "utf8"
      );

      const result = await acquireGatewayLock(tmpDir);
      expect(result.acquired).toBe(true);
      expect(result.stale).toBe(true);
    });

    it("lock file is created with 0o600 permissions", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      await acquireGatewayLock(tmpDir);
      const stats = await stat(join(tmpDir, ".estacoda", "gateway", "gateway.lock"));
      expect(stats.mode & 0o777).toBe(0o600);
      await releaseGatewayLock(tmpDir);
    });

    it("lock file corrects existing 0o644 permissions to 0o600 on reclaim", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      const path = join(tmpDir, ".estacoda", "gateway", "gateway.lock");
      await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
      await writeFile(path, JSON.stringify({ pid: 99999, startedAt: new Date(Date.now() - 60_000).toISOString() }), { encoding: "utf8", mode: 0o644 });
      await chmod(path, 0o644);
      const result = await acquireGatewayLock(tmpDir);
      expect(result.acquired).toBe(true);
      expect(result.stale).toBe(true);
      const stats = await stat(path);
      expect(stats.mode & 0o777).toBe(0o600);
      await releaseGatewayLock(tmpDir);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────

  describe("cleanupStaleGatewayState", () => {
    it("returns cleaned:false when nothing stale", async () => {
      const result = await cleanupStaleGatewayState(tmpDir);
      expect(result.cleaned).toBe(false);
    });

    it("removes stale PID and state but preserves a live lock", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 99999, version: "0.0.1" });

      // Acquire a fresh lock with the live process PID
      const lockResult = await acquireGatewayLock(tmpDir);
      expect(lockResult.acquired).toBe(true);

      const result = await cleanupStaleGatewayState(tmpDir);
      expect(result.cleaned).toBe(true);
      expect(await readGatewayPid(tmpDir)).toBeUndefined();
      expect(await readGatewayState(tmpDir)).toBeUndefined();

      // The live lock must still be held
      const reacquire = await acquireGatewayLock(tmpDir);
      expect(reacquire.acquired).toBe(false);

      // Clean up
      await releaseGatewayLock(tmpDir);
    });
  });
});
