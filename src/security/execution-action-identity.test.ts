import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

it("retains an identical action through a renewed pending expiry without extending approval authority", async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01"));
  const { executionActionIdentity } = await import("./execution-action-identity.js");
  const { createPendingAction, assertPendingAction } = await import("./pending-action-approval.js");
  const scope = { schemaVersion: 1 as const, profileId: "work", sessionId: "session", workspaceIdentityHash: "a".repeat(64),
    authorityFingerprint: "b".repeat(64), environmentInstanceId: "host", surfaceKey: "local" };
  const identity = (content = "reviewed") => executionActionIdentity("work", "session", "file.write", "workspace-write", { path: "a", content });
  const token = identity();
  vi.advanceTimersByTime(9 * 60_000);
  const pending = createPendingAction({ executionScope: scope, actionKey: identity(), riskClass: "workspace-write", description: "write", context: { trustedWorkspace: true } }, 0)!;
  vi.advanceTimersByTime(2 * 60_000);
  expect(identity()).toBe(token);
  expect(identity("changed")).not.toBe(token);
  expect(() => assertPendingAction(pending, scope, 0, identity())).not.toThrow();
  vi.advanceTimersByTime(8 * 60_000);
  expect(() => assertPendingAction(pending, scope, 0)).toThrow(/stale/);
  expect(identity()).not.toBe(token);
});

it("does not evict live approvals under cache pressure and releases capacity at expiry", async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01"));
  const { executionActionIdentity, retainExecutionActionIdentity } = await import("./execution-action-identity.js");
  const identity = (i: number) => executionActionIdentity("work", "session", "file.write", "workspace-write", { i });
  const token = identity(0);
  retainExecutionActionIdentity(token, Date.now() + 24 * 60 * 60_000);
  for (let i = 1; i <= 1100; i++) identity(i);
  expect(identity(0)).toBe(token);
  // Fill all remaining slots with live receipts instead of silently losing one.
  for (let i = 1101; i < 2100; i++) retainExecutionActionIdentity(identity(i), Date.now() + 24 * 60 * 60_000);
  expect(() => identity(2100)).toThrow(/Too many pending actions/);
  expect(identity(0)).toBe(token);
  vi.advanceTimersByTime(24 * 60 * 60_000);
  expect(() => identity(2100)).not.toThrow();
});

it("releases consumed Task retention without evicting another approval for the same action", async () => {
  vi.resetModules();
  const { executionActionIdentity, retainExecutionActionIdentity, releaseExecutionActionRetention } = await import("./execution-action-identity.js");
  const identity = (i: number) => executionActionIdentity("work", "session", "file.write", "workspace-write", { i });
  const token = identity(0);
  retainExecutionActionIdentity(token, Date.now() + 86_400_000, "task:first");
  retainExecutionActionIdentity(token, Date.now() + 86_400_000, "task:second");
  releaseExecutionActionRetention("task:first");
  for (let i = 1; i < 1100; i++) identity(i);
  expect(identity(0)).toBe(token);
  releaseExecutionActionRetention("task:second");
  for (let i = 1100; i < 2100; i++) identity(i);
  expect(identity(0)).not.toBe(token);
});
