import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { HostEnvironment } from "./host-environment.js";
import { ProcessManager } from "../process/process-manager.js";

it("keeps shared-view process resources isolated and releases only the owning scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-processes-"));
  const env = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
  const parent = env.acquire({ profileId: "work", sessionId: "parent", surface: "cli" });
  const child = parent.child({ profileId: "work", sessionId: "child", surface: "task" });
  try {
    const script = "process.stdout.write('ready'); setInterval(() => {}, 1000)";
    const one = parent.processes.spawn(process.execPath, ["-e", script]);
    const two = child.processes.spawn(process.execPath, ["-e", script]);
    await Promise.all([once(one.stdout, "data"), once(two.stdout, "data")]);
    await child.processes.terminate(one);
    expect(one.exitCode).toBeNull(); expect(one.signalCode).toBeNull();
    await parent.release();
    expect(one.signalCode).not.toBeNull();
    expect(two.exitCode).toBeNull(); expect(two.signalCode).toBeNull();
    child.assertActive();
  } finally { await parent.release(); await child.release(); env.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("does not expose another session's managed records or prepared credential destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-records-"));
  const env = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
  const parent = env.acquire({ profileId: "work", sessionId: "parent", surface: "cli" });
  const child = parent.child({ profileId: "work", sessionId: "child", surface: "task" });
  const a = new ProcessManager({ workspaceRoot: root, executionLease: parent });
  const b = new ProcessManager({ workspaceRoot: root, executionLease: child });
  try {
    const record = await a.prepareProtectedEnvironment("echo ready", "EXAMPLE_TOKEN");
    expect(b.list()).toEqual([]); expect(b.get(record.id)).toBeUndefined();
    expect(b.canStartProtectedEnvironment(record.id, "EXAMPLE_TOKEN")).toBe(false);
    expect(await b.stop(record.id)).toBeUndefined();
    expect(a.get(record.id)?.status).toBe("prepared");
  } finally { await a.dispose(); await b.dispose(); await parent.release(); await child.release(); env.destroy(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("terminates an owned process group including a descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-tree-"));
  const env = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
  const lease = env.acquire({ profileId: "work", sessionId: "session", surface: "cli" });
  try {
    const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000);";
    const processHandle = lease.processes.spawn(process.execPath, ["-e", script]);
    const [output] = await once(processHandle.stdout, "data");
    const descendant = Number(String(output));
    expect(descendant).toBeGreaterThan(0);
    await lease.release();
    expect(() => process.kill(descendant, 0)).toThrow();
  } finally { await lease.release(); env.destroy(); await rm(root, { recursive: true, force: true }); }
});
