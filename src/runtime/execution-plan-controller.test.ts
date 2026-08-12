import { describe, expect, it } from "vitest";
import { EXECUTION_PLAN_MAX_ITEMS } from "../contracts/execution-plan.js";
import { ExecutionPlanController, ExecutionPlanValidationError } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

function controller() {
  return new ExecutionPlanController(new ExecutionPlanStore());
}

describe("ExecutionPlanController", () => {
  it("records started, updated, completed, transferred, and abandoned lifecycle snapshots", async () => {
    const events: string[] = [];
    const target = new ExecutionPlanController(
      new ExecutionPlanStore(),
      async (event) => { events.push(event.kind); }
    );
    await target.write({
      objective: "Complete the mission",
      items: [{ id: "work", content: "Do the work", status: "in_progress" }]
    }, "turn-1");
    await target.merge({ items: [{ id: "work", status: "pending" }] });
    await target.merge({ items: [{ id: "work", status: "completed" }] });
    target.clear();
    await target.write({
      objective: "Delegate the mission",
      items: [{ id: "delegate", content: "Create a Task", status: "in_progress" }]
    }, "turn-2");
    await target.transfer(["task-1", "task-1"]);
    target.clear();
    await target.write({
      objective: "Replace the mission",
      items: [{ id: "old", content: "Old work", status: "pending" }]
    }, "turn-3");
    await target.prepareForTurn("Please review a different codebase");

    expect(events).toEqual([
      "execution-plan-started",
      "execution-plan-updated",
      "execution-plan-completed",
      "execution-plan-started",
      "execution-plan-transferred",
      "execution-plan-started",
      "execution-plan-abandoned"
    ]);
    expect(target.current()).toBeUndefined();
  });

  it("keeps active state for explicit continuation", async () => {
    const target = controller();
    await target.write({
      objective: "Continue this mission",
      items: [{ id: "work", content: "Continue", status: "in_progress" }]
    }, "turn-1");
    await target.prepareForTurn("continue");
    expect(target.current()?.status).toBe("active");
  });

  it("hydrates only when the next turn explicitly resumes", async () => {
    const persisted = {
      objective: "Resume this mission",
      originTurnId: "turn-old",
      revision: 2,
      status: "active" as const,
      items: [{ id: "work", content: "Continue", status: "in_progress" as const }]
    };
    const resumed = controller();
    resumed.hydrate(persisted);
    await resumed.prepareForTurn("resume this work");
    expect(resumed.current()).toEqual(persisted);

    const unrelated = controller();
    unrelated.hydrate(persisted);
    await unrelated.prepareForTurn("hello");
    expect(unrelated.current()).toBeUndefined();
  });

  it("writes a redacted bounded plan and derives active state", async () => {
    const target = controller();
    const plan = await target.write({
      objective: "Test API\ntoken=super-secret-value-1234567890",
      items: [
        { id: "inspect", content: "Inspect APIs", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "verify", content: "Verify collection", status: "in_progress" }
      ]
    }, "turn-1");

    expect(plan).toMatchObject({
      originTurnId: "turn-1",
      revision: 1,
      status: "active",
      items: [
        { id: "inspect", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "verify", status: "in_progress" }
      ]
    });
    expect(plan.objective).toContain("API token=[REDACTED]");
    expect(plan.objective).not.toContain("\n");
    expect(JSON.stringify(plan)).not.toContain("super-secret-value");
  });

  it("merges existing items, appends new items, and increments revision", async () => {
    const target = controller();
    await target.write({
      objective: "Build collection",
      items: [{ id: "build", content: "Build it", status: "in_progress" }]
    }, "turn-1");

    const plan = await target.merge({
      objective: "Build and verify collection",
      items: [
        { id: "build", status: "completed", evidenceCallIds: ["call-build"] },
        { id: "verify", content: "Verify it", status: "in_progress" }
      ]
    });

    expect(plan).toMatchObject({
      objective: "Build and verify collection",
      revision: 2,
      status: "active",
      items: [
        { id: "build", status: "completed", evidenceCallIds: ["call-build"] },
        { id: "verify", status: "in_progress" }
      ]
    });
  });

  it("derives terminal status without enforcing evidence yet", async () => {
    const target = controller();
    await target.write({
      objective: "Finish work",
      items: [{ id: "finish", content: "Finish it", status: "in_progress" }]
    }, "turn-1");

    expect((await target.merge({ items: [{ id: "finish", status: "completed" }] })).status).toBe("completed");
  });

  it("distinguishes an abandoned all-cancelled plan from completed work", async () => {
    const target = controller();
    const blocker = { kind: "external_state" as const, summary: "The target was withdrawn." };
    const plan = await target.write({
      objective: "Work that is no longer needed",
      items: [{ id: "stop", content: "Stop the work", status: "cancelled", blocker }]
    }, "turn-1");

    expect(plan.status).toBe("abandoned");
  });

  it("rejects invalid state without mutating the previous plan", async () => {
    const target = controller();
    await target.write({
      objective: "Safe objective",
      items: [{ id: "first", content: "First", status: "in_progress" }]
    }, "turn-1");

    await expect(target.merge({
      items: [{ id: "second", content: "Second", status: "in_progress" }]
    })).rejects.toThrow("Only one plan item may be in_progress");
    expect(target.current()?.items).toHaveLength(1);
    expect(target.current()?.revision).toBe(1);
  });

  it("requires reasons for blocked and cancelled items", async () => {
    const target = controller();
    await expect(target.write({
      objective: "Blocked work",
      items: [{ id: "blocked", content: "Blocked", status: "blocked" }]
    }, "turn-1")).rejects.toThrow("requires a blocker reason");
  });

  it("enforces item count, stable IDs, and merge preconditions", async () => {
    const target = controller();
    await expect(target.merge({ items: [{ id: "missing", status: "completed" }] })).rejects.toThrow(
      "Call plan with operation=write first"
    );
    await expect(target.write({
      objective: "Too many",
      items: Array.from({ length: EXECUTION_PLAN_MAX_ITEMS + 1 }, (_, index) => ({
        id: `item-${index}`,
        content: `Item ${index}`
      }))
    }, "turn-1")).rejects.toThrow(`at most ${EXECUTION_PLAN_MAX_ITEMS} items`);
    await expect(target.write({
      objective: "Bad ID",
      items: [{ id: "bad id", content: "Bad" }]
    }, "turn-1")).rejects.toThrow(ExecutionPlanValidationError);
  });
});
