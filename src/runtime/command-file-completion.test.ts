import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegisteredTool, ToolExecutionContext } from "../contracts/tool.js";
import type { ToolExecutionRecord, ToolExecutor } from "../tools/tool-executor.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { createProcessTools } from "../tools/process-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { deriveRequestRequirements } from "./request-requirements.js";
import { fileOutputEvidence, pendingFileReadbackPaths, verifiedFileOutputContent } from "./file-output-evidence.js";
import { ToolLoopProgressGuard } from "./tool-loop-progress-guard.js";
import { deriveExecutionFinalOutcome } from "./execution-outcome.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { resolveTestPythonBinary } from "../test/test-python.js";

async function fixture(prompt = "Write output.c") {
  const root = await mkdtemp(join(tmpdir(), "estacoda-command-completion-"));
  const manager = new ProcessManager({ workspaceRoot: root });
  const tools = [...createWorkspaceTools({ workspaceRoot: root, processManager: manager, commandTimeoutMs: 100 }), ...createProcessTools({ processManager: manager })];
  const requirements = deriveRequestRequirements(prompt, "turn", root);
  const context: ToolExecutionContext = { visibleTurnId: "turn", requestContract: { version: 1, objective: prompt, requirements } };
  const index = new ExecutionEvidenceIndex();
  const toolExecutions: ToolExecutionRecord[] = [];
  const evidence = () => ({ requirements, toolExecutions, executionReceipts: index.recordsForTurn("turn") });
  const run = async (name: string, input: Record<string, unknown>, tool?: RegisteredTool) => {
    tool ??= tools.find(tool => tool.name === name)!;
    const record: ToolExecutionRecord = { tool, riskClass: tool.riskClass, decision: "allow", input,
      toolCallId: `call-${toolExecutions.length}`, executionEffect: { kind: ["file.read", "process.logs"].includes(name) ? "read" : "mutation" }, result: await tool.run(input, context) };
    toolExecutions.push(record); index.record(record, "turn"); return record;
  };
  return { root, manager, run, context, evidence, toolExecutions, async close() { await manager.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("command-generated file completion", () => {
  it.each(["bounded", "managed", "python"])("verifies %s output only after readback", async mode => {
    const f = await fixture();
    try {
      let command: ToolExecutionRecord;
      if (mode === "python") {
        const tool = createExecuteCodeTool({ workspaceRoot: f.root, pythonBinary: await resolveTestPythonBinary(),
          toolExecutor: {} as ToolExecutor, sessionDb: {} as SessionDB, trajectoryRecorder: {} as TrajectoryRecorder, sessionId: "test", trustedWorkspace: async () => true });
        command = await f.run("execute_code", { code: 'open("output.c", "w").write("int main() {}")' }, tool);
      } else command = await f.run("terminal.run", { command: "printf 'int main() {}' > output.c", ...(mode === "bounded" ? { timeoutMs: 100 } : {}) });
      expect(command.result?.ok).toBe(true);
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
      expect(pendingFileReadbackPaths(f.evidence())).toEqual(["output.c"]);
      await f.run("file.read", { path: "output.c" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(true);
      expect(verifiedFileOutputContent(f.evidence())).toBe("int main() {}");
      expect(deriveExecutionFinalOutcome({ ...f.evidence(), requestRequirements: f.evidence().requirements, completionFloor: "mutation_with_verification" }).status).toBe("completed");
    } finally { await f.close(); }
  });

  it.each(["unchanged", "failed", "stale", "wrong-tool", "tampered", "deleted", "symlink", "secret"])("rejects %s evidence", async scenario => {
    const f = await fixture(scenario === "secret" ? "Write secrets/output.c" : "Write output.c");
    try {
      await writeFile(join(f.root, "output.c"), "old");
      if (scenario === "symlink") { await writeFile(join(f.root, "source.c"), "old"); await rm(join(f.root, "output.c")); await symlink(join(f.root, "source.c"), join(f.root, "output.c")); }
      const command = await f.run("terminal.run", { command: scenario === "unchanged" ? "true" : "printf new > output.c" + (scenario === "failed" ? "; exit 1" : ""), timeoutMs: 100 });
      if (scenario === "stale") (command.result!.metadata!.commandFileObservation as { originTurnId: string }).originTurnId = "other-turn";
      if (scenario === "wrong-tool") command.tool = { ...command.tool, name: "unrelated.write" };
      if (scenario === "tampered") await writeFile(join(f.root, "output.c"), "different");
      if (scenario === "deleted") await f.run("terminal.run", { command: "rm output.c", timeoutMs: 100 });
      await f.run("file.read", { path: "output.c" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["terminal.run", "process.start"])("requires exit and a matching read for background %s", async name => {
    const f = await fixture();
    try {
      const start = await f.run(name, { command: "sleep 0.2; printf generated > output.c" });
      const id = (start.result!.metadata!.process as { id: string }).id;
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
      await f.manager.wait(id, 3000);
      const poll = await f.run("process.logs", { id });
      await f.run("file.read", { path: "output.c" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(true);
      expect(deriveExecutionFinalOutcome({ ...f.evidence(), requestRequirements: f.evidence().requirements, completionFloor: "mutation_with_verification" }).status).toBe("completed");
      // The exit snapshot is immutable; polling cannot claim subsequent writes.
      await writeFile(join(f.root, "output.c"), "later");
      const repeated = await f.run("process.logs", { id });
      expect(repeated.result!.metadata!.commandFileObservation).toEqual(poll.result!.metadata!.commandFileObservation);
      await f.run("file.read", { path: "output.c" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
    } finally { await f.close(); }
  });

  it("requires every mandatory output but only one explicitly optional destination", async () => {
    const f = await fixture("Write main.R. Generate at least one file named a.txt or b.txt.");
    try {
      await f.run("terminal.run", { command: "printf sample > b.txt; printf code > main.R", timeoutMs: 100 });
      expect(pendingFileReadbackPaths(f.evidence())).toEqual(["main.R", "b.txt"]);
      await f.run("file.read", { path: "b.txt" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
      await f.run("file.read", { path: "main.R" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: true, files: [{ path: "main.R" }, { path: "b.txt" }] });
    } finally { await f.close(); }
  });
});


describe("managed wait and output lifecycle", () => {
  it("survives more than six bounded waits, then verifies the completed output", async () => {
    const f = await fixture();
    const guard = new ToolLoopProgressGuard({ noProgressNudgeIteration: 3, maxNoProgressIterations: 6,
      checkpointReader: { current: () => ({ status: "active", progressRevision: 0 }) } as never });
    try {
      const start = await f.run("terminal.run", { command: "sleep 12; printf completed > output.c" });
      guard.observe([start]);
      const id = (start.result!.metadata!.process as { id: string }).id;
      for (let i = 0; i < 7; i++) {
        const poll = await f.run("process.logs", { id, waitMs: 1100 });
        expect(poll.result?.metadata?.process).toMatchObject({ status: "running" });
        expect(guard.observe([poll])).toMatchObject({ materialProgress: false, noProgressIterations: 1, shouldStop: false });
        expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
      }
      const completed = await f.run("process.logs", { id });
      expect(guard.observe([completed])).toMatchObject({ materialProgress: true, noProgressIterations: 0 });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(false);
      await f.run("file.read", { path: "output.c" });
      expect(fileOutputEvidence(f.evidence()).satisfied).toBe(true);
      expect(deriveExecutionFinalOutcome({ ...f.evidence(), requestRequirements: f.evidence().requirements, completionFloor: "mutation_with_verification" }).status).toBe("completed");
    } finally { await f.close(); }
  }, 20000);

  it("binds an unspecified directory to the unique written and read-back file", async () => {
    const f = await fixture("Write a program extract.js");
    try {
      await f.run("file.write", { path: "app/extract.js", content: "console.log('{}')" });
      expect(pendingFileReadbackPaths(f.evidence())).toEqual(["app/extract.js"]);
      await f.run("file.read", { path: "app/extract.js" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: true, path: "app/extract.js" });
      expect(deriveExecutionFinalOutcome({ ...f.evidence(), requestRequirements: f.evidence().requirements, completionFloor: "mutation_with_verification" }).status).toBe("completed");
      await f.run("file.write", { path: "other/extract.js", content: "console.log('{}')" });
      await f.run("file.read", { path: "other/extract.js" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: false, reason: "unresolved-target" });
    } finally { await f.close(); }
  });

  it.each(["Write ./extract.js", "Write specified/extract.js"])("does not relax an explicit directory: %s", async prompt => {
    const f = await fixture(prompt);
    try {
      await f.run("file.write", { path: "app/extract.js", content: "console.log('{}')" });
      await f.run("file.read", { path: "app/extract.js" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: false, reason: "missing-write" });
    } finally { await f.close(); }
  });
});


describe("output directory ambiguity", () => {
  it("repairs the observed path for an alternative bare filename", async () => {
    const f = await fixture("Generate at least one file named a.txt or b.txt.");
    try {
      await f.run("file.write", { path: "app/b.txt", content: "sample" });
      expect(pendingFileReadbackPaths(f.evidence())).toEqual(["app/b.txt"]);
      await f.run("file.read", { path: "app/b.txt" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: true, path: "app/b.txt" });
    } finally { await f.close(); }
  });
  it("cannot count one file as two requested deliverables", async () => {
    const f = await fixture("Write output.c and app/output.c.");
    try {
      await f.run("file.write", { path: "app/output.c", content: "code" });
      await f.run("file.read", { path: "app/output.c" });
      expect(fileOutputEvidence(f.evidence())).toMatchObject({ satisfied: false, reason: "unresolved-target" });
    } finally { await f.close(); }
  });
});
