import { describe, expect, it } from "vitest";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  createTurnToolFeedbackLedger,
  recordTurnToolFeedbackBatch,
  TurnMcpReadLedger
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

describe("turn MCP read ledger", () => {
  const scope = { profileId: "default", sessionId: "session-1" };
  const readTool = {
    name: "mcp.postman.getCollection",
    description: "Read a collection",
    inputSchema: {},
    riskClass: "read-only-network" as const,
    toolsets: ["mcp"],
    progressLabel: "reading",
    maxResultSizeChars: 12_000
  };
  const mutationTool = {
    ...readTool,
    name: "mcp.postman.updateCollection",
    riskClass: "external-side-effect" as const
  };

  it("deduplicates normalized identical reads and invalidates them after mutation", () => {
    const ledger = new TurnMcpReadLedger(scope);
    ledger.observe({
      scope,
      execution: mcpExecution(readTool, { collectionId: "mtn", page: 1 }, { ok: true, content: "collection outline" }, "read-1")
    });

    expect(ledger.reuse({
      scope,
      tool: readTool,
      input: { page: 1, collectionId: "mtn" },
      toolCallId: "read-2"
    })).toMatchObject({
      ok: true,
      metadata: { mcpReadReuse: true, sourceToolCallId: "read-1", targetRevision: 0 }
    });

    ledger.observe({
      scope,
      execution: mcpExecution(mutationTool, { collectionId: "mtn" }, { ok: true, content: "updated" }, "write-1")
    });
    expect(ledger.reuse({ scope, tool: readTool, input: { collectionId: "mtn", page: 1 } })).toBeUndefined();
  });

  it("does not cache failed or partial reads", () => {
    const ledger = new TurnMcpReadLedger(scope);
    ledger.observe({
      scope,
      execution: mcpExecution(readTool, { collectionId: "failed" }, { ok: false, content: "failed" }, "failed")
    });
    ledger.observe({
      scope,
      execution: mcpExecution(readTool, { collectionId: "partial" }, {
        ok: true,
        content: "partial",
        metadata: { structuredContent: { pagination: { next_cursor: "page-2" } } }
      }, "partial")
    });
    expect(ledger.reuse({ scope, tool: readTool, input: { collectionId: "failed" } })).toBeUndefined();
    expect(ledger.reuse({ scope, tool: readTool, input: { collectionId: "partial" } })).toBeUndefined();
  });

  it("cannot reuse across profiles or sessions", () => {
    const ledger = new TurnMcpReadLedger(scope);
    ledger.observe({
      scope,
      execution: mcpExecution(readTool, { collectionId: "mtn" }, { ok: true, content: "outline" }, "read-1")
    });
    expect(ledger.reuse({
      scope: { profileId: "other", sessionId: "session-1" },
      tool: readTool,
      input: { collectionId: "mtn" }
    })).toBeUndefined();
    expect(ledger.reuse({ scope, tool: readTool, input: { collectionId: "mtn" } })).toBeUndefined();
  });

  it("redacts secrets from cached receipts", () => {
    const ledger = new TurnMcpReadLedger(scope);
    ledger.observe({
      scope,
      execution: mcpExecution(readTool, { collectionId: "mtn" }, {
        ok: true,
        content: JSON.stringify({ name: "MTN", apiKey: "postman-secret-value" })
      }, "read-1")
    });
    const reused = ledger.reuse({ scope, tool: readTool, input: { collectionId: "mtn" } });
    expect(reused?.content).toContain("[REDACTED]");
    expect(JSON.stringify(reused)).not.toContain("postman-secret-value");
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

function mcpExecution(
  tool: ToolExecutionRecord["tool"],
  input: Record<string, unknown>,
  result: NonNullable<ToolExecutionRecord["result"]>,
  toolCallId: string
): ToolExecutionRecord {
  return {
    tool,
    input,
    decision: "allow",
    riskClass: tool.riskClass,
    result,
    toolCallId
  };
}
