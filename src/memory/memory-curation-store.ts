import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryFileKind, MemoryOperation } from "../contracts/memory.js";

export type MemoryCurationTrigger =
  | "turn-count"
  | "compact"
  | "handoff"
  | "runtime-dispose"
  | "manual";

export type MemoryCurationStatus =
  | "auto-applied"
  | "applied"
  | "pending-review"
  | "rejected"
  | "ignored"
  | "failed"
  | "undone";

export type StoredMemoryOperation =
  | {
      kind: "append";
      file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
      content: string;
    }
  | {
      kind: "replace";
      file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
      match: string;
      replacement: string;
    }
  | {
      kind: "remove";
      file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
      match: string;
    };

export type MemoryCurationOperationRecord = {
  file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
  kind: MemoryOperation["kind"];
  contentHash?: string;
  matchHash?: string;
  operation?: StoredMemoryOperation;
};

export type MemoryCurationCandidateRecord = {
  id: string;
  factId: string;
  target: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
  disposition: "auto-apply" | "pending-review" | "ignore";
  reviewStatus: "pending" | "applied" | "rejected";
  reason: string;
  risk: "low" | "medium" | "high";
  operation?: StoredMemoryOperation;
};

export type MemoryCurationRecord = {
  id: string;
  profileId: string;
  sessionId: string;
  trigger: MemoryCurationTrigger;
  status: MemoryCurationStatus;
  sourceMessageCount?: number;
  sourceMessageIds?: string[];
  extractedFactIds: string[];
  operations: MemoryCurationOperationRecord[];
  candidates?: MemoryCurationCandidateRecord[];
  reason: string;
  createdAt: string;
};

type MemoryCurationStoreData = {
  version: 1;
  records: MemoryCurationRecord[];
};

export class MemoryCurationStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: {
    path: string;
    now?: () => Date;
    id?: () => string;
  }) {
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
  }

  async append(input: Omit<MemoryCurationRecord, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }): Promise<MemoryCurationRecord> {
    const data = await this.#read();
    const record: MemoryCurationRecord = {
      ...input,
      id: input.id ?? this.#id(),
      createdAt: input.createdAt ?? this.#now().toISOString()
    };
    data.records.push(record);
    await this.#write(data);
    return record;
  }

  async list(options: { limit?: number } = {}): Promise<MemoryCurationRecord[]> {
    const data = await this.#read();
    const limit = Math.max(1, Math.trunc(options.limit ?? 50));
    return data.records.slice(-limit).reverse();
  }

  async latestForSession(sessionId: string): Promise<MemoryCurationRecord | undefined> {
    const data = await this.#read();
    return [...data.records].reverse().find((record) => record.sessionId === sessionId);
  }

  async get(id: string): Promise<MemoryCurationRecord | undefined> {
    const data = await this.#read();
    return data.records.find((record) => record.id === id);
  }

  async update(
    id: string,
    updater: (record: MemoryCurationRecord) => MemoryCurationRecord
  ): Promise<MemoryCurationRecord | undefined> {
    const data = await this.#read();
    const index = data.records.findIndex((record) => record.id === id);
    if (index === -1) {
      return undefined;
    }
    const updated = updater(data.records[index]!);
    data.records[index] = updated;
    await this.#write(data);
    return updated;
  }

  async #read(): Promise<MemoryCurationStoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<MemoryCurationStoreData>;
      return {
        version: 1,
        records: Array.isArray(parsed.records)
          ? parsed.records.flatMap(normalizeRecord)
          : []
      };
    } catch (error) {
      if (isNotFound(error)) {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }

  async #write(data: MemoryCurationStoreData): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export function memoryCurationStorePath(profileRoot: string): string {
  return join(profileRoot, "memory-curation.json");
}

export function summarizeMemoryOperation(operation: MemoryOperation): MemoryCurationOperationRecord {
  const file = operation.file === "USER.md" || operation.file === "MEMORY.md"
    ? operation.file
    : undefined;
  if (file === undefined) {
    throw new Error(`memory curation records do not support ${operation.file}`);
  }
  return {
    file,
    kind: operation.kind,
    operation: storeMemoryOperation({ ...operation, file }),
    ...(operation.kind === "append" ? { contentHash: hashText(operation.content) } : {}),
    ...(operation.kind === "replace" ? {
      contentHash: hashText(operation.replacement),
      matchHash: hashText(operation.match)
    } : {}),
    ...(operation.kind === "remove" ? { matchHash: hashText(operation.match) } : {})
  };
}

