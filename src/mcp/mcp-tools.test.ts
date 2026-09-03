import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/artifact-store.js";
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
    getEnvironments: "read-only-network",
    getEnvironment: "read-only-network",
    createCollection: "external-side-effect",
    putCollection: "external-side-effect",
    createEnvironment: "external-side-effect",
    putEnvironment: "external-side-effect"
  } as const;

  it("classifies configured Postman reads as read-only and mutations as consequential", () => {
    const config = { toolRiskClasses: postmanRiskClasses };
    expect(resolveMcpToolRiskClass(config, "stdio", "getAuthenticatedUser")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getWorkspaces")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getCollections")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getCollection")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getEnvironments")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "getEnvironment")).toBe("read-only-network");
    expect(resolveMcpToolRiskClass(config, "stdio", "createCollection")).toBe("external-side-effect");
    expect(resolveMcpToolRiskClass(config, "stdio", "putCollection")).toBe("external-side-effect");
    expect(resolveMcpToolRiskClass(config, "stdio", "createEnvironment")).toBe("external-side-effect");
    expect(resolveMcpToolRiskClass(config, "stdio", "putEnvironment")).toBe("external-side-effect");
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

  it("removes reviewed fields from structured MCP results before model delivery", () => {
    const secret = "postman-environment-secret-that-must-not-survive";
    const result = normalizeMcpResult({
      content: [{
        type: "text",
        text: JSON.stringify({
          environment: {
            name: "Service credentials",
            values: [
              { key: "service_client_id", type: "secret", value: secret },
              { key: "service_client_secret", type: "secret", value: `${secret}-two` },
            ],
          },
        }),
      }],
      structuredContent: { unsafeEcho: secret },
    }, ["/environment/values/*/value"]);

    expect(result).toMatchObject({ ok: true, metadata: { resultRedactionApplied: true } });
    expect(result.content).toContain("Service credentials");
    expect(result.content).toContain("service_client_id");
    expect(result.content).toContain('"type": "secret"');
    expect(result.content).toContain("[PROTECTED_VALUE]");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.metadata).not.toHaveProperty("structuredContent");
  });

  it("withholds an MCP result when reviewed structural redaction cannot be applied", () => {
    const secret = "unstructured-secret-that-must-not-survive";
    const result = normalizeMcpResult({
      content: [{ type: "text", text: `unstructured response ${secret}` }],
    }, ["/environment/values/*/value"]);

    expect(result).toEqual({
      ok: false,
      content: "MCP response withheld because its configured result redaction could not be applied safely.",
      metadata: { resultRedactionApplied: false },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("emits only reviewed non-secret continuity scalars after result redaction", () => {
    const secret = "sk-secret1234567890abcdef";
    const result = normalizeMcpResult({
      content: [{
        type: "text",
        text: JSON.stringify({
          workspaces: [{ id: "workspace-fixture", name: "Developer Workspace", note: "unreviewed user text" }],
          environment: { values: [{ value: secret }] },
        }),
      }],
      _estacoda_continuity_facts: [{ field: "workspaceId", value: "injected", kind: "identifier" }],
    }, ["/environment/values/*/value"], ["/workspaces/*/id", "/workspaces/*/name"]);

    expect(result.metadata?._estacoda_continuity_facts).toEqual([
      { field: "workspaceId", value: "workspace-fixture", kind: "identifier" },
      { field: "workspaceName", value: "Developer Workspace", kind: "label" },
    ]);
    expect(JSON.stringify(result.metadata?._estacoda_continuity_facts)).not.toContain("unreviewed user text");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result.metadata?._estacoda_continuity_facts)).not.toContain("injected");
  });

  it("does not retain a credential-like value even from a reviewed continuity path", () => {
    const result = normalizeMcpResult({
      content: [{ type: "text", text: JSON.stringify({ workspace: { id: "sk-secret1234567890abcdef" } }) }],
    }, [], ["/workspace/id"]);

    expect(result.metadata).not.toHaveProperty("_estacoda_continuity_facts");
  });

  it("extracts only configured continuity fields from a connector Markdown table", () => {
    const result = normalizeMcpResult({
      content: [{
        type: "text",
        text: [
          "# Workspaces",
          "",
          "## Meta",
          "",
          "| id | name | about |",
          "|---|---|---|",
          "| 065bef6d-e09b-49d6-8702-543f375a2fcb | Insert Disks Workspace | |",
          "| sk-secret1234567890abcdef | Visible safe label | ignored |",
          "",
          "# Unrelated",
          "| id | name |",
          "|---|---|",
          "| unrelated-id | Wrong table |"
        ].join("\n")
      }]
    }, [], ["/workspaces/*/id", "/workspaces/*/name"]);

    expect(result.metadata?._estacoda_continuity_facts).toEqual([
      { field: "workspaceId", value: "065bef6d-e09b-49d6-8702-543f375a2fcb", kind: "identifier" },
      { field: "workspaceName", value: "Insert Disks Workspace", kind: "label" },
      { field: "workspaceName", value: "Visible safe label", kind: "label" }
    ]);
    expect(JSON.stringify(result.metadata?._estacoda_continuity_facts)).not.toContain("sk-secret");
    expect(JSON.stringify(result.metadata?._estacoda_continuity_facts)).not.toContain("unrelated-id");
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
      configured: true,
      enabled: true,
      connected: false,
      schemasRegistered: false,
      available: false,
      failureStage: "configuration",
      error: "MCP environment variable POSTMAN_API_KEY is not set.",
    });
  });

  it("keeps disabled connectors discoverable without attempting startup", async () => {
    const [loaded] = await loadMcpServers({
      servers: { postman: { enabled: false, command: "must-not-run" } }
    });

    expect(loaded?.snapshot).toMatchObject({
      name: "postman",
      configured: true,
      enabled: false,
      connected: false,
      schemasRegistered: false,
      available: false,
      failureStage: "configuration"
    });
  });

  it("distinguishes a connected server that registered no callable schemas", async () => {
    const [loaded] = await loadMcpServers({
      servers: { postman: { transport: "http", url: "https://mcp.example.test" } },
      fetch: async (_url, init) => {
        const payload = JSON.parse(init?.body ?? "{}") as { id?: number; method?: string };
        const result = payload.method === "initialize"
          ? { capabilities: { tools: {} } }
          : payload.method === "tools/list"
            ? { tools: [] }
            : {};
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ jsonrpc: "2.0", id: payload.id, result }),
          text: async () => ""
        };
      }
    });

    expect(loaded?.snapshot).toMatchObject({
      configured: true,
      enabled: true,
      connected: true,
      schemasRegistered: false,
      available: false,
      failureStage: "availability",
      error: "MCP server registered no callable tool schemas."
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
        artifactRelayConfigured: false,
        resultRedactionConfigured: false,
        continuityConfigured: false,
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
      artifactRelayConfigured: false,
      resultRedactionConfigured: false,
      continuityConfigured: false,
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
      expect(server?.snapshot).toMatchObject({
        connected: true,
        schemasRegistered: false,
        available: false,
        failureStage: "schema-registration"
      });
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

  it("validates the reviewed Postman protected-transfer recipe against discovered schemas", async () => {
    const [server] = await loadMcpServers({
      servers: {
        postman: postmanProtectedTransferConfig,
      },
      fetch: createPostmanCapabilityFetch(),
    });

    expect(server?.snapshot).toMatchObject({
      available: true,
      capabilities: {
        protectedDeliveryConfigured: true,
        groupedDeliverySupported: true,
        browserRelaySupported: true,
        artifactRelayConfigured: true,
        resultRedactionConfigured: true,
        continuityConfigured: true,
        verificationConfigured: true,
      },
    });
    for (const toolName of ["createEnvironment", "putEnvironment"] as const) {
      const tool = server?.tools.find((candidate) => candidate.name === `mcp.postman.${toolName}`);
      expect(tool?.riskClass).toBe("external-side-effect");
      expect(tool?.protectedArguments).toEqual([{
        path: "/environment/values/*/value",
        handling: { persistence: "destination-managed", sharing: "workspace" },
        destination: { type: "mcp-argument", serverId: "postman", toolName },
      }]);
      expect(tool?.capabilityMetadata).toEqual({
        protectedInput: { groupedDelivery: true, sources: ["browser"] },
      });
    }
    expect(server?.tools.find((tool) => tool.name === "mcp.postman.getEnvironment")?.capabilityMetadata)
      .toEqual({
        verification: {
          verifies: ["mcp.postman.createEnvironment", "mcp.postman.putEnvironment"],
        },
        resultRedaction: {
          paths: ["/environment/values/*/value"],
        },
      });
    expect(server?.tools.find((tool) => tool.name === "mcp.postman.getCollection")?.capabilityMetadata)
      .toEqual({
        verification: {
          verifies: ["mcp.postman.createCollection", "mcp.postman.putCollection"],
        },
      });
    const createSpec = server?.tools.find((tool) => tool.name === "mcp.postman.createSpec");
    expect(createSpec?.riskClass).toBe("external-side-effect");
    expect(createSpec?.capabilityMetadata).toEqual({
      artifactInput: { paths: ["/files/*/content"] },
    });
    expect(JSON.stringify(createSpec?.inputSchema)).toContain("artifactInput");
    expect(server?.tools.find((tool) => tool.name === "mcp.postman.getSpec")?.capabilityMetadata)
      .toEqual({ verification: { verifies: ["mcp.postman.createSpec"] } });
    const workspaces = await server?.tools.find((tool) => tool.name === "mcp.postman.getWorkspaces")?.run({});
    expect(workspaces?.metadata?._estacoda_continuity_facts).toEqual([
      { field: "workspaceId", value: "workspace-fixture", kind: "identifier" },
      { field: "workspaceName", value: "Developer Workspace", kind: "label" },
    ]);
    expect(JSON.stringify(workspaces?.metadata?._estacoda_continuity_facts)).not.toContain("unreviewed");
    const readBack = await server?.tools.find((tool) => tool.name === "mcp.postman.getEnvironment")
      ?.run({ environmentId: "environment-fixture" });
    expect(readBack).toMatchObject({
      ok: true,
      metadata: { resultRedactionApplied: true },
    });
    expect(readBack?.content).toContain("service_client_id");
    expect(readBack?.content).toContain('"type": "secret"');
    expect(readBack?.content).toContain("[PROTECTED_VALUE]");
    expect(JSON.stringify(readBack)).not.toContain(POSTMAN_READ_BACK_SECRET);
    await server?.stop();
  });

  it("fails the reviewed Postman recipe closed when the protected schema path changes", async () => {
    const [server] = await loadMcpServers({
      servers: {
        postman: postmanProtectedTransferConfig,
      },
      fetch: createPostmanCapabilityFetch({ omitEnvironmentValue: true }),
    });

    expect(server?.snapshot).toMatchObject({ available: false });
    expect(server?.snapshot.error).toMatch(/does not match the input schema/u);
    expect(server?.snapshot.error).not.toContain("/environment/values");
    expect(server?.tools).toEqual([]);
  });

  it("fails the reviewed Postman recipe closed when the spec content path changes", async () => {
    const [server] = await loadMcpServers({
      servers: { postman: postmanProtectedTransferConfig },
      fetch: createPostmanCapabilityFetch({ omitSpecContent: true }),
    });

    expect(server?.snapshot).toMatchObject({ available: false });
    expect(server?.snapshot.error).toMatch(/artifact argument mapping does not match the input schema/u);
    expect(server?.snapshot.error).not.toContain("/files");
    expect(server?.tools).toEqual([]);
  });

  it("rejects unknown, duplicate, and overlapping MCP result redaction declarations", async () => {
    const invalidDeclarations: Array<Record<string, string[]>> = [
      { missingTool: ["/environment/values/*/value"] },
      { getEnvironment: ["/environment/values/*/value", "/environment/values/*/value"] },
      { getEnvironment: ["/environment/values", "/environment/values/*/value"] },
    ];
    for (const redactedToolResultPaths of invalidDeclarations) {
      const [server] = await loadMcpServers({
        servers: {
          postman: {
            ...postmanProtectedTransferConfig,
            redactedToolResultPaths,
          },
        },
        fetch: createPostmanCapabilityFetch(),
      });
      expect(server?.snapshot.available).toBe(false);
      expect(server?.snapshot.error).toMatch(/unknown tool|result redaction/u);
      expect(server?.snapshot.error).not.toContain("/environment/values");
      expect(server?.tools).toEqual([]);
    }
  });

  it("rejects unknown, sensitive, duplicate, and overlapping MCP continuity declarations", async () => {
    const invalidDeclarations: Array<Record<string, string[]>> = [
      { missingTool: ["/workspaces/*/id"] },
      { getWorkspaces: ["/credentials/token"] },
      { getWorkspaces: ["/workspaces/*/id", "/workspaces/*/id"] },
      { getWorkspaces: ["/workspaces", "/workspaces/*/id"] },
      { getWorkspaces: ["/workspaces/*/description"] },
    ];
    for (const continuityToolResultPaths of invalidDeclarations) {
      const [server] = await loadMcpServers({
        servers: {
          postman: {
            ...postmanProtectedTransferConfig,
            continuityToolResultPaths,
          },
        },
        fetch: createPostmanCapabilityFetch(),
      });
      expect(server?.snapshot.available).toBe(false);
      expect(server?.snapshot.error).toMatch(/unknown tool|continuity/u);
      expect(server?.snapshot.error).not.toContain("/workspaces");
      expect(server?.tools).toEqual([]);
    }
  });
});

