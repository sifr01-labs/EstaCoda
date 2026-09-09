import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostEnvironment, type HostExecutionLease } from "./host-environment.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { resolveTestPythonBinary } from "../test/test-python.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";

async function withLease(work: (lease: HostExecutionLease) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "execution-bounds-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "test", surface: "test" });
  try { await work(lease); }
  finally { await lease.release(); environment.destroy(); await rm(root, { recursive: true, force: true }); }
}
async function harness(lease: HostExecutionLease, executeTool: ToolExecutor["executeTool"] = async () => undefined) {
  return createExecuteCodeTool({ workspaceRoot: lease.workspaceRoot, executionLease: lease,
    toolExecutor: { executeTool } as ToolExecutor, sessionDb: {} as SessionDB, trajectoryRecorder: {} as TrajectoryRecorder,
    sessionId: "test", trustedWorkspace: async () => true, pythonBinary: await resolveTestPythonBinary() });
}
it("bounds command and harness floods while retaining structured results", () => withLease(async (lease) => {
  const terminal = createWorkspaceTools({ workspaceRoot: lease.workspaceRoot, executionLease: lease }).find((tool) => tool.name === "terminal.run")!;
  const command = await terminal.run({ command: "node -e \"process.stdout.write('x'.repeat(2000000))\"" });
  expect(command.ok).toBe(true); expect(command.content.length).toBeLessThanOrEqual(16000);
  expect(command.metadata?.outputTruncated).toBe(true);
  const code = await (await harness(lease)).run({ code: 'print("x" * 2000000)', maxOutputChars: 1000 });
  expect(code.ok).toBe(true); expect(code.content.length).toBeLessThanOrEqual(1000);
  expect(code.metadata?.outputTruncated).toBe(true);
}));
it("cancels a running command and rejects dispatch with an already aborted signal", () => withLease(async (lease) => {
  const terminal = createWorkspaceTools({ workspaceRoot: lease.workspaceRoot, executionLease: lease }).find((tool) => tool.name === "terminal.run")!;
  const controller = new AbortController();
  const result = terminal.run({ command: "node -e \"setInterval(()=>{},1000)\"" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  expect((await result).ok).toBe(false);
  expect((await terminal.run({ command: "touch unexpected.txt" }, { signal: controller.signal })).ok).toBe(false);
  await expect(stat(join(lease.workspaceRoot, "unexpected.txt"))).rejects.toThrow();
}));
it("handles fragmented protocol frames and rejects malformed, duplicate and oversized frames", () => withLease(async (lease) => {
  let calls = 0;
  const tool = await harness(lease, async () => { calls++; return undefined; });
  const prefix = "__ESTACODA_TOOL_CALL__";
  const frame = JSON.stringify({ id: "one", tool: "file.read", input: {} });
  const fragmented = await tool.run({ code: `import sys, time\nsys.stdout.write('${prefix}${frame.slice(0, 10)}'); sys.stdout.flush()\ntime.sleep(0.03)\nprint('${frame.slice(10)}', flush=True)\nsys.stdin.readline()\nsys.stdin.readline()` });
  expect(fragmented.ok).toBe(true); expect(calls).toBe(1);
  expect((await tool.run({ code: `print('${prefix}{oops}', flush=True)` })).content).toContain("invalid");
  expect((await tool.run({ code: `print('${prefix}' + 'x' * 70000, flush=True)` })).content).toContain("limit");
  expect((await tool.run({ code: `print('${prefix}${frame}\\n${prefix}${frame}', flush=True)` })).ok).toBe(false);
  expect((await tool.run({ code: "x".repeat(300000) })).content).toContain("limit");
}));
it("bounds nested tool count and cancels a pending nested call on timeout", () => withLease(async (lease) => {
  const tool = await harness(lease);
  const many = await tool.run({ code: 'for i in range(70):\n    tool("file.read", {})' });
  expect(many.ok).toBe(false); expect(many.content).toContain("limit");
  let nestedSignal: AbortSignal | undefined;
  const pending = await harness(lease, async (request) => {
    nestedSignal = request.signal;
    return await new Promise((resolve) => { request.signal?.addEventListener("abort", () => resolve(undefined), { once: true }); });
  });
  const result = await pending.run({ code: 'tool("file.read", {})', timeoutMs: 150 });
  expect(result.ok).toBe(false); expect(result.metadata?.timedOut).toBe(true); expect(nestedSignal?.aborted).toBe(true);
}));
it("rejects oversized workspace reads before allocating their content", () => withLease(async (lease) => {
  const path = join(lease.workspaceRoot, "large.txt");
  await writeFile(path, Buffer.alloc(9 * 1024 * 1024));
  await expect(lease.files.readFile(path)).rejects.toThrow(/limit/);
}));
