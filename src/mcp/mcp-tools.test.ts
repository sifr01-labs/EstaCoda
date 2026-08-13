import { describe, expect, it } from "vitest";
import {
  loadMcpServers,
  normalizeMcpResult,
  resolveMcpEnvironment,
  resolveMcpToolRiskClass
} from "./mcp-tools.js";

describe("MCP per-tool risk classification", () => {
  const postmanRiskClasses = {
    getAuthenticatedUser: "read-only-network",
    getWorkspaces: "read-only-network",
    getCollections: "read-only-network",
    getCollection: "read-only-network",
    updateCollection: "external-side-effect",
    updateCollectionRequest: "external-side-effect"
  } as const;

  it("classifies configured Postman reads as read-only and mutations as consequential", () => {
    const config = { toolRiskClasses: postmanRiskClasses };
    expect(resolveMcpToolRiskClass(config, "stdio", "getAuthenticatedUser")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getWorkspaces")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getCollections")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getCollection")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "updateCollection")).toBe("external-side-effect");
    expect(resolveMcpToolRiskClass(config, "stdio", "updateCollectionRequest")).toBe("external-side-effect");
  });

  it("keeps unknown operations conservative", () => {
    expect(resolveMcpToolRiskClass({
      toolRiskClass: "read-only-network",
      toolRiskClasses: postmanRiskClasses
    }, "stdio", "deleteEverything"))
      .toBe("external-side-effect");
  });
});

describe("MCP structural summaries", () => {
  it("puts a bounded redacted outline before large structured responses", () => {
    const secret = "postman-secret-value-that-must-not-survive";
    const result = normalizeMcpResult({
      content: [{
        type: "text",
        text: JSON.stringify({
          collection: {
            name: "MTN Products",
            apiKey: secret,
            requests: Array.from({ length: 100 }, (_, index) => ({ id: index, name: `Request ${index}` }))
          }
        })
      }]
    });

    const summary = result.metadata?._estacoda_context_summary;
    expect(result.content).toContain("MCP structural summary");
    expect(summary).toContain("MTN Products");
    expect(summary).toContain("[REDACTED]");
    expect(summary?.length).toBeLessThanOrEqual(1_231);
    expect(summary).not.toContain(secret);
  });
});

describe("resolveMcpEnvironment", () => {
  it("resolves explicitly named environment references without exposing unrelated values", () => {
    const result = resolveMcpEnvironment(
      {
        env: { LOG_LEVEL: "warn" },
        envRefs: { POSTMAN_API_KEY: "PROFILE_POSTMAN_API_KEY" },
      },
      {
        PROFILE_POSTMAN_API_KEY: "postman-secret-value",
        UNRELATED_SECRET: "must-not-be-forwarded",
      },
    );

    expect(result).toEqual({
      ok: true,
      env: {
        LOG_LEVEL: "warn",
        POSTMAN_API_KEY: "postman-secret-value",
      },
    });
  });

  it("fails closed when a referenced environment variable is missing", () => {
    expect(resolveMcpEnvironment(
      { envRefs: { POSTMAN_API_KEY: "PROFILE_POSTMAN_API_KEY" } },
      {},
    )).toEqual({
      ok: false,
      error: "MCP environment variable PROFILE_POSTMAN_API_KEY is not set.",
    });
  });

  it("rejects invalid environment variable names", () => {
    expect(resolveMcpEnvironment(
      { envRefs: { POSTMAN_API_KEY: "PROFILE-POSTMAN-API-KEY" } },
      { "PROFILE-POSTMAN-API-KEY": "postman-secret-value" },
    )).toEqual({
      ok: false,
      error: "MCP environment reference POSTMAN_API_KEY is invalid.",
    });
  });
});

describe("loadMcpServers environment references", () => {
  it("marks a server unavailable before launch when its referenced secret is missing", async () => {
    const [loaded] = await loadMcpServers({
      servers: {
        postman: {
          command: "command-that-must-not-run",
          envRefs: { POSTMAN_API_KEY: "POSTMAN_API_KEY" },
        },
      },
      environment: {},
    });

    expect(loaded?.snapshot).toMatchObject({
      name: "postman",
      available: false,
      error: "MCP environment variable POSTMAN_API_KEY is not set.",
    });
  });
});
