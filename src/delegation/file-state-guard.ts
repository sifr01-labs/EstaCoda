import type { DelegationStaleFileWarning } from "../contracts/delegation.js";
import type {
  FileStateOperation,
  FileStateReadSnapshot,
  FileStateTracker,
  FileStateWriteQuery
} from "./file-state-tracker.js";

export type FileStateWarningInput = {
  tracker?: FileStateTracker;
  parentReadSnapshot?: FileStateReadSnapshot;
  parentSessionId: string;
  childSessionId?: string;
  taskIndex?: number;
  batchId?: string;
};

const MAX_WARNING_TEXT_CHARS = 1_000;
const WRITE_OPERATIONS = ["write", "replace", "delete", "unknown-write"] as const;

export function findStaleParentFileReadWarnings(input: FileStateWarningInput): DelegationStaleFileWarning[] {
  if (input.tracker === undefined ||
    input.parentReadSnapshot === undefined ||
    input.childSessionId === undefined ||
    input.childSessionId === "unavailable") {
    return [];
  }

  const parentReads = parentReadsByPath(input.parentReadSnapshot);
  if (parentReads.size === 0) {
    return [];
  }

  const writeQuery: FileStateWriteQuery = {
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    afterSequence: input.parentReadSnapshot.capturedSequence,
    normalizedPaths: [...parentReads.keys()]
  };
  const childWrites = input.tracker.findWritesAfter(writeQuery);

  return childWrites.flatMap((write) => {
    const reads = parentReads.get(write.normalizedPath) ?? [];
    return reads.map((read) => warningFromOperations({
      read,
      write,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId!,
      taskIndex: input.taskIndex,
      batchId: input.batchId
    }));
  });
}

function parentReadsByPath(snapshot: FileStateReadSnapshot): Map<string, FileStateOperation[]> {
  const reads = new Map<string, FileStateOperation[]>();
  for (const read of snapshot.reads) {
    if (read.operation !== "read" ||
      read.timestamp > snapshot.capturedAt ||
      read.sequence > snapshot.capturedSequence) {
      continue;
    }
    const existing = reads.get(read.normalizedPath);
    if (existing === undefined) {
      reads.set(read.normalizedPath, [read]);
    } else {
      existing.push(read);
    }
  }
  return reads;
}

function warningFromOperations(input: {
  read: FileStateOperation;
  write: FileStateOperation;
  parentSessionId: string;
  childSessionId: string;
  taskIndex?: number;
  batchId?: string;
}): DelegationStaleFileWarning {
  return {
    kind: "stale-parent-file-read",
    normalizedPath: boundText(input.write.normalizedPath),
    displayPath: boundText(input.write.path || input.read.path),
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    parentReadAt: input.read.timestamp,
    childWriteAt: input.write.timestamp,
    writeOperation: warningWriteOperation(input.write.operation),
    sourceTool: boundText(input.write.sourceTool),
    taskIndex: input.taskIndex,
    batchId: input.batchId === undefined ? undefined : boundText(input.batchId)
  };
}

function boundText(value: string): string {
  return value.length <= MAX_WARNING_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_WARNING_TEXT_CHARS - " [truncated]".length)} [truncated]`;
}

function warningWriteOperation(operation: FileStateOperation["operation"]): DelegationStaleFileWarning["writeOperation"] {
  return operation === "write" ||
    operation === "replace" ||
    operation === "delete" ||
    operation === "unknown-write"
    ? operation
    : "unknown-write";
}
