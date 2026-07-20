import { describe, expect, it, vi } from "vitest";
import { TaskBackgroundHost } from "./task-background-host.js";

const EMPTY_SCHEDULER_RESULT = {
  reconciled: 0,
  dispatched: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  leaseLost: 0,
  warnings: []
};

describe("TaskBackgroundHost", () => {
  it("recovers interrupted delivery once before scheduling and delivery", async () => {
    const order: string[] = [];
    const recoverInterrupted = vi.fn(() => {
      order.push("recover");
      return 2;
    });
    const scheduler = vi.fn(async () => {
      order.push("scheduler");
      return EMPTY_SCHEDULER_RESULT;
    });
    const delivery = vi.fn(async () => {
      order.push("delivery");
      return { recovered: 0, claimed: 0, delivered: 0, failed: 0 };
    });
    const host = new TaskBackgroundHost({
      scheduler: { runOnce: scheduler },
      delivery: { recoverInterrupted, runOnce: delivery }
    });

    await expect(host.runOnce()).resolves.toMatchObject({
      skipped: false,
      delivery: { recovered: 2 }
    });
    await host.runOnce();
    expect(order).toEqual(["recover", "scheduler", "delivery", "scheduler", "delivery"]);
    expect(recoverInterrupted).toHaveBeenCalledTimes(1);
    expect(host.status()).toMatchObject({ running: false, runs: 2 });
  });

  it("skips overlapping ticks and reports active work until it settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const host = new TaskBackgroundHost({
      scheduler: { runOnce: async () => { await blocked; return EMPTY_SCHEDULER_RESULT; } },
      delivery: {
        recoverInterrupted: () => 0,
        runOnce: async () => ({ recovered: 0, claimed: 0, delivered: 0, failed: 0 })
      }
    });

    const active = host.runOnce();
    expect(host.hasPendingWork()).toBe(true);
    await expect(host.runOnce()).resolves.toEqual({ skipped: true });
    release();
    await active;
    await host.waitForIdle();
    expect(host.hasPendingWork()).toBe(false);
  });

  it("clears failed runs without creating an unhandled rejecting cleanup promise", async () => {
    const scheduler = vi.fn()
      .mockRejectedValueOnce(new TypeError("scheduler unavailable"))
      .mockResolvedValueOnce(EMPTY_SCHEDULER_RESULT);
    const host = new TaskBackgroundHost({
      scheduler: { runOnce: scheduler },
      delivery: {
        recoverInterrupted: () => 0,
        runOnce: async () => ({ recovered: 0, claimed: 0, delivered: 0, failed: 0 })
      }
    });

    await expect(host.runOnce()).rejects.toThrow("scheduler unavailable");
    expect(host.status()).toMatchObject({ running: false, runs: 1, lastErrorClass: "TypeError" });
    await expect(host.runOnce()).resolves.toMatchObject({ skipped: false });
    expect(host.status()).toMatchObject({ running: false, runs: 2 });
  });
});
