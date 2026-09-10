import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { HostProcessScope } from "./host-processes.js";
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

it("isolates default environments and preserves only explicit adapter values", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-env-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "test", surface: "test" });
  const previous = process.env.ESTACODA_PROCESS_TEST_TOKEN;
  process.env.ESTACODA_PROCESS_TEST_TOKEN = "parent-only";
  try {
    const env = lease.processes.environment({ extra: { CAPABILITY_ENDPOINT: "configured", HOME: "/ignored" } });
    expect(env.ESTACODA_PROCESS_TEST_TOKEN).toBeUndefined();
    expect(env.CAPABILITY_ENDPOINT).toBe("configured");
    expect(env.HOME).not.toBe("/ignored");
    const child = lease.processes.spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env });
    let output = ""; child.stdout.on("data", (chunk) => { output += String(chunk); });
    await once(child, "close");
    expect(JSON.parse(output).CAPABILITY_ENDPOINT).toBe("configured");
    expect(JSON.parse(output).ESTACODA_PROCESS_TEST_TOKEN).toBeUndefined();
    await lease.release();
    await expect(stat(env.HOME!)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.ESTACODA_PROCESS_TEST_TOKEN;
    else process.env.ESTACODA_PROCESS_TEST_TOKEN = previous;
    await lease.release(); environment.destroy(); await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32").each(["absent", "present", "denied"])("requires OS proof of group absence after a signal/exit race (%s)", async (state) => {
  const scope = new HostProcessScope(process.cwd());
  const child = scope.spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"], { env: {} });
  await once(child.stdout, "data");
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== -child.pid!) return kill(pid, signal);
    if (signal === 0) {
      if (state === "present") return true;
      if (state === "denied") throw Object.assign(new Error("probe denied"), { code: "EPERM" });
      return kill(pid, signal);
    }
    throw Object.assign(new Error("signal denied"), { code: "EPERM" });
  });
  try {
    const termination = scope.terminate(child, "SIGKILL");
    child.kill("SIGKILL"); // The leader exits independently of the failed group signal.
    if (state === "absent") await expect(termination).resolves.toBeUndefined();
    else {
      await expect(termination).rejects.toThrow(/could not be confirmed/);
      const signals = spy.mock.calls.filter(([, signal]) => signal !== 0).length;
      await expect(scope.release()).rejects.toThrow(/did not settle/);
      expect(spy.mock.calls.filter(([, signal]) => signal !== 0)).toHaveLength(signals);
    }
  } finally {
    spy.mockRestore();
    child.kill("SIGKILL");
    await scope.release(); // A later retry may settle only after fresh OS proof.
  }
});

it.skipIf(process.platform === "win32")("waits for delayed group disappearance after close without ignoring a denied signal", async () => {
  const scope = new HostProcessScope(process.cwd());
  const child = scope.spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"], { env: {} });
  await once(child.stdout, "data");
  const kill = process.kill.bind(process);
  let probes = 0;
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== -child.pid!) return kill(pid, signal);
    if (signal === 0) {
      if (++probes < 4) return true;
      return kill(pid, signal);
    }
    throw Object.assign(new Error("signal denied"), { code: "EPERM" });
  });
  try {
    const termination = scope.terminate(child, "SIGKILL");
    const concurrent = scope.terminate(child, "SIGKILL");
    child.kill("SIGKILL");
    await Promise.all([termination, concurrent]);
    expect(probes).toBeGreaterThanOrEqual(4);
  } finally {
    spy.mockRestore(); child.kill("SIGKILL"); await scope.release();
  }
});

it.skipIf(process.platform === "win32")("keeps a standalone Node process alive until the cleanup decision settles", async () => {
  const moduleUrl = new URL("./host-processes.ts", import.meta.url).href;
  const script = `
    import { once } from 'node:events';
    import { HostProcessScope } from ${JSON.stringify(moduleUrl)};
    const scope = new HostProcessScope(process.cwd());
    const child = scope.spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{},1000)"], { env: {} });
    await once(child.stdout, 'data');
    const kill = process.kill.bind(process);
    let probes = 0;
    process.kill = (pid, signal) => {
      if (pid !== -child.pid) return kill(pid, signal);
      if (signal === 0) { if (++probes < 4) return true; return kill(pid, signal); }
      throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
    };
    try {
      const termination = scope.terminate(child, 'SIGKILL');
      child.kill('SIGKILL');
      await termination;
      await scope.release();
      process.stdout.write('settled');
    } finally { process.kill = kill; child.kill('SIGKILL'); }
  `;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 5_000 });
  expect(result.stdout).toBe("settled");
});
