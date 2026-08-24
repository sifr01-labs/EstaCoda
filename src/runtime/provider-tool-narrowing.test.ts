import { describe, expect, it } from "vitest";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { narrowProviderToolsForTurn, selectProviderToolsForTurn } from "./provider-tool-narrowing.js";

function tool(
  name: string,
  toolsets: ToolsetName[],
  connector?: ToolDefinition["connector"],
  riskClass: ToolDefinition["riskClass"] = "read-only-local"
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    riskClass,
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
  tool("browser.click", ["browser"]),
  tool("browser.tabs", ["browser"]),
  tool("browser.switch_tab", ["browser"]),
  tool("vision.analyze", ["media"]),
  tool("web.extract", ["web"]),
  tool("mcp.postman.getCollection", ["mcp"], { kind: "mcp", id: "postman" }),
  tool("mcp.postman.updateCollection", ["mcp"], { kind: "mcp", id: "postman" }),
  tool("workspaces.list", ["mcp"], { kind: "mcp", id: "linear-cloud" }),
  tool("terminal.inspect", ["shell-readonly"])
];

function intent(
  confidence: number,
  suggestedToolsets: ToolsetName[] = [],
  taskClass?: IntentRoute["taskClass"]
): IntentRoute {
  return {
    nativeIntent: "general",
    taskClass,
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
  it("uses a small bounded policy for low-confidence routing", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = narrowProviderToolsForTurn({ catalog, intent: intent(0.35) });
    expect(names(selected)).toEqual(["file_read", "web_extract"]);
    expect(selected.length).toBeLessThan(catalog.tools.length);
  });

  it("exposes zero tools for a clearly conversational turn", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "conversation"),
      userText: "hello"
    })).toEqual([]);
  });

  it("narrows low-confidence turns to an explicitly named configured connector", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Add these requests to Postman."
    }))).toEqual([
      "mcp_postman_getCollection",
      "mcp_postman_updateCollection"
    ]);
  });

  it("keeps browser actions beside Postman for a deictic action in an active browser", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "okay great - now i want you to click on the tiktok connect app shown there. i want you to get all 6 products set up in our postman collection.",
      continuity: { activeBrowser: true }
    }));

    expect(selected).toEqual(expect.arrayContaining([
      "browser_snapshot",
      "browser_click",
      "browser_tabs",
      "browser_switch_tab",
      "mcp_postman_getCollection",
      "mcp_postman_updateCollection"
    ]));
    expect(selected).not.toContain("workspaces_list");
  });

  it("does not infer browser continuity without an active browser", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "click on the app shown there and update Postman",
      continuity: { activeBrowser: false }
    }));

    expect(selected).toContain("mcp_postman_updateCollection");
    expect(selected).not.toContain("browser_click");
  });

  it("preserves bounded browser and connector context for an open continuation", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.95, ["browser"]),
      userText: "let's do this",
      continuity: {
        userRequest: "Set up the app key and secret in Postman.",
        toolsets: ["browser"],
        connectors: [{ kind: "mcp", id: "postman" }],
        activeBrowser: true
      }
    }));

    expect(selected).toEqual(expect.arrayContaining([
      "browser_click",
      "browser_switch_tab",
      "mcp_postman_getCollection",
      "mcp_postman_updateCollection"
    ]));
    expect(selected).not.toContain("workspaces_list");
  });

  it("lets a current negation retire a continued connector", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.95, ["browser"]),
      userText: "Continue in the browser, but do not use Postman.",
      continuity: {
        userRequest: "Update Postman.",
        toolsets: ["browser"],
        connectors: [{ kind: "mcp", id: "postman" }]
      }
    }));

    expect(selected).toContain("browser_click");
    expect(selected).not.toContain("mcp_postman_getCollection");
  });

  it("uses connector provenance even when MCP tools have custom prefixes", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.4),
      userText: "Use Linear Cloud to inspect the workspaces."
    }))).toEqual([
      "workspaces_list"
    ]);
  });

  it("keeps negated or weak connector references on the bounded general policy", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...tools,
        tool("generic.request", ["mcp"], { kind: "mcp", id: "api" })
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Do not use Postman for this API request."
    }))).toEqual(["file_read", "web_extract"]);
    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Call the API and summarize the response."
    }))).toEqual(["file_read", "web_extract"]);
  });

  it("keeps ambiguous connector identities on the bounded general policy", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...tools,
        tool("crm.first", ["mcp"], { kind: "mcp", id: "sales-force" }),
        tool("crm.second", ["mcp"], { kind: "mcp", id: "sales force" })
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Use Sales Force for this."
    }))).toEqual(["file_read", "web_extract"]);
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

  it("does not let confidence control catalog breadth", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const low = names(narrowProviderToolsForTurn({ catalog, intent: intent(0.35) }));
    const high = names(narrowProviderToolsForTurn({ catalog, intent: intent(0.95) }));
    expect(low).toEqual(["file_read", "web_extract"]);
    expect(high).toEqual(low);
  });

  it("exposes only core and browser tools for high-confidence browser control", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });
    const browserIntent: IntentRoute = {
      ...intent(0.95, ["browser"]),
      nativeIntent: "browser-control",
      labels: ["browser-control", "authentication"]
    };

    expect(names(narrowProviderToolsForTurn({ catalog, intent: browserIntent }))).toEqual([
      "browser_snapshot",
      "browser_click",
      "browser_tabs",
      "browser_switch_tab"
    ]);
  });

  it("includes routed and available non-connector skill toolsets without unrelated MCP connectors", () => {
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
      "file_read",
      "browser_snapshot",
      "browser_click",
      "browser_tabs",
      "browser_switch_tab"
    ]);
  });

  it("recognizes configured connectors even when they registered no callable schemas", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: tools.filter((entry) => entry.connector === undefined) });
    const selected = selectProviderToolsForTurn({
      catalog,
      intent: intent(0.4),
      userText: "Import this Swagger spec into Postman.",
      configuredConnectors: [{
        name: "postman",
        transport: "http",
        configured: true,
        enabled: true,
        connected: false,
        schemasRegistered: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        capabilities: {
          protectedDeliveryConfigured: false,
          groupedDeliverySupported: false,
          browserRelaySupported: false,
          artifactRelayConfigured: false,
          resultRedactionConfigured: false,
          continuityConfigured: false,
          verificationConfigured: false
        },
        available: false,
        failureStage: "connection"
      }]
    });

    expect(selected.namedConnectorIds).toEqual(["postman"]);
    expect(selected.initialTools).toEqual([]);
  });

  it("adds the active browser and compact recovery tools for actionable work", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        ...tools,
        tool("browser.status", ["browser", "core"]),
        tool("browser.vision", ["browser"]),
        tool("config.mcp.status", ["core", "mcp"]),
        tool("config.provider.status", ["core", "provider", "diagnostics"]),
        tool("config.provider.execution_status", ["core", "provider", "diagnostics"])
      ]
    });
    const selected = selectProviderToolsForTurn({
      catalog,
      intent: intent(0.7, [], "repo-inspection"),
      userText: "Inspect the current implementation.",
      continuity: { activeBrowser: true }
    });

    expect(names(selected.initialTools)).toEqual(expect.arrayContaining([
      "file_read",
      "terminal_inspect",
      "browser_snapshot",
      "browser_status",
      "config_mcp_status",
      "config_provider_status",
      "config_provider_execution_status"
    ]));
    expect(names(selected.initialTools)).not.toContain("browser_vision");
    expect(selected.expansionCandidates.map((candidate) => candidate.schema.function.name)).toEqual(["browser_vision"]);
    expect(names(selected.initialTools)).not.toContain("workspaces_list");
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

  it("selects a bounded read-only repository policy for repo inspection", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        tool("plan", ["core"]),
        tool("file.read", ["files"]),
        tool("file.write", ["files"], undefined, "workspace-write"),
        tool("file.grep", ["files"]),
        tool("terminal.inspect", ["shell-readonly"]),
        tool("terminal.run", ["shell-write"], undefined, "workspace-write"),
        tool("web.extract", ["web"])
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "repo-inspection"),
      userText: "Inspect the router implementation."
    }))).toEqual(["file_read", "file_grep", "terminal_inspect"]);
  });

  it("selects bounded repository read, write, and validation tools for modification", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        tool("plan", ["core"]),
        tool("file.read", ["files"]),
        tool("file.write", ["files"], undefined, "workspace-write"),
        tool("terminal.run", ["shell-write"], undefined, "workspace-write"),
        tool("browser.click", ["browser"], undefined, "external-side-effect"),
        tool("mcp.postman.updateCollection", ["mcp"], { kind: "mcp", id: "postman" }, "external-side-effect")
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "repo-change"),
      userText: "Implement the router change and run validation."
    }))).toEqual(["plan", "file_read", "file_write", "terminal_run"]);
  });

  it("selects only registered provider, configuration, and diagnostic tools for provider failures", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        tool("plan", ["core"]),
        tool("config.provider.status", ["core", "provider", "diagnostics"]),
        tool("config.provider.execution_status", ["core", "provider", "diagnostics"]),
        tool("config.provider.setup", ["core", "provider", "configuration"], undefined, "shared-state-mutation"),
        tool("file.read", ["files"]),
        tool("workspaces.list", ["mcp"], { kind: "mcp", id: "linear-cloud" })
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "provider-diagnostics"),
      userText: "Diagnose why Kimi keeps failing."
    }))).toEqual([
      "config_provider_status",
      "config_provider_execution_status",
      "config_provider_setup"
    ]);
  });

  it("does not activate a named connector for educational mention alone", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "conversation"),
      userText: "Explain how Postman environments work."
    }));
    expect(selected).toEqual([]);
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
