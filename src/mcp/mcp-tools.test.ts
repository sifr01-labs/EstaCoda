import { describe, expect, it } from "vitest";
import type { MCPProtectedToolArgumentsConfig } from "../config/runtime-config.js";
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

describe("MCP protected argument declarations", () => {
  const capabilityFetch = async (_url: string, init?: { body?: string }) => {
    const payload = JSON.parse(init?.body ?? "{}") as { id?: number; method?: string };
    const result = payload.method === "initialize"
      ? { capabilities: { tools: {} } }
      : payload.method === "tools/list"
        ? {
            tools: [{
              name: "authenticate",
              inputSchema: {
                type: "object",
                properties: {
                  values: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"]
                    }
                  },
                  metadata: {
                    type: "object",
                    properties: { secret: { type: "string" } }
                  }
                },
                required: ["values"]
              }
            }, {
              name: "verifyAuthentication",
              inputSchema: { type: "object", properties: {} }
            }]
          }
        : {};
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jsonrpc: "2.0", id: payload.id, result }),
      text: async () => ""
    };
  };

  it("leaves ordinary MCP tools unchanged when no capability mappings are configured", async () => {
    const [server] = await loadMcpServers({
      servers: {
        ordinary: {
          transport: "http",
          url: "https://mcp.example.test"
        }
      },
      fetch: capabilityFetch
    });

    expect(server?.snapshot).toMatchObject({
      available: true,
      capabilities: {
        protectedDeliveryConfigured: false,
        groupedDeliverySupported: false,
        browserRelaySupported: false,
        verificationConfigured: false
      }
    });
    expect(server?.tools).toHaveLength(2);
    for (const tool of server?.tools ?? []) {
      expect(tool.protectedArguments).toEqual([]);
      expect(tool.capabilityMetadata).toBeUndefined();
      expect(JSON.stringify(tool.inputSchema)).not.toContain("protectedInput");
    }
    await server?.stop();
  });

  it("registers validated protected delivery and verification metadata from real MCP configuration", async () => {
    const [server] = await loadMcpServers({
      servers: {
        trusted: {
          transport: "http",
          url: "https://mcp.example.test",
          toolRiskClasses: {
            authenticate: "external-side-effect",
            verifyAuthentication: "read-only-network"
          },
          protectedToolArguments: {
            authenticate: {
              paths: ["/values/*/value", "/metadata/secret"],
              handling: { persistence: "destination-managed", sharing: "workspace" },
              groupedDelivery: true,
              browserRelay: true
            }
          },
          toolVerificationRelationships: {
            verifyAuthentication: ["authenticate"]
          }
        }
      },
      fetch: capabilityFetch
    });
    const tool = server?.tools.find((candidate) => candidate.name.endsWith("authenticate"));
    const verifier = server?.tools.find((candidate) => candidate.name.endsWith("verifyAuthentication"));
    expect(tool?.protectedArguments).toEqual([{
      path: "/values/*/value",
      handling: { persistence: "destination-managed", sharing: "workspace" },
      destination: { type: "mcp-argument", serverId: "trusted", toolName: "authenticate" }
    }, {
      path: "/metadata/secret",
      handling: { persistence: "destination-managed", sharing: "workspace" },
      destination: { type: "mcp-argument", serverId: "trusted", toolName: "authenticate" }
    }]);
    expect(tool?.capabilityMetadata).toEqual({
      protectedInput: { groupedDelivery: true, sources: ["browser"] }
    });
    expect(verifier?.capabilityMetadata).toEqual({
      verification: { verifies: ["mcp.trusted.authenticate"] }
    });
    expect(server?.snapshot.capabilities).toEqual({
      protectedDeliveryConfigured: true,
      groupedDeliverySupported: true,
      browserRelaySupported: true,
      verificationConfigured: true
    });
    expect(JSON.stringify(tool?.inputSchema)).toContain("protectedInput");
    expect(JSON.stringify(tool?.inputSchema)).toContain("expectedOrigin");
    expect(JSON.stringify(tool?.inputSchema)).toContain("documentEpoch");
    expect(JSON.stringify(tool?.inputSchema)).toContain('"type":"string"');
    await server?.stop();
  });

  it("rejects unknown tools and mappings that do not resolve to compatible schema arguments", async () => {
    const invalidDeclarations: Array<Record<string, MCPProtectedToolArgumentsConfig>> = [{
      missingTool: {
        paths: ["/value"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }, {
      authenticate: {
        paths: ["/missing/value"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }, {
      authenticate: {
        paths: ["/values"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }, {
      authenticate: {
        paths: ["/__proto__/value"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }, {
      authenticate: {
        paths: ["/metadata/secret", "/metadata/secret"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }, {
      authenticate: {
        paths: ["/metadata", "/metadata/secret"],
        handling: { persistence: "none" as const, sharing: "private" as const }
      }
    }];
    for (const protectedToolArguments of invalidDeclarations) {
      const [server] = await loadMcpServers({
        servers: {
          trusted: {
            transport: "http",
            url: "https://mcp.example.test",
            protectedToolArguments
          }
        },
        fetch: capabilityFetch
      });
      expect(server?.snapshot).toMatchObject({ available: false });
      expect(server?.snapshot.error).toMatch(/unknown tool|invalid|does not match the input schema/u);
      expect(server?.snapshot.error).not.toContain("/");
      expect(server?.tools).toEqual([]);
    }
  });

  it("rejects missing, duplicate, or risk-conflicting verification relationships", async () => {
    const configs = [{
      toolRiskClasses: {
        authenticate: "external-side-effect" as const,
        verifyAuthentication: "read-only-network" as const
      },
      toolVerificationRelationships: { verifyAuthentication: ["missingMutation"] }
    }, {
      toolRiskClasses: {
        authenticate: "external-side-effect" as const,
        verifyAuthentication: "read-only-network" as const
      },
      toolVerificationRelationships: { verifyAuthentication: ["authenticate", "authenticate"] }
    }, {
      toolRiskClasses: {
        authenticate: "external-side-effect" as const,
        verifyAuthentication: "external-side-effect" as const
      },
      toolVerificationRelationships: { verifyAuthentication: ["authenticate"] }
    }];
    for (const config of configs) {
      const [server] = await loadMcpServers({
        servers: {
          trusted: {
            transport: "http",
            url: "https://mcp.example.test",
            ...config
          }
        },
        fetch: capabilityFetch
      });
      expect(server?.snapshot.available).toBe(false);
      expect(server?.snapshot.error).toMatch(/verification|unknown tool/u);
      expect(server?.tools).toEqual([]);
    }
  });
});