describe("MCP governed artifact relay", () => {
  it("reuses a hydrated session artifact after runtime recreation without another download", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-mcp-artifact-resume-"));
    try {
      const content = JSON.stringify({ openapi: "3.1.0", paths: {} });
      const sha256 = createHash("sha256").update(content).digest("hex");
      const capturePath = join(root, "capture.json");
      await writeFile(capturePath, content, { mode: 0o600 });
      const events: unknown[] = [];
      const firstStore = new ArtifactStore({
        storageRoot: join(root, "artifacts"),
        id: () => "resumed-api-description",
        storageId: () => "retained-object"
      });
      await firstStore.retainSessionArtifact({
        sessionId: "session-1",
        profileId: "profile-1",
        capturePath,
        kind: "data",
        bytes: Buffer.byteLength(content),
        mimeType: "application/json",
        sha256,
        source: {
          kind: "browser.download",
          description: "Governed browser download.",
          filename: "openapi.json",
          origin: "https://developer.example.test"
        },
        persist: async (artifact) => { events.push({ kind: "session-artifact-registered", artifact }); }
      });

      const recreatedStore = new ArtifactStore({ storageRoot: join(root, "artifacts") });
      await recreatedStore.hydrateSessionArtifacts({
        events,
        sessionId: "session-1",
        profileId: "profile-1"
      });
      let dispatched: Record<string, unknown> | undefined;
      const [server] = await loadMcpServers({
        servers: {
          destination: {
            transport: "http",
            url: "https://mcp.example.test",
            toolRiskClasses: { importSpec: "external-side-effect" },
            artifactToolArguments: {
              importSpec: {
                paths: ["/files/*/content"],
                allowedMimeTypes: ["application/json"],
                maxBytes: 1024
              }
            }
          }
        },
        artifactStore: recreatedStore,
        fetch: artifactRelayFetch((args) => { dispatched = args; })
      });
      const tool = server?.tools.find((candidate) => candidate.name === "mcp.destination.importSpec");
      const result = await tool?.run({ files: [{ path: "openapi.json", content: {
        artifactInput: { reference: "artifact://resumed-api-description", sha256 }
      } }] }, { sessionId: "session-1", profileId: "profile-1" });

      expect(result).toMatchObject({ ok: true, metadata: { artifactRelay: true } });
      expect((dispatched?.files as Array<{ content: string }>)[0]?.content).toBe(content);
      expect(JSON.stringify(result)).not.toContain(root);

      const wrongOwner = await tool?.run({ files: [{ path: "openapi.json", content: {
        artifactInput: { reference: "artifact://resumed-api-description", sha256 }
      } }] }, { sessionId: "session-2", profileId: "profile-1" });
      expect(wrongOwner).toMatchObject({ ok: false, metadata: { reason: "artifact-not-owned-by-current-session" } });
      await server?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects a current-session browser artifact only at a reviewed string path", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-mcp-artifact-"));
    try {
      const content = JSON.stringify({ openapi: "3.1.0", info: { title: "Example", version: "1" }, paths: {} });
      const sha256 = createHash("sha256").update(content).digest("hex");
      const localPath = join(root, "openapi.json");
      await writeFile(localPath, content, { mode: 0o600 });
      const artifactStore = new ArtifactStore({ id: () => "api-description" });
      artifactStore.record({
        path: localPath,
        kind: "data",
        bytes: Buffer.byteLength(content),
        mimeType: "application/json",
        metadata: {
          filename: "openapi.json",
          sha256,
          sourceOrigin: "https://developer.example.test",
          source: "browser.download",
          outcome: "download-completed"
        }
      });
      let dispatched: Record<string, unknown> | undefined;
      const [server] = await loadMcpServers({
        servers: {
          destination: {
            transport: "http",
            url: "https://mcp.example.test",
            toolRiskClasses: { importSpec: "external-side-effect" },
            artifactToolArguments: {
              importSpec: {
                paths: ["/files/*/content"],
                allowedMimeTypes: ["application/json", "application/yaml"],
                maxBytes: 12 * 1024 * 1024
              }
            }
          }
        },
        artifactStore,
        fetch: artifactRelayFetch((args) => { dispatched = args; }, content)
      });
      const tool = server?.tools.find((candidate) => candidate.name === "mcp.destination.importSpec");
      expect(server?.snapshot.capabilities.artifactRelayConfigured).toBe(true);
      expect(JSON.stringify(tool?.inputSchema)).toContain("artifactInput");

      expect(tool?.operationJournal?.identify({
        name: "Example",
        files: [{
          path: "openapi.json",
          content: { artifactInput: { reference: "artifact://api-description", sha256 } }
        }]
      })).toEqual({
        subjectId: "api-description",
        artifactHash: sha256,
        operationRevision: 1
      });

      const result = await tool?.run({
        name: "Example",
        files: [{
          path: "openapi.json",
          content: {
            artifactInput: {
              reference: "artifact://api-description",
              sha256,
              sourceOrigin: "https://developer.example.test"
            }
          }
        }]
      });

      expect(result).toMatchObject({
        ok: true,
        metadata: {
          _estacoda_continuity_facts: [
            { field: "artifactReference", value: "artifact://api-description", kind: "identifier" },
            { field: "artifactHash", value: sha256, kind: "identifier" }
          ],
          artifactRelay: true,
          artifactCount: 1,
          artifacts: [{
            id: "api-description",
            sha256,
            sourceOrigin: "https://developer.example.test",
            mimeType: "application/json",
            bytes: Buffer.byteLength(content)
          }]
        }
      });
      expect((dispatched?.files as Array<{ content: string }>)[0]?.content).toBe(content);
      expect(JSON.stringify(result)).not.toContain(content);
      expect(result?.content).toContain("[RELAYED_ARTIFACT_CONTENT]");
      await server?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for another store, a changed file, or an unreviewed destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-mcp-artifact-invalid-"));
    try {
      const content = '{"openapi":"3.1.0","paths":{}}';
      const sha256 = createHash("sha256").update(content).digest("hex");
      const localPath = join(root, "openapi.json");
      await writeFile(localPath, content);
      const artifactStore = new ArtifactStore({ id: () => "owned" });
      artifactStore.record({
        path: localPath,
        kind: "data",
        bytes: Buffer.byteLength(content),
        mimeType: "application/json",
        metadata: {
          sha256,
          sourceOrigin: "https://developer.example.test",
          source: "browser.download",
          outcome: "download-completed"
        }
      });
      let dispatchCount = 0;
      const [server] = await loadMcpServers({
        servers: {
          destination: {
            transport: "http",
            url: "https://mcp.example.test",
            artifactToolArguments: {
              importSpec: {
                paths: ["/files/*/content"],
                allowedMimeTypes: ["application/json"],
                maxBytes: 1024
              }
            }
          }
        },
        artifactStore,
        fetch: artifactRelayFetch(() => { dispatchCount += 1; })
      });
      const tool = server?.tools.find((candidate) => candidate.name === "mcp.destination.importSpec");
      const missing = await tool?.run({ files: [{ path: "openapi.json", content: {
        artifactInput: { reference: "artifact://not-in-this-session", sha256 }
      } }] });
      expect(missing).toMatchObject({ ok: false, metadata: { reason: "artifact-not-owned-by-current-session" } });

      await writeFile(localPath, `${content}\nchanged`);
      const changed = await tool?.run({ files: [{ path: "openapi.json", content: {
        artifactInput: { reference: "artifact://owned", sha256 }
      } }] });
      expect(changed).toMatchObject({ ok: false, metadata: { reason: "artifact-file-state-invalid" } });
      expect(dispatchCount).toBe(0);
      await server?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function artifactRelayFetch(
  onCall: (args: Record<string, unknown>) => void,
  echoedContent?: string
) {
  return async (_url: string, init?: { body?: string }) => {
    const payload = JSON.parse(init?.body ?? "{}") as {
      id?: number;
      method?: string;
      params?: { arguments?: Record<string, unknown> };
    };
    const result = payload.method === "initialize"
      ? { capabilities: { tools: {} } }
      : payload.method === "tools/list"
        ? {
            tools: [{
              name: "importSpec",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  files: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { path: { type: "string" }, content: { type: "string" } },
                      required: ["path", "content"]
                    }
                  }
                },
                required: ["files"]
              }
            }]
          }
        : payload.method === "tools/call"
          ? (() => {
              onCall(payload.params?.arguments ?? {});
              return { content: [{ type: "text", text: echoedContent ?? '{"id":"spec-1"}' }] };
            })()
          : {};
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jsonrpc: "2.0", id: payload.id, result }),
      text: async () => ""
    };
  };
}

