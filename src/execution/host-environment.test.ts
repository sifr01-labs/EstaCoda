import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostEnvironment } from "./host-environment.js";

it("releases only the last borrower of a scope and leaves independent children usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-lease-"));
  try {
    const environment = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
    const parent = environment.acquire({ profileId: "work", sessionId: "parent", surface: "cli" });
    const viewer = parent.borrow();
    const child = parent.child({ profileId: "work", sessionId: "child", surface: "task", taskId: "task", attemptId: "attempt" });
    const cleanup = vi.fn(); parent.own({ release: cleanup });
    expect(() => parent.child({ profileId: "other", sessionId: "child", surface: "task" })).toThrow(/profile/);
    await parent.release(); expect(cleanup).not.toHaveBeenCalled();
    expect(() => parent.assertActive()).toThrow(/released/); viewer.assertActive();
    await viewer.release(); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(viewer.signal.aborted).toBe(true); child.assertActive();
    expect(child.context.parentScopeId).toBe(parent.scopeId);
    expect(() => environment.destroy()).toThrow(/borrowed/);
    await child.release(); environment.destroy();
    expect(() => environment.acquire({ profileId: "work", sessionId: "new", surface: "cli" })).toThrow(/unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("waits for resource settlement and reports every cleanup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-settle-"));
  try {
    const environment = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
    const lease = environment.acquire({ profileId: "work", sessionId: "session", surface: "acp" });
    const cleanup = vi.fn();
    lease.own({ release: () => { throw new Error("cleanup failed"); } });
    lease.own({ release: cleanup });
    await expect(lease.release()).rejects.toThrow(/cleanup failed/);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(lease.release()).rejects.toThrow(/cleanup failed/);
    expect(() => environment.destroy()).toThrow(/settling/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("defers shared substrate cleanup until independently owned scopes finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-retirement-"));
  try {
    const environment = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
    const parent = environment.acquire({ profileId: "work", sessionId: "parent", surface: "cli" });
    const child = parent.child({ profileId: "work", sessionId: "child", surface: "task" });
    const cleanup = vi.fn(async () => {});
    await parent.release(); await environment.retire(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    child.assertActive();
    const grandchild = child.child({ profileId: "work", sessionId: "grandchild", surface: "delegation" });
    await child.release(); expect(cleanup).not.toHaveBeenCalled();
    await grandchild.release(); expect(cleanup).toHaveBeenCalledOnce();
    expect(() => environment.acquire({ profileId: "work", sessionId: "new", surface: "cli" })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retries only failed resources while keeping a failed release revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-retry-"));
  try {
    const environment = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
    const lease = environment.acquire({ profileId: "work", sessionId: "s", surface: "cli" });
    const success = vi.fn(), retry = vi.fn().mockRejectedValueOnce(new Error("uncertain")).mockResolvedValue(undefined);
    lease.own({ release: success }); lease.own({ release: retry });
    await expect(lease.release()).rejects.toThrow("cleanup failed");
    expect(() => lease.assertActive()).toThrow("released");
    expect(() => lease.borrow()).toThrow("released");
    await lease.release(); await lease.release();
    expect(success).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledTimes(2);
    environment.destroy();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retries retirement without replaying successful driver disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-retirement-retry-"));
  try {
    const host = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
    const { HostWorkspaceFiles } = await import("./host-workspace-files.js");
    const { HostProcessScope } = await import("./host-processes.js");
    const dispose = vi.fn().mockResolvedValue(undefined);
    const environment = HostEnvironment.prepared("work", host.facts, {
      files: (active) => new HostWorkspaceFiles(root, active), processes: () => new HostProcessScope(root), dispose
    });
    const cleanup = vi.fn().mockRejectedValueOnce(new Error("retry")).mockResolvedValue(undefined);
    await expect(environment.retire(cleanup)).rejects.toThrow("retry");
    await environment.retire(cleanup);
    expect(dispose).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledTimes(2);
    host.destroy();
  } finally { await rm(root, { recursive: true, force: true }); }
});
