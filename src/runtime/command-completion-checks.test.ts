import { ToolLoopProgressGuard } from "./tool-loop-progress-guard.js";
import { ExecutionCheckpointController } from "./execution-checkpoint-controller.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { resolveTestPythonBinary } from "../test/test-python.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createProcessTools } from "../tools/process-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { ToolExecutor, type ToolExecutionRecord } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { deriveRequestRequirements } from "./request-requirements.js";
import { commandCompletionChecks, commandCompletionFeedback } from "./command-completion-checks.js";
import { deriveExecutionFinalOutcome } from "./execution-outcome.js";

async function fixture(request = "Write report.txt and read it back", floor: "mutation" | "mutation_with_verification" = "mutation", throughExecutor = false) {
  const root = await mkdtemp(join(tmpdir(), "completion-checks-"));
  const manager = new ProcessManager({ workspaceRoot: root });
  const tools = [...createWorkspaceTools({ workspaceRoot: root, processManager: manager, commandTimeoutMs: 100 }), ...createProcessTools({ processManager: manager })];
  tools.push(createExecuteCodeTool({ workspaceRoot: root, pythonBinary: await resolveTestPythonBinary(),
    toolExecutor: { executeTool: async () => undefined } as never, sessionDb: {} as never,
    trajectoryRecorder: {} as never, sessionId: "test", trustedWorkspace: async () => true, allowedTools: [] }));
  const requirements = deriveRequestRequirements(request, "turn-1");
  const calls: ToolExecutionRecord[] = [];
  const index = new ExecutionEvidenceIndex();
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const sessionDb = new InMemorySessionDB();
  await sessionDb.createSession({ profileId: "test", id: "test" });
  const executor = new ToolExecutor({ registry, workspaceRoot: root, securityPolicy: { decide: () => "allow" }, sessionDb,
    trajectoryRecorder: new TrajectoryRecorder({ profileId: "test", sessionId: "test", modelId: "test" }) });
  const run = async (name: string, input: Record<string, unknown>, turn = "turn-1") => {
    if (throughExecutor) {
      const call = await executor.executeTool({ tool: name, input, toolCallId: `call-${calls.length}`, trustedWorkspace: true, sessionId: "test", visibleTurnId: turn, requestContract: { version: 1, objective: request, requirements } });
      expect(call).toBeDefined();
      calls.push(call!); index.record(call!, turn); return call!.result!;
    }
    const tool = tools.find(tool => tool.name === name)!;
    const result = await tool.run(input, { visibleTurnId: turn, requestContract: { requirements } } as never);
    const call: ToolExecutionRecord = { tool, input, result, decision: "allow", riskClass: tool.riskClass,
      toolCallId: `call-${calls.length}`, executionEffect: { kind: tool.riskClass === "read-only-local" ? "read" : "mutation" } };
    calls.push(call); index.record(call, turn); return result;
  };
  const output = async (content = "ready") => {
      expect((await run("file.write", { path: "report.txt", content, overwrite: true })).ok).toBe(true);
    await run("file.read", { path: "report.txt" });
  };
  const outcome = () => {
    const input = { toolExecutions: calls, executionReceipts: index.recordsForTurn("turn-1"), requestRequirements: requirements, completionFloor: floor };
    return deriveExecutionFinalOutcome(input);
  };
  return { root, run, output, outcome, calls, async close() { await manager.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("completion checks and unsuccessful approaches", () => {
  it("settles an early missing output after producing and reading it through a relative path", async () => {
    const f = await fixture();
    try {
      expect(await f.run("file.read", { path: join(f.root, "report.txt") })).toMatchObject({ ok: false, metadata: { code: "ENOENT" } });
      await f.output();
      expect(f.outcome().status).toBe("completed_with_recovered_errors");
    } finally { await f.close(); }
  });
  it("credits a passing required check for a task without a named file contract", async () => {
    const f = await fixture("Build a package and ensure it works", "mutation_with_verification");
    try {
      await f.run("terminal.run", { command: "printf ready > package.txt", timeoutMs: 100 });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("terminal.run", { command: "test -s package.txt", verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed");
      await f.run("file.write", { path: "package.txt", content: "changed", overwrite: true });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("terminal.run", { command: "test -s package.txt", verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed");
    } finally { await f.close(); }
  });

  it("settles an unsuccessful probe after a current required check passes without a file contract", async () => {
    const f = await fixture("Build a package and ensure it works", "mutation_with_verification");
    try {
      await f.run("terminal.run", { command: "estacoda_missing_probe_84391", timeoutMs: 100 });
      await f.run("terminal.run", { command: "printf ready > package.txt", timeoutMs: 100 });
      await f.run("terminal.run", { command: "test -s package.txt", verification: "package-installation", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed_with_recovered_errors");
    } finally { await f.close(); }
  });
  it("accepts verified output after an unavailable diagnostic interpreter", async () => {
    const f = await fixture();
    try {
      const result = await f.run("terminal.run", { command: "estacoda_nonexistent_diagnostic_84391 --version", timeoutMs: 100 });
      expect(result).toMatchObject({ ok: false, metadata: { code: 127 } });
      await f.output();
      expect(f.outcome()).toMatchObject({ status: "completed_with_recovered_errors" });
      expect(f.calls[0]?.result?.ok).toBe(false); // The original failure is retained.
    } finally { await f.close(); }
  });

  it("preserves a failed check through unrelated success and output repair until the check passes", async () => {
    const f = await fixture();
    const command = 'test "$(cat report.txt)" = ready';
    try {
      await f.output("wrong");
      expect((await f.run("terminal.run", { command, verification: "output-check", timeoutMs: 100 })).ok).toBe(false);
      await f.run("terminal.inspect", { argv: ["pwd"] });
      expect(f.outcome().status).toBe("partially_completed");
      await f.output();
      expect(f.outcome().status).toBe("partially_completed");
      // A different implementation may prove the same requirement.
      await f.run("terminal.run", { command: `test ready = "$(cat report.txt)"`, verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed_with_recovered_errors");
    } finally { await f.close(); }
  });

  it("invalidates passing checks after an edit, but not an unchanged diagnostic", async () => {
    const f = await fixture();
    try {
      await f.output();
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      await f.run("terminal.inspect", { argv: ["pwd"] });
      expect(f.outcome().status).toBe("completed");
      await f.output("new version");
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed");
    } finally { await f.close(); }
  });

  it.each([0, 1])("requires the final managed-check exit, not successful log retrieval (exit %i)", async code => {
    const f = await fixture();
    try {
      await f.output();
      const started = await f.run("terminal.run", { command: `sleep 0.3; exit ${code}`, verification: "output-check" });
      expect(started.metadata?.running).toBe(true);
      expect(f.outcome().status).toBe("partially_completed");
      const id = (started.metadata?.process as { id: string }).id;
      const result = await f.run("process.logs", { id, waitMs: 5000 });
      expect(result.ok).toBe(true);
      expect(f.outcome().status).toBe(code === 0 ? "completed" : "partially_completed");
    } finally { await f.close(); }
  });

  it("does not erase a timeout with subsequent output", async () => {
    const f = await fixture();
    try {
      expect(await f.run("terminal.run", { command: "sleep 30", timeoutMs: 50 })).toMatchObject({ ok: false, metadata: { timedOut: true } });
      await f.output();
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });

  it("does not accept another turn's passing check", async () => {
    const f = await fixture();
    try {
      await f.output();
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      await f.output("changed");
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 }, "turn-2");
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });

  it.each([false, true])("does not reuse a managed exit after editing output (collected before edit: %s)", async collected => {
    const f = await fixture();
    try {
      await f.output();
      const started = await f.run("terminal.run", { command: "sleep 0.3; test -s report.txt", verification: "output-check" });
      const id = (started.metadata?.process as { id: string }).id;
      if (collected) await f.run("process.logs", { id, waitMs: 5000 });
      await f.output("new output");
      await f.run("process.logs", { id, waitMs: 5000 });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("process.logs", { id, waitMs: 0 });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("terminal.run", { command: "sleep 0.3; test -s report.txt", verification: "output-check" });
      const retry = f.calls.at(-1)!.result!.metadata!.process as { id: string };
      await f.run("process.logs", { id: retry.id, waitMs: 5000 });
      expect(f.outcome().status).toBe("completed");
    } finally { await f.close(); }
  });

  it("does not let another passing check erase a failed check", async () => {
    const f = await fixture();
    try {
      await f.run("terminal.run", { command: "exit 1", verification: "unit-tests", timeoutMs: 100 });
      await f.output();
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });

  it("invalidates checks when a command changes the observed output", async () => {
    const f = await fixture();
    try {
      await f.output();
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      await f.run("terminal.run", { command: "printf changed > report.txt", timeoutMs: 100 });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed");
    } finally { await f.close(); }
  });

  it("does not invent stale build evidence from inspections and a service start", async () => {
    const f = await fixture("Build a package and serve it", "mutation_with_verification");
    try {
      await f.run("terminal.run", { command: "printf ready > package.txt", verification: "package-build", timeoutMs: 100 });
      await f.run("terminal.run", { command: "cat package.txt; pwd", timeoutMs: 100 });
      await f.run("process.start", { command: "sleep 30" });
      await f.run("terminal.run", { command: "test -s package.txt", verification: "package-installation", timeoutMs: 100 });
      expect(f.outcome().status).toBe("completed");
      await f.run("file.write", { path: "package.txt", content: "changed", overwrite: true });
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });

  it("keeps the hardline floor for declared checks", async () => {
    const f = await fixture();
    try {
      expect((await f.run("terminal.run", { command: "rm -rf /", verification: "output-check", timeoutMs: 100 })).ok).toBe(false);
      await f.output();
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });

  it("rejects invalid declarations without starting the command", async () => {
    const f = await fixture();
    try {
      expect((await f.run("terminal.run", { command: "touch never-created", verification: true })).ok).toBe(false);
      expect((await f.run("file.read", { path: "never-created" })).ok).toBe(false);
    } finally { await f.close(); }
  });
});

// Runtime settlement, not a provider-supplied exit code, identifies an approach
// that was refused before dispatch. The original boundary remains inspectable.
describe("declared check recovery boundaries", () => {
  const check = (id: string, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
    tool: { name: "terminal.run", riskClass: "workspace-write", description: "Run", inputSchema: {}, toolsets: [], progressLabel: "run", maxResultSizeChars: 100 },
    toolCallId: id, input: { command: "test -s output.txt", verification: "output-check" },
    decision: "allow", riskClass: "workspace-write", executionEffect: { kind: "mutation" },
    settlement: { terminalStatus: "completed", dispatchState: "finished", sideEffectState: "confirmed" },
    result: { ok: true, content: "", metadata: { code: 0, cwd: "/work", signal: null, timedOut: false, cancelled: false } },
    ...overrides
  });
  const denied = (): ToolExecutionRecord => check("denied", {
    decision: "deny", riskClass: "destructive-local", result: undefined,
    settlement: { terminalStatus: "failed", dispatchState: "not_started", sideEffectState: "none" }
  });
  const observe = (calls: ToolExecutionRecord[], turns: string[] = []) => {
    const index = new ExecutionEvidenceIndex();
    calls.forEach((call, i) => index.record(call, turns[i] ?? "turn-1"));
    return { calls, receipts: index.recordsForTurn("turn-1") };
  };
  it("recovers a refused local check only after a fresh authorized check of the same requirement", () => {
    const refused = denied();
    const first = observe([refused]);
    expect(commandCompletionChecks(first.calls, first.receipts)).toMatchObject({ unresolved: true, unresolvedRequirements: ["output-check"] });
    const success = observe([refused, check("passed")]);
    expect(commandCompletionChecks(success.calls, success.receipts)).toMatchObject({ unresolved: false, recoveredCalls: new Set(["denied"]) });
    expect(refused.decision).toBe("deny");
    expect(deriveExecutionFinalOutcome({ toolExecutions: success.calls, executionReceipts: success.receipts, completionFloor: "mutation_with_verification" }).status).toBe("completed_with_recovered_errors");
  });
  it.each(["ask", "unknown-dispatch", "uncertain", "connector", "external"])("does not recover the %s boundary", kind => {
    const refused = denied();
    if (kind === "ask") refused.decision = "ask";
    if (kind === "unknown-dispatch") refused.settlement = { terminalStatus: "failed", dispatchState: "unknown", sideEffectState: "none" };
    if (kind === "uncertain") refused.settlement = { terminalStatus: "failed", dispatchState: "started", sideEffectState: "possible" };
    if (kind === "connector") refused.executionEffect = { kind: "mutation", connector: { kind: "mcp", id: "remote" } };
    if (kind === "external") refused.riskClass = "external-side-effect";
    const f = observe([refused, check("passed")]);
    expect(commandCompletionChecks(f.calls, f.receipts).recoveredCalls.has("denied")).toBe(false);
  });
  it("requires the same requirement in the same turn, after the denial and on current output", () => {
    for (const f of [
      observe([denied(), check("other", { input: { command: "true", verification: "unrelated" } })]),
      observe([denied(), check("later")], ["turn-1", "turn-2"]),
      observe([denied(), check("remote", { executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "remote" } } })]),
      observe([denied(), check("external", { riskClass: "external-side-effect" })]),
      observe([check("earlier"), denied()]),
      observe([denied(), check("pass"), check("edit", { tool: { ...check("edit").tool, name: "file.write" }, input: { path: "output.txt", content: "changed" } })])
    ]) expect(commandCompletionChecks(f.calls, f.receipts).recoveredCalls.has("denied")).toBe(false);
  });
  it.each([127, 139, 1])("names the failed requirement after exit %i instead of accepting readback or another label", code => {
    const failed = check("failed", { result: { ok: false, content: "failure", metadata: { code, cwd: "/work", signal: null, timedOut: false, cancelled: false } } });
    const other = check("renamed", { input: { command: "test -s output.txt", verification: "new-label" } });
    const f = observe([failed, other]);
    expect(commandCompletionFeedback(f.calls, f.receipts)).toContain('["output-check"]');
    expect(commandCompletionChecks(f.calls, f.receipts).recoveredCalls.size).toBe(0);
    const recovered = observe([failed, other, check("recheck")]);
    expect(commandCompletionFeedback(recovered.calls, recovered.receipts)).toBeUndefined();
    expect(commandCompletionChecks(recovered.calls, recovered.receipts).recoveredCalls.has("failed")).toBe(true);
  });
});


describe("Python and terminal evidence interoperability", () => {
  it("recovers a settled Python exploration failure after verified output", async () => {
    const f = await fixture(undefined, "mutation", true);
    try {
      expect(await f.run("execute_code", { code: "raise ValueError('unavailable approach')" })).toMatchObject({ ok: false, metadata: { exitCode: 1, timedOut: false, cancelled: false } });
      expect(f.calls[0]?.settlement?.sideEffectState).toBe("confirmed");
      await f.output();
      expect(f.outcome().status).toBe("completed_with_recovered_errors");
    } finally { await f.close(); }
  });
  it("lets Python prove the same failed terminal requirement, but not an unrelated one", async () => {
    const f = await fixture();
    try {
      await f.run("terminal.run", { command: "exit 1", verification: "output-check", timeoutMs: 100 });
      await f.output();
      await f.run("execute_code", { code: "assert True", verification: "other-check" });
      expect(f.outcome().status).toBe("partially_completed");
      await f.run("execute_code", { code: "from pathlib import Path\nassert Path('report.txt').read_text() == 'ready'", verification: "output-check" });
      expect(f.outcome().status).toBe("completed_with_recovered_errors");
      await f.output("changed");
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });
  it("preserves a timed-out Python attempt after producing an output", async () => {
    const f = await fixture(undefined, "mutation", true);
    try {
      expect(await f.run("execute_code", { code: "import time; time.sleep(30)", timeoutMs: 50 })).toMatchObject({ ok: false, metadata: { timedOut: true } });
      await f.output();
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });
  it("does not settle nested tool effects from a Python exit", async () => {
    const f = await fixture(undefined, "mutation", true);
    try {
      expect(await f.run("execute_code", { code: "tool('file.read', {'path': 'missing.txt'})\nraise ValueError('after nested call')" })).toMatchObject({ ok: false, metadata: { exitCode: 1, toolCalls: 1 } });
      expect(f.calls[0]?.settlement?.sideEffectState).toBe("possible");
      await f.output();
      expect(f.outcome().status).toBe("partially_completed");
    } finally { await f.close(); }
  });
  it("rejects invalid Python verification labels before dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.run("execute_code", { code: "raise RuntimeError('must not run')", verification: true })).toMatchObject({ ok: false, content: expect.stringContaining("verification must") });
    } finally { await f.close(); }
  });
});


it.each(["terminal.run", "execute_code"])("credits full readback of %s output once", async tool => {
  const f = await fixture("Write report.txt");
  try {
    const checkpoint = new ExecutionCheckpointController({ sessionId: "test", profileId: "test" });
    await checkpoint.ensure({ originTurnId: "turn-1", originalObjective: "Write report.txt",
      requestRequirements: deriveRequestRequirements("Write report.txt", "turn-1"),
      qualificationReasons: ["verified_mutation"], intentLabels: [], requiredOperations: ["mutation", "verification"], connectorIds: [], completionFloor: "mutation_with_verification" });
    const guard = new ToolLoopProgressGuard({ checkpointReader: checkpoint, noProgressNudgeIteration: 2, maxNoProgressIterations: 3 });
    await f.run(tool, tool === "terminal.run" ? { command: "printf ready > report.txt", timeoutMs: 100 } : { code: "from pathlib import Path\nPath('report.txt').write_text('ready')" });
    const write = f.calls.at(-1)!;
    expect(guard.observe([write]).materialProgress).toBe(true);
    await f.run("file.read", { path: "report.txt" });
    const read = f.calls.at(-1)!;
    expect(guard.observe([read]).progressKinds).toContain("verification");
    expect(guard.observe([write]).materialProgress).toBe(false);
    expect(guard.observe([read]).materialProgress).toBe(false);
  } finally { await f.close(); }
});


it("finishes nine outputs only after a current check covers the full request", async () => {
  const paths = Array.from({ length: 9 }, (_, i) => `output${i}.txt`);
  const f = await fixture(`Write ${paths.join(", ")}`);
  try {
    for (const path of paths.slice(0, 8)) await f.run("file.write", { path, content: "ready" });
    await f.run("terminal.run", { command: "true", verification: "unrelated-check", timeoutMs: 100 });
    expect(f.outcome().status).toBe("partially_completed");
    const input = { code: `from pathlib import Path\nassert all(Path(p).read_text() == 'ready' for p in ${JSON.stringify(paths)})`, verification: "file-output-coverage" };
    await f.run("execute_code", input);
    expect(f.outcome().status).toBe("partially_completed");
    await f.run("file.write", { path: paths[8], content: "ready" });
    await f.run("terminal.run", { command: "true", verification: "unrelated-check", timeoutMs: 100 });
    await f.run("execute_code", input, "other-turn");
    expect(f.outcome().status).toBe("partially_completed");
    await f.run("execute_code", input);
    expect(f.outcome().status).toBe("completed_with_recovered_errors");
    await f.run("file.write", { path: paths[8], content: "broken", overwrite: true });
    expect(f.outcome().status).toBe("partially_completed");
  } finally { await f.close(); }
});


it("retains an observed file predicate across unrelated writes without narrowing generic checks", async () => {
  const f = await fixture();
  try {
    await f.output();
    await f.run("terminal.run", { command: "test -s report.txt", verification: "output-check", timeoutMs: 100 });
    await f.run("file.write", { path: "notes.txt", content: "notes" });
    expect(f.outcome().status).toBe("completed");
    await f.run("terminal.run", { command: "test -s report.txt && test -s notes.txt", verification: "both-files", timeoutMs: 100 });
    await f.run("file.write", { path: "other.txt", content: "unknown dependency" });
    expect(f.outcome().status).toBe("partially_completed");
    await f.output("updated");
    expect(commandCompletionChecks(f.calls, f.calls.map(c => ({ toolCallId: c.toolCallId!, tool: c.tool.name, visibleTurnId: "turn-1", status: "success" } as never))).unresolvedRequirements).toContain("output-check");
  } finally { await f.close(); }
});