const postmanProtectedTransferConfig = {
  transport: "http" as const,
  url: "https://postman-mcp.example.test",
  includeTools: [
    "getAuthenticatedUser",
    "getWorkspaces",
    "getCollections",
    "getCollection",
    "getEnvironments",
    "getEnvironment",
    "createCollection",
    "putCollection",
    "createEnvironment",
    "putEnvironment",
    "createSpec",
    "getSpec",
    "generateCollection",
    "getSpecCollections",
  ],
  toolRiskClasses: {
    getAuthenticatedUser: "read-only-network" as const,
    getWorkspaces: "read-only-network" as const,
    getCollections: "read-only-network" as const,
    getCollection: "read-only-network" as const,
    getEnvironments: "read-only-network" as const,
    getEnvironment: "read-only-network" as const,
    createCollection: "external-side-effect" as const,
    putCollection: "external-side-effect" as const,
    createEnvironment: "external-side-effect" as const,
    putEnvironment: "external-side-effect" as const,
    createSpec: "external-side-effect" as const,
    getSpec: "read-only-network" as const,
    generateCollection: "external-side-effect" as const,
    getSpecCollections: "read-only-network" as const,
  },
  artifactToolArguments: {
    createSpec: {
      paths: ["/files/*/content"],
      allowedMimeTypes: ["application/json", "application/yaml"],
      maxBytes: 12 * 1024 * 1024,
    },
  },
  protectedToolArguments: {
    createEnvironment: {
      paths: ["/environment/values/*/value"],
      handling: { persistence: "destination-managed" as const, sharing: "workspace" as const },
      groupedDelivery: true,
      browserRelay: true,
    },
    putEnvironment: {
      paths: ["/environment/values/*/value"],
      handling: { persistence: "destination-managed" as const, sharing: "workspace" as const },
      groupedDelivery: true,
      browserRelay: true,
    },
  },
  redactedToolResultPaths: {
    getEnvironment: ["/environment/values/*/value"],
  },
  continuityToolResultPaths: {
    getWorkspaces: ["/workspaces/*/id", "/workspaces/*/name"],
    getCollection: ["/collection/id", "/collection/name"],
    getEnvironment: ["/environment/id", "/environment/name"],
    getSpec: ["/spec/id"],
  },
  toolVerificationRelationships: {
    getEnvironment: ["createEnvironment", "putEnvironment"],
    getCollection: ["createCollection", "putCollection"],
    getSpec: ["createSpec"],
    getSpecCollections: ["generateCollection"],
  },
};

