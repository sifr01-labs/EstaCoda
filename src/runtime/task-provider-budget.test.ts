import { describe, expect, it } from "vitest";
import { mergeProviderExecutions, budgetTaskProviderRequest } from "./provider-turn-loop.js";

describe("Task provider finalization", () => {
  const request = { model: "test", messages: [{ role: "user" as const, content: "Audit the source" }],
    tools: [{ type: "function" as const, function: { name: "read", description: "Read source", parameters: { type: "object" } } }] };
  it("uses the same conservative input envelope as dispatch and preserves denial through continuation merge", () => {
    const result = budgetTaskProviderRequest(request, { remainingCalls: 20, remainingTokens: 200_000, remainingMs: 120_000 }, 100_000);
    expect(result.finalizing).toBe(true);
    expect(result.request.tools).toBeUndefined();
    expect(125_000 + result.request.maxTokens! * 2 + 2048).toBeLessThanOrEqual(200_000);
    const success = { ok: true, attempts: [], toolCalls: [], fallbackUsed: false };
    expect(mergeProviderExecutions(success, { ...success, ok: false, spendDenialReason: "TASK_EXECUTION_LIMIT_EXHAUSTED" }))
      .toMatchObject({ ok: false, spendDenialReason: "TASK_EXECUTION_LIMIT_EXHAUSTED" });
  });
  it("keeps tools during work and exposes the shared allowance", () => {
    const result = budgetTaskProviderRequest(request, { remainingCalls: 20, remainingTokens: 500_000, remainingMs: 120_000 });
    expect(result.finalizing).toBe(false);
    expect(result.request.tools).toEqual(request.tools);
    expect(result.request.messages.at(-1)?.content).toContain("500000 cumulative tokens");
    expect(request.messages).toHaveLength(1);
  });
  it.each([
    { remainingCalls: 2, remainingTokens: 500_000, remainingMs: 120_000 },
    { remainingCalls: 20, remainingTokens: 20_000, remainingMs: 120_000 },
    { remainingCalls: 20, remainingTokens: 500_000, remainingMs: 20_000 }
  ])("reserves a tool-free final response inside remaining allowance %j", budget => {
    const result = budgetTaskProviderRequest(request, budget);
    expect(result.finalizing).toBe(true);
    expect(result.request.tools).toBeUndefined();
    expect(result.request.messages.at(-1)?.content).toContain("Finalize now");
    expect(result.request.messages.at(-1)?.content).toContain("unverified scope");
  });
});
