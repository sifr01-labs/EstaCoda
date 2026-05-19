import type { MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { MemoryStore } from "./memory-store.js";

const MEMORY_CURATE_FILES: readonly MemoryFileKind[] = ["MEMORY.md", "USER.md", "SOUL.md"];

export function createMemoryTool(memoryStore: MemoryStore): RegisteredTool<MemoryToolInput> {
  return {
    name: "memory.curate",
    description:
      "Curate bounded EstaCoda memory. Memory is already injected into context; use this only to add, replace, or remove durable facts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["append", "replace", "remove"] },
        file: { type: "string", enum: MEMORY_CURATE_FILES },
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
  file: string;
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
  const file = assertMemoryFile(input.file);

  if (input.kind === "append") {
    assertPresent(input.content, "content");
    return {
      kind: "append",
      file,
      content: input.content
    };
  }

  if (input.kind === "replace") {
    assertPresent(input.match, "match");
    assertPresent(input.replacement, "replacement");
    return {
      kind: "replace",
      file,
      match: input.match,
      replacement: input.replacement
    };
  }

  assertPresent(input.match, "match");
  return {
    kind: "remove",
    file,
    match: input.match
  };
}

function assertMemoryFile(file: string): MemoryFileKind {
  if (MEMORY_CURATE_FILES.includes(file as MemoryFileKind)) {
    return file as MemoryFileKind;
  }

  throw new Error(`memory.curate does not manage ${file}`);
}

function assertPresent(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`memory.curate requires ${field}`);
  }
}
