import { parsePollingCoordinates } from "../contracts/execution-checkpoint.js";
import { isMcpArtifactTypeMapping } from "../config/runtime-config.js";
import { inspectBrowserDownload } from "../artifacts/browser-download-validation.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { MCPServerConfig } from "../config/runtime-config.js";
import type { RegisteredTool, RuntimeContinuityFact, ToolResult, ToolRiskClass } from "../contracts/tool.js";
import { parseProtectedArgumentPattern } from "../security/protected-argument-path.js";
import { redactObject, redactSensitiveText } from "../utils/redaction.js";
import { MCPClient, type MCPFetchLike, type MCPPromptDescriptor, type MCPResourceDescriptor, type MCPToolDescriptor } from "./mcp-client.js";
import { sanitizeMcpDiagnostic } from "./mcp-diagnostics.js";

export type MCPServerSnapshot = {
  name: string;
  transport: string;
  configured: true;
  enabled: boolean;
  connected: boolean;
  schemasRegistered: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: string[];
  capabilities: MCPServerCapabilitySummary;
  available: boolean;
  failureStage?: "configuration" | "connection" | "schema-registration" | "availability";
  error?: string;
};

export type MCPServerCapabilitySummary = {
  protectedDeliveryConfigured: boolean;
  groupedDeliverySupported: boolean;
  browserRelaySupported: boolean;
  artifactRelayConfigured: boolean;
  resultRedactionConfigured: boolean;
  continuityConfigured: boolean;
  verificationConfigured: boolean;
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
  artifactStore?: ArtifactStore;
}): Promise<LoadedMCPServer[]> {
  const loaded: LoadedMCPServer[] = [];

  for (const [name, config] of Object.entries(input.servers)) {
    if (config.enabled === false) {
      loaded.push(unavailableServer(name, config, "MCP server is disabled.", {
        failureStage: "configuration"
      }));
      continue;
    }
    const transport = config.transport ?? "stdio";
    if (transport === "stdio" && (typeof config.command !== "string" || config.command.trim().length === 0)) {
      loaded.push(unavailableServer(name, config, "MCP stdio server requires a command.", {
        failureStage: "configuration"
      }));
      continue;
    }
    if (transport === "http" && (typeof config.url !== "string" || config.url.trim().length === 0)) {
      loaded.push(unavailableServer(name, config, "MCP HTTP server requires a url.", {
        failureStage: "configuration"
      }));
      continue;
    }
    const resolvedEnvironment = resolveMcpEnvironment(config, input.environment ?? process.env);
    if (!resolvedEnvironment.ok) {
      loaded.push(unavailableServer(name, config, resolvedEnvironment.error, {
        failureStage: "configuration"
      }));
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

    let connected = false;
    try {
      await client.start();
      connected = true;
      const allTools = await client.listTools();
      const capabilityConfigError = validateMcpCapabilityConfiguration(config, allTools);
      if (capabilityConfigError !== undefined) throw new Error(capabilityConfigError);
      const filteredTools = filterTools(allTools, config);
      const resources = resourcesEnabled(config) && client.capabilities.resources !== undefined
        ? await client.listResources().catch(() => [])
        : [];
      const prompts = promptsEnabled(config) && client.capabilities.prompts !== undefined
        ? await client.listPrompts().catch(() => [])
        : [];
      const tools = [
        ...filteredTools.map((tool) => createMcpTool(name, config, client, tool, input.artifactStore)),
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
          configured: true,
          enabled: true,
          connected: true,
          schemasRegistered: tools.length > 0,
          toolCount: filteredTools.length,
          resourceCount: resources.length,
          promptCount: prompts.length,
          tools: tools.map((tool) => tool.name),
          capabilities: summarizeMcpCapabilityConfig(config),
          available: tools.length > 0,
          ...(tools.length > 0 ? {} : {
            failureStage: "availability" as const,
            error: "MCP server registered no callable tool schemas."
          })
        },
        stop: () => client.stop()
      });
    } catch (error) {
      await client.stop().catch(() => undefined);
      loaded.push(unavailableServer(
        name,
        config,
        sanitizeMcpDiagnostic(error instanceof Error ? error.message : String(error), [
          ...Object.values(resolvedEnvironment.env ?? {}), ...Object.values(config.headers ?? {})
        ]),
        {
          connected,
          failureStage: connected ? "schema-registration" : "connection"
        }
      ));
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

function unavailableServer(
  name: string,
  config: MCPServerConfig,
  error: string,
  state: {
    connected?: boolean;
    failureStage: NonNullable<MCPServerSnapshot["failureStage"]>;
  }
): LoadedMCPServer {
  return {
    name,
    client: {
      stop: async () => undefined
    } as unknown as MCPClient,
    tools: [],
    snapshot: {
      name,
      transport: config.transport ?? "stdio",
      configured: true,
      enabled: config.enabled !== false,
      connected: state.connected === true,
      schemasRegistered: false,
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      tools: [],
      capabilities: summarizeMcpCapabilityConfig(config),
      available: false,
      failureStage: state.failureStage,
      error: redactSensitiveText(error)
    },
    stop: async () => undefined
  };
}

function createMcpTool(
  serverName: string,
  config: MCPServerConfig,
  client: MCPClient,
  tool: MCPToolDescriptor,
  artifactStore?: ArtifactStore
): RegisteredTool {
  const toolName = prefixTool(serverName, config, tool.name);
  const riskClass = resolveMcpToolRiskClass(config, client.transport, tool.name);
  const protectedConfig = config.protectedToolArguments?.[tool.name];
  const artifactConfig = config.artifactToolArguments?.[tool.name];
  const redactedResultPaths = config.redactedToolResultPaths?.[tool.name];
  const continuityResultPaths = config.continuityToolResultPaths?.[tool.name];
  const verificationTargets = config.toolVerificationRelationships?.[tool.name]?.map((target) =>
    prefixTool(serverName, config, target)
  );
  const protectedProjection = addProtectedArgumentEnvelopes(tool.inputSchema ?? {
    type: "object",
    additionalProperties: true
  }, protectedConfig?.paths ?? []);
  const artifactProjection = addArtifactArgumentEnvelopes(protectedProjection.schema, artifactConfig?.paths ?? []);
  return {
    name: toolName,
    description: mcpToolDescription(serverName, tool, riskClass),
    inputSchema: artifactProjection.schema,
    riskClass,
    toolsets: ["mcp"],
    connector: mcpConnector(serverName),
    progressLabel: `calling MCP ${serverName}`,
    maxResultSizeChars: 12_000,
    ...(artifactConfig === undefined ? {} : {
      operationJournal: {
        identify: (input: Record<string, unknown>) => artifactOperationIdentity(input, artifactConfig)
      }
    }),
    protectedArguments: protectedProjection.paths.map((path) => ({
      path,
      handling: protectedConfig?.handling ?? { persistence: "unknown", sharing: "unknown" },
      destination: { type: "mcp-argument" as const, serverId: serverName, toolName: tool.name }
    })),
    ...(
      protectedProjection.paths.length === 0 &&
      artifactProjection.paths.length === 0 &&
      redactedResultPaths === undefined &&
      verificationTargets === undefined
        ? {}
        : {
            capabilityMetadata: {
              ...(protectedProjection.paths.length === 0 ? {} : {
                protectedInput: {
                  groupedDelivery: protectedConfig?.groupedDelivery ?? true,
                  sources: protectedConfig?.browserRelay === false ? [] : ["browser" as const]
                }
              }),
              ...(verificationTargets === undefined ? {} : {
                verification: { verifies: verificationTargets }
              }),
              ...(artifactProjection.paths.length === 0 ? {} : {
                artifactInput: { paths: artifactProjection.paths }
              }),
              ...(redactedResultPaths === undefined ? {} : {
                resultRedaction: { paths: [...redactedResultPaths] }
              })
            }
          }
    ),
    isAvailable: () => true,
    run: async (input: Record<string, unknown>, context) => {
      const scope = context?.sessionId === undefined || context.profileId === undefined
        ? undefined
        : { sessionId: context.sessionId, profileId: context.profileId };
      const relay = await resolveArtifactArguments(input, artifactConfig, artifactStore, scope);
      if (!relay.ok) return relay.result;
      let result: unknown;
      try {
        result = await client.callTool(tool.name, relay.input);
      } catch (error) {
        if (relay.artifacts.length === 0) throw error;
        return {
          ok: false,
          content: "The destination connector did not complete the governed artifact relay.",
          metadata: { reason: "artifact-connector-dispatch-failed", artifactRelay: true }
        };
      }
      const relayedContents = relay.artifacts.map((artifact) => artifact.content);
      const normalized = normalizeMcpResult(
        redactRelayedArtifactValue(result, relayedContents),
        redactedResultPaths,
        continuityResultPaths,
        tool.name
      );
      if (verificationTargets !== undefined) {
        const unfinished = structuredMcpContinuityPayloads(result, []).some((payload) => hasUnfinishedVerificationState(payload));
        normalized.metadata = {
          ...normalized.metadata,
          // A 200 response (including an empty list) is not proof of an effect.
          // Use only the operator-reviewed, redacted result projection here.
          _estacoda_verification_evidence: normalized.ok &&
            !unfinished &&
            (normalized.metadata?._estacoda_continuity_facts ?? []).some((fact) => fact.kind === "identifier")
        };
        if (normalized.ok && !normalized.metadata._estacoda_verification_evidence) {
          const reason = unfinished ? "the result reports unfinished or unsuccessful state"
            : (continuityResultPaths?.length ?? 0) === 0 ? "this verifier has no reviewed result-identifier mapping"
            : "no reviewed resource identifier was returned";
          normalized.content += `\n\nVerification remains pending: ${reason}. This does not block independent work. Inspect job status or the destination readback before repeating a mutation.`;
        }
      }
      const polling = normalized.metadata?._estacoda_continuity_facts?.find((fact) => fact.field === "pollingCoordinates");
      const coordinates = parsePollingCoordinates(polling?.value);
      if (coordinates !== undefined) {
        const hint = `Grounded task status arguments for this connector: ${JSON.stringify(coordinates)}. Use its registered status tool; this is not authorization to fetch a URL.`;
        normalized.content += `\n\n${hint}`;
        normalized.metadata = { ...normalized.metadata, _estacoda_context_summary: hint };
      }
      if (!normalized.ok && /\b403\b/u.test(normalized.content)) {
        normalized.content += "\nThis particular request was forbidden. Check its resource type and IDs against the originating receipt before diagnosing connector-wide permissions. Do not repeat identical failed arguments; continue independent work.";
      }
      if (relay.artifacts.length === 0) return normalized;
      const redacted = redactRelayedArtifactContent(normalized, relayedContents);
      const artifactContinuityFacts = relay.artifacts.flatMap(({ id, sha256 }) => [
        { field: "artifactReference", value: `artifact://${id}`, kind: "identifier" as const },
        { field: "artifactHash", value: sha256, kind: "identifier" as const }
      ]);
      return {
        ...redacted,
        metadata: {
          ...redacted.metadata,
          _estacoda_continuity_facts: mergeContinuityFacts(
            redacted.metadata?._estacoda_continuity_facts,
            artifactContinuityFacts
          ),
          artifactRelay: true,
          artifactCount: relay.artifacts.length,
          artifacts: relay.artifacts.map(({ id, sha256, sourceOrigin, mimeType, bytes }) => ({
            id,
            sha256,
            sourceOrigin,
            mimeType,
            bytes
          }))
        }
      };
    }
  };
}

export function summarizeMcpCapabilityConfig(
  config: Pick<MCPServerConfig, "protectedToolArguments" | "artifactToolArguments" | "redactedToolResultPaths" | "continuityToolResultPaths" | "toolVerificationRelationships">
): MCPServerCapabilitySummary {
  const protectedDeclarations = Object.values(config.protectedToolArguments ?? {});
  return {
    protectedDeliveryConfigured: protectedDeclarations.length > 0,
    groupedDeliverySupported: protectedDeclarations.length > 0 &&
      protectedDeclarations.every((declaration) => declaration.groupedDelivery !== false),
    browserRelaySupported: protectedDeclarations.length > 0 &&
      protectedDeclarations.every((declaration) => declaration.browserRelay !== false),
    artifactRelayConfigured: Object.keys(config.artifactToolArguments ?? {}).length > 0,
    resultRedactionConfigured: Object.keys(config.redactedToolResultPaths ?? {}).length > 0,
    continuityConfigured: Object.keys(config.continuityToolResultPaths ?? {}).length > 0,
    verificationConfigured: Object.keys(config.toolVerificationRelationships ?? {}).length > 0
  };
}

export function validateMcpCapabilityConfiguration(
  config: MCPServerConfig,
  tools: readonly MCPToolDescriptor[]
): string | undefined {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const transport = config.transport ?? "stdio";
  for (const toolName of Object.keys(config.toolRiskClasses ?? {})) {
    if (!byName.has(toolName)) return unknownCapabilityTool(toolName);
  }
  for (const [toolName, declaration] of Object.entries(config.protectedToolArguments ?? {})) {
    const tool = byName.get(toolName);
    if (tool === undefined) return unknownCapabilityTool(toolName);
    if (!isMutationMcpRisk(resolveMcpToolRiskClass(config, transport, toolName))) {
      return `MCP protected argument configuration conflicts with the risk class for tool ${boundedToolName(toolName)}.`;
    }
    if (declaration.paths.length === 0 || declaration.paths.length > 8 ||
      declaration.paths.some((path) => parseProtectedArgumentPattern(path) === undefined) ||
      new Set(declaration.paths).size !== declaration.paths.length ||
      protectedPatternsOverlap(declaration.paths)) {
      return `MCP protected argument configuration is invalid for tool ${boundedToolName(toolName)}.`;
    }
    if (declaration.paths.some((path) => !schemaAcceptsProtectedString(tool.inputSchema, path))) {
      return `MCP protected argument mapping does not match the input schema for tool ${boundedToolName(toolName)}.`;
    }
  }
  for (const [toolName, declaration] of Object.entries(config.artifactToolArguments ?? {})) {
    const tool = byName.get(toolName);
    if (tool === undefined) return unknownCapabilityTool(toolName);
    if (!isMutationMcpRisk(resolveMcpToolRiskClass(config, transport, toolName))) {
      return `MCP artifact argument configuration conflicts with the risk class for tool ${boundedToolName(toolName)}.`;
    }
    if (declaration.paths.length === 0 || declaration.paths.length > 8 ||
      declaration.paths.some((path) => parseProtectedArgumentPattern(path) === undefined) ||
      new Set(declaration.paths).size !== declaration.paths.length || protectedPatternsOverlap(declaration.paths) ||
      declaration.allowedMimeTypes.length === 0 || declaration.allowedMimeTypes.length > 8 ||
      declaration.allowedMimeTypes.some((mimeType) => !RELAYED_ARTIFACT_MIME_TYPES.has(mimeType)) ||
      new Set(declaration.allowedMimeTypes).size !== declaration.allowedMimeTypes.length ||
      !Number.isSafeInteger(declaration.maxBytes) || declaration.maxBytes <= 0 || declaration.maxBytes > MAX_RELAYED_ARTIFACT_BYTES) {
      return `MCP artifact argument configuration is invalid for tool ${boundedToolName(toolName)}.`;
    }
    if (declaration.paths.some((path) => !schemaAcceptsProtectedString(tool.inputSchema, path))) {
      return `MCP artifact argument mapping does not match the input schema for tool ${boundedToolName(toolName)}.`;
    }
    if (declaration.typeMapping !== undefined && (
      !isMcpArtifactTypeMapping(declaration.typeMapping) ||
      !schemaAcceptsProtectedString(tool.inputSchema, `/${declaration.typeMapping.argument}`)
    )) return `MCP artifact type mapping does not match the input schema for tool ${boundedToolName(toolName)}.`;
    const protectedPaths = config.protectedToolArguments?.[toolName]?.paths ?? [];
    const combinedPaths = [...protectedPaths, ...declaration.paths];
    if (new Set(combinedPaths).size !== combinedPaths.length || protectedPatternsOverlap(combinedPaths)) {
      return `MCP artifact argument configuration overlaps protected input for tool ${boundedToolName(toolName)}.`;
    }
  }
  for (const [toolName, paths] of Object.entries(config.redactedToolResultPaths ?? {})) {
    if (!byName.has(toolName)) return unknownCapabilityTool(toolName);
    if (paths.length === 0 || paths.length > 8 ||
      paths.some((path) => parseProtectedArgumentPattern(path) === undefined) ||
      new Set(paths).size !== paths.length || protectedPatternsOverlap(paths)) {
      return `MCP result redaction configuration is invalid for tool ${boundedToolName(toolName)}.`;
    }
  }
  for (const [toolName, paths] of Object.entries(config.continuityToolResultPaths ?? {})) {
    if (!byName.has(toolName)) return unknownCapabilityTool(toolName);
    if (paths.length === 0 || paths.length > 8 ||
      paths.some((path) => !isContinuityResultPattern(path)) ||
      new Set(paths).size !== paths.length || protectedPatternsOverlap(paths)) {
      return `MCP continuity configuration is invalid for tool ${boundedToolName(toolName)}.`;
    }
  }
  for (const [verificationTool, mutationTools] of Object.entries(config.toolVerificationRelationships ?? {})) {
    if (!byName.has(verificationTool)) return unknownCapabilityTool(verificationTool);
    if (!isReadMcpRisk(resolveMcpToolRiskClass(config, transport, verificationTool))) {
      return `MCP verification configuration conflicts with the risk class for tool ${boundedToolName(verificationTool)}.`;
    }
    if (mutationTools.length === 0 || new Set(mutationTools).size !== mutationTools.length ||
      mutationTools.includes(verificationTool)) {
      return `MCP verification configuration is invalid for tool ${boundedToolName(verificationTool)}.`;
    }
    for (const mutationTool of mutationTools) {
      if (!byName.has(mutationTool)) return unknownCapabilityTool(mutationTool);
      if (!isMutationMcpRisk(resolveMcpToolRiskClass(config, transport, mutationTool))) {
        return `MCP verification target conflicts with the risk class for tool ${boundedToolName(mutationTool)}.`;
      }
    }
  }
  return undefined;
}

function schemaAcceptsProtectedString(schema: unknown, path: string): boolean {
  const segments = parseProtectedArgumentPattern(path);
  if (segments === undefined || !isRecord(schema)) return false;
  let nodes: Record<string, unknown>[] = [schema];
  for (const [index, segment] of segments.entries()) {
    nodes = nodes.flatMap(expandSchemaAlternatives).flatMap((node) => {
      if (segment === "*") {
        return index === segments.length - 1 || node.type !== "array" || !isRecord(node.items) ? [] : [node.items];
      }
      return isRecord(node.properties) && isRecord(node.properties[segment]) ? [node.properties[segment]] : [];
    });
    if (nodes.length === 0) return false;
  }
  const leaves = nodes.flatMap(expandSchemaAlternatives);
  return leaves.length > 0 && leaves.every(schemaNodeAcceptsString);
}

function expandSchemaAlternatives(node: Record<string, unknown>): Record<string, unknown>[] {
  const alternatives = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
  return alternatives === undefined
    ? [node]
    : alternatives.filter(isRecord).flatMap(expandSchemaAlternatives);
}

function schemaNodeAcceptsString(node: Record<string, unknown>): boolean {
  if (node.readOnly === true || node.const !== undefined || node.$ref !== undefined || Array.isArray(node.enum)) return false;
  if (node.type === undefined) {
    const alternatives = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
    return alternatives === undefined || alternatives.some((candidate) => isRecord(candidate) && schemaNodeAcceptsString(candidate));
  }
  return node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"));
}

function protectedPatternsOverlap(paths: readonly string[]): boolean {
  const parsed = paths.map((path) => parseProtectedArgumentPattern(path)!);
  return parsed.some((candidate, index) => parsed.some((other, otherIndex) =>
    index !== otherIndex && candidate.length < other.length &&
    candidate.every((segment, segmentIndex) => segment === other[segmentIndex])
  ));
}

function isReadMcpRisk(riskClass: ToolRiskClass): boolean {
  return riskClass === "read-only-local" || riskClass === "read-only-network";
}

function isMutationMcpRisk(riskClass: ToolRiskClass): boolean {
  return riskClass === "workspace-write" || riskClass === "external-side-effect" ||
    riskClass === "destructive-local" || riskClass === "shared-state-mutation" || riskClass === "spend-money";
}

function unknownCapabilityTool(toolName: string): string {
  return `MCP capability configuration references an unknown tool ${boundedToolName(toolName)}.`;
}

function boundedToolName(toolName: string): string {
  return JSON.stringify(toolName.slice(0, 160));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addProtectedArgumentEnvelopes(
  schema: unknown,
  paths: readonly string[]
): { schema: unknown; paths: readonly string[] } {
  if (paths.length === 0 || typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { schema, paths: [] };
  }
  const clone = structuredClone(schema) as Record<string, unknown>;
  const projected: string[] = [];
  for (const path of paths) {
    const segments = parseProtectedArgumentPattern(path);
    if (segments === undefined) continue;
    let node: Record<string, unknown> = clone;
    let applied = false;
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments[index];
      if (key === "*") {
        const item = typeof node.items === "object" && node.items !== null && !Array.isArray(node.items)
          ? node.items as Record<string, unknown>
          : undefined;
        if (item === undefined || index === segments.length - 1) break;
        node = item;
        continue;
      }
      const properties = typeof node.properties === "object" && node.properties !== null && !Array.isArray(node.properties)
        ? node.properties as Record<string, unknown>
        : undefined;
      if (properties === undefined) break;
      const property = properties[key];
      if (typeof property !== "object" || property === null || Array.isArray(property)) break;
      if (index === segments.length - 1) {
        properties[key] = {
          oneOf: [property, protectedArgumentEnvelopeSchema()]
        };
        applied = true;
      } else {
        node = property as Record<string, unknown>;
      }
    }
    if (applied) projected.push(path);
  }
  return { schema: clone, paths: projected };
}

function addArtifactArgumentEnvelopes(
  schema: unknown,
  paths: readonly string[]
): { schema: unknown; paths: readonly string[] } {
  if (paths.length === 0 || typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { schema, paths: [] };
  }
  const clone = structuredClone(schema) as Record<string, unknown>;
  const projected: string[] = [];
  for (const path of paths) {
    const segments = parseProtectedArgumentPattern(path);
    if (segments === undefined) continue;
    if (applyArtifactEnvelopeAtSchemaPath(clone, segments, 0) > 0) projected.push(path);
  }
  return { schema: clone, paths: projected };
}

function applyArtifactEnvelopeAtSchemaPath(
  node: Record<string, unknown>,
  segments: readonly string[],
  index: number
): number {
  const alternatives = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
  if (alternatives !== undefined) {
    return alternatives.filter(isRecord).reduce((count, alternative) =>
      count + applyArtifactEnvelopeAtSchemaPath(alternative, segments, index), 0);
  }
  const key = segments[index];
  if (key === undefined) return 0;
  if (key === "*") {
    return index === segments.length - 1 || node.type !== "array" || !isRecord(node.items)
      ? 0
      : applyArtifactEnvelopeAtSchemaPath(node.items, segments, index + 1);
  }
  if (!isRecord(node.properties) || !isRecord(node.properties[key])) return 0;
  if (index === segments.length - 1) {
    const property = node.properties[key];
    const existing = Array.isArray(property.oneOf) ? property.oneOf : [property];
    node.properties[key] = { oneOf: [...existing, artifactArgumentEnvelopeSchema()] };
    return 1;
  }
  return applyArtifactEnvelopeAtSchemaPath(node.properties[key], segments, index + 1);
}

function artifactArgumentEnvelopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      artifactInput: {
        type: "object",
        additionalProperties: false,
        description: "A current-session governed browser download. The runtime validates and injects its text without placing the artifact content in model context.",
        properties: {
          reference: { type: "string", description: "artifact:// reference from browser.download." },
          sha256: { type: "string", description: "SHA-256 from the browser.download receipt." },
          sourceOrigin: { type: "string", description: "Optional exact source origin from the browser.download receipt." }
        },
        required: ["reference", "sha256"]
      }
    },
    required: ["artifactInput"]
  };
}

