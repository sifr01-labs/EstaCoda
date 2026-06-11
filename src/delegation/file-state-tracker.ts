import { normalize, sep } from "node:path";

export type FileStateOperationKind =
  | "read"
  | "write"
  | "replace"
  | "delete"
  | "unknown-write";

export type FileStateOperationMetadata = {
  bytes?: number;
  changed?: boolean;
  previewAvailable?: boolean;
};

export type FileStateOperation = {
  sessionId: string;
  turnId?: string;
  taskId?: string;
  delegationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  path: string;
  normalizedPath: string;
  operation: FileStateOperationKind;
  sourceTool: string;
  timestamp: string;
  metadata?: FileStateOperationMetadata;
};

export type FileStateOperationInput = Omit<FileStateOperation, "normalizedPath" | "timestamp"> & {
  normalizedPath?: string;
  timestamp?: string;
};

export type FileStateOperationFilter = {
  sessionId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  operation?: FileStateOperationKind | readonly FileStateOperationKind[];
  path?: string;
  normalizedPath?: string;
  since?: string;
  after?: string;
  until?: string;
};

export type FileStateReadSnapshot = {
  sessionId: string;
  capturedAt: string;
  reads: FileStateOperation[];
};

export type FileStateWriteQuery = FileStateOperationFilter & {
  after: string;
  paths?: readonly string[];
  normalizedPaths?: readonly string[];
};

const DEFAULT_MAX_OPERATIONS = 5_000;
const MAX_PATH_CHARS = 1_000;
const WRITE_OPERATIONS: readonly FileStateOperationKind[] = ["write", "replace", "delete", "unknown-write"];

export class FileStateTracker {
  readonly #maxOperations: number;
  readonly #operations: FileStateOperation[] = [];

  constructor(options: { maxOperations?: number } = {}) {
    this.#maxOperations = Math.max(1, Math.floor(options.maxOperations ?? DEFAULT_MAX_OPERATIONS));
  }

  recordOperation(input: FileStateOperationInput): FileStateOperation {
    const operation: FileStateOperation = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      taskId: input.taskId,
      delegationId: input.delegationId,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      path: boundPath(input.path),
      normalizedPath: normalizeOperationPath(input.normalizedPath ?? input.path),
      operation: input.operation,
      sourceTool: input.sourceTool,
      timestamp: input.timestamp ?? new Date().toISOString(),
      metadata: sanitizeMetadata(input.metadata)
    };
    if (operation.metadata === undefined) {
      delete operation.metadata;
    }

    this.#operations.push(operation);
    if (this.#operations.length > this.#maxOperations) {
      this.#operations.splice(0, this.#operations.length - this.#maxOperations);
    }

    return cloneOperation(operation);
  }

  listOperations(filter: FileStateOperationFilter = {}): FileStateOperation[] {
    return this.#operations
      .filter((operation) => matchesFilter(operation, filter))
      .map(cloneOperation);
  }

  listReads(sessionId: string): FileStateOperation[] {
    return this.listOperations({ sessionId, operation: "read" });
  }

  listWrites(sessionId: string): FileStateOperation[] {
    return this.listOperations({ sessionId, operation: WRITE_OPERATIONS });
  }

  snapshotReads(sessionId: string, capturedAt = new Date().toISOString()): FileStateReadSnapshot {
    return {
      sessionId,
      capturedAt,
      reads: this.listReads(sessionId)
    };
  }

  findWritesAfter(options: FileStateWriteQuery): FileStateOperation[] {
    const normalizedPaths = new Set([
      ...(options.normalizedPaths ?? []).map(normalizeOperationPath),
      ...(options.paths ?? []).map(normalizeOperationPath)
    ]);
    return this.listOperations({
      ...options,
      operation: WRITE_OPERATIONS,
      after: options.after
    }).filter((operation) =>
      normalizedPaths.size === 0 || normalizedPaths.has(operation.normalizedPath)
    );
  }

  clearSession(sessionId: string): void {
    for (let index = this.#operations.length - 1; index >= 0; index -= 1) {
      if (this.#operations[index]?.sessionId === sessionId) {
        this.#operations.splice(index, 1);
      }
    }
  }
}

export function normalizeOperationPath(path: string): string {
  const normalized = normalize(path)
    .split(sep)
    .join("/")
    .replace(/^\.\//u, "");
  return boundPath(normalized.length === 0 ? "." : normalized);
}

function matchesFilter(operation: FileStateOperation, filter: FileStateOperationFilter): boolean {
  if (filter.sessionId !== undefined && operation.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.parentSessionId !== undefined && operation.parentSessionId !== filter.parentSessionId) {
    return false;
  }
  if (filter.childSessionId !== undefined && operation.childSessionId !== filter.childSessionId) {
    return false;
  }
  if (filter.operation !== undefined) {
    const operations = Array.isArray(filter.operation) ? filter.operation : [filter.operation];
    if (!operations.includes(operation.operation)) {
      return false;
    }
  }
  if (filter.path !== undefined && operation.normalizedPath !== normalizeOperationPath(filter.path)) {
    return false;
  }
  if (filter.normalizedPath !== undefined && operation.normalizedPath !== normalizeOperationPath(filter.normalizedPath)) {
    return false;
  }
  if (filter.since !== undefined && operation.timestamp < filter.since) {
    return false;
  }
  if (filter.after !== undefined && operation.timestamp <= filter.after) {
    return false;
  }
  if (filter.until !== undefined && operation.timestamp > filter.until) {
    return false;
  }
  return true;
}

function sanitizeMetadata(metadata: FileStateOperationMetadata | undefined): FileStateOperationMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const clean: FileStateOperationMetadata = {};
  if (typeof metadata.bytes === "number" && Number.isFinite(metadata.bytes) && metadata.bytes >= 0) {
    clean.bytes = Math.floor(metadata.bytes);
  }
  if (typeof metadata.changed === "boolean") {
    clean.changed = metadata.changed;
  }
  if (typeof metadata.previewAvailable === "boolean") {
    clean.previewAvailable = metadata.previewAvailable;
  }
  return Object.keys(clean).length === 0 ? undefined : clean;
}

function boundPath(path: string): string {
  return path.length <= MAX_PATH_CHARS
    ? path
    : `${path.slice(0, MAX_PATH_CHARS - " [truncated]".length)} [truncated]`;
}

function cloneOperation(operation: FileStateOperation): FileStateOperation {
  return {
    ...operation,
    metadata: operation.metadata === undefined ? undefined : { ...operation.metadata }
  };
}
