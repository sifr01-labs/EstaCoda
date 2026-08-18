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

  it("records trusted read, mutation, and verification effects and links the latest compatible target", () => {
    const index = new ExecutionEvidenceIndex();
    const mutation = (toolCallId: string, targetKey: string, connectorId = "postman") => execution({
      toolCallId,
      tool: {
        ...execution().tool,
        name: "mcp.postman.updateCollection",
        connector: { kind: "mcp", id: connectorId }
      },
      targetKey,
      targetSummary: `collection ${targetKey}`,
      executionEffect: {
        kind: "mutation",
        connector: { kind: "mcp", id: connectorId }
      }
    });
    const firstMutation = index.record(mutation("call-update-a", "collection:a"), "turn-current");
    index.record(mutation("call-update-b", "collection:b"), "turn-current");
    index.record(mutation("call-other-connector", "collection:a", "other"), "turn-current");
    index.record(mutation("call-earlier-turn", "collection:a"), "turn-earlier");

    const verification = index.record(execution({
      toolCallId: "call-verify-a",
      tool: {
        ...execution().tool,
        name: "mcp.postman.getCollection",
        riskClass: "read-only-network",
        connector: { kind: "mcp", id: "postman" }
      },
      riskClass: "read-only-network",
      targetKey: "collection:a",
      targetSummary: "collection a",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.updateCollection"],
        connector: { kind: "mcp", id: "postman" }
      }
    }), "turn-current");

    expect(firstMutation).toMatchObject({
      status: "success",
      visibleTurnId: "turn-current",
      executionEffect: {
        kind: "mutation",
        connector: { kind: "mcp", id: "postman" }
      }
    });
    expect(verification).toMatchObject({
      status: "success",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.updateCollection"]
      },
      verifiedMutation: {
        toolCallId: "call-update-a",
        tool: "mcp.postman.updateCollection"
      }
    });
    expect(verification).not.toHaveProperty("targetKey");
    expect(index.recordsForTurn("turn-current")).toHaveLength(4);
    expect(index.recordsForTurn("turn-earlier")).toEqual([
      expect.objectContaining({ toolCallId: "call-earlier-turn" })
    ]);
  });

  it("does not fabricate verification links across turns, targets, failures, or undeclared relationships", () => {
    const index = new ExecutionEvidenceIndex();
    index.record(execution({
      toolCallId: "call-update",
      tool: { ...execution().tool, name: "mcp.postman.updateCollection" },
      targetKey: "collection:a",
      executionEffect: { kind: "mutation" }
    }), "turn-one");

    const verifier = (overrides: Partial<ToolExecutionRecord> = {}) => execution({
      toolCallId: "call-verify",
      tool: {
        ...execution().tool,
        name: "mcp.postman.getCollection",
        riskClass: "read-only-network"
      },
      riskClass: "read-only-network",
      targetKey: "collection:a",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.updateCollection"]
      },
      ...overrides
    });

    expect(index.record(verifier(), "turn-two")).not.toHaveProperty("verifiedMutation");
    expect(index.record(verifier({ toolCallId: "target-mismatch", targetKey: "collection:b" }), "turn-one"))
      .not.toHaveProperty("verifiedMutation");
    expect(index.record(verifier({
      toolCallId: "failed-verifier",
      result: { ok: false, content: "verification failed" }
    }), "turn-one")).not.toHaveProperty("verifiedMutation");
    expect(index.record(verifier({
      toolCallId: "unrelated-verifier",
      executionEffect: { kind: "verification", verifies: ["mcp.other.update"] }
    }), "turn-one")).not.toHaveProperty("verifiedMutation");
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

  it("offers only bounded, safe, successful evidence from the current visible turn", () => {
    const index = new ExecutionEvidenceIndex();
    index.record(execution({
      toolCallId: "preferred",
      tool: { ...execution().tool, name: "postman.read" },
      targetSummary: "collection token=raw-secret"
    }), "turn-current");
    for (let position = 0; position < 9; position += 1) {
      index.record(execution({ toolCallId: `recent-${position}`, targetSummary: `target ${position}` }), "turn-current");
    }
    index.record(execution({ toolCallId: "earlier-turn" }), "turn-earlier");
    index.record(execution({ toolCallId: "failed-current", result: { ok: false, content: "raw failure" } }), "turn-current");
    index.record(execution({ toolCallId: "blocked-current", decision: "ask", result: undefined }), "turn-current");
    index.record(execution({
      toolCallId: "plan-current",
      tool: { ...execution().tool, name: "plan" }
    }), "turn-current");
    index.recordUnavailable("unavailable-current", "missing.tool", "turn-current");
    expect(index.record(execution({ toolCallId: "x".repeat(257) }), "turn-current")).toBeUndefined();
    expect(index.record(execution({ toolCallId: "token=raw-secret" }), "turn-current")).toBeUndefined();
    expect(index.record(execution({
      tool: { ...execution().tool, name: "x".repeat(257) }
    }), "turn-current")).toBeUndefined();

    const candidates = index.candidatesForTurn({
      visibleTurnId: "turn-current",
      preferredTools: ["postman.read"]
    });

    expect(candidates).toHaveLength(8);
    expect(candidates[0]).toMatchObject({ toolCallId: "preferred", tool: "postman.read" });
    expect(JSON.stringify(candidates)).not.toContain("raw-secret");
    expect(JSON.stringify(candidates)).not.toContain("raw collection body");
    expect(candidates.map((candidate) => candidate.toolCallId)).not.toEqual(expect.arrayContaining([
      "earlier-turn",
      "failed-current",
      "blocked-current",
      "plan-current",
      "unavailable-current"
    ]));
  });

  it("hydrates only from persisted harness receipt fields", () => {
    const index = new ExecutionEvidenceIndex();
    index.hydrate([{
      kind: "execution-evidence-recorded",
      tool: "postman.update",
      toolCallId: "persisted-call",
      status: "success",
      riskClass: "external-side-effect",
      targetSummary: "safe target",
      visibleTurnId: "turn-current",
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
    } satisfies SessionEvent]);

    expect(index.resolve(["persisted-call"])).toEqual([expect.objectContaining({
      toolCallId: "persisted-call",
      tool: "postman.update",
      riskClass: "external-side-effect",
      targetSummary: "safe target"
    })]);
    expect(index.candidatesForTurn({ visibleTurnId: "turn-current" })).toEqual([
      expect.objectContaining({ toolCallId: "persisted-call" })
    ]);
    expect(index.recordsForTurn("turn-current")).toEqual([
      expect.objectContaining({
        toolCallId: "persisted-call",
        executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
      })
    ]);
  });

  it("drops forged persisted verification links and secret-looking effect metadata", () => {
    const index = new ExecutionEvidenceIndex();
    index.hydrate([{
      kind: "execution-evidence-recorded",
      tool: "mcp.postman.verify",
      toolCallId: "call-verify",
      status: "success",
      riskClass: "read-only-network",
      visibleTurnId: "turn-current",
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.update", "token=raw-secret"],
        connector: { kind: "mcp", id: "token=raw-secret" }
      },
      verifiedMutation: { toolCallId: "call-forged", tool: "mcp.other.update" }
    } as SessionEvent]);

    expect(index.recordsForTurn("turn-current")).toEqual([
      expect.objectContaining({
        executionEffect: {
          kind: "verification",
          verifies: ["mcp.postman.update"]
        }
      })
    ]);
    expect(index.recordsForTurn("turn-current")[0]).not.toHaveProperty("verifiedMutation");
    expect(JSON.stringify(index.recordsForTurn("turn-current"))).not.toContain("raw-secret");
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