const MAX_RELAYED_ARTIFACT_BYTES = 25 * 1024 * 1024;
const RELAYED_ARTIFACT_MIME_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/raml+yaml",
  "application/graphql",
  "text/plain",
  "text/markdown",
  "text/x-protobuf",
  "text/x-smithy"
]);

type ResolvedArtifactRelay = {
  id: string;
  sha256: string;
  sourceOrigin: string;
  mimeType: string;
  bytes: number;
  content: string;
};

async function resolveArtifactArguments(
  input: Record<string, unknown>,
  declaration: NonNullable<MCPServerConfig["artifactToolArguments"]>[string] | undefined,
  artifactStore: ArtifactStore | undefined,
  scope?: { sessionId: string; profileId: string }
): Promise<
  | { ok: true; input: Record<string, unknown>; artifacts: ResolvedArtifactRelay[] }
  | { ok: false; result: ToolResult }
> {
  const envelopes = findArtifactArgumentEnvelopes(input);
  if (envelopes.length === 0) return { ok: true, input, artifacts: [] };
  if (declaration === undefined || artifactStore === undefined) return artifactRelayFailure("artifact-relay-unavailable");

  const dispatchedInput = structuredClone(input);
  const artifacts: ResolvedArtifactRelay[] = [];
  for (const candidate of envelopes) {
    const matches = declaration.paths.filter((path) =>
      matchesArtifactArgumentPattern(path, candidate.pointer, input)
    );
    if (matches.length !== 1) return artifactRelayFailure("artifact-destination-not-reviewed");
    const descriptor = parseArtifactInputDescriptor(candidate.envelope);
    if (descriptor === undefined) return artifactRelayFailure("artifact-reference-invalid");
    const artifact = artifactStore.get(descriptor.reference, scope);
    if (artifact === undefined || artifact.localPath === undefined || artifact.mimeType === undefined) {
      return artifactRelayFailure("artifact-not-owned-by-current-session");
    }
    if (!declaration.allowedMimeTypes.includes(artifact.mimeType) || artifact.bytes > declaration.maxBytes) {
      return artifactRelayFailure("artifact-type-or-size-not-reviewed");
    }
    const metadata = artifact.metadata;
    if (metadata?.source !== "browser.download" || metadata.outcome !== "download-completed" ||
      typeof metadata.sha256 !== "string" || typeof metadata.sourceOrigin !== "string" ||
      metadata.sha256 !== descriptor.sha256 ||
      (descriptor.sourceOrigin !== undefined && metadata.sourceOrigin !== descriptor.sourceOrigin)) {
      return artifactRelayFailure("artifact-download-receipt-invalid");
    }
    let fileBytes: Buffer;
    try {
      const file = await lstat(artifact.localPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size !== artifact.bytes || file.size > declaration.maxBytes) {
        return artifactRelayFailure("artifact-file-state-invalid");
      }
      fileBytes = await readFile(artifact.localPath);
    } catch {
      return artifactRelayFailure("artifact-file-unavailable");
    }
    const sha256 = createHash("sha256").update(fileBytes).digest("hex");
    if (sha256 !== metadata.sha256 || sha256 !== descriptor.sha256) {
      return artifactRelayFailure("artifact-hash-mismatch");
    }
    const mapping = declaration.typeMapping;
    if (mapping !== undefined && typeof metadata.filename === "string") {
      const inspection = inspectBrowserDownload(metadata.filename, fileBytes);
      const api = inspection.allowed ? inspection.apiDescription : undefined;
      if (api !== undefined) {
        const formatVersion = `${api.format}${api.version === undefined ? "" : `:${api.version}`}`;
        const expected = mapping.values[formatVersion] ?? (api.version === undefined ? undefined
          : mapping.values[`${api.format}:${api.version.split(".").slice(0, 2).join(".")}`]);
        if (expected !== undefined && input[mapping.argument] !== expected) {
          return { ok: false, result: { ok: false,
            content: `Artifact format is ${formatVersion}. Set ${mapping.argument} to ${JSON.stringify(expected)} before retrying this import. No destination request was dispatched; independent work may continue.`,
            metadata: { reason: "artifact-type-declaration-mismatch" }
          } };
        }
      }
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
    } catch {
      return artifactRelayFailure("artifact-text-invalid");
    }
    if (content.includes("\u0000")) return artifactRelayFailure("artifact-text-invalid");
    setArtifactArgumentAtPointer(dispatchedInput, candidate.pointer, content);
    artifacts.push({
      id: artifact.id,
      sha256,
      sourceOrigin: metadata.sourceOrigin,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      content
    });
  }
  return { ok: true, input: dispatchedInput, artifacts };
}

