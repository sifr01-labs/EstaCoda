import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { fileOutputEvidence, pendingFileReadbackPaths, verifiedFileOutputContent, verifiedFileMutationCallIds } from "./file-output-evidence.js";
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


describe("readback-only completion repair", () => {
  it("allows verification of successful writes after an unrelated terminal denial", () => {
    const denied = { ...call("terminal.run"), decision: "deny" as const, result: { ok: false, content: "Denied" } };
    const input = observe([denied, call("file.write", "a.md"), call("file.write", "b.md")], "Write a.md and b.md");
    expect(pendingFileReadbackPaths(input)).toEqual(["a.md", "b.md"]);
    expect(pendingFileReadbackPaths({ ...input, executionReceipts: [] })).toBeUndefined();
  });
  it.each(["file.read", "file.write", "file.patch"])("does not retry a denied %s boundary", name => {
    expect(pendingFileReadbackPaths(observe([{ ...call(name), decision: "deny" }, call("file.write")]))).toBeUndefined();
  });
  it("does not repair a missing write, unresolved output or changed copy source by reading", () => {
    expect(pendingFileReadbackPaths(observe([]))).toBeUndefined();
    expect(pendingFileReadbackPaths(observe([call("file.write")], "Save a.md or b.md"))).toBeUndefined();
    expect(pendingFileReadbackPaths(observe([call("file.write")], "Copy source.md to report.md"))).toBeUndefined();
  });
});

