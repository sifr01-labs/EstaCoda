import { describe, expect, it } from "vitest";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  createTurnToolFeedbackLedger,
  recordTurnToolFeedbackBatch
} from "./turn-tool-feedback-ledger.js";

describe("turn tool feedback ledger", () => {
  it("keeps only the newest batch verbatim and converts prior batches to receipts", () => {
    const firstResult = "first raw result that must not be replayed";
    const firstPlan = toolPlan("call-1", firstResult);
    const secondPlan = toolPlan("call-2", "current raw result");

    const afterFirst = recordTurnToolFeedbackBatch(
      createTurnToolFeedbackLedger(),
      [firstPlan],
      [toolExecution("call-1", firstResult)]
    );
    const afterSecond = recordTurnToolFeedbackBatch(
      afterFirst,
      [secondPlan],
      [toolExecution("call-2", "current raw result")]
    );

    expect(afterSecond.latest.map((entry) => entry.plan.id)).toEqual(["call-2"]);
    expect(afterSecond.consumed).toEqual([
      expect.objectContaining({
        callId: "call-1",
        tool: "files.read",
        status: "executed",
        ok: true,
        resultChars: firstResult.length
      })
    ]);
    expect(JSON.stringify(afterSecond.consumed)).not.toContain(firstResult);
  });

  it("bounds accumulated receipts and records how many were omitted", () => {
    let ledger = createTurnToolFeedbackLedger();
    for (let index = 0; index < 100; index += 1) {
      const plan = toolPlan(`call-${index}`, `result-${index}`);
      ledger = recordTurnToolFeedbackBatch(ledger, [plan], [toolExecution(plan.id, plan.result!.content)]);
    }

    expect(ledger.omittedCount).toBeGreaterThan(0);
    expect(JSON.stringify(ledger.consumed).length).toBeLessThan(8_000);
    expect(ledger.latest).toHaveLength(1);
  });
});

function toolPlan(id: string, content: string): ToolCallPlan {
  return {
    id,
    tool: "files.read",
    input: { path: "README.md" },
    source: "provider-tool-call",
    status: "executed",
    result: { ok: true, content }
  };
}

function toolExecution(toolCallId: string, content: string): ToolExecutionRecord {
  return {
    tool: {
      name: "files.read",
      description: "Read a file",
      inputSchema: {},
      riskClass: "read-only-local",
      toolsets: ["files"],
      progressLabel: "reading",
      maxResultSizeChars: 1_800
    },
    decision: "allow",
    riskClass: "read-only-local",
    targetSummary: "README.md",
    result: { ok: true, content },
    toolCallId
  };
}
