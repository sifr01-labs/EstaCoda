import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { MemoryFileCompactionService } from "../memory/memory-file-compaction-service.js";

export function createMemoryFileCompactionTools(
  service: MemoryFileCompactionService
): RegisteredTool[] {
  return [
    {
      name: "memory.file_compact",
      description:
        "Manually compact USER.md or MEMORY.md memory files. Dry-run is supported and automatic memory file compaction is disabled by default.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", enum: ["USER.md", "MEMORY.md"] },
          dryRun: { type: "boolean" }
        },
        required: ["file"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "memory"],
      progressLabel: "compacting memory file",
      maxResultSizeChars: 6_000,
      isAvailable: () => true,
      run: async (input: { file?: string; dryRun?: boolean }, context) => {
        const result = await service.compact({
          file: input.file ?? "",
          dryRun: input.dryRun === true,
          signal: context?.signal
        });
        return toToolResult(result);
      }
    },
    {
      name: "memory.file_compaction_restore",
      description:
        "Restore a USER.md or MEMORY.md file from a memory-file compaction backup.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", enum: ["USER.md", "MEMORY.md"] },
          backupId: { type: "string" }
        },
        required: ["file"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "memory"],
      progressLabel: "restoring memory file backup",
      maxResultSizeChars: 2_000,
      isAvailable: () => true,
      run: async (input: { file?: string; backupId?: string }, context) => {
        const result = await service.restoreBackup({
          file: input.file ?? "",
          backupId: input.backupId,
          signal: context?.signal
        });
        return toToolResult(result);
      }
    }
  ];
}

export const memoryFileCompactionToolProvider: SessionToolProvider = {
  name: "memoryFileCompaction",
  kind: "session",
  createTools(ctx) {
    return createMemoryFileCompactionTools(
      requireProviderDependency("memoryFileCompaction", "memoryFileCompactionService", ctx.memoryFileCompactionService)
    );
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function toToolResult(
  result: Awaited<ReturnType<MemoryFileCompactionService["compact"]>> | Awaited<ReturnType<MemoryFileCompactionService["restoreBackup"]>>
): ToolResult {
  if (result.ok) {
    if (result.status === "dry-run") {
      return {
        ok: true,
        content: [
          `Memory file compaction dry-run for ${result.file}: ${result.originalChars} -> ${result.compactedChars} chars.`,
          "",
          result.compactedText
        ].join("\n"),
        metadata: result
      };
    }
    if (result.status === "applied") {
      return {
        ok: true,
        content: `Memory file compaction applied to ${result.file}: ${result.originalChars} -> ${result.compactedChars} chars. Backup: ${result.backupId}`,
        metadata: result
      };
    }
    return {
      ok: true,
      content: `Memory file compaction backup restored for ${result.file}: ${result.backupId}`,
      metadata: result
    };
  }

  return {
    ok: false,
    content: result.message,
    metadata: result
  };
}