function parseArtifactInputDescriptor(value: Record<string, unknown>): {
  reference: string;
  sha256: string;
  sourceOrigin?: string;
} | undefined {
  if (typeof value.reference !== "string" || !/^artifact:\/\/[A-Za-z0-9._:-]{1,200}$/u.test(value.reference) ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) return undefined;
  if (value.sourceOrigin === undefined) return { reference: value.reference, sha256: value.sha256 };
  if (typeof value.sourceOrigin !== "string") return undefined;
  try {
    const parsed = new URL(value.sourceOrigin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value.sourceOrigin) return undefined;
  } catch {
    return undefined;
  }
  return { reference: value.reference, sha256: value.sha256, sourceOrigin: value.sourceOrigin };
}

function artifactOperationIdentity(
  input: Record<string, unknown>,
  declaration: NonNullable<MCPServerConfig["artifactToolArguments"]>[string]
): import("../contracts/tool.js").ToolOperationIdentity | undefined {
  const descriptors: Array<{ reference: string; sha256: string; sourceOrigin?: string }> = [];
  for (const candidate of findArtifactArgumentEnvelopes(input)) {
    const matches = declaration.paths.filter((path) =>
      matchesArtifactArgumentPattern(path, candidate.pointer, input)
    );
    if (matches.length !== 1) return undefined;
    const descriptor = parseArtifactInputDescriptor(candidate.envelope);
    if (descriptor === undefined) return undefined;
    descriptors.push(descriptor);
  }
  if (descriptors.length === 0) return undefined;
  const hashes = [...new Set(descriptors.map((descriptor) => descriptor.sha256))].sort();
  const artifactHash = hashes.length === 1
    ? hashes[0]!
    : createHash("sha256").update(hashes.join("\0")).digest("hex");
  const references = [...new Set(descriptors.map((descriptor) => descriptor.reference.slice("artifact://".length)))];
  return {
    ...(references.length === 1 ? { subjectId: references[0] } : {}),
    artifactHash,
    operationRevision: 1
  };
}

