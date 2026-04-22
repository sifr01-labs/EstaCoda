import type {
  MemoryConclusion,
  MemoryFileKind,
  MemoryProvider,
  MemoryProviderContext,
  MemorySearchResult,
  SkillOutcome
} from "../contracts/memory.js";
import { renderMemorySnapshot } from "./memory-renderer.js";
import type { MemoryStore } from "./memory-store.js";

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";
  readonly #store: MemoryStore;
  readonly #saveRoot: string | undefined;

  constructor(options: {
    store: MemoryStore;
    saveRoot?: string;
  }) {
    this.#store = options.store;
    this.#saveRoot = options.saveRoot;
  }

  context(): MemoryProviderContext {
    const rendered = renderMemorySnapshot(this.#store.snapshot());

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

  async #save(): Promise<void> {
    if (this.#saveRoot !== undefined) {
      await this.#store.saveToDirectory(this.#saveRoot);
    }
  }
}

function excerpt(content: string, index: number): string {
  const start = Math.max(0, index - 160);
  const end = Math.min(content.length, index + 360);

  return content.slice(start, end).trim();
}
