import type { MCPServerConfig } from "../config/runtime-config.js";
import type { RegisteredTool, ToolResult, ToolRiskClass } from "../contracts/tool.js";
import { redactObject } from "../utils/redaction.js";
import { MCPClient, type MCPFetchLike, type MCPPromptDescriptor, type MCPResourceDescriptor, type MCPToolDescriptor } from "./mcp-client.js";

export type MCPServerSnapshot = {
  name: string;
  transport: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: string[];
  available: boolean;
  error?: string;
};

export type LoadedMCPServer = {
  name: string;
  client: MCPClient;
  tools: RegisteredTool[];
  snapshot: MCPServerSnapshot;
  stop(): Promise<void>;
};

export async function loadMcpServers(input: {
  servers: Record<string, MCPServerConfig>;
  fetch?: MCPFetchLike;
  environment?: NodeJS.ProcessEnv;
}): Promise<LoadedMCPServer[]> {
  const loaded: LoadedMCPServer[] = [];

  for (const [name, config] of Object.entries(input.servers)) {
    if (config.enabled === false) {
      continue;
    }
    const transport = config.transport ?? "stdio";
    if (transport === "stdio" && (typeof config.command !== "string" || config.command.trim().length === 0)) {
      loaded.push(unavailableServer(name, config, "MCP stdio server requires a command."));
      continue;
    }
    if (transport === "http" && (typeof config.url !== "string" || config.url.trim().length === 0)) {
      loaded.push(unavailableServer(name, config, "MCP HTTP server requires a url."));
      continue;
    }
    const resolvedEnvironment = resolveMcpEnvironment(config, input.environment ?? process.env);
    if (!resolvedEnvironment.ok) {
      loaded.push(unavailableServer(name, config, resolvedEnvironment.error));
      continue;
    }

    const client = new MCPClient({
      name,
      transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: resolvedEnvironment.env,
      url: config.url,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      fetch: input.fetch
    });

    try {
      await client.start();
      const allTools = await client.listTools();
      const filteredTools = filterTools(allTools, config);
      const resources = resourcesEnabled(config) && client.capabilities.resources !== undefined
        ? await client.listResources().catch(() => [])
        : [];
      const prompts = promptsEnabled(config) && client.capabilities.prompts !== undefined
        ? await client.listPrompts().catch(() => [])
        : [];
      const tools = [
        ...filteredTools.map((tool) => createMcpTool(name, config, client, tool)),
        ...(resources.length === 0 ? [] : createResourceTools(name, config, client, resources)),
        ...(prompts.length === 0 ? [] : createPromptTools(name, config, client, prompts))
      ];

      loaded.push({
        name,
        client,
        tools,
        snapshot: {
          name,
          transport,
          toolCount: filteredTools.length,
          resourceCount: resources.length,
          promptCount: prompts.length,
          tools: tools.map((tool) => tool.name),
          available: true
        },
        stop: () => client.stop()
      });
    } catch (error) {
      await client.stop().catch(() => undefined);
      loaded.push(unavailableServer(name, config, error instanceof Error ? error.message : String(error)));
    }
  }

  return loaded;
}

export type ResolvedMcpEnvironment =
  | { readonly ok: true; readonly env: Record<string, string> | undefined }
  | { readonly ok: false; readonly error: string };

export function resolveMcpEnvironment(
  config: Pick<MCPServerConfig, "env" | "envRefs">,
  environment: NodeJS.ProcessEnv
): ResolvedMcpEnvironment {
  const refs = Object.entries(config.envRefs ?? {});
  if (refs.length === 0) {
    return { ok: true, env: config.env };
  }

  const resolved = { ...(config.env ?? {}) };
  for (const [targetName, sourceName] of refs) {
    if (!isEnvironmentVariableName(targetName) || !isEnvironmentVariableName(sourceName)) {
      return { ok: false, error: `MCP environment reference ${targetName} is invalid.` };
    }
    const value = environment[sourceName];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `MCP environment variable ${sourceName} is not set.` };
    }
    resolved[targetName] = value;
  }

  return { ok: true, env: resolved };
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function unavailableServer(name: string, config: MCPServerConfig, error: string): LoadedMCPServer {
  return {
    name,
    client: {
      stop: async () => undefined
    } as unknown as MCPClient,
    tools: [],
    snapshot: {
      name,
      transport: config.transport ?? "stdio",
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      tools: [],
      available: false,
      error
    },
    stop: async () => undefined
  };
}

function createMcpTool(
  serverName: string,
  config: MCPServerConfig,
  client: MCPClient,
  tool: MCPToolDescriptor
): RegisteredTool {
  const toolName = prefixTool(serverName, config, tool.name);
  const riskClass = resolveMcpToolRiskClass(config, client.transport, tool.name);
  const protectedPaths = config.protectedToolArguments?.[tool.name] ?? [];
  return {
    name: toolName,
    description: mcpToolDescription(serverName, tool, riskClass),
    inputSchema: addProtectedArgumentEnvelopes(tool.inputSchema ?? {
      type: "object",
      additionalProperties: true
    }, protectedPaths),
    riskClass,
    toolsets: ["mcp"],
    progressLabel: `calling MCP ${serverName}`,
    maxResultSizeChars: 12_000,
    protectedArguments: protectedPaths.map((path) => ({
      path,
      destination: { type: "mcp-argument" as const, serverId: serverName, toolName: tool.name }
    })),
    isAvailable: () => true,
    run: async (input: Record<string, unknown>) => {
      const result = await client.callTool(tool.name, input);
      return normalizeMcpResult(result);
    }
  };
}

