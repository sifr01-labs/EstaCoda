import type { ProviderToolCallDelta, ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolRegistry } from "./tool-registry.js";

export class ToolCallPlanner {
  readonly #registry: ToolRegistry;
  readonly #aliases: Map<string, string>;

  constructor(options: {
    registry: ToolRegistry;
    aliases?: Map<string, string>;
  }) {
    this.#registry = options.registry;
    this.#aliases = options.aliases ?? new Map();
  }

  planFromProviderDelta(delta: ProviderToolCallDelta): ToolCallPlan {
    const id = delta.id ?? `tool-call-${Date.now()}`;
    const tool = this.#resolveToolName(normalizeToolName(delta.name));

    if (tool === undefined) {
      return {
        id,
        tool: "",
        input: {},
        source: "provider-tool-call",
        status: "invalid",
        raw: delta.raw,
        error: "Provider tool call did not include a tool name."
      };
    }

    if (this.#registry.get(tool) === undefined) {
      return {
        id,
        tool,
        input: {},
        source: "provider-tool-call",
        status: "unavailable",
        raw: delta.raw,
        error: `Tool is not registered: ${tool}`
      };
    }

    const parsed = parseArguments(delta.argumentsText);

    if (!parsed.ok) {
      return {
        id,
        tool,
        input: {},
        source: "provider-tool-call",
        status: "invalid",
        raw: delta.raw,
        error: parsed.error
      };
    }

    return {
      id,
      tool,
      input: parsed.input,
      source: "provider-tool-call",
      status: "planned",
      raw: delta.raw
    };
  }

  #resolveToolName(name: string | undefined): string | undefined {
    if (name === undefined) {
      return undefined;
    }

    return this.#aliases.get(name) ?? name;
  }
}

function normalizeToolName(name: string | undefined): string | undefined {
  if (name === undefined || name.trim().length === 0) {
    return undefined;
  }

  return name.trim();
}

function parseArguments(argumentsText: string | undefined): {
  ok: true;
  input: Record<string, unknown>;
} | {
  ok: false;
  error: string;
} {
  if (argumentsText === undefined || argumentsText.trim().length === 0) {
    return {
      ok: true,
      input: {}
    };
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Tool arguments must be a JSON object."
      };
    }

    return {
      ok: true,
      input: parsed as Record<string, unknown>
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool arguments were not valid JSON."
    };
  }
}
