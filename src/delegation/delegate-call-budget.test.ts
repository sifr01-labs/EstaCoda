import { describe, expect, it } from "vitest";
import { DelegateCallBudget } from "./delegate-call-budget.js";

describe("DelegateCallBudget", () => {
  it("reserves atomically, releases once, and ignores old-turn releases", () => {
    const budget=new DelegateCallBudget(1);
    const first=budget.reserve();expect(first.allowed).toBe(true);
    const blocked=budget.reserve();expect(blocked.allowed).toBe(false);blocked.release();
    expect(budget.reserve().allowed).toBe(false);
    first.release();const next=budget.reserve();expect(next.allowed).toBe(true);
    first.release();expect(budget.reserve().allowed).toBe(false);
    budget.reset();expect(budget.reserve().allowed).toBe(true);
    next.release();expect(budget.reserve().allowed).toBe(false);
  });

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
