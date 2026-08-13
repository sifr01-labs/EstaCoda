import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ExecutionEvidenceIndex, executionEvidenceStatus } from "./execution-evidence-index.js";
import type { SessionEvent } from "../contracts/session.js";

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "postman.update",
      description: "Update Postman",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating",
      maxResultSizeChars: 1000
    },
    input: { apiKey: "raw-secret" },
    decision: "allow",
    riskClass: "external-side-effect",
    targetSummary: "collection token=raw-secret",
    toolCallId: "call-ok",
    result: { ok: true, content: "raw collection body" },
    ...overrides
  };
}

describe("ExecutionEvidenceIndex", () => {
  it("shares one deterministic evidence disposition with Mission progress", () => {
    expect(executionEvidenceStatus(execution())).toBe("success");
    expect(executionEvidenceStatus(execution({ result: { ok: false, content: "failed" } }))).toBe("failed");
    expect(executionEvidenceStatus(execution({ decision: "ask", result: undefined }))).toBe("blocked");
    expect(executionEvidenceStatus(execution({ tool: { ...execution().tool, name: "plan" } }))).toBe("ineligible");
  });

  it("derives a bounded redacted receipt from a successful execution record", () => {
    const index = new ExecutionEvidenceIndex();
    index.record(execution());

    const evidence = index.resolve(["call-ok"]);

    expect(evidence).toEqual([expect.objectContaining({
      toolCallId: "call-ok",
      tool: "postman.update",
      outcome: "success",
      riskClass: "external-side-effect"
    })]);
    expect(JSON.stringify(evidence)).not.toContain("raw-secret");
    expect(JSON.stringify(evidence)).not.toContain("raw collection body");
  });

  it("rejects failed, blocked, unknown, plan, and delegation calls", () => {
    const index = new ExecutionEvidenceIndex();
    index.record(execution({ toolCallId: "failed", result: { ok: false, content: "failed" } }));
    index.record(execution({ toolCallId: "blocked", decision: "ask", result: undefined }));
    index.record(execution({ toolCallId: "plan", tool: { ...execution().tool, name: "plan" } }));
    index.record(execution({ toolCallId: "delegate", tool: { ...execution().tool, name: "delegate_task" } }));

    expect(() => index.resolve(["failed"])).toThrow("failed");
    expect(() => index.resolve(["blocked"])).toThrow("blocked");
    expect(() => index.resolve(["missing"])).toThrow("Unknown evidence call id");
    expect(() => index.resolve(["plan"])).toThrow("ineligible");
    expect(() => index.resolve(["delegate"])).toThrow("ineligible");
  });

  it("hydrates only from persisted harness receipt fields", () => {
    const index = new ExecutionEvidenceIndex();
    index.hydrate([{
      kind: "execution-evidence-recorded",
      tool: "postman.update",
      toolCallId: "persisted-call",
      status: "success",
      riskClass: "external-side-effect",
      targetSummary: "safe target"
    } satisfies SessionEvent]);

    expect(index.resolve(["persisted-call"])).toEqual([expect.objectContaining({
      toolCallId: "persisted-call",
      tool: "postman.update",
      riskClass: "external-side-effect",
      targetSummary: "safe target"
    })]);
  });

  it("ignores malformed persisted success receipts", () => {
    const index = new ExecutionEvidenceIndex();
    index.hydrate([{
      kind: "execution-evidence-recorded",
      tool: "postman.update",
      toolCallId: "malformed-call",
      status: "success",
      riskClass: "not-a-risk-class"
    } as unknown as SessionEvent]);

    expect(() => index.resolve(["malformed-call"])).toThrow("Unknown evidence call id");
  });
});
