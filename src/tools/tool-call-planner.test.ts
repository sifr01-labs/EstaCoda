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

    expect(planner.planFromProviderDelta(delta).id).toBe(stableToolCallId(delta));
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
    });

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
    });

    expect(plan.status).toBe("planned");
    const serializedTasks = plan.input.tasks;
    expect(typeof serializedTasks).toBe("string");
    expect(JSON.parse(serializedTasks as string)).toEqual([{
      task: "Inspect the repository",
      allowedTools: ["file.read", "invented_tool"]
    }]);
  });
});
