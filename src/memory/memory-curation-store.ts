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
  | "pending-review"
  | "ignored"
  | "failed"
  | "undone";

export type MemoryCurationOperationRecord = {
  file: Extract<MemoryFileKind, "USER.md" | "MEMORY.md">;
  kind: MemoryOperation["kind"];
  contentHash?: string;
  matchHash?: string;
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
    ...(operation.kind === "append" ? { contentHash: hashText(operation.content) } : {}),
    ...(operation.kind === "replace" ? {
      contentHash: hashText(operation.replacement),
      matchHash: hashText(operation.match)
    } : {}),
    ...(operation.kind === "remove" ? { matchHash: hashText(operation.match) } : {})
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
  const status = oneOf(value.status, ["auto-applied", "pending-review", "ignored", "failed", "undone"] as const);
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
    ...(typeof value.matchHash === "string" ? { matchHash: value.matchHash } : {})
  }];
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
