import { describe, expect, it, vi } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import { ExecutionPlanController, ExecutionPlanValidationError } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

function controller(): ExecutionPlanController {
  return new ExecutionPlanController(new ExecutionPlanStore());
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
});
