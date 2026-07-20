import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { DelegationConfig } from "../contracts/delegation.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { resolveChildToolAccess, resolveTaskStepToolAccess } from "./toolset-security.js";

describe("resolveChildToolAccess", () => {
  it("defaults children to parent-visible read-only local and network tools", () => {
    const result = resolveChildToolAccess({
      parentVisibleTools: inventory(),
      childCandidateTools: inventory(),
      config: DEFAULT_DELEGATION_CONFIG,
      request: { role: "leaf", depth: 1 }
    });

    expect(result.effectiveAllowedTools).toEqual(["file.read", "file.search", "terminal.inspect", "process.logs", "web.search"]);
    expect(result.strippedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "delegate_task", reasons: ["leaf-delegation-disabled", "disallowed-risk-class"] }),
      expect.objectContaining({ name: "terminal.run", reasons: ["blocked-exact-name", "disallowed-risk-class"] }),
      expect.objectContaining({ name: "file.write", reasons: ["blocked-exact-name", "disallowed-risk-class"] }),
      expect.objectContaining({ name: "memory.search", reasons: ["blocked-prefix"] }),
      expect.objectContaining({ name: "browser.open", reasons: expect.arrayContaining(["excluded-toolset"]) }),
      expect.objectContaining({ name: "mcp:server.tool", reasons: ["excluded-toolset"] })
    ]));
  });

  it("rejects tools and toolsets that are not visible to the parent", () => {
    const result = resolveChildToolAccess({
      parentVisibleTools: [tool("file.read", "read-only-local", ["files"])],
      childCandidateTools: [tool("file.read", "read-only-local", ["files"]), tool("web.search", "read-only-network", ["web"])],
      config: DEFAULT_DELEGATION_CONFIG,
      request: {
        role: "leaf",
        depth: 1,
        allowedTools: ["file.read", "web.search", "missing.tool"],
        allowedToolsets: ["files", "web", "missing"]
      }
    });

    expect(result.effectiveAllowedTools).toEqual(["file.read"]);
    expect(result.strippedTools).toEqual([
      expect.objectContaining({ name: "web.search", reasons: expect.arrayContaining(["not-parent-visible"]) })
    ]);
    expect(result.rejectedRequestedTools).toEqual([
      { name: "missing.tool", reasons: ["not-parent-visible"] },
      { name: "web.search", reasons: ["not-parent-visible"] }
    ]);
    expect(result.rejectedRequestedToolsets).toEqual([
      { name: "missing", reasons: ["not-parent-visible"] },
      { name: "web", reasons: ["not-parent-visible"] }
    ]);
  });

  it("intersects explicitly requested tools and toolsets", () => {
    const result = resolveChildToolAccess({
      parentVisibleTools: inventory(),
      childCandidateTools: inventory(),
      config: DEFAULT_DELEGATION_CONFIG,
      request: {
        role: "leaf",
        depth: 1,
        allowedTools: ["file.read", "web.search"],
        allowedToolsets: ["files"]
      }
    });

    expect(result.effectiveAllowedTools).toEqual(["file.read"]);
    expect(result.strippedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "file.search", reasons: expect.arrayContaining(["outside-requested-allowed-tools"]) }),
      expect.objectContaining({ name: "web.search", reasons: expect.arrayContaining(["outside-requested-allowed-toolsets"]) })
    ]));
  });

  it("does not allow blocked exact names or prefixes even when requested", () => {
    const result = resolveChildToolAccess({
      parentVisibleTools: inventory(),
      childCandidateTools: inventory(),
      config: DEFAULT_DELEGATION_CONFIG,
      request: {
        role: "leaf",
        depth: 1,
        allowedTools: ["terminal.run", "memory.search"],
        allowedToolsets: ["shell-write", "memory"]
      }
    });

    expect(result.effectiveAllowedTools).toEqual([]);
    expect(result.blockedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "terminal.run", reasons: expect.arrayContaining(["blocked-exact-name"]) }),
      expect.objectContaining({ name: "memory.search", reasons: expect.arrayContaining(["blocked-prefix"]) })
    ]));
  });

  it("only exposes delegate_task to orchestrators below max spawn depth", () => {
    const config: DelegationConfig = { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 3 };
    const tools = [tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])];

    expect(resolveChildToolAccess({
      parentVisibleTools: tools,
      childCandidateTools: tools,
      config,
      request: { role: "leaf", depth: 1 }
    }).effectiveAllowedTools).toEqual([]);
    expect(resolveChildToolAccess({
      parentVisibleTools: tools,
      childCandidateTools: tools,
      config,
      request: { role: "orchestrator", depth: 1 }
    }).effectiveAllowedTools).toEqual(["delegate_task"]);
    expect(resolveChildToolAccess({
      parentVisibleTools: tools,
      childCandidateTools: tools,
      config,
      request: { role: "orchestrator", depth: 3 }
    }).blockedTools).toEqual([
      expect.objectContaining({ name: "delegate_task", reasons: expect.arrayContaining(["spawn-depth-exceeded"]) })
    ]);
  });
});

describe("resolveTaskStepToolAccess", () => {
  it("keeps Task-authorized write tools without inheriting delegation's read-only defaults", () => {
    const candidates = [
      tool("file.read", "read-only-local", ["files"]),
      tool("file.write", "workspace-write", ["files"]),
      tool("delegate_task", "shared-state-mutation", ["core"])
    ];
    const result = resolveTaskStepToolAccess({
      parentVisibleTools: candidates,
      childCandidateTools: candidates,
      allowedToolsets: ["files"],
      allowedTools: ["file.read", "file.write"]
    });

    expect(result.effectiveAllowedTools).toEqual(["file.read", "file.write"]);
    expect(result.strippedTools).toContainEqual(expect.objectContaining({
      name: "delegate_task",
      reasons: expect.arrayContaining(["leaf-delegation-disabled"])
    }));
  });

  it("retains delegate_task only when the persisted orchestrator authority allows it", () => {
    const candidates = [tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])];
    expect(resolveTaskStepToolAccess({
      parentVisibleTools: candidates,
      childCandidateTools: candidates,
      allowedToolsets: ["core"],
      allowedTools: ["delegate_task"],
      allowDelegation: true
    }).effectiveAllowedTools).toEqual(["delegate_task"]);
    expect(resolveTaskStepToolAccess({
      parentVisibleTools: candidates,
      childCandidateTools: candidates,
      allowedToolsets: ["core"],
      allowedTools: ["delegate_task"]
    }).effectiveAllowedTools).toEqual([]);
  });
});

function inventory(): ToolDefinition[] {
  return [
    tool("file.read", "read-only-local", ["files", "core"]),
    tool("file.search", "read-only-local", ["files", "research"]),
    tool("terminal.inspect", "read-only-local", ["shell-readonly", "coding", "research"]),
    tool("process.logs", "read-only-local", ["core"]),
    tool("web.search", "read-only-network", ["web", "research"]),
    tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"]),
    tool("terminal.run", "workspace-write", ["shell-write", "coding"]),
    tool("file.write", "workspace-write", ["files", "coding"]),
    tool("memory.search", "read-only-local", ["memory"]),
    tool("browser.open", "external-side-effect", ["browser"]),
    tool("mcp:server.tool", "read-only-network", ["mcp"])
  ];
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskClass,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1000
  };
}
