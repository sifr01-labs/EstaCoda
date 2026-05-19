import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryPromotionRecord } from "../contracts/memory.js";

type PromotionFile = {
  version: 1;
  records: MemoryPromotionRecord[];
};

export class MemoryPromotionStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #records = new Map<string, MemoryPromotionRecord>();
  #loaded = false;

  constructor(options: { path: string; now?: () => Date }) {
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date());
  }

  async applyUserPreference(input: {
    id: string;
    content: string;
    confidence: number;
    occurrences: number;
    source: string;
    sourceSessionIds: string[];
    sourceTrajectoryId?: string;
    sourceEventId?: string;
  }): Promise<{
    action: "created" | "strengthened" | "replaced";
    record: MemoryPromotionRecord;
    superseded?: MemoryPromotionRecord;
  }> {
    await this.#ensureLoaded();
    const now = this.#now().toISOString();
    const key = normalizeContentKey(input.content);
    const existing = this.#records.get(key);

    if (existing !== undefined) {
      const updated: MemoryPromotionRecord = {
        ...existing,
        active: true,
        confidence: Math.max(existing.confidence, input.confidence),
        occurrences: Math.max(existing.occurrences, input.occurrences),
        sourceSessionIds: unique([...existing.sourceSessionIds, ...input.sourceSessionIds]),
        updatedAt: now
      };
      this.#records.set(key, updated);
      await this.#flush();
      return {
        action: "strengthened",
        record: updated
      };
    }

    const category = classifyPreferenceCategory(input.content);
    const conflicting = category === undefined ? undefined : this.#findActiveConflict(category, input.content);
    const record: MemoryPromotionRecord = {
      id: input.id,
      kind: "user-preference",
      content: input.content,
      active: true,
      confidence: input.confidence,
      occurrences: input.occurrences,
      source: input.source,
      sourceSessionIds: unique(input.sourceSessionIds),
      updatedAt: now,
      createdAt: now,
      sourceTrajectoryId: input.sourceTrajectoryId,
      sourceEventId: input.sourceEventId
    };

    if (conflicting !== undefined) {
      const retired: MemoryPromotionRecord = {
        ...conflicting,
        active: false,
        supersededBy: record.id,
        updatedAt: now
      };
      this.#records.set(normalizeContentKey(retired.content), retired);
      this.#records.set(key, record);
      await this.#flush();
      return {
        action: "replaced",
        record,
        superseded: retired
      };
    }

    this.#records.set(key, record);
    await this.#flush();
    return {
      action: "created",
      record
    };
  }

  async applyProjectFact(input: {
    id: string;
    content: string;
    confidence: number;
    occurrences: number;
    source: string;
    sourceSessionIds: string[];
    sourceTrajectoryId?: string;
    sourceEventId?: string;
  }): Promise<{
    action: "created" | "strengthened";
    record: MemoryPromotionRecord;
  }> {
    await this.#ensureLoaded();
    const now = this.#now().toISOString();
    const key = normalizeContentKey(input.content);
    const existing = this.#records.get(key);

    if (existing !== undefined) {
      const updated: MemoryPromotionRecord = {
        ...existing,
        active: true,
        confidence: Math.max(existing.confidence, input.confidence),
        occurrences: Math.max(existing.occurrences, input.occurrences),
        sourceSessionIds: unique([...existing.sourceSessionIds, ...input.sourceSessionIds]),
        updatedAt: now
      };
      this.#records.set(key, updated);
      await this.#flush();
      return {
        action: "strengthened",
        record: updated
      };
    }

    const record: MemoryPromotionRecord = {
      id: input.id,
      kind: "project-fact",
      content: input.content,
      active: true,
      confidence: input.confidence,
      occurrences: input.occurrences,
      source: input.source,
      sourceSessionIds: unique(input.sourceSessionIds),
      updatedAt: now,
      createdAt: now,
      sourceTrajectoryId: input.sourceTrajectoryId,
      sourceEventId: input.sourceEventId
    };
    this.#records.set(key, record);
    await this.#flush();
    return {
      action: "created",
      record
    };
  }

  async forgetUserPreference(content: string): Promise<MemoryPromotionRecord | undefined> {
    await this.#ensureLoaded();
    const match = this.#findMatchingActiveRecord(content);
    if (match === undefined) {
      return undefined;
    }

    const forgotten: MemoryPromotionRecord = {
      ...match,
      active: false,
      forgottenAt: this.#now().toISOString(),
      forgottenReason: "user-requested",
      updatedAt: this.#now().toISOString()
    };
    this.#records.set(normalizeContentKey(match.content), forgotten);
    await this.#flush();
    return forgotten;
  }

  async findById(id: string): Promise<MemoryPromotionRecord | undefined> {
    await this.#ensureLoaded();
    return [...this.#records.values()].find((record) => record.id === id);
  }

  async deactivateById(id: string): Promise<MemoryPromotionRecord | undefined> {
    await this.#ensureLoaded();
    const record = [...this.#records.values()].find((r) => r.id === id);
    if (record === undefined) {
      return undefined;
    }
    const deactivated: MemoryPromotionRecord = {
      ...record,
      active: false,
      updatedAt: this.#now().toISOString()
    };
    this.#records.set(normalizeContentKey(record.content), deactivated);
    await this.#flush();
    return deactivated;
  }

  async list(): Promise<MemoryPromotionRecord[]> {
    await this.#ensureLoaded();
    return [...this.#records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async restore(records: readonly MemoryPromotionRecord[]): Promise<void> {
    await this.#ensureLoaded();
    this.#records.clear();
    for (const record of records) {
      this.#records.set(normalizeContentKey(record.content), record);
    }
    await this.#flush();
  }

  #findMatchingActiveRecord(content: string): MemoryPromotionRecord | undefined {
    const target = normalizeContentKey(content);
    const exact = this.#records.get(target);
    if (exact?.active) {
      return exact;
    }

    return [...this.#records.values()].find((record) =>
      record.active && normalizeContentKey(record.content) === target
    );
  }

  #findActiveConflict(category: string, nextContent: string): MemoryPromotionRecord | undefined {
    return [...this.#records.values()].find((record) =>
      record.active &&
      record.content !== nextContent &&
      classifyPreferenceCategory(record.content) === category
    );
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<PromotionFile>;
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      for (const record of records) {
        if (typeof record?.content !== "string" || typeof record?.id !== "string") {
          continue;
        }
        this.#records.set(normalizeContentKey(record.content), record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #flush(): Promise<void> {
    const file: PromotionFile = {
      version: 1,
      records: [...this.#records.values()].sort((left, right) => left.content.localeCompare(right.content))
    };
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

function normalizeContentKey(content: string): string {
  return content.trim().toLowerCase();
}

function classifyPreferenceCategory(content: string): string | undefined {
  const normalized = normalizeContentKey(content);
  if (normalized.includes("concise") && normalized.includes("repl")) {
    return "reply-verbosity";
  }
  if (normalized.includes("detailed") && normalized.includes("repl")) {
    return "reply-verbosity";
  }
  if (normalized.includes("brief") && normalized.includes("repl")) {
    return "reply-verbosity";
  }
  return undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
