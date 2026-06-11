export type DelegateCallBudgetResult =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; used: number; limit: number; skippedCount: number };

export class DelegateCallBudget {
  readonly #limit: number;
  #used = 0;
  #skipped = 0;

  constructor(limit: number | undefined) {
    this.#limit = Math.max(1, limit ?? 1);
  }

  reset(): void {
    this.#used = 0;
    this.#skipped = 0;
  }

  tryConsume(): DelegateCallBudgetResult {
    if (this.#used >= this.#limit) {
      this.#skipped += 1;
      return {
        allowed: false,
        used: this.#used,
        limit: this.#limit,
        skippedCount: this.#skipped
      };
    }

    this.#used += 1;
    return {
      allowed: true,
      used: this.#used,
      limit: this.#limit
    };
  }
}
