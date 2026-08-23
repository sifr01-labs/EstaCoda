import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "../contracts/tool.js";
import { ToolRegistry } from "./tool-registry.js";

describe("ToolRegistry connector provenance", () => {
  it("preserves connector identity in availability-filtered definitions", async () => {
    const registry = new ToolRegistry();
    const connector = { kind: "mcp" as const, id: "postman" };
    const registered: RegisteredTool = {
      name: "collections.get",
      description: "Read a collection",
      inputSchema: { type: "object", properties: {} },
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      connector,
      protectedArguments: [{
        path: "/secret",
        handling: { persistence: "none", sharing: "private" }
      }],
      capabilityMetadata: {
        protectedInput: { groupedDelivery: false, sources: ["browser"] }
      },
      executionConcurrency: {
        mode: "exclusive",
        resourceKey: (_input, context) => `connector:${context.sessionId}`
      },
      progressLabel: "reading collection",
      maxResultSizeChars: 1_000,
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "ok" })
    };
    registry.register(registered);

    const snapshot = await registry.snapshot();
    expect(snapshot.available[0]?.connector).toEqual(connector);
    expect(snapshot.available[0]?.connector).not.toBe(connector);
    expect(snapshot.available[0]).not.toHaveProperty("protectedArguments");
    expect(snapshot.available[0]).not.toHaveProperty("capabilityMetadata");
    expect(snapshot.available[0]).not.toHaveProperty("executionConcurrency");
  });
});
