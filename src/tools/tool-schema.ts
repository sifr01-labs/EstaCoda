import type { ToolDefinition, ToolRiskClass } from "../contracts/tool.js";

export type ProviderToolSchemaCatalog = {
  tools: OpenAICompatibleToolSchema[];
  aliases: Map<string, string>;
};

export type OpenAICompatibleToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

const DEFAULT_MAX_PROVIDER_TOOLS = 40;
const BLOCKED_PROVIDER_RISKS = new Set<ToolRiskClass>([
  "credential-access",
  "destructive-local",
  "sandbox-escape",
  "spend-money"
]);

export function buildProviderToolSchemaCatalog(input: {
  tools: ToolDefinition[];
  maxTools?: number;
}): ProviderToolSchemaCatalog {
  const aliases = new Map<string, string>();
  const selected = input.tools
    .filter((tool) => !BLOCKED_PROVIDER_RISKS.has(tool.riskClass))
    .slice(0, input.maxTools ?? DEFAULT_MAX_PROVIDER_TOOLS);

  return {
    aliases,
    tools: selected.map((tool) => {
      const alias = toProviderToolName(tool.name, aliases);

      aliases.set(alias, tool.name);

      return {
        type: "function",
        function: {
          name: alias,
          description: tool.description,
          parameters: normalizeSchema(tool.inputSchema)
        }
      };
    })
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
