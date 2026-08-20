import { describe, expect, it } from "vitest";
import type { ExecutionEvidenceRecord, ExecutionPlan } from "../contracts/execution-plan.js";
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
    executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
    targetSummary: "collection token=raw-secret",
    toolCallId: "call-update",
    result: {
      ok: true,
      content: "raw Postman collection body with raw-secret"
    },
    ...overrides
  };
}

type SuccessfulExecutionReceipt = Extract<ExecutionEvidenceRecord, { status: "success" }>;
type UnsuccessfulExecutionReceipt = Exclude<ExecutionEvidenceRecord, { status: "success" }>;

function successfulReceipt(
  overrides: Partial<SuccessfulExecutionReceipt> = {}
): SuccessfulExecutionReceipt {
  return {
    kind: "execution-evidence-recorded",
    toolCallId: "call-update",
    tool: "mcp.postman.updateCollection",
    status: "success",
    riskClass: "external-side-effect",
    targetSummary: "Collection Alpha",
    visibleTurnId: "turn-1",
    executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
    ...overrides
  };
}

function unsuccessfulReceipt(
  status: UnsuccessfulExecutionReceipt["status"],
  overrides: Partial<UnsuccessfulExecutionReceipt> = {}
): UnsuccessfulExecutionReceipt {
  return {
    kind: "execution-evidence-recorded",
    toolCallId: `call-${status}`,
    tool: "mcp.postman.updateCollection",
    status,
    riskClass: "external-side-effect",
    visibleTurnId: "turn-1",
    executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
    ...overrides
  };
}

