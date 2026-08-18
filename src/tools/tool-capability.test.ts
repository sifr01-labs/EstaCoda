import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "../contracts/tool.js";
import { resolveRegisteredToolCapability } from "./tool-capability.js";

function registered(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name: "mcp.target.update",
    description: "Update target",
    inputSchema: { type: "object" },
    riskClass: "external-side-effect",
    toolsets: ["mcp"],
    connector: { kind: "mcp", id: "target" },
    progressLabel: "updating",
    maxResultSizeChars: 100,
    isAvailable: () => true,
    run: async () => ({ ok: true, content: "unused" }),
    ...overrides
  };
}

describe("resolveRegisteredToolCapability", () => {
  it("derives canonical security facts from runtime-owned tool registration", () => {
    const result = resolveRegisteredToolCapability(registered({
      protectedArguments: [{
        path: "/values/*/value",
        handling: { persistence: "destination-managed", sharing: "workspace" }
      }],
      capabilityMetadata: {
        protectedInput: { groupedDelivery: true, sources: ["browser"] }
      }
    }));

    expect(result).toEqual({
      ok: true,
      capability: {
        canonicalTool: "mcp.target.update",
        riskClass: "external-side-effect",
        classification: "mutate",
        connector: { kind: "mcp", id: "target" },
        protectedInput: {
          paths: ["/values/*/value"],
          groupedDelivery: true,
          sources: ["browser"]
        }
      }
    });
    expect(resolveRegisteredToolCapability(registered({
      name: "mcp.target.verify",
      riskClass: "read-only-network",
      capabilityMetadata: { verification: { verifies: ["mcp.target.update"] } }
    }))).toMatchObject({
      ok: true,
      capability: {
        canonicalTool: "mcp.target.verify",
        classification: "read",
        verification: { verifies: ["mcp.target.update"] }
      }
    });
  });

  it("fails closed on absent risk or malformed capability metadata", () => {
    expect(resolveRegisteredToolCapability(registered({ riskClass: undefined as never }))).toEqual({
      ok: false,
      reason: "risk_class_missing"
    });
    expect(resolveRegisteredToolCapability(registered({
      capabilityMetadata: {
        protectedInput: { groupedDelivery: true, sources: ["browser"] }
      }
    }))).toEqual({
      ok: false,
      reason: "capability_metadata_invalid"
    });
    expect(resolveRegisteredToolCapability(registered({
      riskClass: "read-only-network",
      protectedArguments: [{
        path: "/secret",
        handling: { persistence: "none", sharing: "private" }
      }],
      capabilityMetadata: {
        protectedInput: { groupedDelivery: false, sources: ["browser"] }
      }
    }))).toEqual({
      ok: false,
      reason: "capability_metadata_invalid"
    });
  });

  it("does not infer protected capability from secret-looking tool names", () => {
    expect(resolveRegisteredToolCapability(registered({
      name: "mcp.target.setPassword",
      protectedArguments: undefined,
      capabilityMetadata: undefined
    }))).toEqual({
      ok: true,
      capability: expect.objectContaining({
        canonicalTool: "mcp.target.setPassword",
        classification: "mutate"
      })
    });
    const result = resolveRegisteredToolCapability(registered({ name: "mcp.target.setPassword" }));
    expect(result.ok && result.capability.protectedInput).toBeUndefined();
  });
});
