import { describe, expect, it } from "vitest";
import { EXECUTION_PLAN_MAX_ITEMS } from "../contracts/execution-plan.js";
import { ExecutionPlanController, ExecutionPlanValidationError } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

function controller() {
  return new ExecutionPlanController(new ExecutionPlanStore());
}

describe("ExecutionPlanController", () => {
  it("writes a redacted bounded plan and derives active state", () => {
    const target = controller();
    const plan = target.write({
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

  it("merges existing items, appends new items, and increments revision", () => {
    const target = controller();
    target.write({
      objective: "Build collection",
      items: [{ id: "build", content: "Build it", status: "in_progress" }]
    }, "turn-1");

    const plan = target.merge({
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

  it("derives terminal status without enforcing evidence yet", () => {
    const target = controller();
    target.write({
      objective: "Finish work",
      items: [{ id: "finish", content: "Finish it", status: "in_progress" }]
    }, "turn-1");

    expect(target.merge({ items: [{ id: "finish", status: "completed" }] }).status).toBe("completed");
  });

  it("distinguishes an abandoned all-cancelled plan from completed work", () => {
    const target = controller();
    const blocker = { kind: "external_state" as const, summary: "The target was withdrawn." };
    const plan = target.write({
      objective: "Work that is no longer needed",
      items: [{ id: "stop", content: "Stop the work", status: "cancelled", blocker }]
    }, "turn-1");

    expect(plan.status).toBe("abandoned");
  });

  it("rejects invalid state without mutating the previous plan", () => {
    const target = controller();
    target.write({
      objective: "Safe objective",
      items: [{ id: "first", content: "First", status: "in_progress" }]
    }, "turn-1");

    expect(() => target.merge({
      items: [{ id: "second", content: "Second", status: "in_progress" }]
    })).toThrow("Only one plan item may be in_progress");
    expect(target.current()?.items).toHaveLength(1);
    expect(target.current()?.revision).toBe(1);
  });

  it("requires reasons for blocked and cancelled items", () => {
    const target = controller();
    expect(() => target.write({
      objective: "Blocked work",
      items: [{ id: "blocked", content: "Blocked", status: "blocked" }]
    }, "turn-1")).toThrow("requires a blocker reason");
  });

  it("enforces item count, stable IDs, and merge preconditions", () => {
    const target = controller();
    expect(() => target.merge({ items: [{ id: "missing", status: "completed" }] })).toThrow(
      "Call plan with operation=write first"
    );
    expect(() => target.write({
      objective: "Too many",
      items: Array.from({ length: EXECUTION_PLAN_MAX_ITEMS + 1 }, (_, index) => ({
        id: `item-${index}`,
        content: `Item ${index}`
      }))
    }, "turn-1")).toThrow(`at most ${EXECUTION_PLAN_MAX_ITEMS} items`);
    expect(() => target.write({
      objective: "Bad ID",
      items: [{ id: "bad id", content: "Bad" }]
    }, "turn-1")).toThrow(ExecutionPlanValidationError);
  });
});
