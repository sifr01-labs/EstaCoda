import { describe, expect, it } from "vitest";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { describeCapabilitySelection, narrowProviderToolsForTurn, selectProviderToolsForTurn } from "./provider-tool-narrowing.js";

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
  it("keeps available process controls beside an explicitly selected terminal", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [
      tool("process.logs", ["coding"]), tool("process.list", ["coding"]),
      tool("process.stop", ["coding"], undefined, "workspace-write"),
      tool("process.start", ["coding"], undefined, "workspace-write"),
      tool("terminal.run", ["coding"], undefined, "workspace-write"),
      tool("process.input", ["coding"], undefined, "credential-access")
    ] });
    expect(names(narrowProviderToolsForTurn({ catalog, intent: intent(0.35), requiredTools: ["terminal.run"] })))
      .toEqual(expect.arrayContaining(["terminal_run", "process_start", "process_list", "process_logs", "process_stop"]));
    expect(names(narrowProviderToolsForTurn({ catalog, intent: intent(0.35), requiredTools: ["terminal.run"] })))
      .not.toContain("process_input");
    expect(names(narrowProviderToolsForTurn({ catalog, intent: intent(0.35, [], "repo-inspection") })))
      .toContain("process_start");
    const restricted = buildProviderToolSchemaCatalog({ tools: [tool("terminal.run", ["coding"], undefined, "workspace-write")] });
    expect(names(narrowProviderToolsForTurn({ catalog: restricted, intent: intent(0.35), requiredTools: ["terminal.run"] })))
      .toEqual(["terminal_run"]);
  });

  it("uses a small bounded policy for low-confidence routing", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    const selected = narrowProviderToolsForTurn({ catalog, intent: intent(0.35) });
    expect(names(selected)).toEqual(["file_read", "terminal_inspect", "web_extract"]);
    expect(selected.length).toBeLessThan(catalog.tools.length);
  });

  it("keeps working tools available for a conversational turn without selecting optional capabilities", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35, [], "conversation"),
      userText: "hello"
    }))).toEqual(["file_read", "terminal_inspect"]);
  });

  it("narrows low-confidence turns to an explicitly named configured connector", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Add these requests to Postman."
    }))).toEqual([
      "file_read", "terminal_inspect",
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

  it("keeps the blocked connector and recovery status available on an explicit retry", () => {
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        tool("browser.snapshot", ["browser"]),
        tool("config.mcp.status", ["configuration"]),
        tool("mcp.postman.getCollection", ["mcp"], { kind: "mcp", id: "postman" }),
        tool("workspaces.list", ["mcp"], { kind: "mcp", id: "linear-cloud" })
      ]
    });

    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "why not try again",
      continuity: {
        userRequest: "Set up these products in Postman.",
        toolsets: ["browser"],
        connectors: [{ kind: "mcp", id: "postman" }]
      }
    }))).toEqual([
      "browser_snapshot",
      "config_mcp_status",
      "mcp_postman_getCollection"
    ]);
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
      "file_read", "terminal_inspect",
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
    }))).toEqual(["file_read", "terminal_inspect", "web_extract"]);
    expect(names(narrowProviderToolsForTurn({
      catalog,
      intent: intent(0.35),
      userText: "Call the API and summarize the response."
    }))).toEqual(["file_read", "terminal_inspect", "web_extract"]);
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
    }))).toEqual(["file_read", "terminal_inspect", "web_extract"]);
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
    expect(low).toEqual(["file_read", "terminal_inspect", "web_extract"]);
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
      "file_read", "terminal_inspect",
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
      "file_read", "terminal_inspect",
      "browser_snapshot",
      "browser_click",
      "browser_tabs",
      "browser_switch_tab"
    ]);
  });

  it("uses a complete but bounded browser and Postman profile for API integration", () => {
    const browserTools = [
      "status", "snapshot", "find", "click", "type", "fill_protected_form", "select",
      "extract", "scroll", "press", "back", "tabs", "switch_tab", "download", "vision",
      "dialog", "navigate"
    ].map((name) => tool(`browser.${name}`, ["browser"], undefined, "read-only-network"));
    const postmanTools = Array.from({ length: 14 }, (_, index) => tool(
      `mcp.postman.operation${index + 1}`,
      ["mcp"],
      { kind: "mcp", id: "postman" },
      index < 7 ? "read-only-network" : "external-side-effect"
    ));
    const catalog = buildProviderToolSchemaCatalog({
      tools: [
        tool("plan", ["core"]),
        ...browserTools,
        tool("config.mcp.status", ["configuration"]),
        tool("config.provider.status", ["provider", "diagnostics"]),
        tool("config.provider.execution_status", ["provider", "diagnostics"]),
        ...postmanTools,
        tool("browser.console", ["browser"], undefined, "read-only-network"),
        tool("browser.screenshot", ["browser"], undefined, "read-only-network"),
        tool("browser.get_images", ["browser"], undefined, "read-only-network"),
        tool("file.read", ["files"]),
        tool("file.write", ["files"], undefined, "workspace-write"),
        tool("web.extract", ["web"], undefined, "read-only-network"),
        tool("config.mcp.setup", ["configuration"], undefined, "shared-state-mutation"),
        tool("skills.propose", ["skills"], undefined, "shared-state-mutation"),
        tool("workspaces.list", ["mcp"], { kind: "mcp", id: "linear-cloud" })
      ]
    });
    const skill: SkillDefinition = {
      name: "api-integration",
      description: "test",
      version: "1",
      whenToUse: [],
      requiredToolsets: ["browser", "mcp"],
      optionalToolsets: ["web", "files"],
      playbook: Array.from({ length: 4 }, (_, index) => ({
        id: `step-${index + 1}`,
        description: `Step ${index + 1}`
      })),
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };

    const selected = selectProviderToolsForTurn({
      catalog,
      intent: intent(0.7),
      userText: "Import these Swagger products into Postman and configure their credentials.",
      selectedSkill: skill
    });
    const initialNames = names(selected.initialTools);

    expect(initialNames).toHaveLength(36);
    expect(initialNames).toEqual(expect.arrayContaining([
      "plan",
      "browser_status",
      "browser_download",
      "browser_fill_protected_form",
      "browser_dialog",
      "config_mcp_status",
      "config_provider_status",
      "config_provider_execution_status",
      ...postmanTools.map((entry) => entry.name.replaceAll(".", "_"))
    ]));
    for (const excluded of [
      "browser_console",
      "browser_screenshot",
      "browser_get_images",
      "web_extract",
      "config_mcp_setup",
      "skills_propose",
      "workspaces_list",
      "browser_vision"
    ]) {
      expect(initialNames).not.toContain(excluded);
    }
    expect(selected.expansionCandidates.map((candidate) => candidate.schema.function.name)).toEqual([
      "browser_vision"
    ]);
    expect(selected.namedConnectorIds).toEqual(["postman"]);
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
    expect(names(selected.initialTools)).toEqual(["file_read", "terminal_inspect"]);
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

  it("preserves working tools during repository inspection while deferring unrelated capabilities", () => {
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
    }))).toEqual(["file_read", "file_write", "file_grep", "terminal_inspect", "terminal_run"]);
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
    }))).toEqual(["file_read", "file_write", "terminal_run", "plan"]);
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
      "file_read",
      "config_provider_execution_status",
      "config_provider_status",
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
    expect(selected).toEqual(["file_read", "terminal_inspect"]);
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


