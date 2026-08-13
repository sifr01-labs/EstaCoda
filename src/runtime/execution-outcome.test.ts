import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { isolateLtr } from "../ui/bidi.js";
import {
  appendExecutionReceipt,
  deriveExecutionFinalOutcome,
  learningOutcomeStatus
} from "./execution-outcome.js";

function execution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "mcp.postman.updateCollection",
      description: "Update a Postman collection",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating Postman",
      maxResultSizeChars: 1_000
    },
    input: {
      apiKey: "raw-secret",
      collection: { info: { name: "private collection" } }
    },
    decision: "allow",
    riskClass: "external-side-effect",
    targetSummary: "collection token=raw-secret",
    toolCallId: "call-update",
    result: {
      ok: true,
      content: "raw Postman collection body with raw-secret"
    },
    ...overrides
  };
}

function completedPlan(): ExecutionPlan {
  return {
    objective: "Update and verify Postman",
    originTurnId: "turn-1",
    revision: 3,
    status: "completed",
    items: [
      {
        id: "update",
        content: "Update the Postman collection",
        status: "completed",
        evidenceCallIds: ["call-update"],
        evidence: [{
          toolCallId: "call-update",
          tool: "mcp.postman.updateCollection",
          outcome: "success",
          riskClass: "external-side-effect"
        }]
      },
      {
        id: "verify",
        content: "Read back and verify the collection",
        status: "completed",
        evidenceCallIds: ["call-verify"],
        evidence: [{
          toolCallId: "call-verify",
          tool: "mcp.postman.getCollection",
          outcome: "success",
          riskClass: "read-only-network"
        }]
      }
    ]
  };
}

function activePlan(): ExecutionPlan {
  return {
    objective: "Update and verify Postman",
    originTurnId: "turn-1",
    revision: 1,
    status: "active",
    items: [
      { id: "inspect", content: "Inspect the collection", status: "in_progress" },
      { id: "update", content: "Update the collection", status: "pending" },
      { id: "verify", content: "Verify the collection", status: "pending" }
    ]
  };
}

function toolPlan(overrides: Partial<ToolCallPlan> = {}): ToolCallPlan {
  return {
    id: "call-update",
    tool: "mcp.postman.updateCollection",
    input: {},
    source: "provider-tool-call",
    status: "planned",
    riskClass: "external-side-effect",
    ...overrides
  };
}