export function storeMemoryOperation(operation: MemoryOperation): StoredMemoryOperation {
  const file = operation.file === "USER.md" || operation.file === "MEMORY.md"
    ? operation.file
    : undefined;
  if (file === undefined) {
    throw new Error(`memory curation records do not support ${operation.file}`);
  }
  if (operation.kind === "append") {
    return {
      kind: "append",
      file,
      content: operation.content
    };
  }
  if (operation.kind === "replace") {
    return {
      kind: "replace",
      file,
      match: operation.match,
      replacement: operation.replacement
    };
  }
  return {
    kind: "remove",
    file,
    match: operation.match
  };
}

function normalizeRecord(value: unknown): MemoryCurationRecord[] {
  if (!isRecord(value)) {
    return [];
  }
  const id = stringValue(value.id);
  const profileId = stringValue(value.profileId);
  const sessionId = stringValue(value.sessionId);
  const trigger = oneOf(value.trigger, ["turn-count", "compact", "handoff", "runtime-dispose", "manual"] as const);
  const status = oneOf(value.status, ["auto-applied", "applied", "pending-review", "rejected", "ignored", "failed", "undone"] as const);
  const reason = stringValue(value.reason);
  const createdAt = stringValue(value.createdAt);
  if (
    id === undefined ||
    profileId === undefined ||
    sessionId === undefined ||
    trigger === undefined ||
    status === undefined ||
    reason === undefined ||
    createdAt === undefined
  ) {
    return [];
  }
  return [{
    id,
    profileId,
    sessionId,
    trigger,
    status,
    reason,
    createdAt,
    ...(typeof value.sourceMessageCount === "number" && Number.isFinite(value.sourceMessageCount)
      ? { sourceMessageCount: Math.max(0, Math.trunc(value.sourceMessageCount)) }
      : {}),
    sourceMessageIds: Array.isArray(value.sourceMessageIds)
      ? value.sourceMessageIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    extractedFactIds: Array.isArray(value.extractedFactIds)
      ? value.extractedFactIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    operations: Array.isArray(value.operations)
      ? value.operations.flatMap(normalizeOperationRecord)
      : [],
    candidates: Array.isArray(value.candidates)
      ? value.candidates.flatMap(normalizeCandidateRecord)
      : []
  }];
}

function normalizeOperationRecord(value: unknown): MemoryCurationOperationRecord[] {
  if (!isRecord(value)) {
    return [];
  }
  const file = oneOf(value.file, ["USER.md", "MEMORY.md"] as const);
  const kind = oneOf(value.kind, ["append", "replace", "remove"] as const);
  if (file === undefined || kind === undefined) {
    return [];
  }
  return [{
    file,
    kind,
    ...(typeof value.contentHash === "string" ? { contentHash: value.contentHash } : {}),
    ...(typeof value.matchHash === "string" ? { matchHash: value.matchHash } : {}),
    ...normalizeStoredOperationField(value.operation)
  }];
}

function normalizeCandidateRecord(value: unknown): MemoryCurationCandidateRecord[] {
  if (!isRecord(value)) {
    return [];
  }
  const id = stringValue(value.id);
  const factId = stringValue(value.factId);
  const target = oneOf(value.target, ["USER.md", "MEMORY.md"] as const);
  const disposition = oneOf(value.disposition, ["auto-apply", "pending-review", "ignore"] as const);
  const reviewStatus = oneOf(value.reviewStatus, ["pending", "applied", "rejected"] as const);
  const reason = stringValue(value.reason);
  const risk = oneOf(value.risk, ["low", "medium", "high"] as const);
  if (
    id === undefined ||
    factId === undefined ||
    target === undefined ||
    disposition === undefined ||
    reviewStatus === undefined ||
    reason === undefined ||
    risk === undefined
  ) {
    return [];
  }
  return [{
    id,
    factId,
    target,
    disposition,
    reviewStatus,
    reason,
    risk,
    ...normalizeStoredOperationField(value.operation)
  }];
}

function normalizeStoredOperationField(value: unknown): { operation?: StoredMemoryOperation } {
  const operation = normalizeStoredOperation(value);
  return operation === undefined ? {} : { operation };
}

function normalizeStoredOperation(value: unknown): StoredMemoryOperation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const file = oneOf(value.file, ["USER.md", "MEMORY.md"] as const);
  const kind = oneOf(value.kind, ["append", "replace", "remove"] as const);
  if (file === undefined || kind === undefined) {
    return undefined;
  }
  if (kind === "append") {
    const content = nonEmptyStringValue(value.content);
    return content === undefined ? undefined : { kind, file, content };
  }
  if (kind === "replace") {
    const match = nonEmptyStringValue(value.match);
    const replacement = nonEmptyStringValue(value.replacement);
    return match === undefined || replacement === undefined ? undefined : { kind, file, match, replacement };
  }
  const match = nonEmptyStringValue(value.match);
  return match === undefined ? undefined : { kind, file, match };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
