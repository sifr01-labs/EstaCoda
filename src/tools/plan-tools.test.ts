import { describe, expect, it } from "vitest";
import { ExecutionPlanController } from "../runtime/execution-plan-controller.js";
import { ExecutionPlanStore } from "../runtime/execution-plan-store.js";
import { createPlanTools, planToolProvider } from "./plan-tools.js";
import { ExecutionEvidenceIndex } from "../runtime/execution-evidence-index.js";

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
    const emitted: string[] = [];
    const evidence = new ExecutionEvidenceIndex();
    evidence.record({
      tool: { name: "test.tool", description: "test", inputSchema: {}, riskClass: "read-only-local", toolsets: ["core"], progressLabel: "test", maxResultSizeChars: 100 },
      decision: "allow",
      riskClass: "read-only-local",
      toolCallId: "call-1",
      result: { ok: true, content: "done" }
    });
    const controller = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    const tool = createPlanTools({ controller })[0]!;
    const write = await tool.run({
      operation: "write",
      objective: "Test APIs",
      items: [{ id: "inspect", content: "Inspect APIs", status: "in_progress" }]
    }, { visibleTurnId: "turn-1", onEvent: (event) => { emitted.push(event.kind); } });
    const merge = await tool.run({
      operation: "merge",
      items: [{ id: "inspect", status: "completed", evidenceCallIds: ["call-1"] }]
    }, { onEvent: (event) => { emitted.push(event.kind); } });
    const read = await tool.run({ operation: "read" });

    expect(write.ok).toBe(true);
    expect(JSON.parse(write.content)).toMatchObject({ revision: 1, status: "active" });
    expect(JSON.parse(merge.content)).toMatchObject({ revision: 2, status: "completed" });
    expect(read.content).toBe(merge.content);
    expect(emitted).toEqual(["execution-plan-started", "execution-plan-completed"]);
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

  it("repairs invalid completion metadata and preserves the model-authored Mission", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const result = await tool.run({
      operation: "write",
      objective: "Configure five MTN product steps in Postman",
      items: [
        { id: "inspect", content: "Inspect the approved MTN app", status: "in_progress", completionKind: "reasoning" },
        { id: "products", content: "Identify MTN products", status: "pending", completionKind: "reasoning" },
        { id: "postman", content: "Inspect Postman", status: "pending", completionKind: "reasoning" },
        { id: "update", content: "Update Postman collection", status: "pending", completionKind: "reasoning" },
        { id: "verify", content: "Verify Postman collection", status: "pending", completionKind: "reasoning" }
      ]
    }, { visibleTurnId: "turn-mtn" });

    expect(result.ok).toBe(true);
    expect(result.metadata?.repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "update", field: "completionKind" })
    ]));
    expect(controller.current()).toMatchObject({
      objective: "Configure five MTN product steps in Postman",
      originTurnId: "turn-mtn",
      status: "active",
      items: [
        { id: "inspect", status: "in_progress" },
        { id: "products", status: "pending" },
        { id: "postman", status: "pending" },
        { id: "update", status: "pending" },
        { id: "verify", status: "pending" }
      ]
    });
    expect(JSON.stringify(controller.current())).not.toContain("completionKind");
    expect(JSON.stringify(controller.current())).not.toContain("evidenceCallIds");
  });

  it("keeps structurally invalid Mission writes rejected", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const duplicate = await tool.run({
      operation: "write",
      objective: "Duplicate plan",
      items: [
        { id: "same", content: "First" },
        { id: "same", content: "Second" }
      ]
    }, { visibleTurnId: "turn-duplicate" });

    expect(duplicate).toMatchObject({ ok: false, metadata: { error: "invalid-plan" } });
    expect(controller.current()).toBeUndefined();
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
