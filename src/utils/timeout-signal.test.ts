import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal } from "./timeout-signal.js";

describe("createTimeoutSignal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts and classifies total timeout", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal({ timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(true);
    expect(timeout.timeoutKind()).toBe("total");
    expect(timeout.classify(timeout.signal.reason)).toBe("timeout");
    timeout.cleanup();
  });

  it("aborts and classifies stale timeout", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal({ timeoutMs: 100, staleTimeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(true);
    expect(timeout.timeoutKind()).toBe("stale");
    expect(timeout.classify(timeout.signal.reason)).toBe("timeout");
    timeout.cleanup();
  });

  it("resets stale timeout on progress", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal({ timeoutMs: 100, staleTimeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(8);
    timeout.markProgress();
    await vi.advanceTimersByTimeAsync(8);
    expect(timeout.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timeoutKind()).toBe("stale");
    timeout.cleanup();
  });

  it("disables stale timeout without disabling total timeout", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal({ timeoutMs: 20, staleTimeoutMs: 5 });

    timeout.disableStale();
    await vi.advanceTimersByTimeAsync(6);
    expect(timeout.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(14);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timeoutKind()).toBe("total");
    timeout.cleanup();
  });

  it("cleanup clears timers", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal({ timeoutMs: 5, staleTimeoutMs: 5 });

    timeout.cleanup();
    await vi.advanceTimersByTimeAsync(10);

    expect(timeout.signal.aborted).toBe(false);
  });

  it("propagates parent abort without classifying it as local timeout", () => {
    const parent = new AbortController();
    const timeout = createTimeoutSignal({ timeoutMs: 100, parentSignal: parent.signal });

    parent.abort(new DOMException("Cancelled", "AbortError"));

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(false);
    expect(timeout.timeoutKind()).toBeUndefined();
    expect(timeout.classify(timeout.signal.reason)).toBeUndefined();
    timeout.cleanup();
  });

  it("does not classify real network errors as timeout", () => {
    const timeout = createTimeoutSignal({ timeoutMs: 100 });

    expect(timeout.classify(new Error("Connection refused"))).toBeUndefined();
    timeout.cleanup();
  });
});