const POSTMAN_READ_BACK_SECRET = "postman-read-back-secret-that-must-not-survive";

function createPostmanCapabilityFetch(options: { omitEnvironmentValue?: boolean; omitSpecContent?: boolean } = {}) {
  return async (_url: string, init?: { body?: string }) => {
    const payload = JSON.parse(init?.body ?? "{}") as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    const result = payload.method === "initialize"
      ? { capabilities: { tools: {} } }
      : payload.method === "tools/list"
        ? { tools: postmanTools(options) }
        : payload.method === "tools/call" && payload.params?.name === "getWorkspaces"
          ? {
              content: [{
                type: "text",
                text: JSON.stringify({
                  workspaces: [{ id: "workspace-fixture", name: "Developer Workspace", note: "unreviewed" }],
                }),
              }],
            }
          : payload.method === "tools/call" && payload.params?.name === "getEnvironment"
          ? {
              content: [{
                type: "text",
                text: JSON.stringify({
                  environment: {
                    id: "environment-fixture",
                    name: "Service credentials",
                    values: [{
                      enabled: true,
                      key: "service_client_id",
                      type: "secret",
                      value: POSTMAN_READ_BACK_SECRET,
                    }],
                  },
                }),
              }],
            }
          : {};
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jsonrpc: "2.0", id: payload.id, result }),
      text: async () => "",
    };
  };
}