function addProtectedArgumentEnvelopes(schema: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0 || typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const clone = structuredClone(schema) as Record<string, unknown>;
  for (const path of paths) {
    const segments = path.split(".");
    let node: Record<string, unknown> = clone;
    for (let index = 0; index < segments.length; index += 1) {
      const properties = typeof node.properties === "object" && node.properties !== null && !Array.isArray(node.properties)
        ? node.properties as Record<string, unknown>
        : undefined;
      if (properties === undefined) break;
      const key = segments[index];
      const property = properties[key];
      if (typeof property !== "object" || property === null || Array.isArray(property)) break;
      if (index === segments.length - 1) {
        properties[key] = {
          oneOf: [property, protectedArgumentEnvelopeSchema()]
        };
      } else {
        node = property as Record<string, unknown>;
      }
    }
  }
  return clone;
}

function protectedArgumentEnvelopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      protectedInput: {
        type: "object",
        properties: {
          kind: { type: "string" },
          purpose: { type: "string" },
          retention: { type: "string", enum: ["use-once"] }
        },
        required: ["kind"]
      }
    },
    required: ["protectedInput"]
  };
}

function mcpToolDescription(
  serverName: string,
  tool: MCPToolDescriptor,
  riskClass: ToolRiskClass
): string {
  const base = tool.description ?? `Call MCP tool ${tool.name} from ${serverName}.`;
  if (riskClass !== "read-only-local" && riskClass !== "read-only-network") return base;
  const detailGuidance = /getCollection$/iu.test(tool.name)
    ? " Prefer collection outlines and request metadata when sufficient; request full collection detail only when exact bodies or definitions are required."
    : "";
  return `${base}${detailGuidance} Identical confirmed reads are reused within the current turn; do not poll unchanged facts.`;
}

export function resolveMcpToolRiskClass(
  config: MCPServerConfig,
  transport: "stdio" | "http",
  toolName: string
): ToolRiskClass {
  if (config.toolRiskClasses !== undefined) {
    return config.toolRiskClasses[toolName] ?? defaultMcpRisk(config, transport, "tool");
  }
  return config.toolRiskClass ?? defaultMcpRisk(config, transport, "tool");
}

function createResourceTools(
  serverName: string,
  config: MCPServerConfig,
  client: MCPClient,
  resources: MCPResourceDescriptor[]
): RegisteredTool[] {
  return [
    {
      name: prefixTool(serverName, config, "resource.list"),
      description: `List MCP resources exposed by ${serverName}.`,
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: listWrapperRisk(client.transport),
      toolsets: ["mcp"],
      progressLabel: `listing MCP resources`,
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async () => ({
        ok: true,
        content: resources.length === 0
          ? "No MCP resources available."
          : resources.map((resource) => `${resource.name ?? resource.uri}\t${resource.uri}\t${resource.mimeType ?? "unknown"}`).join("\n"),
        metadata: {
          resources
        }
      })
    },
    {
      name: prefixTool(serverName, config, "resource.read"),
      description: `Read an MCP resource from ${serverName} by URI.`,
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string" }
        },
        required: ["uri"]
      },
      riskClass: config.resourceReadRiskClass ?? defaultMcpRisk(config, client.transport, "resource"),
      toolsets: ["mcp"],
      progressLabel: `reading MCP resource`,
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { uri?: string }) => {
        if (typeof input.uri !== "string" || input.uri.trim().length === 0) {
          return {
            ok: false,
            content: "resource.read requires uri"
          };
        }
        const result = await client.readResource(input.uri);
        return normalizeMcpResult(result);
      }
    }
  ];
}