function findArtifactArgumentEnvelopes(root: unknown): readonly { pointer: string; envelope: Record<string, unknown> }[] {
  const found: Array<{ pointer: string; envelope: Record<string, unknown> }> = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, segments: readonly string[]): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (isRecord(value) && isRecord(value.artifactInput)) {
      found.push({ pointer: encodeArtifactPointer(segments), envelope: value.artifactInput });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...segments, String(index)]));
      return;
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, [...segments, key]);
  };
  visit(root, []);
  return found;
}

function matchesArtifactArgumentPattern(pattern: string, pointer: string, root: unknown): boolean {
  const patternSegments = parseProtectedArgumentPattern(pattern);
  const pointerSegments = parseArtifactPointer(pointer);
  if (patternSegments === undefined || pointerSegments === undefined || patternSegments.length !== pointerSegments.length) return false;
  let current = root;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]!;
    const actual = pointerSegments[index]!;
    if (Array.isArray(current)) {
      if (expected !== "*" || !/^(?:0|[1-9][0-9]*)$/u.test(actual) || Number(actual) >= current.length) return false;
      current = current[Number(actual)];
    } else if (isRecord(current) && expected === actual && Object.hasOwn(current, actual)) {
      current = current[actual];
    } else {
      return false;
    }
  }
  return true;
}

