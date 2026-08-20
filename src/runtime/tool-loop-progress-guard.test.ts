import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ToolLoopProgressGuard } from "./tool-loop-progress-guard.js";

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "mcp.postman.getCollection",
      description: "Read collection",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      progressLabel: "reading",
      maxResultSizeChars: 1_000
    },
    input: { collectionId: "collection-1" },
    decision: "allow",
    riskClass: "read-only-network",
    toolCallId: "call-1",
    executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } },
    result: { ok: true, content: "collection state" },
    ...overrides
  };
}

describe("ToolLoopProgressGuard", () => {
  it("is inactive before substantive tool activity and does not depend on a plan", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4
    });

    expect(guard.observe([])).toEqual({
      active: false,
      materialProgress: false,
      progressKinds: [],
      noProgressIterations: 0,
      shouldNudge: false,
      shouldStop: false
    });
  });

  it("counts new call/result pairs as progress and repeated calls as no progress", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3
    });

    expect(guard.observe([execution()])).toMatchObject({
      active: true,
      materialProgress: true,
      progressKinds: ["new-tool-result"],
      noProgressIterations: 0
    });
    expect(guard.observe([execution({
      toolCallId: "call-2",
      result: { ok: true, content: "changing representation" }
    })])).toMatchObject({
      materialProgress: false,
      progressKinds: ["repeated-tool-call"],
      noProgressIterations: 1
    });
    expect(guard.observe([execution({ toolCallId: "call-3" })])).toMatchObject({
      noProgressIterations: 2,
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([execution({ toolCallId: "call-4" })])).toMatchObject({
      noProgressIterations: 3,
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("recognizes runtime mutation and verification effects without plan semantics", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4
    });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.updateCollection", riskClass: "external-side-effect" },
      input: { collectionId: "collection-1", name: "Updated" },
      riskClass: "external-side-effect",
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
      result: { ok: true, content: "updated" }
    })])).toMatchObject({ materialProgress: true, progressKinds: ["target-mutation"] });

    expect(guard.observe([execution({
      tool: { ...execution().tool, name: "mcp.postman.verifyCollection" },
      input: { collectionId: "collection-1", expectedName: "Updated" },
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.updateCollection"],
        connector: { kind: "mcp", id: "postman" }
      },
      result: { ok: true, content: "verified" }
    })])).toMatchObject({ materialProgress: true, progressKinds: ["verification"] });
  });

  it("seeds prior foreground-turn executions to reject rediscovery", () => {
    const prior = execution();
    const guard = new ToolLoopProgressGuard({
      existingExecutions: [prior],
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });

    expect(guard.observe([execution({ toolCallId: "call-repeated" })])).toMatchObject({
      active: true,
      materialProgress: false,
      progressKinds: ["repeated-tool-call"],
      shouldNudge: true
    });
  });

  it("ignores plan and delegation housekeeping calls", () => {
    const guard = new ToolLoopProgressGuard({
      noProgressNudgeIteration: 1,
      maxNoProgressIterations: 2
    });
    const planCall = execution({ tool: { ...execution().tool, name: "plan" } });

    expect(guard.observe([planCall])).toMatchObject({ active: false, noProgressIterations: 0 });
  });
});