function createPromptTools(
  serverName: string,
  config: MCPServerConfig,
  client: MCPClient,
  prompts: MCPPromptDescriptor[]
): RegisteredTool[] {
  return [
    {
      name: prefixTool(serverName, config, "prompt.list"),
      description: `List MCP prompts exposed by ${serverName}.`,
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: listWrapperRisk(client.transport),
      toolsets: ["mcp"],
      progressLabel: `listing MCP prompts`,
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async () => ({
        ok: true,
        content: prompts.length === 0
          ? "No MCP prompts available."
          : prompts.map((prompt) => `${prompt.name}\t${prompt.description ?? ""}`).join("\n"),
        metadata: {
          prompts
        }
      })
    },
    {
      name: prefixTool(serverName, config, "prompt.get"),
      description: `Get an MCP prompt from ${serverName} by name.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: {
            type: "object",
            additionalProperties: true
          }
        },
        required: ["name"]
      },
      riskClass: config.promptGetRiskClass ?? defaultMcpRisk(config, client.transport, "prompt"),
      toolsets: ["mcp"],
      progressLabel: `getting MCP prompt`,
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { name?: string; arguments?: Record<string, unknown> }) => {
        if (typeof input.name !== "string" || input.name.trim().length === 0) {
          return {
            ok: false,
            content: "prompt.get requires name"
          };
        }
        const result = await client.getPrompt(input.name, input.arguments ?? {});
        return normalizeMcpResult(result);
      }
    }
  ];
}

function defaultMcpRisk(
  config: MCPServerConfig,
  transport: "stdio" | "http",
  target: "tool" | "resource" | "prompt"
): ToolRiskClass {
  const trust = config.trust ?? "conservative";

  if (trust === "read-only-local") {
    return "read-only-local";
  }

  if (trust === "read-only-network") {
    return "read-only-network";
  }

  if (target === "resource" && transport === "http") {
    return "read-only-network";
  }

  return "external-side-effect";
}

function listWrapperRisk(transport: "stdio" | "http"): ToolRiskClass {
  return transport === "http" ? "read-only-network" : "read-only-local";
}

function prefixTool(serverName: string, config: MCPServerConfig, toolName: string): string {
  const toolPrefix = config.toolPrefix ?? config.tools?.prefix;
  if (toolPrefix === false) {
    return toolName;
  }
  if (typeof toolPrefix === "string" && toolPrefix.trim().length > 0) {
    return `${toolPrefix.trim()}.${toolName}`;
  }
  return `mcp.${serverName}.${toolName}`;
}

function filterTools(tools: MCPToolDescriptor[], config: MCPServerConfig): MCPToolDescriptor[] {
  const include = new Set(config.includeTools ?? config.tools?.include ?? []);
  const exclude = new Set(config.excludeTools ?? config.tools?.exclude ?? []);
  return tools.filter((tool) => {
    if (include.size > 0 && !include.has(tool.name)) {
      return false;
    }
    if (exclude.has(tool.name)) {
      return false;
    }
    return true;
  });
}

function resourcesEnabled(config: MCPServerConfig): boolean {
  return config.exposeResources ?? config.tools?.resources ?? false;
}

function promptsEnabled(config: MCPServerConfig): boolean {
  return config.exposePrompts ?? config.tools?.prompts ?? false;
}

export function normalizeMcpResult(result: unknown): ToolResult {
  if (typeof result === "string") {
    return {
      ok: true,
      content: result
    };
  }

  if (typeof result !== "object" || result === null) {
    return {
      ok: true,
      content: JSON.stringify(result, null, 2)
    };
  }

  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? record.content.map(renderContentPart).filter((part) => part.length > 0).join("\n\n")
    : undefined;
  const isError = record.isError === true;
  const rendered = content?.length ? content : JSON.stringify(result, null, 2);
  const structuralSummary = mcpStructuralSummary(rendered);
  const {
    content: _rawContent,
    _estacoda_context_summary: _untrustedContextSummary,
    ...boundedMetadata
  } = record;

  return {
    ok: !isError,
    content: rendered.length > 1_800 && structuralSummary !== undefined
      ? [
          "MCP structural summary (request narrower or explicit full detail only when omitted fields are required):",
          structuralSummary,
          "",
          "Full MCP response:",
          rendered
        ].join("\n")
      : rendered,
    metadata: {
      ...boundedMetadata,
      ...(structuralSummary === undefined ? {} : { _estacoda_context_summary: structuralSummary })
    }
  };
}

function mcpStructuralSummary(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.length > 1_800
      ? `MCP response contains ${content.length} unstructured characters; exact content was delivered in the current tool result.`
      : undefined;
  }

  const summary = JSON.stringify(summarizeMcpValue(redactObject(parsed, { strict: true }), 0), null, 2);
  return summary.length <= 1_200 ? summary : `${summary.slice(0, 1_200)}\n[structural summary truncated]`;
}

function summarizeMcpValue(value: unknown, depth: number): unknown {
  if (depth >= 4) {
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === "object" && value !== null) return `{${Object.keys(value).length} fields}`;
  }
  if (Array.isArray(value)) {
    return {
      count: value.length,
      items: value.slice(0, 12).map((item) => summarizeMcpValue(item, depth + 1)),
      ...(value.length > 12 ? { omitted: value.length - 12 } : {})
    };
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 30).map(([key, entry]) => [key, summarizeMcpValue(entry, depth + 1)])
    );
  }
  if (typeof value === "string") {
    return value.length <= 180 ? value : `${value.slice(0, 180)}...`;
  }
  return value;
}

function renderContentPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (typeof part !== "object" || part === null) {
    return JSON.stringify(part, null, 2);
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (record.type === "resource" && typeof record.uri === "string") {
    return `Resource: ${record.uri}`;
  }
  if (record.type === "image" && typeof record.mimeType === "string") {
    return `Image content (${record.mimeType})`;
  }
  return JSON.stringify(part, null, 2);
}
