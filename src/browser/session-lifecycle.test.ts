import { access, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessionLifecycle,
  DEFAULT_BROWSER_INACTIVITY_TIMEOUT_MS,
  registerEmergencyCleanup
} from "./session-lifecycle.js";

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe("BrowserSessionLifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("touch() resets the inactivity timer", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-1", {});
    await vi.advanceTimersByTimeAsync(59_990);
    lifecycle.touch("session-1");
    await vi.advanceTimersByTimeAsync(20);
    expect(onCleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("cleans up inactive sessions after timeout", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-1", {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onCleanup).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("uses the deterministic five-minute inactivity default", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });

    lifecycle.start();
    lifecycle.register("session-1", {});
    await vi.advanceTimersByTimeAsync(DEFAULT_BROWSER_INACTIVITY_TIMEOUT_MS - 1);
    expect(onCleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("keeps leased sessions alive and resumes normal cleanup after release", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-1", {});
    lifecycle.acquire("session-1", "execution-plan:profile-a:mission-1");
    lifecycle.unregister("session-1");
    lifecycle.register("session-1", { replacement: true });
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(onCleanup).not.toHaveBeenCalled();

    lifecycle.release("session-1", "execution-plan:profile-a:mission-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("isolates leases by session and owner and clears them during shutdown", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-a", {});
    lifecycle.register("session-b", {});
    lifecycle.acquire("session-a", "execution-plan:profile-a:mission-1");
    lifecycle.release("session-a", "execution-plan:profile-b:mission-1");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onCleanup).not.toHaveBeenCalledWith("session-a");
    expect(onCleanup).toHaveBeenCalledWith("session-b");
    await lifecycle.cleanupAll();
    expect(onCleanup).toHaveBeenCalledWith("session-a");

    onCleanup.mockClear();
    lifecycle.register("session-a", {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledWith("session-a");
    lifecycle.stop();
  });

  it("inactive cleanup swallows cleanup failures and continues other sessions", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const onCleanup = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-1") {
        throw new Error("cleanup failed");
      }
    });
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-1", {});
    lifecycle.register("session-2", {});
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    expect(onCleanup).toHaveBeenCalledWith("session-1");
    expect(onCleanup).toHaveBeenCalledWith("session-2");
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
    lifecycle.stop();
  });

  it("unregister() prevents inactivity cleanup", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.register("session-1", {});
    lifecycle.unregister("session-1");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onCleanup).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it("start() and stop() are idempotent", async () => {
    vi.useFakeTimers();
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup
    });

    lifecycle.start();
    lifecycle.start();
    lifecycle.register("session-1", {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledTimes(1);

    lifecycle.stop();
    lifecycle.stop();
    lifecycle.register("session-2", {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  it("reapOrphans() removes dead owner PID browser dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-lifecycle-"));
    const socketDir = join(root, "estacoda-browser-session-1");
    await mkdir(socketDir);
    await writeFile(join(socketDir, "session-1.owner_pid"), "99999999");
    const lifecycle = new BrowserSessionLifecycle({ tmpDir: root, onCleanup: vi.fn() });

    await lifecycle.reapOrphans();

    expect(await exists(socketDir)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("reapOrphans() preserves live owner PID browser dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-lifecycle-"));
    const socketDir = join(root, "estacoda-browser-session-1");
    await mkdir(socketDir);
    await writeFile(join(socketDir, "session-1.owner_pid"), String(process.pid));
    const lifecycle = new BrowserSessionLifecycle({ tmpDir: root, onCleanup: vi.fn() });

    await lifecycle.reapOrphans();

    expect(await exists(socketDir)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("reapOrphans() preserves malformed owner PID browser dirs safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-lifecycle-"));
    const socketDir = join(root, "estacoda-browser-session-1");
    await mkdir(socketDir);
    await writeFile(join(socketDir, "session-1.owner_pid"), "not-a-pid");
    const lifecycle = new BrowserSessionLifecycle({ tmpDir: root, onCleanup: vi.fn() });

    await lifecycle.reapOrphans();

    expect(await exists(socketDir)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("cleanupAll() gives tests an explicit emergency cleanup path", async () => {
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });

    lifecycle.register("session-1", {});
    await lifecycle.cleanupAll();
    await lifecycle.cleanupAll();

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledWith("session-1");
  });

  it("cleanupAll() swallows per-session failures and continues cleanup", async () => {
    const onCleanup = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-1") {
        throw new Error("cleanup failed");
      }
    });
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });

    lifecycle.register("session-1", {});
    lifecycle.register("session-2", {});
    await expect(lifecycle.cleanupAll()).resolves.toBeUndefined();

    expect(onCleanup).toHaveBeenCalledWith("session-1");
    expect(onCleanup).toHaveBeenCalledWith("session-2");
  });

  it("registerEmergencyCleanup() registers idempotently and unregisters handlers", () => {
    const lifecycle = new BrowserSessionLifecycle({ onCleanup: vi.fn() });
    const exitBefore = process.listenerCount("exit");
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const unregister = registerEmergencyCleanup(lifecycle);
    const secondUnregister = registerEmergencyCleanup(lifecycle);

    expect(secondUnregister).toBe(unregister);
    expect(process.listenerCount("exit")).toBe(exitBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

    unregister();
    expect(process.listenerCount("exit")).toBe(exitBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("SIGINT emergency handler does not call process.exit()", async () => {
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });
    lifecycle.register("session-1", {});
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = new Set(process.listeners("SIGINT"));
    const unregister = registerEmergencyCleanup(lifecycle);
    const added = process.listeners("SIGINT").find((listener) => !before.has(listener));

    expect(added).toBeDefined();
    (added as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCleanup).toHaveBeenCalledWith("session-1");
    expect(processExit).not.toHaveBeenCalled();
    unregister();
  });

  it("SIGTERM emergency handler invokes bounded cleanup idempotently", async () => {
    const onCleanup = vi.fn(async () => undefined);
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });
    lifecycle.register("session-1", {});
    const before = new Set(process.listeners("SIGTERM"));
    const unregister = registerEmergencyCleanup(lifecycle);
    const added = process.listeners("SIGTERM").find((listener) => !before.has(listener));

    expect(added).toBeDefined();
    (added as () => void)();
    (added as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledWith("session-1");
    unregister();
  });

  it("exit emergency handler is sync-only and does not start async cleanup", () => {
    const onCleanup = vi.fn();
    const lifecycle = new BrowserSessionLifecycle({ onCleanup });
    lifecycle.register("session-1", {});
    const before = new Set(process.listeners("exit"));
    const unregister = registerEmergencyCleanup(lifecycle);
    const added = process.listeners("exit").find((listener) => !before.has(listener));

    expect(added).toBeDefined();
    (added as () => void)();

    expect(onCleanup).not.toHaveBeenCalled();
    unregister();
  });
});
