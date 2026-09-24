import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { fileOutputEvidence } from "./file-output-evidence.js";
import { deriveRequestRequirements } from "./request-requirements.js";
import { deriveExecutionFinalOutcome } from "./execution-outcome.js";

const digest = createHash("sha256").update("report").digest("hex");
function call(name: string, path = "report.md", metadata: Record<string, unknown> = {}): ToolExecutionRecord {
  const read = name === "file.read";
  const riskClass = read ? "read-only-local" : "workspace-write";
  return {
    tool: { name, riskClass, description: name, inputSchema: {}, toolsets: ["files"], progressLabel: name, maxResultSizeChars: 1000 },
    riskClass, decision: "allow", executionEffect: { kind: read ? "read" : "mutation" },
    result: { ok: true, content: "report", metadata: { path, contentSha256: digest, bytes: 6, materialized: true, truncated: false, ...metadata } }
  };
}
function observe(executions: ToolExecutionRecord[], prompt = "Save report.md", turn = "turn-1") {
  const index = new ExecutionEvidenceIndex();
  const toolExecutions = executions.map((execution, i) => ({ ...execution, toolCallId: `call-${i}` }));
  for (const execution of toolExecutions) index.record(execution, turn);
  const requirements = deriveRequestRequirements(prompt, "turn-1");
  return { requirements, toolExecutions, executionReceipts: index.recordsForTurn(turn) };
}

describe("file output evidence", () => {
  it.each(["file.write", "file.patch"])("accepts %s plus matching readback", (name) => {
    const input = observe([call(name), call("file.read")]);
    expect(fileOutputEvidence(input)).toEqual({ satisfied: true, writeCallId: "call-0", path: "report.md" });
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" })).toMatchObject({ status: "completed", confirmedActions: [{ verification: "verified" }] });
  });
  it("accepts an unchanged matching write and a chosen Markdown filename", () => {
    expect(fileOutputEvidence(observe([call("file.write", "chosen.md", { changed: false }), call("file.read", "chosen.md")], "Prepare a markdown file")).satisfied).toBe(true);
  });
  it("accepts the intended target in a multifile patch result", () => {
    const patch = call("file.patch", "unused", { paths: ["report.md", "other.txt"], fileOutputs: [{ path: "report.md", contentSha256: digest }] });
    expect(fileOutputEvidence(observe([patch, call("file.read")])).satisfied).toBe(true);
  });
  it.each([
    [], [call("file.read")], [call("file.write")], [call("file.read"), call("file.write")],
    [call("file.write", "other.md"), call("file.read", "other.md")],
    [call("file.write"), call("file.read", "other.md")],
    [call("file.write"), call("file.read", "report.md", { contentSha256: "a".repeat(64) })],
    [call("file.write"), call("file.read", "report.md", { contentSha256: undefined })],
    [call("file.write"), call("file.read", "report.md", { materialized: false })],
    [call("file.write"), call("file.read", "report.md", { truncated: true })],
    [call("file.write"), call("file.read", "report.md", { bytes: 0 })],
    [{ ...call("file.write"), decision: "deny" as const }, call("file.read")],
    [call("other.write"), call("file.read")],
    [call("file.write"), call("file.read"), call("file.write")],
    [call("file.write"), call("file.read"), call("file.read", "report.md", { contentSha256: "a".repeat(64) })],
    [call("file.write"), call("file.read"), call("file.patch", "report.md", { operation: "delete", contentSha256: undefined })]
  ])("rejects missing, unrelated, stale, denied or incomplete evidence %#", (...executions) => {
    const input = observe(executions as ToolExecutionRecord[]);
    expect(fileOutputEvidence(input).satisfied).toBe(false);
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements }).status).not.toMatch(/^completed/u);
  });
  it("rejects previous-turn receipts and unowned success metadata", () => {
    expect(fileOutputEvidence(observe([call("file.write"), call("file.read")], "Save report.md", "old-turn")).satisfied).toBe(false);
    expect(fileOutputEvidence({ ...observe([call("file.write"), call("file.read")]), executionReceipts: [] }).satisfied).toBe(false);
  });
  it.each(["Save a.md and b.md", "Save ../report.md"])("does not silently substitute an unresolved target: %s", (prompt) => {
    expect(fileOutputEvidence(observe([call("file.write"), call("file.read")], prompt))).toEqual({ satisfied: false, reason: "unresolved-target" });
  });
  it("preserves foreground completion when a durable Task owns the file objective", () => {
    const input = observe([]);
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification", delegatedAnswerOwned: true }).status).toBe("completed");
  });
  it.each(["primary", "worker", "partial-page", "foreign", "different-report", "unowned"])("binds a save-only request to the exact accepted report: %s", (kind) => {
    const resultRead = { ...call("file.read"), tool: { ...call("file.read").tool, name: "task.result.read" },
      result: { ok: true, content: kind === "partial-page" ? "rep" : "report", metadata: { taskId: kind === "foreign" ? "foreign" : "task",
        resultId: "result", disposition: "accepted", primary: kind !== "worker", totalChars: 6, offset: 0,
        contentHash: `sha256:${digest}`, hasMore: kind === "partial-page" } } };
    const fileDigest = kind === "different-report" ? "b".repeat(64) : digest;
    const input = observe([resultRead, call("file.write", "report.md", { contentSha256: fileDigest }), call("file.read", "report.md", { contentSha256: fileDigest })]);
    input.requirements.sourceTaskId = "task";
    if (kind === "unowned") input.executionReceipts = input.executionReceipts.filter((receipt) => receipt.tool !== "task.result.read");
    expect(fileOutputEvidence(input).satisfied).toBe(kind === "primary");
  });

});