function setArtifactArgumentAtPointer(root: unknown, pointer: string, content: string): void {
  const segments = parseArtifactPointer(pointer);
  if (segments === undefined) throw new Error("Artifact argument pointer is invalid.");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(segment)) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else throw new Error("Artifact argument pointer changed before dispatch.");
  }
  const leaf = segments.at(-1)!;
  if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(leaf) && Number(leaf) < current.length) current[Number(leaf)] = content;
  else if (isRecord(current) && Object.hasOwn(current, leaf)) current[leaf] = content;
  else throw new Error("Artifact argument pointer changed before dispatch.");
}

function parseArtifactPointer(pointer: string): readonly string[] | undefined {
  if (!pointer.startsWith("/") || pointer === "/") return undefined;
  const segments = pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment) || /^(?:0|[1-9][0-9]*)$/u.test(segment))
    ? segments
    : undefined;
}

function encodeArtifactPointer(segments: readonly string[]): string {
  return `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function artifactRelayFailure(reason: string): { ok: false; result: ToolResult } {
  return {
    ok: false,
    result: {
      ok: false,
      content: "The governed artifact could not be relayed to the reviewed connector argument.",
      metadata: { reason }
    }
  };
}

function redactRelayedArtifactContent(result: ToolResult, contents: readonly string[]): ToolResult {
  return redactRelayedArtifactValue(result, contents) as ToolResult;
}

function redactRelayedArtifactValue(value: unknown, contents: readonly string[]): unknown {
  return contents.reduce((current, content) => {
    if (content.length === 0) return current;
    const escaped = JSON.stringify(content).slice(1, -1);
    return replaceRelayedArtifactText(replaceRelayedArtifactText(current, content), escaped) as ToolResult;
  }, value);
}

function replaceRelayedArtifactText(value: unknown, content: string): unknown {
  if (typeof value === "string") return value.split(content).join("[RELAYED_ARTIFACT_CONTENT]");
  if (Array.isArray(value)) return value.map((entry) => replaceRelayedArtifactText(entry, content));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceRelayedArtifactText(entry, content)]));
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
          retention: { type: "string", enum: ["use-once"] },
          source: {
            type: "object",
            description: "Optional verified browser source. Its value is relayed outside model context.",
            properties: {
              type: { type: "string", enum: ["browser-field"] },
              sessionId: { type: "string" },
              ref: { type: "string" },
              identity: {
                type: "object",
                properties: {
                  documentEpoch: { type: "integer" },
                  actionRevision: { type: "integer" },
                  observationId: { type: "integer" }
                },
                required: ["documentEpoch", "actionRevision", "observationId"]
              },
              expectedOrigin: { type: "string", description: "Exact HTTP(S) origin from the current browser snapshot, without a path." },
              tabRef: { type: "string" },
              frameId: { type: "string" }
            },
            required: ["type", "sessionId", "ref", "identity", "expectedOrigin", "tabRef"]
          }
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
      connector: mcpConnector(serverName),
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
      connector: mcpConnector(serverName),
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
      connector: mcpConnector(serverName),
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
      connector: mcpConnector(serverName),
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

function mcpConnector(serverName: string): NonNullable<RegisteredTool["connector"]> {
  return {
    kind: "mcp",
    id: serverName
  };
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

export function normalizeMcpResult(
  result: unknown,
  redactedPaths: readonly string[] = [],
  continuityPaths: readonly string[] = [],
  toolName?: string
): ToolResult {
  const protectedResult = redactedPaths.length === 0
    ? result
    : redactStructuredMcpResult(result, redactedPaths);
  if (protectedResult === undefined) {
    return {
      ok: false,
      content: "MCP response withheld because its configured result redaction could not be applied safely.",
      metadata: { resultRedactionApplied: false }
    };
  }
  result = protectedResult;
  const continuityFacts = extractReviewedContinuityFacts(result, continuityPaths, toolName);
  if (typeof result === "string") {
    return {
      ok: true,
      content: result,
      ...(redactedPaths.length === 0 && continuityFacts.length === 0 ? {} : {
        metadata: {
          ...(redactedPaths.length === 0 ? {} : { resultRedactionApplied: true }),
          ...(continuityFacts.length === 0 ? {} : { _estacoda_continuity_facts: continuityFacts })
        }
      })
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
    _estacoda_continuity_facts: _untrustedContinuityFacts,
    _estacoda_verification_evidence: _untrustedVerificationEvidence,
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
      ...(redactedPaths.length === 0 ? {} : { resultRedactionApplied: true }),
      ...(continuityFacts.length === 0 ? {} : { _estacoda_continuity_facts: continuityFacts }),
      ...(structuralSummary === undefined ? {} : { _estacoda_context_summary: structuralSummary })
    }
  };
}

const MAX_MCP_CONTINUITY_FACTS = 24;
const MAX_MCP_CONTINUITY_SCALAR_CHARS = 160;

function hasUnfinishedVerificationState(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.slice(0, 128).some((entry) => hasUnfinishedVerificationState(entry, depth + 1));
  return Object.entries(value).slice(0, 128).some(([key, entry]) => {
    const field = key.replace(/[_-]/gu, "").toLowerCase();
    if (["status", "state"].includes(field) && typeof entry === "string" &&
      /^(?:pending|queued|running|processing|in[ _-]?progress|accepted|failed|error|cancelled|canceled)$/iu.test(entry)) return true;
    if (["partial", "incomplete", "truncated", "hasmore"].includes(field) && entry === true) return true;
    return hasUnfinishedVerificationState(entry, depth + 1);
  });
}

function mergeContinuityFacts(
  left: readonly RuntimeContinuityFact[] | undefined,
  right: readonly RuntimeContinuityFact[]
): RuntimeContinuityFact[] {
  return [...new Map([...(left ?? []), ...right].map((fact) => [`${fact.field}\0${fact.value}`, fact])).values()]
    .slice(0, MAX_MCP_CONTINUITY_FACTS);
}

function extractReviewedContinuityFacts(
  result: unknown,
  paths: readonly string[],
  toolName?: string
): RuntimeContinuityFact[] {
  if (paths.length === 0) return [];
  const facts: RuntimeContinuityFact[] = [];
  const seen = new Set<string>();
  for (const payload of structuredMcpContinuityPayloads(result, paths)) {
    for (const path of paths) {
      const segments = parseProtectedArgumentPattern(path);
      if (segments === undefined) continue;
      if (path === "/url") {
        // Only a reviewed relative task path paired with its reviewed task ID is admitted.
        // Absolute URLs, queries, fragments, traversal, and unmatched handles are excluded.
        if (!paths.includes("/taskId") || !isRecord(payload) || typeof payload.url !== "string") continue;
        const match = /^\/([^/]+)\/([^/]+)\/tasks\/([^/]+)$/u.exec(payload.url);
        const value = match === null ? undefined : `${match[1]}:${match[2]}:${match[3]}`;
        const coordinates = parsePollingCoordinates(value);
        if (coordinates !== undefined && coordinates.taskId === payload.taskId && safeContinuityScalar(value) !== undefined) {
          const key = `pollingCoordinates\0${value}`;
          if (!seen.has(key)) { seen.add(key); facts.push({ field: "pollingCoordinates", value: value!, kind: "identifier" }); }
        }
        continue;
      }
      const field = continuityField(segments, toolName);
      const kind = continuityKind(field);
      for (const candidate of valuesAtContinuityPath(payload, segments, 0)) {
        const value = safeContinuityScalar(candidate);
        if (value === undefined) continue;
        const key = `${field}\0${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ field, value, kind });
        if (facts.length >= MAX_MCP_CONTINUITY_FACTS) return facts;
      }
    }
  }
  return facts;
}

