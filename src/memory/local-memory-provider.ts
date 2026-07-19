import type {
  MemoryConclusion,
  MemoryFileKind,
  MemoryPromotionRecord,
  MemoryProvider,
  MemoryProviderContext,
  MemorySearchResult
} from "../contracts/memory.js";
import { join } from "node:path";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";
import { renderMemorySnapshot } from "./memory-renderer.js";
import { renderSelective } from "./selective-renderer.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import { MemoryInspector } from "./memory-inspector.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryPersistenceService } from "./memory-persistence-service.js";
import type { MemoryIndexWriteSync } from "./memory-index-sync.js";
import type { LocalMemoryRetrievalService } from "./memory-retrieval-service.js";
import type { MemoryCurationCheckpointCoordinator } from "./memory-curation-coordinator.js";

type LocalMemorySearchService = Pick<LocalMemoryRetrievalService, "search">;

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";
  readonly #store: MemoryStore;
  readonly #saveRoots: Partial<Record<MemoryFileKind, string>>;
  readonly #promotionStore: MemoryPromotionStore | undefined;
  readonly #inspector: MemoryInspector | undefined;
  readonly #persistence: MemoryPersistenceService | undefined;
  readonly #memoryIndexSync: MemoryIndexWriteSync | undefined;
  readonly #memorySearchService: LocalMemorySearchService | undefined;
  readonly #mutationCoordinator: MemoryCurationCheckpointCoordinator | undefined;
  readonly #profileId: string;

  constructor(options: {
    store: MemoryStore;
    saveRoot?: string;
    saveRoots?: Partial<Record<MemoryFileKind, string>>;
    promotionStore?: MemoryPromotionStore;
    promotionStorePath?: string;
    persistence?: MemoryPersistenceService;
    memoryIndexSync?: MemoryIndexWriteSync;
    memorySearchService?: LocalMemorySearchService;
    mutationCoordinator?: MemoryCurationCheckpointCoordinator;
    profileId?: string;
  }) {
    this.#store = options.store;
    this.#persistence = options.persistence;
    this.#memoryIndexSync = options.memoryIndexSync;
    this.#memorySearchService = options.memorySearchService;
    this.#mutationCoordinator = options.mutationCoordinator;
    this.#profileId = options.profileId ?? "default";
    this.#saveRoots = options.saveRoots ?? (
      options.saveRoot === undefined
        ? {}
        : {
            "MEMORY.md": options.saveRoot,
            "USER.md": options.saveRoot,
            "SOUL.md": options.saveRoot
          }
    );
    this.#promotionStore = options.promotionStore ?? (options.promotionStorePath === undefined
      ? undefined
      : new MemoryPromotionStore({
          path: options.promotionStorePath,
          persistence: this.#persistence
        }));
    this.#inspector = this.#promotionStore === undefined
      ? undefined
      : new MemoryInspector({
          promotionStore: this.#promotionStore,
          memoryStore: this.#store
        });
  }

  get inspector(): MemoryInspector | undefined {
    return this.#inspector;
  }

  async context(options?: { query?: string }): Promise<MemoryProviderContext> {
    const snapshot = this.#store.snapshot();

    if (this.#promotionStore !== undefined) {
      const records = await this.#promotionStore.list();
      const rendered = renderSelective(snapshot, records, { query: options?.query });
      return {
        text: rendered.text,
        usage: rendered.usage
      };
    }

    const rendered = renderMemorySnapshot(snapshot);

    return {
      text: rendered.text,
      usage: rendered.usage
    };
  }

  search(query: string, options: { limit?: number } = {}): Promise<MemorySearchResult[]> | MemorySearchResult[] {
    const needle = query.trim().toLowerCase();

    if (needle.length === 0) {
      return [];
    }

    if (this.#memorySearchService !== undefined) {
      return this.#memorySearchService.search({
        profileId: this.#profileId,
        query,
        maxResults: options.limit
      }).then((result) => result.results.map((entry): MemorySearchResult => ({
        source: entry.memoryFileKind ?? "SHARED.md",
        content: entry.content,
        score: entry.score
      })));
    }

    const results: MemorySearchResult[] = [];

    for (const [kind, content] of this.#store.snapshot().files.entries()) {
      if (kind === "SOUL.md") {
        continue;
      }
      const index = content.toLowerCase().indexOf(needle);

      if (index === -1) {
        continue;
      }

      results.push({
        source: kind,
        content: excerpt(content, index),
        score: 1
      });
    }

    return results.slice(0, options.limit ?? 10);
  }

  async conclude(conclusion: MemoryConclusion): Promise<void> {
    if (this.#mutationCoordinator !== undefined) {
      await this.#mutationCoordinator.runExclusive({
        task: async () => await this.#conclude(conclusion)
      });
      return;
    }
    await this.#conclude(conclusion);
  }

  async #conclude(conclusion: MemoryConclusion): Promise<void> {
    const visibleContent = sanitizeMemoryText(conclusion.content);
    if (visibleContent.length === 0) {
      return;
    }
    const sanitizedConclusion = {
      ...conclusion,
      content: visibleContent
    };
    const target = sanitizedConclusion.kind === "user-preference" ? "USER.md" : "MEMORY.md";
    if (sanitizedConclusion.kind === "user-preference" && this.#promotionStore !== undefined) {
      const previousRecords = await this.#promotionStore.list();
      const previousMarkdown = this.#store.read(target);
      const applied = await this.#promotionStore.applyUserPreference({
        id: sanitizedConclusion.id,
        content: sanitizedConclusion.content,
        confidence: sanitizedConclusion.confidence,
        occurrences: sanitizedConclusion.occurrences ?? 1,
        source: sanitizedConclusion.source ?? "unknown",
        sourceSessionIds: sanitizedConclusion.sourceSessionIds ?? [],
        sourceTrajectoryId: sanitizedConclusion.sourceTrajectoryId,
        sourceEventId: sanitizedConclusion.sourceEventId
      });

      try {
        if (applied.superseded !== undefined) {
          this.#removeExactLine("USER.md", `- ${applied.superseded.content}`);
        }
        if (applied.action === "created" || applied.action === "replaced") {
          this.#appendDedupe(target, `- ${sanitizedConclusion.content}`);
        }
        await this.#save([target]);
      } catch (error) {
        this.#store.hydrate(target, previousMarkdown);
        await this.#promotionStore.restore(previousRecords);
        throw error;
      }
      return;
    }
    if (sanitizedConclusion.kind === "project-fact" && this.#promotionStore !== undefined) {
      const previousRecords = await this.#promotionStore.list();
      const previousMarkdown = this.#store.read(target);
      const applied = await this.#promotionStore.applyProjectFact({
        id: sanitizedConclusion.id,
        content: sanitizedConclusion.content,
        confidence: sanitizedConclusion.confidence,
        occurrences: sanitizedConclusion.occurrences ?? 1,
        source: sanitizedConclusion.source ?? "unknown",
        sourceSessionIds: sanitizedConclusion.sourceSessionIds ?? [],
        sourceTrajectoryId: sanitizedConclusion.sourceTrajectoryId,
        sourceEventId: sanitizedConclusion.sourceEventId
      });
      try {
        if (applied.action === "created") {
          this.#appendDedupe(target, `- ${sanitizedConclusion.content}`);
        }
        await this.#save([target]);
      } catch (error) {
        this.#store.hydrate(target, previousMarkdown);
        await this.#promotionStore.restore(previousRecords);
        throw error;
      }
      return;
    }

    const previousMarkdown = this.#store.read(target);
    try {
      this.#appendDedupe(target, `- ${sanitizedConclusion.content}`);
      await this.#save([target]);
    } catch (error) {
      this.#store.hydrate(target, previousMarkdown);
      throw error;
    }
  }

  async inspectPromotions(): Promise<MemoryPromotionRecord[]> {
    return await this.#promotionStore?.list() ?? [];
  }

  async forgetPromotion(content: string): Promise<MemoryPromotionRecord | undefined> {
    if (this.#mutationCoordinator !== undefined) {
      return await this.#mutationCoordinator.runExclusive({
        task: async () => await this.#forgetPromotion(content)
      });
    }
    return await this.#forgetPromotion(content);
  }

  async #forgetPromotion(content: string): Promise<MemoryPromotionRecord | undefined> {
    const previousRecords = await this.#promotionStore?.list();
    const previousMarkdown = this.#store.read("USER.md");
    const forgotten = await this.#promotionStore?.forgetUserPreference(content);
    if (forgotten !== undefined) {
      try {
        this.#removeExactLine("USER.md", `- ${forgotten.content}`);
        await this.#save(["USER.md"]);
      } catch (error) {
        this.#store.hydrate("USER.md", previousMarkdown);
        if (previousRecords !== undefined) {
          await this.#promotionStore?.restore(previousRecords);
        }
        throw error;
      }
    }
    return forgotten;
  }

  #appendDedupe(file: MemoryFileKind, content: string): void {
    const current = this.#store.read(file);

    if (current.includes(content)) {
      return;
    }

    this.#store.apply({
      kind: "append",
      file,
      content
    });
  }

  #removeExactLine(file: MemoryFileKind, content: string): void {
    const current = this.#store.read(file);
    const lines = current
      .split("\n")
      .filter((line) => line.trim() !== content.trim());
    this.#store.write(file, lines.filter((line, index, array) => !(index === array.length - 1 && line.length === 0)).join("\n"));
  }

  async #save(files: readonly MemoryFileKind[]): Promise<void> {
    for (const file of uniqueFiles(files)) {
      const root = this.#saveRoots[file];
      if (root !== undefined) {
        if (this.#persistence === undefined) {
          await this.#store.saveFileToDirectory(root, file);
        } else {
          await this.#persistence.writeFile({
            path: join(root, file),
            kind: file,
            content: this.#store.read(file)
          });
        }
      }
      await this.#syncMemoryIndex(file, root === undefined ? undefined : join(root, file));
    }
  }

  async #syncMemoryIndex(file: MemoryFileKind, sourcePath: string | undefined): Promise<void> {
    if (this.#memoryIndexSync === undefined) {
      return;
    }
    try {
      await this.#memoryIndexSync.syncMemoryFile({
        file,
        content: this.#store.read(file),
        sourcePath
      });
    } catch {
      // Memory index sync is derived state; authoritative memory writes stay committed.
    }
  }
}

function uniqueFiles(files: readonly MemoryFileKind[]): MemoryFileKind[] {
  return [...new Set(files)];
}

function excerpt(content: string, index: number): string {
  const start = Math.max(0, index - 160);
  const end = Math.min(content.length, index + 360);

  return content.slice(start, end).trim();
}

function sanitizeMemoryText(value: string): string {
  return stripInlineReasoning(value).trim();
}
