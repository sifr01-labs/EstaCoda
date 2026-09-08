import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import type { SessionEvent } from "../contracts/session.js";
import { executionPlanCarryForwardEvent, hydratableExecutionPlanSnapshot } from "./execution-plan-state.js";

const events: SessionEvent[] = [{
  kind: "execution-plan-started",
  plan: {
    objective: "Inspect APIs",
    originTurnId: "turn-1",
    revision: 1,
    status: "active",
    items: [{ id: "inspect", content: "Inspect APIs", status: "in_progress" }]
  }
}, {
  kind: "execution-plan-updated",
  plan: {
    objective: "Inspect APIs",
    originTurnId: "turn-1",
    revision: 2,
    status: "active",
    provenance: { source: "provider", provisional: false, sessionId: "session-1" },
    requirements: [{ id: "read", itemId: "inspect", tool: "mcp.target.read", capability: "read" }],
    capabilityPreflight: {
      status: "ready",
      assessments: [{
        requirementId: "read",
        itemId: "inspect",
        tool: "mcp.target.read",
        capability: "read",
        status: "ready",
        resolution: {
          canonicalTool: "mcp.target.read",
          riskClass: "read-only-network",
          classification: "read"
        }
      }]
    },
    runtimeSynchronization: { status: "current" },
    items: [{
      id: "inspect",
      content: "Inspect APIs",
      status: "pending",
      runtimeProgress: {
        status: "observed",
        evidence: [{
          toolCallId: "call-read",
          tool: "mcp.target.read",
          outcome: "success",
          riskClass: "read-only-network"
        }]
      }
    }]
  }
}];

describe("execution plan session state", () => {
  it("hydrates only the latest unresolved bounded snapshot", () => {
    const snapshot = hydratableExecutionPlanSnapshot(events);
    expect(snapshot).toMatchObject({
      revision: 2,
      provenance: { source: "provider", provisional: false, sessionId: "session-1" }
    });
    snapshot!.provenance!.sessionId = "mutated-session";
    snapshot!.capabilityPreflight!.assessments[0]!.resolution!.canonicalTool = "mutated.tool";
    snapshot!.items[0]!.runtimeProgress!.evidence[0]!.tool = "mutated.tool";
    expect((events[1] as { plan: ExecutionPlan }).plan.provenance?.sessionId).toBe(
      "session-1"
    );
    expect((events[1] as { plan: ExecutionPlan }).plan.capabilityPreflight?.assessments[0]?.resolution?.canonicalTool)
      .toBe("mcp.target.read");
    expect((events[1] as { plan: ExecutionPlan }).plan.items[0]?.runtimeProgress?.evidence[0]?.tool)
      .toBe("mcp.target.read");
    expect(executionPlanCarryForwardEvent(events)).toMatchObject({
      kind: "execution-plan-updated",
      plan: { revision: 2, originTurnId: "turn-1" }
    });
  });

  it("does not hydrate completed state", () => {
    const latestPlan: ExecutionPlan = {
      objective: "Inspect APIs",
      originTurnId: "turn-1",
      revision: 2,
      status: "active",
      items: [{ id: "inspect", content: "Inspect APIs", status: "pending" }]
    };
    const completed: SessionEvent = {
      kind: "execution-plan-completed",
      plan: {
        ...latestPlan,
        status: "completed",
        revision: 3,
        items: [{ id: "inspect", content: "Inspect APIs", status: "completed" }]
      }
    };
    expect(hydratableExecutionPlanSnapshot([...events, completed])).toBeUndefined();
  });
});