describe("file output evidence", () => {
  it("verifies an intentional empty file only with matching same-turn readback", () => {
    const metadata = { bytes: 0, contentSha256: createHash("sha256").update("").digest("hex") };
    const input = observe([call("file.write", "scratch.txt", metadata), call("file.read", "scratch.txt", metadata)], "Clear scratch.txt and verify it is empty.");
    expect(input.requirements.fileOutput?.path).toBe("scratch.txt");
    expect(fileOutputEvidence(input).satisfied).toBe(true);
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }))
      .toMatchObject({ status: "completed", confirmedActions: [{ verification: "verified" }] });
    expect(fileOutputEvidence(observe([call("file.read", "scratch.txt", metadata)], "Clear scratch.txt")).satisfied).toBe(false);
  });
  it("verifies a real replacement patch through materialized readback", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-patch-evidence-"));
    try {
      await writeFile(join(root, "settings.json"), '{"retry":{"count":2},"enabled":true}');
      const tools = createWorkspaceTools({ workspaceRoot: root });
      const patch = tools.find(tool => tool.name === "file.patch")!;
      const read = tools.find(tool => tool.name === "file.read")!;
      const patchInput = { path: "settings.json", mode: "replace", old_string: '"count":2', new_string: '"count":4' };
      const executions: ToolExecutionRecord[] = [
        { tool: patch, input: patchInput, decision: "allow", riskClass: "workspace-write", executionEffect: { kind: "mutation" }, result: await patch.run(patchInput) },
        { tool: read, input: { path: "settings.json" }, decision: "allow", riskClass: "read-only-local", executionEffect: { kind: "read" }, result: await read.run({ path: "settings.json", lineStart: null, lineEnd: null }) }
      ];
      const input = observe(executions, "Update the setting and verify it.");
      expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }))
        .toMatchObject({ status: "completed", confirmedActions: [{ verification: "verified" }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["file.write", "file.patch"])("verifies generic JSON edits without a report requirement: %s", name => {
    const input = observe([call(name, "settings.json"), call("file.read", "settings.json")], "Update the setting and verify it.");
    expect(input.requirements.fileOutput).toBeUndefined();
    expect(verifiedFileMutationCallIds({ ...input, executionReceipts: input.executionReceipts.map(r => ({ ...r, visibleTurnId: undefined })) }).size).toBe(0);
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }))
      .toMatchObject({ status: "completed", confirmedActions: [{ verification: "verified" }] });
    expect(verifiedFileMutationCallIds({ ...input, executionReceipts: input.executionReceipts.map((r, i) => ({ ...r, visibleTurnId: `turn-${i}` })) }).size).toBe(0);
    expect(verifiedFileMutationCallIds(observe([call(name, "settings.json"), call("file.read", "settings.json", { truncated: true })])).size).toBe(0);
    expect(verifiedFileMutationCallIds(observe([call(name, "settings.json"), call("file.read", "settings.json"), call("file.patch", "settings.json")])).size).toBe(0);
  });
  it("requires every output of a generic multi-file patch to be read back", () => {
    const patch = call("file.patch", "a.json", { paths: ["a.json", "b.json"], fileOutputs: [{ path: "a.json", contentSha256: digest }, { path: "b.json", contentSha256: digest }] });
    expect(verifiedFileMutationCallIds(observe([patch, call("file.read", "a.json")])).size).toBe(0);
    expect([...verifiedFileMutationCallIds(observe([patch, call("file.read", "a.json"), call("file.read", "b.json")]))]).toEqual(["call-0"]);
  });
  it.each(["file.write", "file.patch"])("accepts %s plus matching readback", (name) => {
    const input = observe([call(name), call("file.read")]);
    expect(fileOutputEvidence(input)).toEqual({ satisfied: true, writeCallId: "call-0", path: "report.md" });
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" })).toMatchObject({ status: "completed", confirmedActions: [{ verification: "verified" }] });
  });
  it("accepts a bounded preview only when a complete materialized file read verifies the digest", () => {
    expect(fileOutputEvidence(observe([call("file.write"), call("file.read", "report.md", { truncated: true, completeFileRead: true })])).satisfied).toBe(true);
    expect(fileOutputEvidence(observe([call("file.write"), call("file.read", "report.md", { truncated: true, completeFileRead: true, contentSha256: "a".repeat(64) })])).satisfied).toBe(false);
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
  it.each(["Save a.md or b.md", "Save ../report.md"])("does not silently substitute an unresolved target: %s", (prompt) => {
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


describe("verified report content", () => {
  it("uses the exact written bytes only after complete matching readback", () => {
    const write = { ...call("file.write"), input: { path: "report.md", content: "report" } };
    expect(verifiedFileOutputContent(observe([write, call("file.read")]))).toBe("report");
    expect(verifiedFileOutputContent(observe([write]))).toBeUndefined();
    expect(verifiedFileOutputContent(observe([write, call("file.read", "report.md", { contentSha256: undefined })]))).toBeUndefined();
    expect(verifiedFileOutputContent(observe([write, call("file.read"), call("file.write")]))).toBeUndefined();
    expect(verifiedFileOutputContent({ ...observe([write, call("file.read")]), executionReceipts: [] })).toBeUndefined();
  });
  it("recovers patched content from a matching complete body, never an arbitrary tool summary", () => {
    const read = { ...call("file.read"), result: { ...call("file.read").result!, content: "# report.md\nreport" } };
    expect(verifiedFileOutputContent(observe([call("file.patch"), read]))).toBe("report");
    expect(verifiedFileOutputContent(observe([call("file.patch"), { ...read, result: { ...read.result, content: "# report.md\nfake report" } }]))).toBeUndefined();
    const write = { ...call("file.write"), input: { path: "report.md", content: "wrong content" } };
    expect(verifiedFileOutputContent(observe([write, call("file.read")]))).toBeUndefined();
  });
});

describe("exact-copy source equality", () => {
  const prompt = "Copy source.md to report.md";
  it("requires source equality, not just a consistent destination write/readback", () => {
    const bad = { contentSha256: "a".repeat(64) };
    const input = observe([call("file.read", "source.md"), call("file.write", "report.md", bad), call("file.read", "report.md", bad)], prompt);
    expect(fileOutputEvidence(input)).toEqual({ satisfied: false, reason: "copy-source-mismatch" });
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }).status).not.toMatch(/^completed/u);
    expect(fileOutputEvidence(observe([call("file.read", "source.md"), call("file.write"), call("file.read")], prompt)).satisfied).toBe(true);
  });
  it.each(["missing", "denied", "partial", "stale-turn", "changed-after-copy", "wrong-source"])("rejects %s source evidence", kind => {
    const read = call("file.read", "source.md", kind === "partial" ? { truncated: true } : {});
    if (kind === "denied") read.decision = "deny";
    const input = observe([...(kind === "missing" ? [] : [read]), call("file.write", "report.md", kind === "wrong-source" ? { copiedSource: { path: "other.md", contentSha256: digest } } : {}), call("file.read"), ...(kind === "changed-after-copy" ? [call("file.patch", "source.md")] : [])], prompt);
    if (kind === "stale-turn") input.executionReceipts[0]!.visibleTurnId = "earlier";
    expect(fileOutputEvidence(input).satisfied).toBe(false);
  });
  it("requires an observed source even for sourceFile metadata on an unnamed follow-up", () => {
    const write = call("file.write", "report.md", { copiedSource: { path: "source.md", contentSha256: digest } });
    const followup = "Make an identical copy of the report you just saved as report.md.";
    expect(fileOutputEvidence(observe([write, call("file.read")], followup)).satisfied).toBe(false);
    expect(fileOutputEvidence(observe([call("file.read", "source.md"), write, call("file.read")], followup)).satisfied).toBe(true);
  });
});

it.each(["preview-heading", "trailing-newline"])("rejects and repairs the live %s copy failure with real file tools", async kind => {
  const root = await mkdtemp(join(tmpdir(), "estacoda-copy-evidence-"));
  try {
    const source = "# قرار — Décision\n\nKeep café and العربية unchanged.\n\n";
    await writeFile(join(root, "source.md"), source);
    const tools = createWorkspaceTools({ workspaceRoot: root });
    const executions: ToolExecutionRecord[] = [];
    async function execute(name: string, input: Record<string, unknown>) {
      const tool = tools.find(t => t.name === name)!;
      const result = await tool.run(input);
      executions.push({ tool, input, decision: "allow", riskClass: tool.riskClass, executionEffect: { kind: name === "file.read" ? "read" : "mutation" }, result });
      return result;
    }
    await execute("file.read", { path: "source.md" });
    await execute("file.write", { path: "report.md", content: kind === "preview-heading" ? `# source.md\n${source}` : source.slice(0, -1) });
    await execute("file.read", { path: "report.md" });
    expect(fileOutputEvidence(observe(executions, "Copy source.md to report.md"))).toMatchObject({ satisfied: false, reason: "copy-source-mismatch" });
    await execute("file.write", { path: "report.md", sourceFile: { path: "source.md" }, overwrite: true });
    await execute("file.read", { path: "report.md" });
    const input = observe(executions, "Copy source.md to report.md");
    expect(fileOutputEvidence(input).satisfied).toBe(true);
    expect(verifiedFileOutputContent(input)).toBe(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves exact-copy delivery from an authorized accepted Task result", () => {
  const taskRead = { ...call("file.read"), tool: { ...call("file.read").tool, name: "task.result.read" },
    result: { ok: true, content: "report", metadata: { taskId: "task", resultId: "result", disposition: "accepted", primary: true,
      totalChars: 6, offset: 0, contentHash: `sha256:${digest}`, hasMore: false } } };
  const input = observe([taskRead, call("file.write"), call("file.read")], "Save an identical copy of the accepted report as report.md.");
  input.requirements.sourceTaskId = "task";
  expect(fileOutputEvidence(input).satisfied).toBe(true);
});

it("keeps unrelated edits verified without blessing an incorrect copy", () => {
  const bad = { contentSha256: "a".repeat(64) };
  const input = observe([call("file.read", "source.md"), call("file.write", "report.md", bad), call("file.read", "report.md", bad),
    call("file.write", "other.json"), call("file.read", "other.json")], "Copy source.md to report.md");
  expect([...verifiedFileMutationCallIds(input)]).toEqual(["call-3"]);
  expect(fileOutputEvidence(input).satisfied).toBe(false);
});

describe("multiple requested file outputs", () => {
  const prompt = "Save a.md and b.json";
  const first = () => [call("file.write", "a.md"), call("file.read", "a.md")];
  it("requires and identifies independent writes and readbacks for every target", () => {
    const input = observe([...first(), call("file.write", "b.json"), call("file.read", "b.json")], prompt);
    expect(fileOutputEvidence(input)).toEqual({ satisfied: true, path: "a.md", writeCallId: "call-0", files: [
      { path: "a.md", writeCallId: "call-0" }, { path: "b.json", writeCallId: "call-2" }
    ] });
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }).status).toBe("completed");
  });
  it.each([
    [], [call("file.read", "b.json")], [call("file.write", "b.json")],
    [call("file.write", "b.json"), call("file.read", "b.json", { truncated: true })],
    [call("file.write", "b.json"), call("file.read", "b.json", { contentSha256: "b".repeat(64) })],
    [{ ...call("file.write", "b.json"), decision: "deny" as const }, call("file.read", "b.json")],
    [call("other.write", "b.json"), call("file.read", "b.json")],
    [call("file.write", "b.json"), call("file.read", "b.json"), call("file.write", "b.json")],
    [call("file.write", "b.json"), call("file.read", "b.json"), call("file.patch", "b.json", { operation: "delete", contentSha256: undefined })]
  ])("does not complete when the second file is missing, denied, stale or unverified %#", (...second) => {
    const input = observe([...first(), ...second as ToolExecutionRecord[]], prompt);
    expect(fileOutputEvidence(input)).toMatchObject({ satisfied: false, path: "b.json" });
    expect(deriveExecutionFinalOutcome({ ...input, requestRequirements: input.requirements, completionFloor: "mutation_with_verification" }).status).not.toMatch(/^completed/u);
  });
  it("does not borrow second-file evidence from a previous turn", () => {
    const input = observe([...first(), call("file.write", "b.json"), call("file.read", "b.json")], prompt);
    input.executionReceipts = input.executionReceipts.map((receipt, i) => i < 2 ? receipt : { ...receipt, visibleTurnId: "old-turn" });
    expect(fileOutputEvidence(input)).toMatchObject({ satisfied: false, path: "b.json" });
  });
  it("verifies a multi-file patch only after both targets are read back", () => {
    const patch = call("file.patch", "a.md", { paths: ["a.md", "b.json"], fileOutputs: [{ path: "a.md", contentSha256: digest }, { path: "b.json", contentSha256: digest }] });
    expect(fileOutputEvidence(observe([patch, call("file.read", "a.md")], prompt))).toMatchObject({ satisfied: false, path: "b.json" });
    expect(fileOutputEvidence(observe([patch, call("file.read", "a.md"), call("file.read", "b.json")], prompt)).satisfied).toBe(true);
  });
  it("keeps secondary exact-copy constraints when verifying mutation receipts", () => {
    const input = observe([...first(), call("file.read", "source.json", { contentSha256: "b".repeat(64) }), call("file.write", "b.json"), call("file.read", "b.json")], "Save a.md. Copy source.json to b.json.");
    expect(fileOutputEvidence(input)).toMatchObject({ satisfied: false, path: "b.json", reason: "copy-source-mismatch" });
    expect([...verifiedFileMutationCallIds(input)]).toEqual(["call-0"]);
  });
  it("cannot complete only the retained prefix of an excessive request", () => {
    const paths = Array.from({ length: 9 }, (_, i) => `file-${i}.txt`);
    const input = observe(paths.slice(0, 8).flatMap(path => [call("file.write", path), call("file.read", path)]), "Save " + paths.join(" and "));
    expect(fileOutputEvidence(input)).toEqual({ satisfied: false, reason: "unresolved-target" });
  });
});


it("includes secondary output content in research validation only after all outputs are verified", () => {
  const writes = ["a.md", "b.md"].flatMap(path => [{ ...call("file.write", path), input: { path, content: "report" } }, call("file.read", path)]);
  expect(verifiedFileOutputContent(observe(writes, "Save a.md and b.md"))).toBe("report\n\nreport");
  expect(verifiedFileOutputContent(observe(writes.slice(0, -1), "Save a.md and b.md"))).toBeUndefined();
});
