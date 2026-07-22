import { describe, expect, it, vi } from "vitest";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../papyrus/termio/dec.js";
import { createTerminalLifecycle } from "./terminalLifecycle.js";
import { createSuspendResumeManager, type SuspendResumeLifecycle } from "./suspendResume.js";

function fakeLifecycle(overrides: Partial<SuspendResumeLifecycle> = {}) {
  const calls: string[] = [];
  let started = false;
  const lifecycle: SuspendResumeLifecycle = {
    start: vi.fn(() => {
      calls.push("start");
      started = true;
    }),
    stop: vi.fn(() => {
      calls.push("stop");
      started = false;
      return { errors: [] };
    }),
    isStarted: vi.fn(() => started),
    ...overrides,
  };
  return {
    lifecycle,
    calls,
    setStarted(value: boolean) {
      started = value;
    },
  };
}

describe("suspend/resume manager", () => {
  it("suspend stops a started lifecycle and returns a suspend action", () => {
    const fake = fakeLifecycle();
    fake.setStarted(true);
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    const result = manager.suspend();

    expect(result).toEqual({
      type: "suspend",
      wasStarted: true,
      alreadySuspended: false,
      errors: [],
    });
    expect(fake.calls).toEqual(["stop"]);
    expect(manager.isSuspended()).toBe(true);
  });

  it("resume restarts a lifecycle that was active before suspend", () => {
    const fake = fakeLifecycle();
    fake.setStarted(true);
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    manager.suspend();
    const result = manager.resume();

    expect(result).toEqual({
      type: "resume",
      attempted: true,
      started: true,
      alreadyRunning: false,
    });
    expect(fake.calls).toEqual(["stop", "start"]);
    expect(manager.isSuspended()).toBe(false);
  });

  it("disables and restores SGR mouse tracking across a real suspend/resume cycle", () => {
    const writes: string[] = [];
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        this.isRaw = mode;
      },
    };
    const lifecycle = createTerminalLifecycle({
      stdin,
      stdout: {
        isTTY: true,
        write(chunk: string) {
          writes.push(chunk);
        },
      },
      hideCursor: false,
      enableBracketedPaste: false,
      enableMouseTracking: true,
    });
    const manager = createSuspendResumeManager({ lifecycle });

    lifecycle.start();
    manager.suspend();
    manager.resume();
    lifecycle.stop();

    expect(writes).toEqual([
      ENABLE_MOUSE_TRACKING,
      DISABLE_MOUSE_TRACKING,
      ENABLE_MOUSE_TRACKING,
      DISABLE_MOUSE_TRACKING,
    ]);
  });

  it("repeated suspend and resume calls are idempotent", () => {
    const fake = fakeLifecycle();
    fake.setStarted(true);
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    const firstSuspend = manager.suspend();
    const secondSuspend = manager.suspend();
    const firstResume = manager.resume();
    const secondResume = manager.resume();

    expect(firstSuspend.alreadySuspended).toBe(false);
    expect(secondSuspend).toEqual({
      type: "suspend",
      wasStarted: true,
      alreadySuspended: true,
      errors: [],
    });
    expect(firstResume.attempted).toBe(true);
    expect(firstResume.started).toBe(true);
    expect(secondResume).toEqual({
      type: "resume",
      attempted: false,
      started: true,
      alreadyRunning: true,
    });
    expect(fake.calls).toEqual(["stop", "start"]);
  });

  it("suspend before start is safe and does not force a later start", () => {
    const fake = fakeLifecycle();
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    const suspend = manager.suspend();
    const resume = manager.resume();

    expect(suspend).toEqual({
      type: "suspend",
      wasStarted: false,
      alreadySuspended: false,
      errors: [],
    });
    expect(resume).toEqual({
      type: "resume",
      attempted: false,
      started: false,
      alreadyRunning: false,
    });
    expect(fake.calls).toEqual(["stop"]);
  });

  it("resume reports lifecycle start errors without throwing", () => {
    const error = new Error("raw mode failed");
    const fake = fakeLifecycle({
      start: vi.fn(() => {
        fake.calls.push("start");
        throw error;
      }),
    });
    fake.setStarted(true);
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    manager.suspend();
    const result = manager.resume();

    expect(result).toEqual({
      type: "resume",
      attempted: true,
      started: false,
      alreadyRunning: false,
      error: error,
    });
    expect(manager.isSuspended()).toBe(true);
    expect(fake.calls).toEqual(["stop", "start"]);
  });

  it("suspend surfaces lifecycle cleanup errors safely", () => {
    const error = new Error("show cursor failed");
    const fake = fakeLifecycle({
      stop: vi.fn(() => {
        fake.calls.push("stop");
        return { errors: [error] };
      }),
    });
    fake.setStarted(true);
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    const result = manager.suspend();

    expect(result.errors).toEqual([error]);
    expect(result.wasStarted).toBe(true);
    expect(manager.isSuspended()).toBe(true);
  });

  it("does not require global process or signal objects", () => {
    const fake = fakeLifecycle();
    const manager = createSuspendResumeManager({ lifecycle: fake.lifecycle });

    expect(() => manager.suspend()).not.toThrow();
    expect(() => manager.resume()).not.toThrow();
    expect(fake.calls).toEqual(["stop"]);
  });
});
