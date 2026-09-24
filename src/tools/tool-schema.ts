import { CHARS_PER_TOKEN, estimateTextTokensRough } from "../prompt/token-estimator.js";
import type { ToolDefinition, ToolRiskClass } from "../contracts/tool.js";

export type ProviderToolSchemaCatalog = {
  /** Bounded default exposure for callers without turn-specific selection. */
  tools: OpenAICompatibleToolSchema[];
  /** Complete metadata after session policy filtering; never contains schemas. */
  inventory: SessionToolMetadata[];
  aliases: Map<string, string>;
  entries: ProviderToolSchemaCatalogEntry[];
};

export type ProviderToolSchemaCatalogEntry = {
  tool: ToolDefinition;
  schema: OpenAICompatibleToolSchema;
};

export type OpenAICompatibleToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

export type SessionToolMetadata = Pick<ToolDefinition, "name" | "description" | "toolsets"> & {
  availability: "available" | "temporarily_unavailable";
  schemaEligible: boolean;
};

export const MAX_PROVIDER_TOOLS = 100;
// Rough serialized-schema tokens, using the same estimator as prompt accounting.
export const MAX_PROVIDER_SCHEMA_TOKENS = 24_000;

export function budgetProviderTools(input: {
  tools: readonly OpenAICompatibleToolSchema[];
  priorityNames?: ReadonlySet<string>;
  maxTools?: number;
  maxSchemaTokens?: number;
}): { tools: OpenAICompatibleToolSchema[]; omitted: string[]; schemaTokens: number } {
  const maxTools = Math.max(0, Math.min(MAX_PROVIDER_TOOLS, input.maxTools ?? MAX_PROVIDER_TOOLS));
  const maxTokens = Math.max(0, Math.min(MAX_PROVIDER_SCHEMA_TOKENS, input.maxSchemaTokens ?? MAX_PROVIDER_SCHEMA_TOKENS));
  const candidates = [...input.tools].sort((a, b) =>
    Number(input.priorityNames?.has(b.function.name) ?? false) - Number(input.priorityNames?.has(a.function.name) ?? false));
  const tools: OpenAICompatibleToolSchema[] = [];
  const omitted: string[] = [];
  const seen = new Set<string>();
  let chars = 2; // JSON array framing, including comma separators below.
  for (const schema of candidates) {
    if (seen.has(schema.function.name)) continue;
    seen.add(schema.function.name);
    const nextChars = chars + JSON.stringify(schema).length + (tools.length > 0 ? 1 : 0);
    if (tools.length >= maxTools || Math.ceil(nextChars / CHARS_PER_TOKEN) > maxTokens) {
      omitted.push(schema.function.name);
      continue;
    }
    tools.push(schema);
    chars = nextChars;
  }
  return { tools, omitted, schemaTokens: estimateTextTokensRough(JSON.stringify(tools)) };
}
const BLOCKED_PROVIDER_RISKS = new Set<ToolRiskClass>([
  "credential-access",
  "destructive-local",
  "sandbox-escape",
  "spend-money"
]);

export function buildProviderToolSchemaCatalog(input: {
  tools: ToolDefinition[];
  unavailableTools?: ToolDefinition[];
  maxTools?: number;
}): ProviderToolSchemaCatalog {
  const aliases = new Map<string, string>();
  const selected = input.tools.filter((tool) => !BLOCKED_PROVIDER_RISKS.has(tool.riskClass));
  // Reserve canonical provider-safe names first so an alias cannot shadow one.
  // Allocate collisions deterministically once for the complete session catalog.
  const canonicalNames = new Set(selected.map((tool) => tool.name));
  for (const name of [...canonicalNames].sort()) {
    if (/^[a-zA-Z0-9_-]{1,64}$/u.test(name)) aliases.set(name, name);
  }
  for (const name of [...canonicalNames].sort()) {
    if (!aliases.has(name)) aliases.set(toProviderToolName(name, aliases), name);
  }
  const aliasesByTool = new Map([...aliases].map(([alias, name]) => [name, alias]));
  const entries = selected.map((tool) => {
    const alias = aliasesByTool.get(tool.name)!;

    return {
      tool,
      schema: {
        type: "function" as const,
        function: {
          name: alias,
          description: tool.description,
          parameters: normalizeSchema(tool.inputSchema)
        }
      }
    };
  });

  return {
    aliases,
    entries,
    inventory: [
      ...input.tools.map((tool) => metadata(tool, "available")),
      ...(input.unavailableTools ?? []).map((tool) => metadata(tool, "temporarily_unavailable"))
    ],
    tools: budgetProviderTools({ tools: entries.map((entry) => entry.schema), maxTools: input.maxTools }).tools
  };
}

function toProviderToolName(name: string, aliases: Map<string, string>): string {
  const base = name
    .replace(/[^a-zA-Z0-9_-]/gu, "__")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60) || "tool";
  let alias = base;
  let index = 2;

  while (aliases.has(alias)) {
    alias = `${base}_${index++}`;
  }

  return alias;
}

function normalizeSchema(schema: unknown): unknown {
  if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      type: "object",
      properties: {}
    };
  }

  return schema;
}

function metadata(tool: ToolDefinition, availability: SessionToolMetadata["availability"]): SessionToolMetadata {
  return { name: tool.name, description: tool.description, toolsets: [...tool.toolsets],
    availability, schemaEligible: !BLOCKED_PROVIDER_RISKS.has(tool.riskClass) };
}
