import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../contracts/tool.js";
import { stableToolCallId, ToolCallPlanner } from "./tool-call-planner.js";
import { ToolRegistry } from "./tool-registry.js";
import { buildProviderToolSchemaCatalog } from "./tool-schema.js";

const testTool: ToolDefinition = {
  name: "test.tool",
  description: "Test tool",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["test"],
  progressLabel: "testing",
  maxResultSizeChars: 1000
};

describe("stableToolCallId", () => {
  it("generates deterministic IDs from provider tool-call deltas", () => {
    const delta = {
      index: 0,
      name: "test.tool",
      argumentsText: "{\"path\":\"src/index.ts\"}"
    };

    expect(stableToolCallId(delta)).toBe(stableToolCallId(delta));
    expect(stableToolCallId(delta)).toMatch(/^tool-call-[a-f0-9]{16}$/u);
  });

  it("uses the same generated ID as ToolCallPlanner for missing provider IDs", () => {
    const registry = new ToolRegistry();
    registry.register({
      ...testTool,
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "ok" })
    });
    const planner = new ToolCallPlanner({ registry });
    const delta = {
      index: 1,
      name: "test.tool",
      argumentsText: "{\"query\":\"docs\"}"
    };

    expect(planner.planFromProviderDelta(delta, new Set(["test.tool"])).id).toBe(stableToolCallId(delta));
  });

  it("canonicalizes provider aliases nested in delegate_task tool allowlists", () => {
    const registry = new ToolRegistry();
    const delegateTool = {
      ...testTool,
      name: "delegate_task",
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "ok" })
    };
    registry.register(delegateTool);
    const providerCatalog = buildProviderToolSchemaCatalog({
      tools: [
        delegateTool,
        ...[
          "file.glob",
          "file.grep",
          "file.read",
          "terminal.inspect",
          "knowledge.code.query",
          "web.search"
        ].map((name) => ({ ...testTool, name }))
      ]
    });
    const planner = new ToolCallPlanner({ registry, aliases: providerCatalog.aliases });

    expect(providerCatalog.tools.map((tool) => tool.function.name)).toEqual([
      "delegate_task",
      "file_glob",
      "file_grep",
      "file_read",
      "terminal_inspect",
      "knowledge_code_query",
      "web_search"
    ]);

    const plan = planner.planFromProviderDelta({
      id: "hermes-delegation-call",
      name: "delegate_task",
      argumentsText: JSON.stringify({
        allowedTools: ["web_search"],
        tasks: [{
          task: "Inspect the repository",
          allowedTools: [
            "file_glob",
            "file_grep",
            "file_read",
            "terminal_inspect",
            "knowledge_code_query"
          ]
        }]
      })
    }, new Set(["delegate_task", "plan"]));

    expect(plan).toMatchObject({
      status: "planned",
      input: {
        allowedTools: ["web.search"],
        tasks: [{
          task: "Inspect the repository",
          allowedTools: [
            "file.glob",
            "file.grep",
            "file.read",
            "terminal.inspect",
            "knowledge.code.query"
          ]
        }]
      }
    });
  });

  it("canonicalizes recovered JSON task aliases and preserves unknown names for fail-closed admission", () => {
    const registry = new ToolRegistry();
    registry.register({
      ...testTool,
      name: "delegate_task",
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "ok" })
    });
    const planner = new ToolCallPlanner({
      registry,
      aliases: new Map([
        ["delegate_task", "delegate_task"],
        ["file_read", "file.read"]
      ])
    });

    const plan = planner.planFromProviderDelta({
      name: "delegate_task",
      argumentsText: JSON.stringify({
        tasks: JSON.stringify([{
          task: "Inspect the repository",
          allowedTools: ["file_read", "invented_tool"]
        }])
      })
    }, new Set(["delegate_task", "plan"]));

    expect(plan.status).toBe("planned");
    const serializedTasks = plan.input.tasks;
    expect(typeof serializedTasks).toBe("string");
    expect(JSON.parse(serializedTasks as string)).toEqual([{
      task: "Inspect the repository",
      allowedTools: ["file.read", "invented_tool"]
    }]);
  });

  it("canonicalizes session-visible provider aliases in Mission requirements", () => {
    const registry = new ToolRegistry();
    const definitions = [
      { ...testTool, name: "plan" },
      { ...testTool, name: "mcp.target.read" },
      { ...testTool, name: "mcp.target.update" }
    ];
    for (const definition of definitions) {
      registry.register({
        ...definition,
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "ok" })
      });
    }
    const catalog = buildProviderToolSchemaCatalog({ tools: definitions });
    const planner = new ToolCallPlanner({ registry, aliases: catalog.aliases });

    const planned = planner.planFromProviderDelta({
      id: "plan-requirements",
      name: "plan",
      argumentsText: JSON.stringify({
        operation: "write",
        objective: "Update target",
        items: [{ id: "update", content: "Update", status: "in_progress" }],
        requirements: [
          { id: "read", itemId: "update", tool: "mcp_target_read", capability: "read" },
          { id: "mutate", itemId: "update", tool: "mcp_target_update", capability: "mutate" },
          { id: "verify", itemId: "update", tool: "mcp.target.read", capability: "verify" }
        ]
      })
    }, new Set(["delegate_task", "plan"]));

    expect(planned).toMatchObject({
      status: "planned",
      input: {
        requirements: [
          { id: "read", tool: "mcp.target.read" },
          { id: "mutate", tool: "mcp.target.update" },
          { id: "verify", tool: "mcp.target.read" }
        ]
      }
    });
  });

  it("rejects unavailable and ambiguous Mission requirement tool names before execution", () => {
    const registry = new ToolRegistry();
    const definitions = [
      { ...testTool, name: "plan" },
      { ...testTool, name: "file.read" },
      { ...testTool, name: "file_read" }
    ];
    for (const definition of definitions) {
      registry.register({
        ...definition,
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "ok" })
      });
    }
    const catalog = buildProviderToolSchemaCatalog({ tools: definitions });
    const planner = new ToolCallPlanner({ registry, aliases: catalog.aliases });
    const call = (tool: string) => planner.planFromProviderDelta({
      name: "plan",
      argumentsText: JSON.stringify({
        operation: "write",
        requirements: [{ id: "read", itemId: "read", tool, capability: "read" }]
      })
    }, new Set(["delegate_task", "plan"]));

    expect(call("invented_tool")).toMatchObject({
      status: "invalid",
      error: expect.stringContaining("unavailable tool")
    });
    expect(call("file_read")).toMatchObject({ status: "planned", input: { requirements: [{ tool: "file_read" }] } });
    expect(call("mcp.unavailable.mutate")).toMatchObject({
      status: "planned",
      input: {
        requirements: [{ tool: "mcp.unavailable.mutate" }]
      }
    });
  });
});