describe("bounded session capability diagnostics", () => {
  it("reports availability, eligibility, budget and selection separately without content", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [
      ...Array.from({ length: 105 }, (_, i) => tool(`file.read${i}`, ["files"])),
      { ...tool("file.write", ["files"], undefined, "workspace-write"), description: "private-description".repeat(10_000) },
      tool("restricted", ["files"], undefined, "credential-access"),
      tool("unrelated", ["test"])
    ], unavailableTools: [tool("web.search", ["web"])] });
    const route = { ...intent(1, ["files"], "research"), requestRequirements: { skillReferences: [], fileOutput: { format: "markdown" as const }, issues: [] } };
    const selection = selectProviderToolsForTurn({ catalog, intent: route, userText: "Save report.md" });
    const diagnostic = describeCapabilitySelection({ catalog, exposedTools: selection.initialTools, selection, requirements: route.requestRequirements });
    expect(diagnostic).toMatchObject({ catalogCount: 109, availableCount: 108, schemaEligibleCount: 107, selectedCount: 100,
      omissionCounts: { schema_budget: 6, temporarily_unavailable: 1, provider_schema_restricted: 1, not_selected: 1 },
      requestedOmissions: expect.arrayContaining([{ tool: "file.write", reason: "schema_budget" }, { tool: "file.read", reason: "not_in_session" }]) });
    expect(JSON.stringify(diagnostic)).not.toContain("private-description");
    expect(JSON.stringify(diagnostic)).not.toContain("inputSchema");
  });

  it("bounds samples, prioritizes requested omissions and redacts non-ID strings", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [
      tool("/private/path?token=value", ["test"]),
      ...Array.from({ length: 100 }, (_, i) => tool(`unused.${i}`, ["test"])), tool("file.write", ["files"])
    ] });
    const diagnostic = describeCapabilitySelection({ catalog, exposedTools: [], selection: { policy: "conversation", expansionCandidates: [] }, requirements: { skillReferences: [], fileOutput: { format: "markdown" }, issues: [] } });
    expect(diagnostic.omissions).toHaveLength(32);
    expect(diagnostic.omittedDetailsCount).toBe(70);
    expect(diagnostic.omissions[0]).toEqual({ tool: "file.write", reason: "not_selected" });
    expect(JSON.stringify(diagnostic)).not.toContain("private/path");
    expect(diagnostic.omissionCounts.not_selected).toBe(102);
  });

  it("prioritizes exact requested tools over other relevant schemas before budgeting", () => {
    const catalog = buildProviderToolSchemaCatalog({ tools: [...Array.from({ length: 100 }, (_, i) => tool(`file.read${i}`, ["files"])), tool("file.write", ["files"], undefined, "workspace-write")] });
    const selection = selectProviderToolsForTurn({ catalog, intent: { ...intent(1, ["files"]), requestRequirements: { skillReferences: [], fileOutput: { format: "markdown" }, issues: [] } }, userText: "Save report.md" });
    expect(selection.initialTools).toHaveLength(100);
    expect(selection.initialTools[0]?.function.name).toBe("file_write");
    expect(selection.budgetOmittedTools).toHaveLength(1);
  });
});


