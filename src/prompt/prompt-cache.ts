export type PromptCacheEntry = {
  key: string;
  chars: number;
  estimatedTokens: number;
  firstSeenAt: string;
  lastSeenAt: string;
  hits: number;
};

export class PromptCache {
  readonly #entries = new Map<string, PromptCacheEntry>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  check(input: {
    key: string;
    chars: number;
    estimatedTokens: number;
  }): "hit" | "miss" {
    const now = this.#now().toISOString();
    const existing = this.#entries.get(input.key);

    if (existing !== undefined) {
      existing.lastSeenAt = now;
      existing.hits += 1;
      return "hit";
    }

    this.#entries.set(input.key, {
      key: input.key,
      chars: input.chars,
      estimatedTokens: input.estimatedTokens,
      firstSeenAt: now,
      lastSeenAt: now,
      hits: 0
    });

    return "miss";
  }

  snapshot(): PromptCacheEntry[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }
}
