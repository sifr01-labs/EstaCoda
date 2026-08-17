import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";

const plan: ExecutionPlan = {
  objective: "Verify an API collection",
  originTurnId: "turn-1",
  revision: 1,
  status: "active",
  provenance: { source: "runtime", provisional: true, sessionId: "session-1" },
  items: [{ id: "inspect", content: "Inspect the collection", status: "in_progress" }]
};

describe("ExecutionPlanStore", () => {
  it("returns defensive snapshots on replace and read", () => {
    const store = new ExecutionPlanStore();
    const written = store.replace(plan);
    written.items[0]!.content = "mutated outside";
    written.provenance!.provisional = false;
    const firstRead = store.current()!;
    firstRead.items[0]!.status = "completed";
    firstRead.provenance!.sessionId = "another-session";

    expect(store.current()).toEqual(plan);
  });

  it("starts without an active plan", () => {
    expect(new ExecutionPlanStore().current()).toBeUndefined();
  });
});
