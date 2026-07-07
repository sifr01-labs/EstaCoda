import type { ExternalMemoryProvider, MemoryFileKind, MemoryOperation } from "../contracts/memory.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { truncate } from "../utils/formatting.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { ExternalMemoryRuntimeConfig } from "./external-memory-provider.js";
import { mirrorMemoryWriteToExternalProviders } from "./external-memory-provider.js";
import type { MemoryIndexWriteSync } from "./memory-index-sync.js";
import {
  isMemoryPersistenceDriftError,
  type MemoryPersistenceService
} from "./memory-persistence-service.js";
import { isMemoryBudgetOverflowError, type MemoryStore } from "./memory-store.js";

export type MemoryMutationSource = "memory.curate" | "memory.curation" | "memory.operator";

export type MemoryMutationOptions = {
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

export type MemoryMutationSuccess = {
  ok: true;
  operation: MemoryOperation;
  warnings: string[];
};

export type MemoryMutationFailure = {
  ok: false;
  operation: MemoryOperation;
  message: string;
  metadata?: Record<string, unknown>;
};

export type MemoryMutationResult = MemoryMutationSuccess | MemoryMutationFailure;

export class MemoryMutationService {
  readonly #memoryStore: MemoryStore;
  readonly #options: MemoryMutationOptions;

  constructor(options: MemoryMutationOptions & { memoryStore: MemoryStore }) {
    this.#memoryStore = options.memoryStore;
    this.#options = options;
  }

  async apply(operation: MemoryOperation, input: { source?: MemoryMutationSource } = {}): Promise<MemoryMutationResult> {
    const previous = this.#memoryStore.read(operation.file);
    try {
      this.#memoryStore.apply(operation);
    } catch (error) {
      if (isMemoryBudgetOverflowError(error)) {
        return {
          ok: false,
          operation,
          message: [
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

    if (this.#options.persistence !== undefined) {
      const path = this.#options.persistencePaths?.[operation.file];
      try {
        if (path !== undefined) {
          await this.#options.persistence.writeFile({
            path,
            kind: operation.file,
            content: this.#memoryStore.read(operation.file)
          });
        }
      } catch (error) {
        this.#memoryStore.write(operation.file, previous);
        if (isMemoryPersistenceDriftError(error)) {
          return {
            ok: false,
            operation,
            message: `${operation.file} was not updated because the disk file changed after memory was loaded.`,
            metadata: {
              error: error.code,
              kind: error.kind,
              path: error.path,
              expected: error.expected,
              actual: error.actual
            }
          };
        }
        throw error;
      }
    }

    const indexSyncWarning = await syncLocalMemoryIndex({
      memoryIndexSync: this.#options.memoryIndexSync,
      operation,
      content: this.#memoryStore.read(operation.file),
      sourcePath: this.#options.persistencePaths?.[operation.file]
    });

    const mirror = await mirrorMemoryWriteToExternalProviders({
      entry: {
        profileId: this.#options.profileId ?? "default",
        sessionId: resolveSessionId(this.#options.sessionId),
        workspaceRoot: this.#options.workspaceRoot,
        operation,
        source: externalMemorySource(input.source)
      },
      providers: this.#options.externalMemoryProviders ?? [],
      config: this.#options.externalMemory ?? defaultExternalMemoryConfig()
    });
    const auditWarnings = await recordExternalMemoryMirrorWrite({
      options: this.#options,
      operation,
      mirrorWarnings: mirror.warnings
    });

    return {
      ok: true,
      operation,
      warnings: [
        ...indexSyncWarning,
        ...mirror.warnings,
        ...auditWarnings
      ]
    };
  }
}

async function syncLocalMemoryIndex(input: {
  memoryIndexSync: MemoryIndexWriteSync | undefined;
  operation: MemoryOperation;
  content: string;
  sourcePath?: string;
}): Promise<string[]> {
  if (input.memoryIndexSync === undefined) {
    return [];
  }
  try {
    const result = await input.memoryIndexSync.syncMemoryFile({
      file: input.operation.file,
      content: input.content,
      sourcePath: input.sourcePath
    });
    return result.warning === undefined ? [] : [result.warning];
  } catch (error) {
    return [`memory index sync failed for ${input.operation.file}: ${errorMessage(error)}`];
  }
}

async function recordExternalMemoryMirrorWrite(input: {
  options: MemoryMutationOptions;
  operation: MemoryOperation;
  mirrorWarnings: readonly string[];
}): Promise<string[]> {
  const providers = input.options.externalMemoryProviders ?? [];
  const config = input.options.externalMemory ?? defaultExternalMemoryConfig();
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

function defaultExternalMemoryConfig(): ExternalMemoryRuntimeConfig {
  return {
    enabled: false,
    timeoutMs: 750,
    maxResults: 3,
    maxChars: 2_500,
    mirrorWrites: false
  };
}

function externalMemorySource(source: MemoryMutationSource | undefined): "memory.curate" | "unknown" {
  return source === "memory.curate" ? "memory.curate" : "unknown";
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