describe("execution outcome receipts", () => {
  it("creates redacted confirmed receipts only for successful consequential executions", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: { ok: false, fallbackUsed: false, attempts: [], toolCalls: [] },
      toolExecutions: [
        execution(),
        execution({
          tool: { ...execution().tool, name: "mcp.postman.getCollection", riskClass: "read-only-network" },
          riskClass: "read-only-network",
          toolCallId: "call-read"
        }),
        execution({ toolCallId: "call-failed", result: { ok: false, content: "failed raw body" } })
      ]
    });

    expect(outcome).toEqual({
      status: "partially_completed",
      confirmedActions: [{
        toolCallId: "call-update",
        tool: "mcp.postman.updateCollection",
        riskClass: "external-side-effect",
        status: "confirmed",
        verification: "not_verified"
      }],
      uncertainActions: []
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-secret");
    expect(JSON.stringify(outcome)).not.toContain("private collection");
    expect(JSON.stringify(outcome)).not.toContain("raw Postman collection body");
  });

  it("marks an earlier mutation verified only when a later evidence-backed verification completes", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "done", model: "test", provider: "openai" }
      },
      toolExecutions: [
        execution(),
        execution({
          tool: { ...execution().tool, name: "mcp.postman.getCollection", riskClass: "read-only-network" },
          riskClass: "read-only-network",
          toolCallId: "call-verify"
        })
      ],
      executionPlan: completedPlan()
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.confirmedActions).toEqual([expect.objectContaining({
      toolCallId: "call-update",
      verification: "verified"
    })]);
  });

  it("does not report success while a Mission remains active after successful reads", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "I inspected the collection.", model: "test", provider: "openai" }
      },
      toolExecutions: [execution({
        tool: { ...execution().tool, name: "mcp.postman.getCollection", riskClass: "read-only-network" },
        riskClass: "read-only-network",
        toolCallId: "call-read"
      })],
      executionPlan: activePlan()
    });

    expect(outcome.status).toBe("partially_completed");
  });

  it("reports a blocked Mission with no completed items as blocked despite successful exploration", () => {
    const plan = activePlan();
    plan.status = "blocked";
    plan.items[0] = {
      ...plan.items[0]!,
      status: "blocked",
      blocker: { kind: "external_state", summary: "Postman authentication expired." }
    };

    const outcome = deriveExecutionFinalOutcome({
      toolExecutions: [execution({
        tool: { ...execution().tool, name: "mcp.postman.getCollection", riskClass: "read-only-network" },
        riskClass: "read-only-network",
        toolCallId: "call-read"
      })],
      executionPlan: plan
    });

    expect(outcome.status).toBe("blocked");
  });

  it("reports a blocked Mission with a completed item as partially completed", () => {
    const plan = activePlan();
    plan.status = "blocked";
    plan.items[0] = {
      ...plan.items[0]!,
      status: "completed",
      completionKind: "reasoning"
    };
    plan.items[1] = {
      ...plan.items[1]!,
      status: "blocked",
      blocker: { kind: "external_state", summary: "Postman authentication expired." }
    };

    expect(deriveExecutionFinalOutcome({ toolExecutions: [], executionPlan: plan }).status)
      .toBe("partially_completed");
  });

  it("keeps a planned consequential call without a result uncertain and non-successful", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "done", model: "test", provider: "openai" }
      },
      toolExecutions: [],
      toolPlans: [toolPlan()]
    });

    expect(outcome).toEqual({
      status: "partially_completed",
      confirmedActions: [],
      uncertainActions: [{
        toolCallId: "call-update",
        tool: "mcp.postman.updateCollection",
        riskClass: "external-side-effect",
        status: "uncertain"
      }]
    });
  });

  it("does not let delegated answer ownership bypass an active Mission", () => {
    const outcome = deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionPlan: activePlan(),
      delegatedAnswerOwned: true
    });

    expect(outcome.status).toBe("partially_completed");
  });

  it("classifies successful recovery after an intermediate failure", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "generated successfully", model: "test", provider: "openai" }
      },
      toolExecutions: [
        execution({
          tool: { ...execution().tool, name: "python.exec", riskClass: "workspace-write" },
          riskClass: "workspace-write",
          toolCallId: "call-python-failed",
          result: { ok: false, content: "syntax error" }
        }),
        execution({
          tool: { ...execution().tool, name: "image.generate", riskClass: "external-side-effect" },
          riskClass: "external-side-effect",
          toolCallId: "call-generated"
        })
      ]
    });

    expect(outcome.status).toBe("completed_with_recovered_errors");
    expect(learningOutcomeStatus(outcome.status)).toBe("partial");
  });

  it("classifies an emergency deadline receipt as partial without fabricating failure", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "Emergency receipt", model: "test", provider: "openai" }
      },
      toolExecutions: [],
      emergencyDeadlineReached: true
    });

    expect(outcome.status).toBe("partially_completed");
    expect(learningOutcomeStatus(outcome.status)).toBe("partial");
  });

  it("does not claim recovery when the final execution still failed", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "The final action failed", model: "test", provider: "openai" }
      },
      toolExecutions: [
        execution({ toolCallId: "call-generated" }),
        execution({
          tool: { ...execution().tool, name: "python.exec", riskClass: "workspace-write" },
          riskClass: "workspace-write",
          toolCallId: "call-python-failed",
          result: { ok: false, content: "syntax error" }
        })
      ]
    });

    expect(outcome.status).toBe("partially_completed");
  });

  it("keeps a dispatched consequential action uncertain when no result exists", () => {
    const outcome = deriveExecutionFinalOutcome({
      cancelled: true,
      toolExecutions: [execution({ result: undefined })]
    });

    expect(outcome).toEqual({
      status: "cancelled",
      confirmedActions: [],
      uncertainActions: [{
        toolCallId: "call-update",
        tool: "mcp.postman.updateCollection",
        riskClass: "external-side-effect",
        status: "uncertain"
      }]
    });
    expect(appendExecutionReceipt("Cancelled.", outcome, "en")).toContain("Uncertain actions:");
  });

  it("treats the executor's synthetic cancellation result as uncertain", () => {
    const outcome = deriveExecutionFinalOutcome({
      cancelled: true,
      toolExecutions: [execution({
        result: {
          ok: false,
          content: "Tool execution cancelled.",
          metadata: { reason: "cancelled" }
        }
      })]
    });

    expect(outcome.uncertainActions).toEqual([
      expect.objectContaining({ toolCallId: "call-update", status: "uncertain" })
    ]);
  });

  it("renders Arabic receipt labels with isolated technical tokens", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: { ok: false, fallbackUsed: false, attempts: [], toolCalls: [] },
      toolExecutions: [execution()]
    });
    const rendered = appendExecutionReceipt("تعذر إكمال الملخص.", outcome, "ar");

    expect(rendered).toContain("الإجراءات المؤكدة:");
    expect(rendered).toContain(isolateLtr("mcp.postman.updateCollection"));
    expect(rendered).not.toContain("raw-secret");
  });
});
