import type { ExternalMemoryProvider, MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { truncate } from "../utils/formatting.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { ExternalMemoryRuntimeConfig } from "./external-memory-provider.js";
import { mirrorMemoryWriteToExternalProviders } from "./external-memory-provider.js";
import { isMemoryBudgetOverflowError, type MemoryStore } from "./memory-store.js";

const MEMORY_CURATE_FILES: readonly MemoryFileKind[] = ["MEMORY.md", "USER.md", "SOUL.md"];

export type MemoryToolOptions = {
  externalMemory?: ExternalMemoryRuntimeConfig;
  externalMemoryProviders?: ExternalMemoryProvider[];
  profileId?: string;
  sessionId?: string | (() => string);
  workspaceRoot?: string;
  sessionDb?: Pick<SessionDB, "appendEvent">;
  trajectoryRecorder?: Pick<TrajectoryRecorder, "record">;
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
  try {
    memoryStore.apply(operation);
  } catch (error) {
    if (isMemoryBudgetOverflowError(error)) {
      return {
        ok: false,
        content: [
          `${error.overflow.kind} was not updated because it exceeded the memory budget.`,
          `Budget: ${error.overflow.chars}/${error.overflow.maxChars} chars (${error.overflow.pressure.state}).`
        ].join("\n"),
        metadata: {
          error: error.overflow.code,
          overflow: error.overflow,
          pressure: error.overflow.pressure
        }
      };
    }
    throw error;
  }

  const mirror = await mirrorMemoryWriteToExternalProviders({
    entry: {
      profileId: options.profileId ?? "default",
      sessionId: resolveSessionId(options.sessionId),
      workspaceRoot: options.workspaceRoot,
      operation,
      source: "memory.curate"
    },
    providers: options.externalMemoryProviders ?? [],
    config: options.externalMemory ?? {
      enabled: false,
      timeoutMs: 750,
      maxResults: 3,
      maxChars: 2_500,
      mirrorWrites: false
    }
  });
  const auditWarnings = await recordExternalMemoryMirrorWrite({
    options,
    operation,
    mirrorWarnings: mirror.warnings
  });
  const warnings = [
    ...mirror.warnings,
    ...auditWarnings
  ];

  return {
    ok: true,
    content: [
      `${input.file} updated with ${input.kind}`,
      ...warnings
    ].join("\n"),
    metadata: warnings.length === 0 ? undefined : {
      warnings
    }
  };
}

async function recordExternalMemoryMirrorWrite(input: {
  options: MemoryToolOptions;
  operation: MemoryOperation;
  mirrorWarnings: readonly string[];
}): Promise<string[]> {
  const providers = input.options.externalMemoryProviders ?? [];
  const config = input.options.externalMemory ?? {
    enabled: false,
    timeoutMs: 750,
    maxResults: 3,
    maxChars: 2_500,
    mirrorWrites: false
  };
  const mirrorCapableProviders = providers.filter((provider) => provider.mirrorMemoryWrite !== undefined);
  const mirrorAttempted = config.enabled === true && config.mirrorWrites === true && mirrorCapableProviders.length > 0;
  if (!mirrorAttempted) {
    return [];
  }

  const providerIds = mirrorCapableProviders.map((provider) => provider.id);
  const event = {
    kind: "external-memory-mirror-write" as const,
    providerIds,
    enabled: config.enabled === true,
    mirrorEnabled: config.mirrorWrites === true,
    localWriteSucceeded: true,
    mirrorAttempted,
    mirrorSucceeded: input.mirrorWarnings.length === 0,
    memoryFile: input.operation.file,
    operationKind: input.operation.kind,
    entryChars: operationCharCount(input.operation),
    profileId: input.options.profileId ?? "default",
    workspaceScoped: input.options.workspaceRoot !== undefined,
    warningCount: input.mirrorWarnings.length,
    failureCount: input.mirrorWarnings.length,
    ...(input.mirrorWarnings.length === 0 ? {} : { failures: failuresFromWarnings(input.mirrorWarnings) })
  };
  const warnings: string[] = [];
  try {
    const sessionId = resolveSessionId(input.options.sessionId);
    if (input.options.sessionDb !== undefined && sessionId !== undefined) {
      await input.options.sessionDb.appendEvent(sessionId, event);
    }
  } catch (error) {
    warnings.push(`external memory mirror write session event failed: ${errorMessage(error)}`);
  }
  try {
    input.options.trajectoryRecorder?.record("external-memory-mirror-write", event);
  } catch (error) {
    warnings.push(`external memory mirror write trajectory event failed: ${errorMessage(error)}`);
  }
  return warnings;
}

function resolveSessionId(sessionId: string | (() => string) | undefined): string | undefined {
  return typeof sessionId === "function" ? sessionId() : sessionId;
}

function operationCharCount(operation: MemoryOperation): number {
  if (operation.kind === "append") {
    return operation.content.length;
  }
  if (operation.kind === "replace") {
    return operation.match.length + operation.replacement.length;
  }
  return operation.match.length;
}

function failuresFromWarnings(warnings: readonly string[]): Array<{ providerId?: string; reason: string }> {
  return warnings.slice(0, 8).map((warning) => ({
    providerId: providerIdFromWarning(warning),
    reason: truncate(redactSensitiveText(warning), 240)
  }));
}

function providerIdFromWarning(warning: string): string | undefined {
  const match = /external memory provider ([^\s]+) /iu.exec(warning);
  return match?.[1];
}

function errorMessage(error: unknown): string {
  return truncate(redactSensitiveText(error instanceof Error ? error.message : String(error)), 240);
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
