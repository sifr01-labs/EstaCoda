import type { MemoryFileKind, MemoryPromotionRecord } from "../contracts/memory.js";
import type { MemoryPromotionStore } from "./memory-promotion-store.js";
import type { MemoryStore } from "./memory-store.js";

export const SAFETY_FILES: readonly MemoryFileKind[] = ["SOUL.md"];

export class MemoryInspector {
  readonly #promotionStore: MemoryPromotionStore;
  readonly #memoryStore: MemoryStore;

  constructor(options: {
    promotionStore: MemoryPromotionStore;
    memoryStore: MemoryStore;
  }) {
    this.#promotionStore = options.promotionStore;
    this.#memoryStore = options.memoryStore;
  }

  async list(options: {
    activeOnly?: boolean;
    kind?: "user-preference" | "project-fact";
    limit?: number;
  } = {}): Promise<MemoryPromotionRecord[]> {
    let records = await this.#promotionStore.list();

    if (options.activeOnly === true) {
      records = records.filter((record) => record.active);
    }

    if (options.kind !== undefined) {
      records = records.filter((record) => record.kind === options.kind);
    }

    const limit = options.limit ?? 50;
    return records.slice(0, limit);
  }

  async inspect(id: string): Promise<MemoryPromotionRecord | undefined> {
    return await this.#promotionStore.findById(id);
  }

  async deactivate(id: string): Promise<
    | { ok: true; record: MemoryPromotionRecord; fileRemoved: boolean }
    | { ok: false; reason: string }
  > {
    const record = await this.#promotionStore.findById(id);

    if (record === undefined) {
      return { ok: false, reason: `No promotion record found with id: ${id}` };
    }

    if (!record.active) {
      return { ok: false, reason: `Record ${id} is already inactive.` };
    }

    const targetFile = record.kind === "user-preference" ? "USER.md" : "MEMORY.md";

    if (SAFETY_FILES.includes(targetFile)) {
      return { ok: false, reason: `Cannot deactivate safety file entries: ${targetFile}` };
    }

    const deactivated = await this.#promotionStore.deactivateById(id);

    if (deactivated === undefined) {
      return { ok: false, reason: `Failed to deactivate record ${id}.` };
    }

    let fileRemoved = false;

    // Attempt exact safe removal from the markdown file only.
    const exactLine = `- ${record.content}`;
    const current = this.#memoryStore.read(targetFile);
    const hasExact = current.split("\n").some((line) => line.trim() === exactLine.trim());

    if (hasExact) {
      try {
        this.#memoryStore.apply({
          kind: "remove",
          file: targetFile,
          match: exactLine
        });
        fileRemoved = true;
      } catch {
        // If removal fails (e.g., ambiguous match), deactivation still succeeds
        // because the selective renderer will suppress it.
        fileRemoved = false;
      }
    }

    return { ok: true, record: deactivated, fileRemoved };
  }

  isSafetyFile(file: MemoryFileKind): boolean {
    return SAFETY_FILES.includes(file);
  }
}
