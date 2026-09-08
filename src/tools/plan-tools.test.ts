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

  it("supports lightweight write, read, and merge snapshots", async () => {
    const emitted: string[] = [];
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const write = await tool.run({
      operation: "write",
      objective: "Test APIs",
      items: [{ id: "inspect", content: "Inspect APIs", status: "in_progress" }]
    }, { visibleTurnId: "turn-1", onEvent: (event) => { emitted.push(event.kind); } });
    const merge = await tool.run({
      operation: "merge",
      items: [{ id: "inspect", content: "Inspect APIs", status: "completed" }]
    }, { onEvent: (event) => { emitted.push(event.kind); } });
    const read = await tool.run({ operation: "read" });

    expect(write.ok).toBe(true);
    expect(JSON.parse(write.content)).toMatchObject({ revision: 1, status: "active" });
    expect(JSON.parse(merge.content)).toMatchObject({
      revision: 2,
      status: "completed",
      items: [{ id: "inspect", content: "Inspect APIs", status: "completed" }]
    });
    expect(read.content).toBe(merge.content);
    expect(emitted).toEqual(["execution-plan-started", "execution-plan-completed"]);
  });

  it("uses the first step as the optional objective fallback", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const result = await tool.run({
      operation: "write",
      items: [{ id: "inspect", content: "Inspect APIs", status: "pending" }]
    }, { visibleTurnId: "turn-1" });

    expect(result.ok).toBe(true);
    expect(controller.current()?.objective).toBe("Inspect APIs");
  });

  it("returns structured errors instead of throwing", async () => {
    const tool = createPlanTools({ controller: new ExecutionPlanController(new ExecutionPlanStore()) })[0]!;

    await expect(tool.run({
      operation: "write",
      items: [{ id: "one", content: "One", status: "pending" }]
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      metadata: { error: "missing-origin-turn" }
    }));
    await expect(tool.run({
      operation: "merge",
      items: [{ id: "one", content: "One", status: "completed" }]
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      metadata: { error: "invalid-plan" }
    }));
  });

  it("rejects duplicate step ids without mutating Plan state", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const tool = createPlanTools({ controller })[0]!;
    const result = await tool.run({
      operation: "write",
      items: [
        { id: "same", content: "First", status: "pending" },
        { id: "same", content: "Second", status: "pending" }
      ]
    }, { visibleTurnId: "turn-duplicate" });

    expect(result).toMatchObject({ ok: false, metadata: { error: "invalid-plan" } });
    expect(controller.current()).toBeUndefined();
  });

  it("exposes only id, content, and status as step fields", () => {
    const tools = createPlanTools({ controller: new ExecutionPlanController(new ExecutionPlanStore()) });
    const schema = JSON.stringify(tools[0]!.inputSchema);

    expect(tools[0]).toMatchObject({
      name: "plan",
      riskClass: "read-only-local",
      toolsets: ["core"],
      maxResultSizeChars: 8192
    });
    expect(tools[0]!.description).toContain("Ordinary execution does not require a Plan");
    expect(schema).toContain('"enum":["read","write","merge"]');
    expect(schema).toContain('"required":["id","content","status"]');
    expect(schema).not.toContain("requirements");
    expect(schema).not.toContain("evidenceCallIds");
    expect(schema).not.toContain("completionKind");
    expect(schema).not.toContain("blocker");
    expect(schema).not.toContain("protectedSource");
    expect(schema).not.toContain("capabilityPreflight");
  });
});
