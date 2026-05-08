import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { stopGateway, signalGateway } from "./supervisor-lifecycle.js";
import { writeGatewayPid, readGatewayPid } from "./pid-file.js";
import { writeGatewayState, readGatewayState } from "./supervisor-state.js";
import { acquireGatewayLock, releaseGatewayLock, readGatewayLockContent } from "./gateway-lock.js";
import {
  writeCleanShutdownMarker,
  readCleanShutdownMarker,
  removeCleanShutdownMarker,
  isCleanShutdownTrustworthy,
} from "./supervisor-lifecycle.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-lifecycle-test-"));
}

describe("supervisor-lifecycle", () => {
  let tmpDir: string;
  let children: ReturnType<typeof spawn>[] = [];

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    children = [];
  });

  afterEach(async () => {
    // Kill any spawned children
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function spawnDecoy(script: string, interpreter?: string[]): ReturnType<typeof spawn> {
    const args = interpreter ?? [process.execPath, "-e"];
    const child = spawn(args[0], [...args.slice(1), script], {
      detached: false,
      stdio: "ignore",
    });
    children.push(child);
    return child;
  }

  async function waitForChildPid(child: ReturnType<typeof spawn>): Promise<number> {
    return new Promise((resolve, reject) => {
      if (child.pid !== undefined) {
        resolve(child.pid);
        return;
      }
      child.on("spawn", () => {
        if (child.pid !== undefined) resolve(child.pid);
        else reject(new Error("Child spawned without PID"));
      });
      child.on("error", reject);
    });
  }

  describe("stopGateway", () => {
    it("returns was_not_running when no PID file exists", async () => {
      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.pid).toBeUndefined();
    });

    it("preserves a fresh live lock and state when no PID file exists", async () => {
      // Write a live lock (current process PID is alive)
      await acquireGatewayLock(tmpDir);
      // Write state that should be preserved
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.liveLock).toBe(true);

      // Lock must still exist
      const lockContent = await readGatewayLockContent(tmpDir);
      expect(lockContent).toBeDefined();
      expect(lockContent?.pid).toBe(process.pid);

      // State must be preserved
      const state = await readGatewayState(tmpDir);
      expect(state).toBeDefined();
      expect(state?.pid).toBe(process.pid);

      // A second acquire must fail because the lock is still held
      const secondAcquire = await acquireGatewayLock(tmpDir);
      expect(secondAcquire.acquired).toBe(false);

      // Cleanup our own lock
      await releaseGatewayLock(tmpDir);
    });

    it("cleans up stale PID + state + stale lock", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 99999, version: "0.0.1" });
      // Write a stale lock directly (old timestamp so isStaleLock returns true)
      const { writeFile, mkdir } = await import("node:fs/promises");
      const lockDir = join(tmpDir, ".estacoda", "gateway");
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        join(lockDir, "gateway.lock"),
        JSON.stringify({ pid: 99999, startedAt: new Date(Date.now() - 60_000).toISOString() }),
        "utf8"
      );

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.pid).toBe(99999);

      expect(await readGatewayPid(tmpDir)).toBeUndefined();
      expect(await readGatewayState(tmpDir)).toBeUndefined();
      expect(await readGatewayLockContent(tmpDir)).toBeUndefined();
    });

    it("regression: no PID + fresh live lock + state file preserves lock and state", async () => {
      await acquireGatewayLock(tmpDir);
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.liveLock).toBe(true);

      // Lock remains
      const lockContent = await readGatewayLockContent(tmpDir);
      expect(lockContent).toBeDefined();
      expect(lockContent?.pid).toBe(process.pid);

      // State remains
      const state = await readGatewayState(tmpDir);
      expect(state).toBeDefined();
      expect(state?.pid).toBe(process.pid);

      // Second acquire fails
      const secondAcquire = await acquireGatewayLock(tmpDir);
      expect(secondAcquire.acquired).toBe(false);

      await releaseGatewayLock(tmpDir);
    });

    it("regression: invalid PID JSON + fresh live lock + state file preserves lock and state", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const gatewayDir = join(tmpDir, ".estacoda", "gateway");
      await mkdir(gatewayDir, { recursive: true });

      await writeFile(join(gatewayDir, "gateway.pid"), "not-json", "utf8");
      await acquireGatewayLock(tmpDir);
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.liveLock).toBe(true);

      // Corrupt PID removed
      expect(await readGatewayPid(tmpDir)).toBeUndefined();

      // Lock remains
      const lockContent = await readGatewayLockContent(tmpDir);
      expect(lockContent).toBeDefined();
      expect(lockContent?.pid).toBe(process.pid);

      // State remains
      const state = await readGatewayState(tmpDir);
      expect(state).toBeDefined();
      expect(state?.pid).toBe(process.pid);

      await releaseGatewayLock(tmpDir);
    });

    it("removes corrupt PID but preserves fresh live lock and state", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const gatewayDir = join(tmpDir, ".estacoda", "gateway");
      await mkdir(gatewayDir, { recursive: true });

      // Write corrupt PID file
      await writeFile(join(gatewayDir, "gateway.pid"), "not-json", "utf8");
      // Write live lock
      await acquireGatewayLock(tmpDir);
      // Write state that should be preserved
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("was_not_running");
      expect(result.liveLock).toBe(true);

      // PID removed
      expect(await readGatewayPid(tmpDir)).toBeUndefined();
      // State preserved
      const state = await readGatewayState(tmpDir);
      expect(state).toBeDefined();
      expect(state?.pid).toBe(process.pid);
      // Lock preserved
      const lockContent = await readGatewayLockContent(tmpDir);
      expect(lockContent).toBeDefined();
      expect(lockContent?.pid).toBe(process.pid);

      await releaseGatewayLock(tmpDir);
    });

    it("stops a gracefully-exiting process and cleans up files", async () => {
      const child = spawnDecoy("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
      const pid = await waitForChildPid(child);

      await writeGatewayPid(tmpDir, { pid, startedAt: new Date().toISOString(), version: "0.0.1" });
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir);
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("stopped");
      expect(result.pid).toBe(pid);
      expect(result.forced).toBeUndefined();

      expect(await readGatewayPid(tmpDir)).toBeUndefined();
      expect(await readGatewayState(tmpDir)).toBeUndefined();
    });

    it("times out on SIGTERM without force and preserves files", async () => {
      // Use Python to ignore SIGTERM (Bun may exit on SIGTERM even with handler)
      const child = spawnDecoy(
        "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        ["python3", "-c"]
      );
      const pid = await waitForChildPid(child);
      // Allow Python to fully initialize signal handler before we test
      await new Promise((r) => setTimeout(r, 150));

      await writeGatewayPid(tmpDir, { pid, startedAt: new Date().toISOString(), version: "0.0.1" });
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir, { gracefulTimeoutMs: 300 });
      if (result.ok) throw new Error(`Expected failure but got success: ${result.action}`);
      expect(result.error).toContain("0.3s");
      expect(result.error).toContain("Use --force");
      expect(result.pid).toBe(pid);

      // Files must remain because process is still alive
      expect(await readGatewayPid(tmpDir)).toBeDefined();
      expect(await readGatewayState(tmpDir)).toBeDefined();

      // Cleanup
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    });

    it("forces SIGKILL when --force is set and cleans up files", async () => {
      const child = spawnDecoy(
        "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        ["python3", "-c"]
      );
      const pid = await waitForChildPid(child);
      // Allow Python to fully initialize signal handler
      await new Promise((r) => setTimeout(r, 150));

      await writeGatewayPid(tmpDir, { pid, startedAt: new Date().toISOString(), version: "0.0.1" });
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid, version: "0.0.1" });

      const result = await stopGateway(tmpDir, {
        force: true,
        gracefulTimeoutMs: 300,
        killTimeoutMs: 300,
      });
      if (!result.ok) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.action).toBe("stopped");
      expect(result.forced).toBe(true);
      expect(result.pid).toBe(pid);

      expect(await readGatewayPid(tmpDir)).toBeUndefined();
      expect(await readGatewayState(tmpDir)).toBeUndefined();
    });
  });

  describe("signalGateway", () => {
    it("returns not_running when no PID file exists", async () => {
      const result = await signalGateway(tmpDir, "SIGTERM");
      if (result.ok) throw new Error(`Expected failure but got success`);
      expect(result.reason).toBe("not_running");
    });

    it("sends signal to a running process", async () => {
      const markerPath = join(tmpDir, "signal-marker.txt");
      const child = spawnDecoy(
        `import signal, time, os; signal.signal(signal.SIGUSR1, lambda s,f: open('${markerPath}','w').write('ok') or os._exit(0)); time.sleep(60)`,
        ["python3", "-c"]
      );
      const pid = await waitForChildPid(child);
      // Allow Python to fully initialize signal handler
      await new Promise((r) => setTimeout(r, 150));

      await writeGatewayPid(tmpDir, { pid, startedAt: new Date().toISOString(), version: "0.0.1" });

      const result = await signalGateway(tmpDir, "SIGUSR1");
      if (!result.ok) throw new Error(`Unexpected error: ${result.reason}`);

      // Wait a moment for the signal handler to run
      await new Promise((r) => setTimeout(r, 800));

      const marker = await import("node:fs/promises").then((m) =>
        m.readFile(markerPath, "utf8").catch(() => undefined)
      );
      expect(marker).toBe("ok");
    });

    it("returns permission_denied on EPERM", async () => {
      const originalKill = process.kill;
      process.kill = (_pid: number, _signal?: string | number) => {
        const err = new Error("Operation not permitted") as any;
        err.code = "EPERM";
        throw err;
      };

      try {
        // Write a fake PID that passes isPidAlive (our own PID)
        await writeGatewayPid(tmpDir, { pid: process.pid, startedAt: new Date().toISOString(), version: "0.0.1" });
        const result = await signalGateway(tmpDir, "SIGTERM");
        if (result.ok) throw new Error(`Expected failure but got success`);
        expect(result.reason).toBe("permission_denied");
      } finally {
        process.kill = originalKill;
      }
    });
  });

  describe("clean shutdown marker", () => {
    it("write/read roundtrip", async () => {
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      await writeCleanShutdownMarker(tmpDir, marker);
      const read = await readCleanShutdownMarker(tmpDir);
      expect(read).toEqual(marker);
    });

    it("remove deletes file", async () => {
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      await writeCleanShutdownMarker(tmpDir, marker);
      await removeCleanShutdownMarker(tmpDir);
      expect(await readCleanShutdownMarker(tmpDir)).toBeUndefined();
    });

    it("missing file returns undefined", async () => {
      expect(await readCleanShutdownMarker(tmpDir)).toBeUndefined();
    });

    it("isCleanShutdownTrustworthy returns true when no PID/state/lock exist", async () => {
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      const result = await isCleanShutdownTrustworthy(tmpDir, marker);
      expect(result).toBe(true);
    });

    it("isCleanShutdownTrustworthy returns false when PID file exists (even if stale)", async () => {
      await writeGatewayPid(tmpDir, { pid: 99999, startedAt: new Date().toISOString(), version: "0.0.1" });
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      expect(await isCleanShutdownTrustworthy(tmpDir, marker)).toBe(false);
    });

    it("isCleanShutdownTrustworthy returns false when gateway-state.json exists", async () => {
      await writeGatewayState(tmpDir, { lifecycle: "running", startedAt: new Date().toISOString(), pid: 99999, version: "0.0.1" });
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      expect(await isCleanShutdownTrustworthy(tmpDir, marker)).toBe(false);
    });

    it("isCleanShutdownTrustworthy returns false when gateway.lock exists", async () => {
      await acquireGatewayLock(tmpDir);
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      expect(await isCleanShutdownTrustworthy(tmpDir, marker)).toBe(false);
      await releaseGatewayLock(tmpDir);
    });

    it("isCleanShutdownTrustworthy returns false when stale marker (>5min)", async () => {
      const marker = { stoppedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      expect(await isCleanShutdownTrustworthy(tmpDir, marker)).toBe(false);
    });

    it("clean-shutdown marker is created with 0o600 permissions", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      await writeCleanShutdownMarker(tmpDir, marker);
      const stats = await stat(join(tmpDir, ".estacoda", "gateway", ".clean_shutdown"));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("clean-shutdown marker corrects existing 0o644 permissions to 0o600", async () => {
      if (process.platform === "win32") {
        console.log("Skipping permission test on Windows");
        return;
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        console.log("Skipping permission test when running as root");
        return;
      }
      const path = join(tmpDir, ".estacoda", "gateway", ".clean_shutdown");
      await mkdir(join(tmpDir, ".estacoda", "gateway"), { recursive: true });
      await writeFile(path, JSON.stringify({ stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" }), { encoding: "utf8", mode: 0o644 });
      await chmod(path, 0o644);
      const marker = { stoppedAt: new Date().toISOString(), pid: 12345, version: "1.0.0", reason: "drain" as const };
      await writeCleanShutdownMarker(tmpDir, marker);
      const stats = await stat(path);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });
});
