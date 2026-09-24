import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolRiskClass } from "../contracts/tool.js";
import { budgetProviderTools, buildProviderToolSchemaCatalog, MAX_PROVIDER_SCHEMA_TOKENS } from "./tool-schema.js";

function tool(name: string, riskClass: ToolRiskClass = "read-only-local"): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    riskClass,
    toolsets: ["test"],
    progressLabel: name,
    maxResultSizeChars: 1_000,
  };
}

describe("buildProviderToolSchemaCatalog", () => {
  it("selects up to one hundred eligible tools by default", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: Array.from({ length: 105 }, (_, index) => tool(`test.tool.${index + 1}`)),
    });

    expect(catalog.entries).toHaveLength(105);
    expect(catalog.tools).toHaveLength(100);
    expect([...catalog.aliases.values()]).toContain("test.tool.100");
    expect([...catalog.aliases.values()]).toContain("test.tool.101");
  });

  it("excludes blocked risk classes from provider tool schemas", () => {
    const blockedRisks: ToolRiskClass[] = [
      "credential-access",
      "destructive-local",
      "sandbox-escape",
      "spend-money",
    ];
    const blockedTools = blockedRisks.map((riskClass) => tool(`blocked.${riskClass}`, riskClass));
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...blockedTools,
        ...Array.from({ length: 100 }, (_, index) => tool(`allowed.tool.${index + 1}`)),
      ],
    });
    const selectedToolNames = [...catalog.aliases.values()];

    expect(catalog.tools).toHaveLength(100);
    for (const blockedTool of blockedTools) {
      expect(selectedToolNames).not.toContain(blockedTool.name);
      expect(catalog.entries.map((entry) => entry.tool.name)).not.toContain(blockedTool.name);
    }
  });

  it("retains canonical metadata beside each provider-safe schema", () => {
    const source = {
      ...tool("mcp.postman.getCollection"),
      toolsets: ["mcp", "research"]
    };
    const catalog = buildProviderToolSchemaCatalog({ tools: [source] });

    expect(catalog.entries).toEqual([{
      tool: source,
      schema: catalog.tools[0]
    }]);
    expect(catalog.entries[0]?.schema.function.name).toBe("mcp_postman_getCollection");
    expect(catalog.aliases.get("mcp_postman_getCollection")).toBe(source.name);
  });
});


describe("provider schema budgets", () => {
  it("retains unavailable metadata without schemas or aliases", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [], unavailableTools: [tool("web.search")] });
    expect(catalog.entries).toEqual([]);
    expect(catalog.aliases.size).toBe(0);
    expect(catalog.inventory).toEqual([expect.objectContaining({ name: "web.search", availability: "temporarily_unavailable" })]);
    expect(catalog.inventory[0]).not.toHaveProperty("inputSchema");
  });

  it("prioritizes requirements and skips an oversized schema within both bounds", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [
      { ...tool("huge"), description: "x".repeat(MAX_PROVIDER_SCHEMA_TOKENS * 4) },
      ...Array.from({ length: 105 }, (_, i) => tool(`read.${i}`)), tool("file.write")
    ] });
    const budget = budgetProviderTools({ tools: catalog.entries.map((entry) => entry.schema), priorityNames: new Set(["file_write"]) });
    expect(budget.tools).toHaveLength(100);
    expect(budget.tools[0]?.function.name).toBe("file_write");
    expect(budget.omitted).toContain("huge");
    expect(budget.schemaTokens).toBeLessThanOrEqual(MAX_PROVIDER_SCHEMA_TOKENS);
    expect(catalog.entries).toHaveLength(107);
  });
});
