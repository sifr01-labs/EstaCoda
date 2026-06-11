import { describe, expect, it } from "vitest";
import { runBoundedBatch } from "./batch-runner.js";

describe("runBoundedBatch", () => {
  it("limits concurrency and returns results in input order", async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<number, () => void>();

    const pending = runBoundedBatch({
      tasks: [0, 1, 2],
      maxConcurrency: 2,
      runTask: async (task, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          resolvers.set(index, resolve);
        });
        active -= 1;
        return `result-${task}`;
      },
      skipTask: (task) => `skipped-${task}`
    });

    await waitFor(() => resolvers.size === 2);
    resolvers.get(1)?.();
    await waitFor(() => resolvers.size === 3);
    resolvers.get(2)?.();
    resolvers.get(0)?.();

    const result = await pending;
    expect(maxActive).toBe(2);
    expect(result.results).toEqual(["result-0", "result-1", "result-2"]);
  });

  it("does not start queued tasks after parent abort", async () => {
    const controller = new AbortController();
    let started = 0;

    const result = await runBoundedBatch({
      tasks: ["a", "b", "c"],
      maxConcurrency: 1,
      signal: controller.signal,
      runTask: async (task) => {
        started += 1;
        controller.abort();
        return `ran-${task}`;
      },
      skipTask: (task) => `skipped-${task}`
    });

    expect(started).toBe(1);
    expect(result.results).toEqual(["ran-a", "skipped-b", "skipped-c"]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 500) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
