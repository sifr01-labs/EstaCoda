import type { MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { MemoryStore } from "./memory-store.js";

export function createMemoryTool(memoryStore: MemoryStore): RegisteredTool<MemoryToolInput> {
  return {
    name: "memory.curate",
    description:
      "Curate bounded EstaCoda memory. Memory is already injected into context; use this only to add, replace, or remove durable facts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["append", "replace", "remove"] },
        file: { type: "string", enum: ["MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md"] },
        content: { type: "string" },
        match: { type: "string" },
        replacement: { type: "string" }
      },
      required: ["kind", "file"]
    },
    riskClass: "workspace-write",
    toolsets: ["core", "memory"],
    progressLabel: "curating memory",
    maxResultSizeChars: 2000,
    isAvailable: () => true,
    run: async (input) => applyMemoryToolInput(memoryStore, input)
  };
}

type MemoryToolInput = {
  kind: "append" | "replace" | "remove";
  file: MemoryFileKind;
  content?: string;
  match?: string;
  replacement?: string;
};

function applyMemoryToolInput(memoryStore: MemoryStore, input: MemoryToolInput): ToolResult {
  const operation = toOperation(input);
  memoryStore.apply(operation);

  return {
    ok: true,
    content: `${input.file} updated with ${input.kind}`
  };
}

function toOperation(input: MemoryToolInput): MemoryOperation {
  if (input.kind === "append") {
    assertPresent(input.content, "content");
    return {
      kind: "append",
      file: input.file,
      content: input.content
    };
  }

  if (input.kind === "replace") {
    assertPresent(input.match, "match");
    assertPresent(input.replacement, "replacement");
    return {
      kind: "replace",
      file: input.file,
      match: input.match,
      replacement: input.replacement
    };
  }

  assertPresent(input.match, "match");
  return {
    kind: "remove",
    file: input.file,
    match: input.match
  };
}

function assertPresent(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`memory.curate requires ${field}`);
  }
}

