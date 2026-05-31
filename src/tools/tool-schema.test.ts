import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolRiskClass } from "../contracts/tool.js";
import { buildProviderToolSchemaCatalog } from "./tool-schema.js";

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

    expect(catalog.tools).toHaveLength(100);
    expect([...catalog.aliases.values()]).toContain("test.tool.100");
    expect([...catalog.aliases.values()]).not.toContain("test.tool.101");
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
    }
  });
});
