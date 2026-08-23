import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

const plan: ExecutionPlan = {
  objective: "Verify an API collection",
  originTurnId: "turn-1",
  revision: 1,
  status: "active",
  provenance: { source: "runtime", provisional: true, sessionId: "session-1" },
  requirements: [{
    id: "update",
    itemId: "inspect",
    tool: "mcp.target.update",
    capability: "mutate",
    requiresProtectedInput: true,
    protectedSource: "browser"
  }],
  capabilityPreflight: {
    status: "ready",
    assessments: [{
      requirementId: "update",
      itemId: "inspect",
      tool: "mcp.target.update",
      capability: "mutate",
      status: "ready",
      resolution: {
        canonicalTool: "mcp.target.update",
        riskClass: "external-side-effect",
        classification: "mutate",
        protectedInput: { paths: ["/values/*/value"], grouped: true, source: "browser" }
      }
    }]
  },
  runtimeSynchronization: {
    status: "stale",
    reason: "ambiguous_execution_evidence",
    evidenceCallIds: ["call-1"]
  },
  items: [{
    id: "inspect",
    content: "Inspect the collection",
    status: "in_progress",
    runtimeProgress: {
      status: "observed",
      evidence: [{
        toolCallId: "call-1",
        tool: "mcp.target.read",
        outcome: "success",
        riskClass: "read-only-network"
      }]
    }
  }]
};

describe("ExecutionPlanStore", () => {
  it("returns defensive snapshots on replace and read", () => {
    const store = new ExecutionPlanStore();
    const written = store.replace(plan);
    written.items[0]!.content = "mutated outside";
    written.provenance!.provisional = false;
    written.capabilityPreflight!.assessments[0]!.resolution!.protectedInput!.paths[0] = "/mutated";
    written.runtimeSynchronization!.evidenceCallIds![0] = "mutated-call";
    written.items[0]!.runtimeProgress!.evidence[0]!.tool = "mutated.tool";
    const firstRead = store.current()!;
    firstRead.items[0]!.status = "completed";
    firstRead.provenance!.sessionId = "another-session";

    expect(store.current()).toEqual(plan);
  });

  it("starts without an active plan", () => {
    expect(new ExecutionPlanStore().current()).toBeUndefined();
  });
});
