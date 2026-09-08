import { describe, expect, it } from "vitest";
import {
  EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS,
  EXECUTION_PLAN_MAX_ITEMS,
  type ExecutionPlanWriteInput
} from "../contracts/execution-plan.js";
import { repairExecutionPlanWriteInput } from "./execution-plan-repair.js";

describe("repairExecutionPlanWriteInput", () => {
  it("repairs the five-step MTN and Postman proposal without losing its structure", () => {
    const proposal: ExecutionPlanWriteInput = {
      objective: "Configure the approved MTN products in Postman and verify them",
      items: [
        { id: "inspect", content: "Inspect the approved MTN app", status: "in_progress", completionKind: "reasoning" },
        { id: "products", content: "Identify the enabled MTN products", status: "pending", completionKind: "reasoning" },
        { id: "collection", content: "Inspect the Postman collection", status: "pending", completionKind: "reasoning" },
        { id: "update", content: "Update the Postman collection", status: "pending", completionKind: "reasoning" },
        { id: "verify", content: "Verify all collection changes", status: "pending", completionKind: "reasoning" }
      ]
    };

    const repaired = repairExecutionPlanWriteInput(proposal);

    expect(repaired?.plan.objective).toBe(proposal.objective);
    expect(repaired?.plan.items.map(({ id, content, status }) => ({ id, content, status }))).toEqual(
      proposal.items.map(({ id, content, status }) => ({ id, content, status }))
    );
    expect(repaired?.plan.items.every((item) => item.completionKind === undefined)).toBe(true);
    expect(repaired?.plan.items.every((item) => item.evidenceCallIds === undefined)).toBe(true);
    expect(repaired?.repairs).toHaveLength(5);
    expect(repaired?.repairs).toContainEqual({
      itemId: "update",
      field: "completionKind",
      reason: "Completion metadata applies only to completed items"
    });
  });

  it("keeps only the first in-progress item and starts the first pending item when needed", () => {
    const multiple = repairExecutionPlanWriteInput({
      objective: "Do the work",
      items: [
        { id: "one", content: "First", status: "in_progress" },
        { id: "two", content: "Second", status: "in_progress" }
      ]
    });
    const none = repairExecutionPlanWriteInput({
      objective: "Do the work",
      items: [
        { id: "one", content: "First", status: "pending" },
        { id: "two", content: "Second", status: "pending" }
      ]
    });

    expect(multiple?.plan.items.map((item) => item.status)).toEqual(["in_progress", "pending"]);
    expect(none?.plan.items.map((item) => item.status)).toEqual(["in_progress", "pending"]);
  });

  it("does not manufacture evidence and leaves a correct proposal unchanged", () => {
    const proposal: ExecutionPlanWriteInput = {
      objective: "Explain then execute",
      items: [
        { id: "explain", content: "Explain the approach", status: "completed", completionKind: "reasoning" },
        { id: "execute", content: "Execute the approved work", status: "in_progress" }
      ]
    };

    const repaired = repairExecutionPlanWriteInput(proposal);

    expect(repaired).toEqual({ plan: proposal, repairs: [] });
    expect(JSON.stringify(repaired)).not.toContain("evidenceCallIds");
  });

  it("demotes a consequential reasoning completion instead of accepting unproven work", () => {
    const repaired = repairExecutionPlanWriteInput({
      objective: "Update Postman",
      items: [{
        id: "update",
        content: "Update the Postman collection",
        status: "completed",
        completionKind: "reasoning"
      }]
    });

    expect(repaired?.plan.items).toEqual([{
      id: "update",
      content: "Update the Postman collection",
      status: "in_progress"
    }]);
    expect(repaired?.repairs).toEqual([
      {
        itemId: "update",
        field: "completionKind",
        reason: "Consequential work requires tool evidence"
      },
      {
        itemId: "update",
        field: "status",
        reason: "Consequential completion has no harness evidence"
      },
      {
        itemId: "update",
        field: "status",
        reason: "An active Mission needs one current item"
      }
    ]);
    expect(JSON.stringify(repaired)).not.toContain("evidenceCallIds");
  });

  it("refuses structural repair for duplicate, oversized, and malformed proposals", () => {
    expect(repairExecutionPlanWriteInput({
      objective: "Duplicates",
      items: [
        { id: "same", content: "First" },
        { id: "same", content: "Second" }
      ]
    })).toBeUndefined();
    expect(repairExecutionPlanWriteInput({
      objective: "Too many",
      items: Array.from({ length: EXECUTION_PLAN_MAX_ITEMS + 1 }, (_, index) => ({
        id: `item-${index}`,
        content: `Item ${index}`
      }))
    })).toBeUndefined();
    expect(repairExecutionPlanWriteInput({
      objective: "Oversized serialized input",
      items: Array.from({ length: EXECUTION_PLAN_MAX_ITEMS }, (_, index) => ({
        id: `item-${index}`,
        content: `Item ${index}`,
        status: "pending" as const,
        evidenceCallIds: Array.from(
          { length: EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS },
          (__, evidenceIndex) => `${index}-${evidenceIndex}-${"x".repeat(240)}`
        )
      }))
    })).toBeUndefined();
    expect(repairExecutionPlanWriteInput({
      objective: "Malformed",
      items: [{ id: "bad id", content: "Bad" }]
    })).toBeUndefined();
  });
});
