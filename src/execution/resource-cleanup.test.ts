import { expect, it } from "vitest";
import { ResourceCleanup } from "./resource-cleanup.js";
it("unwinds in reverse construction order and attempts every action once after a failure", async () => {
  const cleanup = new ResourceCleanup();
  const calls: number[] = [];
  cleanup.defer(() => { calls.push(1); });
  cleanup.defer(() => { calls.push(2); throw new Error("cleanup failure"); });
  cleanup.defer(() => { calls.push(3); });
  await expect(cleanup.release()).rejects.toThrow("cleanup failure");
  expect(calls).toEqual([3, 2, 1]);
  await expect(cleanup.release()).rejects.toThrow("cleanup failure");
  expect(calls).toEqual([3, 2, 1]);
});
