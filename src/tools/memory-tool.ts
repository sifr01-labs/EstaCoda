import type { ExternalMemoryProvider, MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ExternalMemoryRuntimeConfig } from "../memory/external-memory-provider.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { MemoryPersistenceService } from "../memory/memory-persistence-service.js";
import type { MemoryIndexWriteSync } from "../memory/memory-index-sync.js";
import { MemoryMutationService } from "../memory/memory-mutation-service.js";

const MEMORY_CURATE_FILES: readonly MemoryFileKind[] = ["MEMORY.md", "USER.md", "SOUL.md"];

export type MemoryToolOptions = {
  externalMemory?: ExternalMemoryRuntimeConfig;
  externalMemoryProviders?: ExternalMemoryProvider[];
  profileId?: string;
  sessionId?: string | (() => string);
  workspaceRoot?: string;
  sessionDb?: Pick<SessionDB, "appendEvent">;
  trajectoryRecorder?: Pick<TrajectoryRecorder, "record">;
  persistence?: MemoryPersistenceService;
  persistencePaths?: Partial<Record<MemoryFileKind, string>>;
  memoryIndexSync?: MemoryIndexWriteSync;
};

export function createMemoryTool(memoryStore: MemoryStore, options: MemoryToolOptions = {}): RegisteredTool<MemoryToolInput> {
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
    run: async (input) => applyMemoryToolInput(memoryStore, input, options)
  };
}

export const memoryToolProvider: SessionToolProvider = {
  name: "memory",
  kind: "session",
  createTools(ctx) {
    return [
      createMemoryTool(requireProviderDependency("memory", "memoryStore", ctx.memoryStore), {
        externalMemory: ctx.externalMemory ?? ctx.externalMemoryConfig,
        externalMemoryProviders: ctx.externalMemoryProviders,
        profileId: ctx.profileId,
        sessionId: ctx.currentSessionId,
        workspaceRoot: ctx.workspaceRoot,
        sessionDb: requireProviderDependency("memory", "sessionDb", ctx.sessionDb),
        trajectoryRecorder: requireProviderDependency("memory", "trajectoryRecorder", ctx.trajectoryRecorder),
        persistence: ctx.memoryPersistenceService,
        persistencePaths: ctx.memoryPersistencePaths,
        memoryIndexSync: ctx.memoryIndexSync
      })
    ];
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

type MemoryToolInput = {
  kind: "append" | "replace" | "remove";
  file: string;
  content?: string;
  match?: string;
  replacement?: string;
};

async function applyMemoryToolInput(
  memoryStore: MemoryStore,
  input: MemoryToolInput,
  options: MemoryToolOptions
): Promise<ToolResult> {
  const operation = toOperation(input);
  const result = await new MemoryMutationService({
    memoryStore,
    ...options
  }).apply(operation, { source: "memory.curate" });

  if (!result.ok) {
    return {
      ok: false,
      content: result.message,
      metadata: result.metadata
    };
  }

  return {
    ok: true,
    content: [
      `${input.file} updated with ${input.kind}`,
      ...result.warnings
    ].join("\n"),
    metadata: result.warnings.length === 0 ? undefined : {
      warnings: result.warnings
    }
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
