import { describe, expect, it } from "vitest";
import { DelegateCallBudget } from "./delegate-call-budget.js";

describe("DelegateCallBudget", () => {
  it("allows up to the configured limit and reports skipped calls", () => {
    const budget = new DelegateCallBudget(2);

    expect(budget.tryConsume()).toEqual({ allowed: true, used: 1, limit: 2 });
    expect(budget.tryConsume()).toEqual({ allowed: true, used: 2, limit: 2 });
    expect(budget.tryConsume()).toEqual({ allowed: false, used: 2, limit: 2, skippedCount: 1 });
    expect(budget.tryConsume()).toEqual({ allowed: false, used: 2, limit: 2, skippedCount: 2 });
  });

  it("resets between provider turns", () => {
    const budget = new DelegateCallBudget(1);

    expect(budget.tryConsume().allowed).toBe(true);
    expect(budget.tryConsume().allowed).toBe(false);
    budget.reset();
    expect(budget.tryConsume()).toEqual({ allowed: true, used: 1, limit: 1 });
  });
});
