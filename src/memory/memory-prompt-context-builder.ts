import type {
  MemoryFileKind,
  MemoryPromptContext,
  MemoryPromptDiagnostics,
  MemoryPromotionRecord,
  MemoryScope,
  PromptMemoryBlock
} from "../contracts/memory.js";
import type { MemoryPromotionStore } from "./memory-promotion-store.js";
import type { MemoryStore } from "./memory-store.js";
import { calculateSnapshotBudgetPressure } from "./memory-pressure.js";

type PromotionStoreReader = Pick<MemoryPromotionStore, "list">;

export type MemoryPromptContextBuilderOptions = {
  store: MemoryStore;
  promotionStore?: PromotionStoreReader;
  scope?: Partial<Record<MemoryFileKind, MemoryScope>>;
};

export class MemoryPromptContextBuilder {
  readonly #store: MemoryStore;
  readonly #promotionStore: PromotionStoreReader | undefined;
  readonly #scope: Partial<Record<MemoryFileKind, MemoryScope>>;

  constructor(options: MemoryPromptContextBuilderOptions) {
    this.#store = options.store;
    this.#promotionStore = options.promotionStore;
    this.#scope = options.scope ?? {};
  }

  async build(options: { dryRun?: boolean } = {}): Promise<MemoryPromptContext> {
    const snapshot = this.#store.snapshot();
    const records = this.#promotionStore === undefined ? [] : await this.#promotionStore.list();
    const inactive = inactiveContentSet(records);
    const budgetPressure = calculateSnapshotBudgetPressure(snapshot);
    const diagnostics: MemoryPromptDiagnostics = {
      includedBlocks: [],
      suppressedEntries: 0,
      duplicateEntriesRemoved: 0,
      recallTriggered: false,
      budgetPressure,
      compactionPressure: budgetPressure,
      warnings: [
        ...(options.dryRun === true ? ["dry-run: no memory files were written"] : []),
        ...budgetPressure
          .filter((pressure) => pressure.state !== "ok")
          .map((pressure) =>
            `${pressure.source} memory budget pressure is ${pressure.state}: ${pressure.chars}/${pressure.maxChars} chars`
          )
      ]
    };
    const frozenCompactMemory: PromptMemoryBlock[] = [];
    const safetyMemory: PromptMemoryBlock[] = [];

    const shared = trimmed(snapshot.files.get("SHARED.md"));
    if (shared !== undefined) {
      frozenCompactMemory.push(block({
        id: "memory:shared",
        kind: "learned-project",
        scope: this.#scope["SHARED.md"] ?? "user-global",
        source: "memory/shared",
        content: shared,
        trusted: true
      }, diagnostics));
    }

    const user = filterLearnedMemory(snapshot.files.get("USER.md") ?? "", inactive);
    diagnostics.suppressedEntries += user.suppressedEntries;
    diagnostics.duplicateEntriesRemoved += user.duplicateEntriesRemoved;
    if (user.content !== undefined) {
      frozenCompactMemory.push(block({
        id: "memory:user",
        kind: "learned-user",
        scope: this.#scope["USER.md"] ?? "user-global",
        source: "USER.md",
        content: user.content,
        trusted: true
      }, diagnostics));
    }

    const soul = trimmed(snapshot.files.get("SOUL.md"));
    if (soul !== undefined) {
      safetyMemory.push(block({
        id: "memory:soul",
        kind: "identity",
        scope: this.#scope["SOUL.md"] ?? "user-global",
        source: "SOUL.md",
        content: soul,
        trusted: true
      }, diagnostics));
    }

    const project = filterLearnedMemory(snapshot.files.get("MEMORY.md") ?? "", inactive);
    diagnostics.suppressedEntries += project.suppressedEntries;
    diagnostics.duplicateEntriesRemoved += project.duplicateEntriesRemoved;
    if (project.content !== undefined) {
      frozenCompactMemory.push(block({
        id: "memory:project",
        kind: "learned-project",
        scope: this.#scope["MEMORY.md"] ?? "project",
        source: "MEMORY.md",
        content: project.content,
        trusted: true
      }, diagnostics));
    }

    return {
      frozenCompactMemory,
      safetyMemory,
      diagnostics
    };
  }
}

function block(
  input: Omit<PromptMemoryBlock, "chars">,
  diagnostics: MemoryPromptDiagnostics
): PromptMemoryBlock {
  const result: PromptMemoryBlock = {
    ...input,
    chars: input.content.length
  };
  diagnostics.includedBlocks.push({
    id: result.id,
    kind: result.kind,
    source: result.source,
    chars: result.chars
  });
  return result;
}

function filterLearnedMemory(
  content: string,
  inactive: Set<string>
): { content: string | undefined; suppressedEntries: number; duplicateEntriesRemoved: number } {
  const lines = content.split("\n");
  const seen = new Set<string>();
  const kept: string[] = [];
  let suppressedEntries = 0;
  let duplicateEntriesRemoved = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("- ")) {
      if (trimmedLine.length > 0) {
        kept.push(line);
      }
      continue;
    }

    const key = normalizeContentKey(trimmedLine.slice(2));
    if (inactive.has(key)) {
      suppressedEntries += 1;
      continue;
    }

    if (seen.has(key)) {
      duplicateEntriesRemoved += 1;
      continue;
    }

    seen.add(key);
    kept.push(line);
  }

  return {
    content: trimmed(kept.join("\n")),
    suppressedEntries,
    duplicateEntriesRemoved
  };
}

function inactiveContentSet(records: MemoryPromotionRecord[]): Set<string> {
  const inactive = new Set<string>();
  for (const record of records) {
    if (!record.active) {
      inactive.add(normalizeContentKey(record.content));
    }
  }
  return inactive;
}

function normalizeContentKey(content: string): string {
  return content.trim().toLowerCase();
}

function trimmed(content: string | undefined): string | undefined {
  const value = content?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
