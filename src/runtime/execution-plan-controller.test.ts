import { describe, expect, it, vi } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import { ExecutionPlanController, ExecutionPlanValidationError } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

function controller(): ExecutionPlanController {
  return new ExecutionPlanController(new ExecutionPlanStore());
}

function execution(input: {
  id: string;
  tool: string;
  effect: NonNullable<ToolExecutionRecord["executionEffect"]>;
  ok?: boolean;
  targetKey?: string;
}): ToolExecutionRecord {
  const riskClass = input.effect.kind === "mutation" ? "external-side-effect" : "read-only-network";
  return {
    tool: {
      name: input.tool,
      description: input.tool,
      inputSchema: {},
      riskClass,
      toolsets: [input.tool.startsWith("browser.") ? "browser" : "mcp"],
      progressLabel: input.tool,
      maxResultSizeChars: 1_000
    },
    executionEffect: input.effect,
    decision: "allow",
    riskClass,
    targetKey: input.targetKey ?? "target-1",
    result: { ok: input.ok ?? true, content: input.ok === false ? "failed" : "ok" },
    toolCallId: input.id
  };
}

describe("ExecutionPlanController", () => {
  it("writes a bounded lightweight Plan and derives its objective when omitted", async () => {
    const target = controller();
    const plan = await target.write({
      items: [
        { id: "inspect", content: "Inspect APIs", status: "in_progress" },
        { id: "update", content: "Update APIs", status: "pending" }
      ]
    }, "turn-1");

    expect(plan).toMatchObject({
      objective: "Inspect APIs",
      originTurnId: "turn-1",
      revision: 1,
      status: "active",
      items: [
        { id: "inspect", content: "Inspect APIs", status: "in_progress" },
        { id: "update", content: "Update APIs", status: "pending" }
      ]
    });
  });

  it("merges complete steps without asking the Plan for execution evidence", async () => {
    const target = controller();
    await target.write({
      objective: "Inspect APIs",
      items: [{ id: "inspect", content: "Inspect APIs", status: "in_progress" }]
    }, "turn-1");

    const plan = await target.merge({
      items: [{ id: "inspect", content: "Inspect APIs", status: "completed" }]
    });

    expect(plan).toMatchObject({
      revision: 2,
      status: "completed",
      items: [{ id: "inspect", content: "Inspect APIs", status: "completed" }]
    });
    expect(plan.items[0]).toEqual({ id: "inspect", content: "Inspect APIs", status: "completed" });
  });

  it("strips legacy governance fields from new writes", async () => {
    const target = controller();
    const plan = await target.write({
      objective: "Update destination",
      items: [{
        id: "update",
        content: "Update destination",
        status: "completed",
        evidenceCallIds: ["fabricated-call"],
        completionKind: "reasoning",
        blocker: { kind: "approval_required", summary: "model-authored" }
      }],
      requirements: [{ id: "invented", itemId: "update", tool: "invented.tool", capability: "mutate" }]
    }, "turn-1");

    expect(plan.items[0]).toEqual({ id: "update", content: "Update destination", status: "completed" });
    expect(plan).not.toHaveProperty("requirements");
    expect(plan).not.toHaveProperty("capabilityPreflight");
    expect(JSON.stringify(plan)).not.toContain("fabricated-call");
    expect(JSON.stringify(plan)).not.toContain("invented.tool");
  });

  it("hydrates legacy Mission snapshots into lightweight Plan state", () => {
    const target = controller();
    const legacy = {
      objective: "Legacy work",
      originTurnId: "turn-legacy",
      revision: 4,
      status: "blocked",
      provenance: { source: "provider", provisional: false },
      requirements: [{ id: "mutate", itemId: "write", tool: "fabricated.tool", capability: "mutate" }],
      capabilityPreflight: { status: "blocked", assessments: [] },
      items: [{
        id: "write",
        content: "Write destination",
        status: "blocked",
        evidenceCallIds: ["fabricated-call"],
        evidence: [{
          toolCallId: "fabricated-call",
          tool: "fabricated.tool",
          outcome: "success",
          riskClass: "external-side-effect"
        }],
        blocker: { kind: "missing_capability", summary: "legacy blocker" }
      }]
    } as ExecutionPlan;

    const hydrated = target.hydrate(legacy);

    expect(hydrated).toEqual({
      objective: "Legacy work",
      originTurnId: "turn-legacy",
      revision: 4,
      status: "active",
      items: [{ id: "write", content: "Write destination", status: "pending" }]
    });
  });

  it("hydrates bounded runtime Plan evidence while rejecting model-only governance fields", () => {
    const evidence = new ExecutionEvidenceIndex();
    evidence.record(execution({
      id: "navigate-1",
      tool: "browser.navigate",
      effect: { kind: "read" }
    }), "turn-1");
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    const hydrated = target.hydrate({
      objective: "Open the app",
      originTurnId: "turn-1",
      revision: 2,
      status: "active",
      runtimeSynchronization: { status: "current" },
      items: [{
        id: "open",
        content: "Open the app",
        status: "in_progress",
        runtimeProgress: {
          status: "observed",
          evidence: [{
            toolCallId: "navigate-1",
            tool: "browser.navigate",
            outcome: "success",
            riskClass: "read-only-network"
          }]
        }
      }]
    });

    expect(hydrated.items[0]).toMatchObject({
      runtimeProgress: { status: "observed", evidence: [{ toolCallId: "navigate-1" }] }
    });
  });

  it("keeps lifecycle snapshots inspectable", async () => {
    const events: string[] = [];
    const record = vi.fn(async (event: { kind: string }) => { events.push(event.kind); });
    const target = new ExecutionPlanController(new ExecutionPlanStore(), record);
    await target.write({
      items: [{ id: "one", content: "One", status: "pending" }]
    }, "turn-1");
    await target.merge({
      items: [{ id: "one", content: "One", status: "completed" }]
    });
    await target.transfer(["task-1", "task-1"]);

    expect(events).toEqual([
      "execution-plan-started",
      "execution-plan-completed",
      "execution-plan-transferred"
    ]);
    expect(record.mock.calls[2]?.[0]).toMatchObject({ taskIds: ["task-1"] });
  });

  it("requires explicit continuation before resuming hydrated Plan state", async () => {
    const persisted: ExecutionPlan = {
      objective: "Continue migration",
      originTurnId: "turn-1",
      revision: 1,
      status: "active",
      items: [{ id: "migrate", content: "Migrate", status: "in_progress" }]
    };
    const resumed = controller();
    resumed.hydrate(persisted);
    await resumed.prepareForTurn("resume this work");
    expect(resumed.current()).toBeDefined();

    const unrelated = controller();
    unrelated.hydrate(persisted);
    await unrelated.prepareForTurn("review a different codebase");
    expect(unrelated.current()).toBeUndefined();
  });

  it("redacts and bounds Plan text", async () => {
    const target = controller();
    const plan = await target.write({
      objective: "API token=sk-secret\ninspect",
      items: [{ id: "inspect", content: "Use token=sk-secret\n safely", status: "pending" }]
    }, "turn-1");

    expect(plan.objective).toContain("[REDACTED]");
    expect(plan.items[0]?.content).toContain("[REDACTED]");
    expect(JSON.stringify(plan)).not.toContain("sk-secret");
    expect(plan.objective).not.toContain("\n");
  });

  it("rejects malformed or duplicate steps without mutating existing state", async () => {
    const target = controller();
    await expect(target.write({
      items: [
        { id: "same", content: "One", status: "pending" },
        { id: "same", content: "Two", status: "pending" }
      ]
    }, "turn-1")).rejects.toBeInstanceOf(ExecutionPlanValidationError);
    expect(target.current()).toBeUndefined();
  });

  it("completes a unique import step from an independently verified mutation", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      objective: "Set up Postman",
      items: [
        { id: "import", content: "Import the OpenAPI specification", status: "in_progress" },
        { id: "credentials", content: "Configure credentials in the environment", status: "pending" }
      ]
    }, "turn-1");

    const mutation = evidence.record(execution({
      id: "import-1",
      tool: "mcp.postman.createCollection",
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
    }), "turn-1")!;
    await target.synchronizeEvidence([mutation.toolCallId]);
    expect(target.current()?.items[0]).toMatchObject({
      status: "in_progress",
      runtimeProgress: { status: "observed" }
    });

    const verification = evidence.record(execution({
      id: "verify-import-1",
      tool: "mcp.postman.getCollection",
      effect: {
        kind: "verification",
        verifies: ["mcp.postman.createCollection"],
        connector: { kind: "mcp", id: "postman" }
      }
    }), "turn-1")!;
    await target.synchronizeEvidence([verification.toolCallId]);

    expect(target.current()).toMatchObject({
      status: "active",
      runtimeSynchronization: { status: "current" },
      items: [
        {
          id: "import",
          status: "completed",
          runtimeProgress: {
            status: "verified",
            evidence: [{ toolCallId: "import-1" }, { toolCallId: "verify-import-1" }]
          }
        },
        { id: "credentials", status: "in_progress" }
      ]
    });
  });

  it("records navigation evidence without treating an unverified destination as complete", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      items: [{ id: "open-app", content: "Open the Postman app", status: "in_progress" }]
    }, "turn-1");
    const receipt = evidence.record(execution({
      id: "navigate-1",
      tool: "browser.navigate",
      effect: { kind: "read" }
    }), "turn-1")!;

    await target.synchronizeEvidence([receipt.toolCallId]);

    expect(target.current()?.items[0]).toMatchObject({
      status: "in_progress",
      runtimeProgress: {
        status: "observed",
        evidence: [{ toolCallId: "navigate-1", tool: "browser.navigate" }]
      }
    });
  });

  it("does not complete from failed receipts, clicks, unknown IDs, or provider-authored evidence text", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      items: [{
        id: "import",
        content: "Import the Swagger specification",
        status: "in_progress",
        runtimeProgress: {
          status: "verified",
          evidence: [{
            toolCallId: "fabricated",
            tool: "mcp.postman.importSwaggerSpecification",
            outcome: "success",
            riskClass: "external-side-effect"
          }]
        }
      } as any]
    }, "turn-1", undefined, { source: "provider" });
    const failed = evidence.record(execution({
      id: "failed-import",
      tool: "mcp.postman.importSwaggerSpecification",
      effect: { kind: "mutation" },
      ok: false
    }), "turn-1")!;
    const click = evidence.record(execution({
      id: "click-1",
      tool: "browser.click",
      effect: { kind: "read" }
    }), "turn-1")!;

    await target.synchronizeEvidence([failed.toolCallId, click.toolCallId, "fabricated"]);

    expect(target.current()?.items[0]).toEqual({
      id: "import",
      content: "Import the Swagger specification",
      status: "in_progress"
    });
  });

  it("marks genuinely ambiguous verified progress stale without completing either step", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      objective: "Import two specifications",
      items: [
        { id: "import-one", content: "Import the first OpenAPI specification", status: "in_progress" },
        { id: "import-two", content: "Import the second OpenAPI specification", status: "pending" }
      ]
    }, "turn-1");
    evidence.record(execution({
      id: "import-ambiguous",
      tool: "mcp.postman.importOpenApiSpecification",
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
    }), "turn-1");
    const verification = evidence.record(execution({
      id: "verify-ambiguous",
      tool: "mcp.postman.getSpecification",
      effect: {
        kind: "verification",
        verifies: ["mcp.postman.importOpenApiSpecification"],
        connector: { kind: "mcp", id: "postman" }
      }
    }), "turn-1")!;

    await target.synchronizeEvidence([verification.toolCallId]);

    expect(target.current()).toMatchObject({
      runtimeSynchronization: {
        status: "stale",
        reason: "ambiguous_execution_evidence",
        evidenceCallIds: ["verify-ambiguous"]
      },
      items: [{ status: "in_progress" }, { status: "pending" }]
    });
  });

  it("keeps aggregate import work incomplete after only one verified mutation", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      items: [{ id: "imports", content: "Import all six API specifications", status: "in_progress" }]
    }, "turn-1");
    evidence.record(execution({
      id: "import-one-of-six",
      tool: "mcp.postman.importSpec",
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
    }), "turn-1");
    const verification = evidence.record(execution({
      id: "verify-one-of-six",
      tool: "mcp.postman.getCollection",
      effect: {
        kind: "verification",
        verifies: ["mcp.postman.importSpec"],
        connector: { kind: "mcp", id: "postman" }
      }
    }), "turn-1")!;

    await target.synchronizeEvidence([verification.toolCallId]);

    expect(target.current()).toMatchObject({
      runtimeSynchronization: { status: "stale" },
      items: [{ status: "in_progress", runtimeProgress: { status: "observed" } }]
    });
  });

  it("does not revise or reactivate a verified completed step when the same receipt is observed again", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const target = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await target.write({
      items: [{ id: "credentials", content: "Create the protected credentials environment", status: "in_progress" }]
    }, "turn-1");
    evidence.record(execution({
      id: "environment-1",
      tool: "mcp.postman.createEnvironment",
      effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
    }), "turn-1");
    const verification = evidence.record(execution({
      id: "verify-environment-1",
      tool: "mcp.postman.getEnvironment",
      effect: {
        kind: "verification",
        verifies: ["mcp.postman.createEnvironment"],
        connector: { kind: "mcp", id: "postman" }
      }
    }), "turn-1")!;
    await target.synchronizeEvidence([verification.toolCallId]);
    const completed = target.current()!;

    await target.synchronizeEvidence([verification.toolCallId]);

    expect(target.current()).toEqual(completed);
    expect(completed.items[0]).toMatchObject({ status: "completed", runtimeProgress: { status: "verified" } });

    await target.merge({
      items: [{ id: "credentials", content: "Repeat the credentials environment", status: "in_progress" }]
    });
    expect(target.current()?.items[0]).toMatchObject({
      content: "Create the protected credentials environment",
      status: "completed",
      runtimeProgress: { status: "verified" }
    });
  });
});