describe("active native exposure", () => {
  it("rejects hidden aliases, canonical bypasses and unknown probes identically", () => {
    const registry = new ToolRegistry();
    for (const name of ["file.read", "file.write"]) registry.register({ ...testTool, name,
      isAvailable: () => true, run: async () => ({ ok: true, content: "ok" }) });
    const catalog = buildProviderToolSchemaCatalog({ tools: registry.list() });
    const planner = new ToolCallPlanner({ registry, aliases: catalog.aliases });
    const exposed = new Set(["file_read"]);
    for (const name of ["file_write", "file.write", "unknown.tool"]) {
      expect(planner.planFromProviderDelta({ name, argumentsText: "{}" }, exposed)).toMatchObject({
        status: "unavailable", error: "Tool is not exposed for this provider iteration."
      });
    }
    expect(planner.planFromProviderDelta({ name: "file_read", argumentsText: "{}" })).toMatchObject({ status: "unavailable" });
    expect(planner.planFromProviderDelta({ name: "file.read", argumentsText: "{}" }, exposed)).toMatchObject({ status: "planned" });
    expect(planner.planFromProviderDelta({ name: "file_write", argumentsText: "{}" }, new Set(["file_write"]))).toMatchObject({ status: "planned", tool: "file.write" });
    // A later exposure does not authorize a call against the old batch snapshot.
    expect(planner.planFromProviderDelta({ name: "file_write", argumentsText: "{}" }, exposed).status).toBe("unavailable");
  });

  it.each([false, true])("rejects ambiguous delegated aliases (serialized=%s)", (serialized) => {
    const registry = new ToolRegistry();
    registry.register({ ...testTool, name: "delegate_task", isAvailable: () => true, run: async () => ({ ok: true, content: "ok" }) });
    const planner = new ToolCallPlanner({ registry, aliases: new Map([["file_read", "file.read"], ["file_read_2", "file_read"]]) });
    const tasks = [{ task: "read", allowedTools: ["file_read"] }];
    expect(planner.planFromProviderDelta({ name: "delegate_task", argumentsText: JSON.stringify({ tasks: serialized ? JSON.stringify(tasks) : tasks }) }, new Set(["delegate_task"]))).toMatchObject({ status: "invalid", error: expect.stringContaining("ambiguous") });
  });
});
