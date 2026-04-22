import type { RegisteredTool, ToolDefinition, ToolsetName } from "../contracts/tool.js";

export type ToolRegistrySnapshot = {
  total: number;
  available: ToolDefinition[];
  unavailable: ToolDefinition[];
};

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool<any>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.#tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()].map(toDefinition);
  }

  listByToolset(toolset: ToolsetName): ToolDefinition[] {
    return this.list().filter((tool) => tool.toolsets.includes(toolset));
  }

  getRegisteredByToolset(toolset: ToolsetName): RegisteredTool[] {
    return [...this.#tools.values()].filter((tool) => tool.toolsets.includes(toolset));
  }

  async listAvailable(): Promise<ToolDefinition[]> {
    const available: ToolDefinition[] = [];

    for (const tool of this.#tools.values()) {
      if (await tool.isAvailable()) {
        available.push(toDefinition(tool));
      }
    }

    return available;
  }

  async snapshot(): Promise<ToolRegistrySnapshot> {
    const available: ToolDefinition[] = [];
    const unavailable: ToolDefinition[] = [];

    for (const tool of this.#tools.values()) {
      const target = (await tool.isAvailable()) ? available : unavailable;
      target.push(toDefinition(tool));
    }

    return {
      total: this.#tools.size,
      available,
      unavailable
    };
  }
}

function toDefinition(tool: RegisteredTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    riskClass: tool.riskClass,
    toolsets: [...tool.toolsets],
    progressLabel: tool.progressLabel,
    maxResultSizeChars: tool.maxResultSizeChars,
    requiredConfig: tool.requiredConfig === undefined ? undefined : [...tool.requiredConfig]
  };
}
