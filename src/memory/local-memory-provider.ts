import type {
  MemoryConclusion,
  MemoryFileKind,
  MemoryPromotionRecord,
  MemoryProvider,
  MemoryProviderContext,
  MemorySearchResult,
  SkillOutcome
} from "../contracts/memory.js";
import { renderMemorySnapshot } from "./memory-renderer.js";
import { renderSelective } from "./selective-renderer.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import { MemoryInspector } from "./memory-inspector.js";
import { isMemoryBudgetOverflowError, type MemoryStore } from "./memory-store.js";

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";
  readonly #store: MemoryStore;
  readonly #saveRoots: Partial<Record<MemoryFileKind, string>>;
  readonly #promotionStore: MemoryPromotionStore | undefined;
  readonly #inspector: MemoryInspector | undefined;

  constructor(options: {
    store: MemoryStore;
    saveRoot?: string;
    saveRoots?: Partial<Record<MemoryFileKind, string>>;
    promotionStore?: MemoryPromotionStore;
    promotionStorePath?: string;
  }) {
    this.#store = options.store;
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
          path: options.promotionStorePath
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

  search(query: string, options: { limit?: number } = {}): MemorySearchResult[] {
    const needle = query.trim().toLowerCase();

    if (needle.length === 0) {
      return [];
    }

    const results: MemorySearchResult[] = [];

    for (const [kind, content] of this.#store.snapshot().files.entries()) {
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
    const target = conclusion.kind === "user-preference" ? "USER.md" : "MEMORY.md";
    if (conclusion.kind === "user-preference" && this.#promotionStore !== undefined) {
      const previousRecords = await this.#promotionStore.list();
      const previousMarkdown = this.#store.read(target);
      const applied = await this.#promotionStore.applyUserPreference({
        id: conclusion.id,
        content: conclusion.content,
        confidence: conclusion.confidence,
        occurrences: conclusion.occurrences ?? 1,
        source: conclusion.source ?? "unknown",
        sourceSessionIds: conclusion.sourceSessionIds ?? [],
        sourceTrajectoryId: conclusion.sourceTrajectoryId,
        sourceEventId: conclusion.sourceEventId
      });

      try {
        if (applied.superseded !== undefined) {
          this.#removeExactLine("USER.md", `- ${applied.superseded.content}`);
        }
        if (applied.action === "created" || applied.action === "replaced") {
          this.#appendDedupe(target, `- ${conclusion.content}`);
        }
      } catch (error) {
        if (isMemoryBudgetOverflowError(error)) {
          this.#store.write(target, previousMarkdown);
          await this.#promotionStore.restore(previousRecords);
        }
        throw error;
      }
      await this.#save();
      return;
    }
    if (conclusion.kind === "project-fact" && this.#promotionStore !== undefined) {
      const previousRecords = await this.#promotionStore.list();
      const previousMarkdown = this.#store.read(target);
      const applied = await this.#promotionStore.applyProjectFact({
        id: conclusion.id,
        content: conclusion.content,
        confidence: conclusion.confidence,
        occurrences: conclusion.occurrences ?? 1,
        source: conclusion.source ?? "unknown",
        sourceSessionIds: conclusion.sourceSessionIds ?? [],
        sourceTrajectoryId: conclusion.sourceTrajectoryId,
        sourceEventId: conclusion.sourceEventId
      });
      try {
        if (applied.action === "created") {
          this.#appendDedupe(target, `- ${conclusion.content}`);
        }
      } catch (error) {
        if (isMemoryBudgetOverflowError(error)) {
          this.#store.write(target, previousMarkdown);
          await this.#promotionStore.restore(previousRecords);
        }
        throw error;
      }
      await this.#save();
      return;
    }

    this.#appendDedupe(target, `- ${conclusion.content}`);
    await this.#save();
  }

  async recordSkillOutcome(outcome: SkillOutcome): Promise<void> {
    const targets = outcome.memoryTargets ?? ["MEMORY.md"];
    const line = [
      `- skill:${outcome.skill}`,
      outcome.stepId === undefined ? undefined : `step:${outcome.stepId}`,
      `status:${outcome.status}`,
      `tools:${outcome.tools.join(",") || "none"}`,
      `summary:${outcome.summary}`
    ].filter((part) => part !== undefined).join(" | ");

    for (const target of targets) {
      this.#appendDedupe(target, line);
    }

    await this.#save();
  }

  async inspectPromotions(): Promise<MemoryPromotionRecord[]> {
    return await this.#promotionStore?.list() ?? [];
  }

  async forgetPromotion(content: string): Promise<MemoryPromotionRecord | undefined> {
    const forgotten = await this.#promotionStore?.forgetUserPreference(content);
    if (forgotten !== undefined) {
      this.#removeExactLine("USER.md", `- ${forgotten.content}`);
      await this.#save();
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

  async #save(): Promise<void> {
    for (const file of ["MEMORY.md", "USER.md", "SOUL.md"] as const) {
      const root = this.#saveRoots[file];
      if (root !== undefined) {
        await this.#store.saveFileToDirectory(root, file);
      }
    }
  }
}

function excerpt(content: string, index: number): string {
  const start = Math.max(0, index - 160);
  const end = Math.min(content.length, index + 360);

  return content.slice(start, end).trim();
}
