import { describe, expect, it } from "vitest";
import { ExecutionPlanController } from "../runtime/execution-plan-controller.js";
import { ExecutionPlanStore } from "../runtime/execution-plan-store.js";
import { createPlanTools, planToolProvider } from "./plan-tools.js";

describe("plan tool", () => {
  it("is absent without a foreground controller", () => {
    expect(createPlanTools({})).toEqual([]);
    expect(planToolProvider.createTools({
      workspaceRoot: "/workspace",
      profileId: "default",
      sessionId: "child",
      currentSessionId: () => "child"
    })).toEqual([]);
  });

  it("supports write, read, and merge with canonical snapshots", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const write = await tool.run({
      operation: "write",
      objective: "Test APIs",
      items: [{ id: "inspect", content: "Inspect APIs", status: "in_progress" }]
    }, { visibleTurnId: "turn-1" });
    const merge = await tool.run({
      operation: "merge",
      items: [{ id: "inspect", status: "completed", evidenceCallIds: ["call-1"] }]
    });
    const read = await tool.run({ operation: "read" });

    expect(write.ok).toBe(true);
    expect(JSON.parse(write.content)).toMatchObject({ revision: 1, status: "active" });
    expect(JSON.parse(merge.content)).toMatchObject({ revision: 2, status: "completed" });
    expect(read.content).toBe(merge.content);
  });

  it("returns structured errors instead of throwing", async () => {
    const tool = createPlanTools({
      controller: new ExecutionPlanController(new ExecutionPlanStore())
    })[0]!;

    await expect(tool.run({
      operation: "write",
      objective: "No turn",
      items: [{ id: "one", content: "One" }]
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      metadata: { error: "missing-origin-turn" }
    }));
    await expect(tool.run({ operation: "merge", items: [{ id: "one", status: "completed" }] })).resolves.toEqual(
      expect.objectContaining({ ok: false, metadata: { error: "invalid-plan" } })
    );
  });

  it("registers as one read-only local core tool", () => {
    const tools = createPlanTools({
      controller: new ExecutionPlanController(new ExecutionPlanStore())
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "plan",
      riskClass: "read-only-local",
      toolsets: ["core"],
      maxResultSizeChars: 8192
    });
  });
});