function structuredMcpContinuityPayloads(result: unknown, paths: readonly string[]): unknown[] {
  if (typeof result === "string") {
    const parsed = parseStructuredMcpText(result);
    return parsed === undefined ? reviewedMarkdownContinuityPayloads(result, paths) : [parsed];
  }
  if (!isRecord(result)) return [];
  if (result.structuredContent !== undefined) return [result.structuredContent];
  const payloads: unknown[] = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
      const parsed = parseStructuredMcpText(part.text);
      if (parsed !== undefined) payloads.push(parsed);
      else payloads.push(...reviewedMarkdownContinuityPayloads(part.text, paths));
    }
  }
  if (payloads.length === 0) payloads.push(result);
  return payloads;
}

function parseStructuredMcpText(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Some reviewed connectors render list results as Markdown tables rather than
 * JSON. Recover only direct collection-wildcard-field paths whose collection
 * heading and table columns both match the reviewed continuity declaration.
 */
function reviewedMarkdownContinuityPayloads(text: string, paths: readonly string[]): unknown[] {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const segments = parseProtectedArgumentPattern(path);
    if (
      segments === undefined || segments.length !== 3 || segments[1] !== "*" ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segments[0]!) ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segments[2]!)
    ) continue;
    const fields = groups.get(segments[0]!) ?? new Set<string>();
    fields.add(segments[2]!);
    groups.set(segments[0]!, fields);
  }
  if (groups.size === 0) return [];

  const lines = text.split(/\r?\n/u).slice(0, 500);
  const headings: string[] = [];
  const payloads: unknown[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index]!);
    if (heading !== null) {
      const level = heading[1]!.length;
      headings[level - 1] = heading[2]!;
      headings.length = level;
      continue;
    }
    const headers = markdownTableCells(lines[index]!);
    const separator = markdownTableCells(lines[index + 1]!);
    if (
      headers === undefined || separator === undefined || headers.length !== separator.length ||
      !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))
    ) continue;

    for (const [root, fields] of groups) {
      if (!headings.some((candidate) => markdownName(candidate) === markdownName(root))) continue;
      const headerIndexes = new Map(
        headers.map((headerName, headerIndex) => [markdownName(headerName), headerIndex])
      );
      const selected = [...fields].flatMap((field) => {
        const fieldIndex = headerIndexes.get(markdownName(field));
        return fieldIndex === undefined ? [] : [{ field, fieldIndex }];
      });
      if (selected.length === 0) continue;
      const rows: Record<string, string>[] = [];
      for (
        let rowIndex = index + 2;
        rowIndex < lines.length && rows.length < MAX_MCP_CONTINUITY_FACTS;
        rowIndex += 1
      ) {
        const cells = markdownTableCells(lines[rowIndex]!);
        if (cells === undefined || cells.length !== headers.length) break;
        const row: Record<string, string> = {};
        for (const { field, fieldIndex } of selected) row[field] = cells[fieldIndex]!;
        rows.push(row);
      }
      if (rows.length > 0) payloads.push({ [root]: rows });
    }
  }
  return payloads;
}

function markdownTableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/^`|`$/gu, ""));
  return cells.length === 0 ? undefined : cells;
}

function markdownName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/gu, "");
}

function valuesAtContinuityPath(current: unknown, segments: readonly string[], index: number): unknown[] {
  const segment = segments[index];
  if (segment === undefined) return [];
  const leaf = index === segments.length - 1;
  if (segment === "*") {
    if (!Array.isArray(current)) return [];
    return leaf
      ? [...current]
      : current.flatMap((entry) => valuesAtContinuityPath(entry, segments, index + 1));
  }
  if (!isRecord(current) || !Object.hasOwn(current, segment)) return [];
  return leaf ? [current[segment]] : valuesAtContinuityPath(current[segment], segments, index + 1);
}

function safeContinuityScalar(value: unknown): string | undefined {
  const scalar = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" ? value : undefined;
  if (scalar === undefined) return undefined;
  const normalized = scalar.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_MCP_CONTINUITY_SCALAR_CHARS ||
    normalized === "[PROTECTED_VALUE]" || normalized === "[REDACTED]") {
    return undefined;
  }
  const redacted = redactSensitiveText(normalized).trim();
  return redacted === normalized ? normalized : undefined;
}

function continuityField(segments: readonly string[], toolName?: string): string {
  const named = segments.filter((segment) => segment !== "*");
  const leaf = named.at(-1) ?? "value";
  const normalizedLeaf = leaf.replace(/[_-]+/gu, "").toLocaleLowerCase();
  const parent = named.at(-2) ?? rootContinuityEntity(toolName, normalizedLeaf);
  if (parent === undefined || !/^(?:id|identifier|uid|uuid|name|label|title|hash|sha256|ref|reference)$/u.test(normalizedLeaf)) {
    return leaf;
  }
  const singularParent = parent.endsWith("ies")
    ? `${parent.slice(0, -3)}y`
    : parent.endsWith("s") ? parent.slice(0, -1) : parent;
  return `${singularParent}${leaf.slice(0, 1).toLocaleUpperCase()}${leaf.slice(1)}`;
}