function postmanTools(options: { omitEnvironmentValue?: boolean; omitSpecContent?: boolean }) {
  const environmentItemProperties = {
    enabled: { type: "boolean" },
    key: { type: "string" },
    type: { type: "string", enum: ["secret", "default"] },
    ...(options.omitEnvironmentValue === true ? {} : { value: { type: "string" } }),
  };
  const environmentSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      values: {
        type: "array",
        items: {
          type: "object",
          properties: environmentItemProperties,
        },
      },
    },
  };
  const schemas: Record<string, Record<string, unknown>> = {
    getAuthenticatedUser: { type: "object", properties: {} },
    getWorkspaces: { type: "object", properties: {} },
    getCollections: { type: "object", properties: { workspace: { type: "string" } } },
    getCollection: { type: "object", properties: { collectionId: { type: "string" } }, required: ["collectionId"] },
    getEnvironments: { type: "object", properties: { workspace: { type: "string" } } },
    getEnvironment: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"] },
    createCollection: { type: "object", properties: { workspace: { type: "string" }, collection: { type: "object" } }, required: ["workspace", "collection"] },
    putCollection: { type: "object", properties: { collectionId: { type: "string" }, collection: { type: "object" } }, required: ["collectionId", "collection"] },
    createEnvironment: { type: "object", properties: { workspace: { type: "string" }, environment: environmentSchema }, required: ["workspace"] },
    putEnvironment: { type: "object", properties: { environmentId: { type: "string" }, environment: environmentSchema }, required: ["environmentId"] },
    createSpec: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        files: {
          type: "array",
          items: {
            oneOf: [{
              type: "object",
              properties: {
                path: { type: "string" },
                ...(options.omitSpecContent === true ? {} : { content: { type: "string" } }),
                type: { type: "string" }
              },
              required: ["path", "content", "type"]
            }, {
              type: "object",
              properties: {
                path: { type: "string" },
                ...(options.omitSpecContent === true ? {} : { content: { type: "string" } })
              },
              required: ["path", "content"]
            }]
          }
        }
      },
      required: ["workspaceId", "name", "type", "files"]
    },
    getSpec: { type: "object", properties: { specId: { type: "string" } }, required: ["specId"] },
    generateCollection: { type: "object", properties: { specId: { type: "string" }, name: { type: "string" } }, required: ["specId", "name"] },
    getSpecCollections: { type: "object", properties: { specId: { type: "string" } }, required: ["specId"] },
  };
  return Object.entries(schemas).map(([name, inputSchema]) => ({
    name,
    description: `Sanitized Postman ${name} fixture.`,
    inputSchema,
  }));
}
