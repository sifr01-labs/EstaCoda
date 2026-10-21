import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostEnvironment } from "../execution/host-environment.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createProcessTools } from "../tools/process-tools.js";
import { ProcessManager } from "./process-manager.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "estacoda-managed-command-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "managed-command", surface: "cli" });
  const manager = new ProcessManager({ workspaceRoot: root, executionLease: lease });
  const terminal = createWorkspaceTools({ workspaceRoot: root, executionLease: lease, processManager: manager, commandTimeoutMs: 100 })
    .find(tool => tool.name === "terminal.run")!;
  return { root, lease, manager, terminal, async close() {
    await lease.release(); environment.destroy(); await rm(root, { recursive: true, force: true });
  } };
}

describe("managed terminal continuation", () => {
  it.each([undefined, null])("yields without killing or restarting a command (timeoutMs=%j)", async timeoutMs => {
    const f = await fixture();
    try {
      const result = await f.terminal.run({ command: "printf started >> starts.txt; sleep 0.3; printf done > done.txt", timeoutMs });
      expect(result).toMatchObject({ ok: true, metadata: { running: true, code: null, timedOut: false } });
      const id = (result.metadata?.process as { id: string }).id;
      expect(result.content).toContain(id);
      expect(f.terminal.isFailureOutcomeKnown?.(result)).toBe(false);
      expect(await f.manager.wait(id, 5000)).toMatchObject({ status: "exited", exitCode: 0 });
      expect(await readFile(join(f.root, "starts.txt"), "utf8")).toBe("started");
      expect(await readFile(join(f.root, "done.txt"), "utf8")).toBe("done");
      const logs = createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.logs")!;
      const observed = await logs.run({ id });
      expect(observed).toMatchObject({ ok: true, metadata: { process: { status: "exited", exitCode: 0 } } });
      expect(observed.content).toContain("exited, exit code 0");
    } finally { await f.close(); }
  });

  it("collects short command output and exit status, with stdin closed", async () => {
    const f = await fixture();
    try {
      const terminal = createWorkspaceTools({ workspaceRoot: f.root, executionLease: f.lease, processManager: f.manager, commandTimeoutMs: 5000 })
        .find(tool => tool.name === "terminal.run")!;
      const result = await terminal.run({ command: "cat; printf output; printf error >&2; exit 7" });
      expect(result).toMatchObject({ ok: false, metadata: { running: false, code: 7, timedOut: false, signal: null } });
      expect(result.content).toContain("output"); expect(result.content).toContain("error");
      expect(terminal.isFailureOutcomeKnown?.(result)).toBe(true);
    } finally { await f.close(); }
  });

  it("retains explicit hard deadlines without handing the command to the manager", async () => {
    const f = await fixture();
    try {
      const result = await f.terminal.run({ command: "sleep 30; printf late > late.txt", timeoutMs: 100 });
      expect(result).toMatchObject({ ok: false, metadata: { timedOut: true, timeoutMs: 100 } });
      expect(f.manager.list()).toEqual([]);
      await expect(access(join(f.root, "late.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it("stops a running command on cancellation while waiting", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const terminal = createWorkspaceTools({ workspaceRoot: f.root, executionLease: f.lease, processManager: f.manager, commandTimeoutMs: 5000 })
      .find(tool => tool.name === "terminal.run")!;
    const pending = terminal.run({ command: "printf ready > ready.txt; sleep 30; printf late > late.txt" }, {
      signal: controller.signal, continuationSignal: controller.signal
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    try {
      await vi.waitFor(() => access(join(f.root, "ready.txt")), { timeout: 3000 });
      controller.abort(new Error("cancelled")); await rejected;
      expect(f.manager.list()[0]?.status).toBe("stopped");
      expect(f.manager.list()[0]?.signal).toBeTruthy();
      await expect(access(join(f.root, "late.txt"))).rejects.toThrow();
    } finally { controller.abort(new Error("cancelled")); await pending.catch(() => undefined); await f.close(); }
  });

  it("keeps yielded work owned until explicit stop or execution-scope release", async () => {
    const f = await fixture();
    try {
      const first = await f.terminal.run({ command: "sleep 30" });
      const id = (first.metadata?.process as { id: string }).id;
      const stop = createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.stop")!;
      expect(await stop.run({ id })).toMatchObject({ ok: true, metadata: { process: { status: "stopped" } } });
      expect((await f.terminal.run({ command: "sleep 30; printf late > late.txt" })).metadata?.running).toBe(true);
      await f.lease.release();
      expect(f.manager.list()).toEqual([]);
      await expect(f.manager.start("printf late > late.txt")).rejects.toThrow(/disposed/);
      await expect(access(join(f.root, "late.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it.each(["terminal", "process"])("cancels %s work on the parent deadline after dispatch returns", async kind => {
    const f = await fixture();
    const controller = new AbortController();
    try {
      const tool = kind === "terminal" ? f.terminal : createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.start")!;
      const result = await tool.run({ command: "sleep 30; printf late > late.txt" }, { continuationSignal: controller.signal });
      expect(result.ok).toBe(true);
      controller.abort(new Error("Task deadline reached"));
      await vi.waitFor(() => expect(f.manager.list()[0]?.signal).toBeTruthy(), { timeout: 3000 });
      expect(f.manager.list()[0]?.status).toBe("stopped");
      await expect(access(join(f.root, "late.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it("retains hardline checks and prevents dispatch after cancellation", async () => {
    const f = await fixture();
    try {
      expect((await f.terminal.run({ command: "rm -rf /" })).ok).toBe(false);
      await expect(f.terminal.run({ command: "printf late > late.txt" }, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect(f.manager.list()).toEqual([]);
    } finally { await f.close(); }
  });
});


describe("process log waits", () => {
  it("waits by default for a yielded command and retains its real exit status", async () => {
    const f = await fixture();
    try {
      const result = await f.terminal.run({ command: "sleep 0.3; printf finished; exit 7" });
      const id = (result.metadata?.process as { id: string }).id;
      const logs = createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.logs")!;
      expect(await logs.run({ id, waitMs: 0 })).toMatchObject({ metadata: { process: { status: "running" } } });
      expect(await logs.run({ id })).toMatchObject({ metadata: { process: { status: "failed", exitCode: 7 } } });
    } finally { await f.close(); }
  });

  it("cancels and settles the owned process during a default log wait", async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const result = await f.terminal.run({ command: "sleep 30; printf late > late.txt" });
      const id = (result.metadata?.process as { id: string }).id;
      const logs = createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.logs")!;
      const pending = logs.run({ id }, { signal: abort.signal });
      const rejected = expect(pending).rejects.toThrow("cancelled");
      abort.abort(new Error("cancelled"));
      await rejected;
      expect(f.manager.get(id)).toMatchObject({ status: "stopped" });
      await expect(access(join(f.root, "late.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it("rejects invalid waits and missing process IDs", async () => {
    const f = await fixture();
    try {
      const logs = createProcessTools({ processManager: f.manager }).find(tool => tool.name === "process.logs")!;
      for (const waitMs of [-1, 30001, NaN, Infinity, "1000"]) expect((await logs.run({ id: "missing", waitMs })).ok).toBe(false);
      expect((await logs.run({ id: "missing" })).ok).toBe(false);
    } finally { await f.close(); }
  });
});
