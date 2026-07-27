import { createHash } from "node:crypto";
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
    const id = delta.id ?? stableToolCallId(delta);
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
      input: canonicalizeNestedToolNames(tool, parsed.input, this.#aliases),
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

function canonicalizeNestedToolNames(
  tool: string,
  input: Record<string, unknown>,
  aliases: ReadonlyMap<string, string>
): Record<string, unknown> {
  if (tool !== "delegate_task" || aliases.size === 0) return input;

  return {
    ...input,
    ...(input.allowedTools === undefined
      ? {}
      : { allowedTools: canonicalizeAllowedTools(input.allowedTools, aliases) }),
    ...(input.tasks === undefined
      ? {}
      : { tasks: canonicalizeDelegatedTasks(input.tasks, aliases) })
  };
}

function canonicalizeDelegatedTasks(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeDelegatedTaskItem(item, aliases));
  }
  if (typeof value !== "string") return value;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return value;
    return JSON.stringify(parsed.map((item) => canonicalizeDelegatedTaskItem(item, aliases)));
  } catch {
    return value;
  }
}

function canonicalizeDelegatedTaskItem(item: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  if (record.allowedTools === undefined) return item;
  return {
    ...record,
    allowedTools: canonicalizeAllowedTools(record.allowedTools, aliases)
  };
}

function canonicalizeAllowedTools(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((name) => {
    if (typeof name !== "string") return name;
    return aliases.get(name.trim()) ?? name;
  });
}

export function stableToolCallId(delta: ProviderToolCallDelta): string {
  const hash = createHash("sha256")
    .update(String(delta.index ?? ""))
    .update("\0")
    .update(delta.name ?? "")
    .update("\0")
    .update(delta.argumentsText ?? "")
    .digest("hex")
    .slice(0, 16);
  return `tool-call-${hash}`;
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
