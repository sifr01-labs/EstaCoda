import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createProcessTools } from "../tools/process-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { deriveRequestRequirements } from "./request-requirements.js";
import { deriveExecutionFinalOutcome } from "./execution-outcome.js";

async function fixture(request = "Write report.txt and read it back", floor: "mutation" | "mutation_with_verification" = "mutation") {
  const root = await mkdtemp(join(tmpdir(), "completion-checks-"));
  const manager = new ProcessManager({ workspaceRoot: root });
  const tools = [...createWorkspaceTools({ workspaceRoot: root, processManager: manager, commandTimeoutMs: 100 }), ...createProcessTools({ processManager: manager })];
  const requirements = deriveRequestRequirements(request, "turn-1");
  const calls: ToolExecutionRecord[] = [];
  const index = new ExecutionEvidenceIndex();
  const run = async (name: string, input: Record<string, unknown>, turn = "turn-1") => {
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
