import { describe, expect, it } from "vitest";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { narrowProviderToolsForTurn } from "./provider-tool-narrowing.js";

function tool(
  name: string,
  toolsets: ToolsetName[],
  connector?: ToolDefinition["connector"]
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets,
    ...(connector === undefined ? {} : { connector }),
    progressLabel: name,
    maxResultSizeChars: 1_000
  };
}

const tools = [
  tool("plan", ["core"]),
  tool("task.status", ["core"]),
  tool("file.read", ["files"]),
  tool("browser.snapshot", ["browser"]),
  tool("vision.analyze", ["media"]),
  tool("web.extract", ["web"]),
  tool("mcp.postman.getCollection", ["mcp"], { kind: "mcp", id: "postman" }),
  tool("mcp.postman.updateCollection", ["mcp"], { kind: "mcp", id: "postman" }),
  tool("workspaces.list", ["mcp"], { kind: "mcp", id: "linear-cloud" }),
  tool("terminal.inspect", ["shell-readonly"])
];

function intent(confidence: number, suggestedToolsets: ToolsetName[] = []): IntentRoute {
  return {
    nativeIntent: "general",
    labels: ["test"],
    confidence,
    suggestedToolsets,
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test"
  };
}

function names(result: ReturnType<typeof narrowProviderToolsForTurn>): string[] {
  return result.map((schema) => schema.function.name);
}

describe("narrowProviderToolsForTurn", () => {
  it("keeps the wider resolved inventory for low-confidence routing", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(narrowProviderToolsForTurn({ catalog, intent: intent(0.69) })).toBe(catalog.tools);
  });

  it("narrows low-confidence turns to an explicitly named configured connector", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Add these requests to Postman."
    }))).toEqual([
      "plan",
      "task_status",
      "mcp_postman_getCollection",
      "mcp_postman_updateCollection"
    ]);
  });

  it("uses connector provenance even when MCP tools have custom prefixes", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.4),
      userText: "Use Linear Cloud to inspect the workspaces."
    }))).toEqual([
      "plan",
      "task_status",
      "workspaces_list"
    ]);
  });

  it("retains the broad catalog for negated or weak connector references", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...tools,
        tool("generic.request", ["mcp"], { kind: "mcp", id: "api" })
      ]
    });

    expect(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Do not use Postman for this API request."
    })).toBe(catalog.tools);
    expect(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Call the API and summarize the response."
    })).toBe(catalog.tools);
  });

  it("retains the broad catalog when configured connector identities normalize ambiguously", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...tools,
        tool("crm.first", ["mcp"], { kind: "mcp", id: "sales-force" }),
        tool("crm.second", ["mcp"], { kind: "mcp", id: "sales force" })
      ]
    });

    expect(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Use Sales Force for this."
    })).toBe(catalog.tools);
  });

  it("includes every distinctly named connector in a cross-connector request", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.4),
      userText: "Read the Linear Cloud workspace and add the result to Postman."
    }));
    expect(selected).toContain("workspaces_list");
    expect(selected).toContain("mcp_postman_updateCollection");
    expect(selected).not.toContain("browser_snapshot");
  });

  it("does not let a generic MCP toolset widen an explicit connector selection", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });
    const skill: SkillDefinition = {
      name: "Collection management",
      description: "test",
      version: "1",
      whenToUse: [],
      requiredToolsets: ["mcp"],
      optionalToolsets: [],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.9, ["mcp"]),
      userText: "Use Postman for the collection.",
      selectedSkill: skill
    }));
    expect(selected).toContain("mcp_postman_getCollection");
    expect(selected).not.toContain("workspaces_list");
  });

  it("narrows at the deterministic high-confidence routing threshold", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({ catalog, intent: intent(0.7) }))).toEqual([
      "plan",
      "task_status"
    ]);
  });

  it("exposes only core and browser tools for high-confidence browser control", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });
    const browserIntent: IntentRoute = {
      ...intent(0.95, ["browser"]),
      nativeIntent: "browser-control",
      labels: ["browser-control", "authentication"]
    };

    expect(names(narrowProviderToolsForTurn({ catalog, intent: browserIntent }))).toEqual([
      "plan",
      "task_status",
      "browser_snapshot"
    ]);
  });

  it("includes core, plan, routed, required, and available optional toolsets", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });
    const skill: SkillDefinition = {
      name: "Postman",
      description: "test",
      version: "1",
      whenToUse: [],
      requiredToolsets: ["mcp"],
      optionalToolsets: ["browser", "missing-toolset"],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.9, ["files"]),
      selectedSkill: skill
    }))).toEqual([
      "plan",
      "task_status",
      "file_read",
      "browser_snapshot",
      "mcp_postman_getCollection",
      "mcp_postman_updateCollection",
      "workspaces_list"
    ]);
  });

  it("keeps attachment-required tools without exposing unrelated toolsets", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });
    const attachments: ChannelAttachment[] = [{
      id: "image-1",
      kind: "image",
      status: "ready",
      localPath: "/media/image.png"
    }];

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.85),
      attachments
    }));
    expect(selected).toContain("vision_analyze");
    expect(selected).toContain("file_read");
    expect(selected).not.toContain("web_extract");
    expect(selected).not.toContain("mcp_postman_getCollection");
  });

  it("cannot reintroduce tools excluded from the resolved catalog", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: tools.filter((entry) => entry.name !== "mcp.postman.updateCollection")
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.9, ["mcp"])
    }))).not.toContain("mcp_postman_updateCollection");
  });

});