function rootContinuityEntity(toolName: string | undefined, leaf: string): string | undefined {
  if (toolName === undefined || !/^(?:id|identifier|uid|uuid|name|label|title)$/u.test(leaf)) return undefined;
  const entity = toolName
    .replace(/^(?:get|list|find|search|read|retrieve|fetch|create|import|update|put)/u, "")
    .replace(/[^A-Za-z0-9_-]+/gu, "")
    .replace(/^[_-]+|[_-]+$/gu, "");
  if (entity.length === 0 || entity.length > 80) return undefined;
  return `${entity.slice(0, 1).toLocaleLowerCase()}${entity.slice(1)}`;
}

function continuityKind(field: string): RuntimeContinuityFact["kind"] {
  const normalized = field.replace(/[_-]+/gu, "").toLocaleLowerCase();
  return /(?:^name$|name$|label$|title$)/u.test(normalized) ? "label" : "identifier";
}

function isContinuityResultPattern(path: string): boolean {
  if (path === "/url") return true; // Only validated task coordinates are retained from this path.
  const segments = parseProtectedArgumentPattern(path);
  if (segments === undefined) return false;
  const namedSegments = segments.filter((segment) => segment !== "*");
  if (namedSegments.some((segment) => /(?:api.?key|auth|cookie|credential|otp|pass(?:word|code)?|secret|token)/iu.test(segment))) {
    return false;
  }
  const leaf = namedSegments.at(-1)?.replace(/[_-]+/gu, "").toLocaleLowerCase();
  return leaf !== undefined && (
    /(?:^id$|id$|identifier$|uid$|uuid$|hash$|sha256$|ref$|reference$)/u.test(leaf) ||
    /(?:^name$|name$|label$|title$)/u.test(leaf)
  );
}

function redactStructuredMcpResult(result: unknown, paths: readonly string[]): unknown | undefined {
  if (typeof result === "string") {
    const redacted = redactStructuredMcpText(result, paths);
    return redacted;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) {
    const payload = structuredClone(record);
    return redactStructuredPayload(payload, paths) ? payload : undefined;
  }

  const content: unknown[] = [];
  for (const part of record.content) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return undefined;
    const contentPart = part as Record<string, unknown>;
    if (contentPart.type !== "text" || typeof contentPart.text !== "string") return undefined;
    const text = redactStructuredMcpText(contentPart.text, paths);
    if (text === undefined) return undefined;
    content.push({ type: "text", text });
  }
  return {
    content,
    ...(record.isError === true ? { isError: true } : {})
  };
}

function redactStructuredMcpText(text: string, paths: readonly string[]): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!redactStructuredPayload(payload, paths)) return undefined;
  return JSON.stringify(payload, null, 2);
}

function redactStructuredPayload(payload: unknown, paths: readonly string[]): boolean {
  return paths.every((path) => {
    const segments = parseProtectedArgumentPattern(path);
    return segments !== undefined && redactStructuredPath(payload, segments, 0);
  });
}

function redactStructuredPath(current: unknown, segments: readonly string[], index: number): boolean {
  const segment = segments[index];
  if (segment === undefined) return false;
  const leaf = index === segments.length - 1;
  if (segment === "*") {
    if (!Array.isArray(current)) return false;
    if (leaf) {
      for (let itemIndex = 0; itemIndex < current.length; itemIndex += 1) {
        current[itemIndex] = "[PROTECTED_VALUE]";
      }
      return true;
    }
    return current.length === 0 || current.every((entry) => redactStructuredPath(entry, segments, index + 1));
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
  const record = current as Record<string, unknown>;
  if (leaf) {
    if (Object.hasOwn(record, segment)) record[segment] = "[PROTECTED_VALUE]";
    return true;
  }
  if (!Object.hasOwn(record, segment)) return false;
  return redactStructuredPath(record[segment], segments, index + 1);
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
