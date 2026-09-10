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
it("releases ownership only after successful resource cleanup", async () => {
  const calls: string[] = [];
  const failed = new ResourceCleanup();
  failed.afterRelease(() => { calls.push("owner"); });
  failed.defer(() => { throw new Error("unsettled"); });
  await expect(failed.release()).rejects.toThrow("unsettled");
  expect(calls).toEqual([]);
  const settled = new ResourceCleanup();
  settled.afterRelease(() => { calls.push("database"); });
  settled.afterRelease(() => { calls.push("owner"); });
  settled.defer(() => { calls.push("resource"); });
  await settled.release();
  expect(calls).toEqual(["resource", "owner", "database"]);
});
