import { describe, expect, it, vi } from "vitest";
import type { ExecutionPlanCapabilityRequirement } from "../contracts/execution-plan.js";
import type { RegisteredTool, ToolRiskClass } from "../contracts/tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ExecutionCapabilityPreflight, formatExecutionCapabilityBlocker } from "./execution-capability-preflight.js";

function tool(input: {
  name: string;
  riskClass: ToolRiskClass;
  available?: boolean;
  protectedPaths?: string[];
  run?: RegisteredTool["run"];
}): RegisteredTool {
  return {
    name: input.name,
    description: "test tool",
    inputSchema: { type: "object" },
    riskClass: input.riskClass,
    toolsets: ["mcp"],
    progressLabel: "testing",
    maxResultSizeChars: 100,
    protectedArguments: input.protectedPaths?.map((path) => ({
      path,
      handling: { persistence: "destination-managed", sharing: "workspace" }
    })),
    isAvailable: () => input.available ?? true,
    run: input.run ?? vi.fn(async () => ({ ok: true, content: "must not run" }))
  };
}

const requirements: ExecutionPlanCapabilityRequirement[] = [
  { id: "read-target", itemId: "inspect", tool: "mcp.target.read", capability: "read" },
  {
    id: "mutate-target",
    itemId: "update",
    tool: "mcp.target.update",
    capability: "mutate",
    protectedPaths: ["/entries/*/value", "/metadata/secret"],
    protectedSource: "browser"
  },
  { id: "verify-target", itemId: "verify", tool: "mcp.target.verify", capability: "verify" }
];

describe("ExecutionCapabilityPreflight", () => {
  it("marks bounded read, mutation, protected transfer, and independent verification requirements ready", async () => {
    const registry = new ToolRegistry();
    const runs = Array.from({ length: 3 }, () => vi.fn(async () => ({ ok: true, content: "unused" })));
    registry.register(tool({ name: "mcp.target.read", riskClass: "read-only-network", run: runs[0] }));
    registry.register(tool({
      name: "mcp.target.update",
      riskClass: "external-side-effect",
      protectedPaths: ["/entries/*/value", "/metadata/secret"],
      run: runs[1]
    }));
    registry.register(tool({ name: "mcp.target.verify", riskClass: "read-only-network", run: runs[2] }));
    const browserSourceAvailable = vi.fn(async () => true);

    const result = await new ExecutionCapabilityPreflight({ registry, browserSourceAvailable }).assess(requirements, {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: true
    });

    expect(result).toMatchObject({
      status: "ready",
      assessments: [
        { requirementId: "read-target", status: "ready" },
        { requirementId: "mutate-target", status: "ready" },
        { requirementId: "verify-target", status: "ready" }
      ]
    });
    expect(browserSourceAvailable).toHaveBeenCalledOnce();
    expect(runs.every((run) => run.mock.calls.length === 0)).toBe(true);
  });

  it("distinguishes missing, unavailable, undeclared protected paths, and incompatible risk", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "unavailable.update", riskClass: "external-side-effect", available: false }));
    registry.register(tool({ name: "unprotected.update", riskClass: "external-side-effect" }));
    registry.register(tool({ name: "readonly.update", riskClass: "read-only-network" }));
    const preflight = new ExecutionCapabilityPreflight({ registry });

    await expect(preflight.assess([
      { id: "missing", itemId: "one", tool: "absent.update", capability: "mutate" },
      { id: "unavailable", itemId: "two", tool: "unavailable.update", capability: "mutate" },
      {
        id: "path",
        itemId: "three",
        tool: "unprotected.update",
        capability: "mutate",
        protectedPaths: ["/values/*/value"]
      },
      { id: "risk", itemId: "four", tool: "readonly.update", capability: "mutate" }
    ], { protectedTransferAvailable: true })).resolves.toEqual({
      status: "blocked",
      assessments: [
        expect.objectContaining({ requirementId: "missing", status: "missing", reasonCode: "tool_missing" }),
        expect.objectContaining({ requirementId: "unavailable", status: "unavailable", reasonCode: "tool_unavailable" }),
        expect.objectContaining({ requirementId: "path", status: "incompatible", reasonCode: "protected_path_missing" }),
        expect.objectContaining({ requirementId: "risk", status: "incompatible", reasonCode: "risk_mismatch" })
      ]
    });
  });

  it("requires verification to use a different read-safe tool than mutation", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "target.change", riskClass: "external-side-effect" }));
    const result = await new ExecutionCapabilityPreflight({ registry }).assess([
      { id: "change", itemId: "change", tool: "target.change", capability: "mutate" },
      { id: "verify", itemId: "verify", tool: "target.change", capability: "verify" }
    ]);
    expect(result.assessments[1]).toMatchObject({ status: "incompatible", reasonCode: "risk_mismatch" });
  });

  it("fails closed when protected or browser-source transfer is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.change",
      riskClass: "external-side-effect",
      protectedPaths: ["/values/*/value"]
    }));
    const requirement: ExecutionPlanCapabilityRequirement = {
      id: "change",
      itemId: "change",
      tool: "target.change",
      capability: "mutate",
      protectedPaths: ["/values/*/value"],
      protectedSource: "browser"
    };
    const preflight = new ExecutionCapabilityPreflight({
      registry,
      browserSourceAvailable: async () => false
    });

    expect((await preflight.assess([requirement], { protectedTransferAvailable: false })).assessments[0])
      .toMatchObject({ status: "unavailable", reasonCode: "tool_unavailable" });
    expect((await preflight.assess([requirement], { protectedTransferAvailable: true })).assessments[0])
      .toMatchObject({ status: "unavailable", reasonCode: "tool_unavailable" });
  });

  it("requires grouped delivery for wildcard protected paths", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.change",
      riskClass: "external-side-effect",
      protectedPaths: ["/values/*/value"]
    }));
    const result = await new ExecutionCapabilityPreflight({ registry }).assess([{
      id: "change",
      itemId: "change",
      tool: "target.change",
      capability: "mutate",
      protectedPaths: ["/values/*/value"]
    }], {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: false
    });

    expect(result.assessments[0]).toMatchObject({ status: "unavailable", reasonCode: "tool_unavailable" });
  });

  it("assesses only the final filtered registry", async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(tool({ name: "parent.only.update", riskClass: "external-side-effect" }));
    const childRegistry = new ToolRegistry();
    const child = new ExecutionCapabilityPreflight({ registry: childRegistry });

    const result = await child.assess([
      { id: "child-update", itemId: "update", tool: "parent.only.update", capability: "mutate" }
    ]);

    expect(parentRegistry.get("parent.only.update")).toBeDefined();
    expect(result.assessments[0]).toMatchObject({ status: "missing", reasonCode: "tool_missing" });
  });

  it("renders one precise English or Arabic blocker without secret values", () => {
    const assessment = {
      requirementId: "update",
      itemId: "update",
      tool: "mcp.target.update",
      capability: "mutate" as const,
      status: "incompatible" as const,
      reasonCode: "protected_path_missing" as const
    };
    expect(formatExecutionCapabilityBlocker({ assessment, locale: "en" }))
      .toBe('Tool "mcp.target.update" does not declare the required protected input paths.');
    expect(formatExecutionCapabilityBlocker({ assessment, locale: "ar" }))
      .toBe('الأداة "mcp.target.update" لا تعلن مسارات الإدخال المحمي المطلوبة.');
  });
});