function verificationReceipt(
  overrides: Partial<SuccessfulExecutionReceipt> = {}
): SuccessfulExecutionReceipt {
  return successfulReceipt({
    toolCallId: "call-verify",
    tool: "mcp.postman.getCollection",
    riskClass: "read-only-network",
    executionEffect: {
      kind: "verification",
      verifies: ["mcp.postman.updateCollection"],
      connector: { kind: "mcp", id: "postman" }
    },
    verifiedMutation: {
      toolCallId: "call-update",
      tool: "mcp.postman.updateCollection"
    },
    ...overrides
  });
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
      ],
      executionReceipts: [
        successfulReceipt(),
        successfulReceipt({
          toolCallId: "call-read",
          tool: "mcp.postman.getCollection",
          riskClass: "read-only-network",
          executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } }
        }),
        unsuccessfulReceipt("failed", { toolCallId: "call-failed" })
      ]
    });

    expect(outcome).toEqual({
      status: "partially_completed",
      confirmedActions: [{
        toolCallId: "call-update",
        tool: "mcp.postman.updateCollection",
        riskClass: "external-side-effect",
        targetSummary: "Collection Alpha",
        status: "confirmed",
        verification: "not_verified"
      }],
      uncertainActions: []
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-secret");
    expect(JSON.stringify(outcome)).not.toContain("private collection");
    expect(JSON.stringify(outcome)).not.toContain("raw Postman collection body");
  });

  it("marks a mutation verified only from a linked authoritative verification receipt", () => {
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
      executionReceipts: [successfulReceipt(), verificationReceipt()]
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.confirmedActions).toEqual([expect.objectContaining({
      toolCallId: "call-update",
      verification: "verified"
    })]);
    expect(deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionReceipts: [verificationReceipt(), successfulReceipt()]
    }).confirmedActions[0]).toMatchObject({ verification: "not_verified" });
  });

  it("does not let fabricated Mission evidence create a verified mutation", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "done", model: "test", provider: "openai" }
      },
      toolExecutions: [execution()],
      executionReceipts: [successfulReceipt()],
      executionPlan: completedPlan()
    } as Parameters<typeof deriveExecutionFinalOutcome>[0]);

    expect(outcome.status).toBe("completed");
    expect(outcome.confirmedActions).toEqual([
      expect.objectContaining({ toolCallId: "call-update", verification: "not_verified" })
    ]);
    expect(deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionReceipts: [successfulReceipt({ riskClass: "read-only-network" })]
    }).confirmedActions).toEqual([]);
  });

  it("returns partial completion when independent verification fails after a mutation", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "verification failed", model: "test", provider: "openai" }
      },
      toolExecutions: [execution()],
      executionReceipts: [
        successfulReceipt(),
        unsuccessfulReceipt("failed", {
          toolCallId: "call-verify",
          tool: "mcp.postman.getCollection",
          riskClass: "read-only-network",
          executionEffect: {
            kind: "verification",
            verifies: ["mcp.postman.updateCollection"],
            connector: { kind: "mcp", id: "postman" }
          }
        })
      ]
    });

    expect(outcome.status).toBe("partially_completed");
    expect(outcome.confirmedActions[0]).toMatchObject({ verification: "not_verified" });
  });

  it("does not let a completed Mission hide a failed or blocked execution", () => {
    const withCompletedPlan = (executionReceipts: ExecutionEvidenceRecord[]) => deriveExecutionFinalOutcome({
      providerExecution: {
        ok: true,
        fallbackUsed: false,
        attempts: [],
        toolCalls: [],
        response: { ok: true, content: "done", model: "test", provider: "openai" }
      },
      toolExecutions: [],
      executionReceipts,
      executionPlan: completedPlan()
    } as Parameters<typeof deriveExecutionFinalOutcome>[0]);

    expect(withCompletedPlan([unsuccessfulReceipt("failed")]).status).toBe("failed");
    expect(withCompletedPlan([unsuccessfulReceipt("blocked")]).status).toBe("blocked");
  });

  it("returns the same outcome with no Mission, a completed Mission, or a stale active Mission", () => {
    const input = {
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
      executionReceipts: [successfulReceipt({
        toolCallId: "call-read",
        tool: "mcp.postman.getCollection",
        riskClass: "read-only-network",
        executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } }
      })]
    };
    const withLegacyPlan = (executionPlan: ExecutionPlan) => deriveExecutionFinalOutcome({
      ...input,
      executionPlan
    } as Parameters<typeof deriveExecutionFinalOutcome>[0]);

    expect(deriveExecutionFinalOutcome(input).status).toBe("completed");
    expect(withLegacyPlan(completedPlan())).toEqual(deriveExecutionFinalOutcome(input));
    expect(withLegacyPlan(activePlan())).toEqual(deriveExecutionFinalOutcome(input));
  });

  it("reports an authoritative blocked execution with no completed work as blocked", () => {
    const outcome = deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionReceipts: [unsuccessfulReceipt("blocked")]
    });

    expect(outcome.status).toBe("blocked");
  });

  it("reports an authoritative blocker after successful work as partially completed", () => {
    expect(deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionReceipts: [successfulReceipt(), unsuccessfulReceipt("blocked")]
    }).status).toBe("partially_completed");
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
      executionReceipts: [],
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

  it("does not let stale Mission state downgrade delegated answer ownership", () => {
    const outcome = deriveExecutionFinalOutcome({
      toolExecutions: [],
      executionReceipts: [],
      executionPlan: activePlan(),
      delegatedAnswerOwned: true
    } as Parameters<typeof deriveExecutionFinalOutcome>[0]);

    expect(outcome.status).toBe("completed");
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
      ],
      executionReceipts: [
        unsuccessfulReceipt("failed", { toolCallId: "call-python-failed", tool: "python.exec" }),
        successfulReceipt({ toolCallId: "call-generated", tool: "image.generate" })
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
      executionReceipts: [],
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
      ],
      executionReceipts: [
        successfulReceipt({ toolCallId: "call-generated" }),
        unsuccessfulReceipt("failed", { toolCallId: "call-python-failed", tool: "python.exec" })
      ]
    });

    expect(outcome.status).toBe("partially_completed");
  });

  it("keeps a dispatched consequential action uncertain when no result exists", () => {
    const outcome = deriveExecutionFinalOutcome({
      cancelled: true,
      toolExecutions: [execution({ result: undefined })],
      executionReceipts: [unsuccessfulReceipt("failed")]
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
      })],
      executionReceipts: [unsuccessfulReceipt("failed")]
    });

    expect(outcome.uncertainActions).toEqual([
      expect.objectContaining({ toolCallId: "call-update", status: "uncertain" })
    ]);
  });

  it("renders Arabic receipt labels with isolated technical tokens", () => {
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: { ok: false, fallbackUsed: false, attempts: [], toolCalls: [] },
      toolExecutions: [execution()],
      executionReceipts: [successfulReceipt()]
    });
    const rendered = appendExecutionReceipt("تعذر إكمال الملخص.", outcome, "ar");

    expect(rendered).toContain("الإجراءات المؤكدة:");
    expect(rendered).toContain(isolateLtr("mcp.postman.updateCollection"));
    expect(rendered).not.toContain("raw-secret");
  });
});