it.each(["hello", "What tools and skills are available?", "Find a way to inspect this", "Do not use tools", 'Explain "use tools"', "ما هي الأدوات المتاحة؟"])("keeps recovery discoverable regardless of phrasing: %s", (userText) => {
  const catalog = buildProviderToolSchemaCatalog({ tools: [tool("capability.discover", ["core"]), tool("capability.request", ["core"])] });
  const selection = selectProviderToolsForTurn({ catalog, intent: intent(0.1), userText: userText as string });
  expect(selection.initialTools.length).toBe(2);
});


it('selects exact inspection tools alongside working tools without exposing configuration mutation', () => {
 const catalog = buildProviderToolSchemaCatalog({tools:[...tools,
  tool('task.result.read',['core']), tool('config.provider.status',['core']),
  tool('config.web.setup',['core','web'],undefined,'shared-state-mutation'),
  tool('terminal.run',['shell-readonly'],undefined,'workspace-write')]});
 const selected=names(narrowProviderToolsForTurn({catalog,intent:intent(.4,[],'conversation'),
  userText:'Check task_demo status and show its saved result. Check web search settings. Inspect git diff.'}));
 expect(selected).toEqual(expect.arrayContaining(['task_status','task_result_read','config_provider_status','terminal_inspect']));
 expect(selected).not.toContain('config_web_setup');expect(selected).toContain('terminal_run');
 const absent=buildProviderToolSchemaCatalog({tools:[]});
 expect(narrowProviderToolsForTurn({catalog:absent,intent:intent(.4),userText:'Check task_demo status.'})).toEqual([]);
});

it.each([
  'https://sleepnomad.github.io/hermes-trismegistus/ Can you extract all the content here into a well formatted and designed PDF?',
  'A polished PDF of the attached notes, please.',
  'حوّل محتوى الصفحة إلى ملف PDF منسق.',
  'لخّص البيانات في ملف CSV.',
  'Hello'
])('preserves a stable working set without requiring an action dictionary: %s', userText => {
  const catalog = buildProviderToolSchemaCatalog({ tools: [
    tool('file.read', ['files']), tool('file.write', ['files'], undefined, 'workspace-write'),
    tool('file.patch', ['files'], undefined, 'workspace-write'), tool('execute_code', ['coding'], undefined, 'workspace-write'),
    tool('terminal.run', ['shell-write'], undefined, 'workspace-write'),
    tool('skill.list', ['skills']), tool('skill.read', ['skills']),
    tool('capability.discover', ['core']), tool('capability.request', ['core']),
    tool('config.provider.setup', ['configuration'], undefined, 'shared-state-mutation')
  ] });
  const selected = names(narrowProviderToolsForTurn({ catalog, intent: intent(.1, [], 'conversation'), userText }));
  expect(selected).toEqual(expect.arrayContaining(['file_read', 'file_write', 'file_patch', 'execute_code', 'terminal_run', 'skill_list', 'skill_read', 'capability_discover', 'capability_request']));
  expect(selected).not.toContain('config_provider_setup');
});

it('does not reintroduce prohibited core tools through process dependencies or explicit requirements', () => {
  const catalog = buildProviderToolSchemaCatalog({tools: [
    tool('terminal.run', ['coding']), tool('process.stop', ['coding']), tool('file.write', ['files']),
    tool('capability.discover', ['core']), tool('capability.request', ['core'])
  ]});
  const selected = names(narrowProviderToolsForTurn({ catalog, intent: intent(.1), requiredTools: ['file.write'],
    userText: 'Do not use file.write. Do not use process.stop.' }));
  expect(selected).toContain('terminal_run');
  expect(selected).not.toContain('file_write');
  expect(selected).not.toContain('process_stop');
});
