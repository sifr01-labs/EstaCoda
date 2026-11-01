import { describe, expect, it, vi } from "vitest";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import { createSkillDrafter, type SkillDraftInput } from "./skill-draft.js";

const route: ResolvedModelRoute = { provider: "mock", id: "mock", profile: {
  provider: "mock", id: "mock", contextWindowTokens: 32_000, supportsTools: true, supportsVision: false,
  supportsStructuredOutput: false, cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }
} };
const input: SkillDraftInput = { content: '---\n{"name":"test"}\n---\nRun checks.', evidence: [],
  candidateId: "candidate", sessionId: "session", usage: { visibleTurnId: "turn", sessionBudgetScopeId: "scope" },
  policy: deriveAgentEvolutionPolicy("proactive") };
const response = (content: unknown) => ({ ok: true, toolCalls: [], response: { content: JSON.stringify(content) } });

describe("bounded skill drafting", () => {
  it("uses the shared executor with attribution, no tools or fallback, and an exact body patch", async () => {
    const complete = vi.fn().mockResolvedValue(response({ oldString: "Run checks.", newString: "Run checks and inspect their results." }));
    const draft = createSkillDrafter({ executor: { complete }, route, profileId: "work" });
    expect(await draft(input)).toMatchObject({ type: "text_patch", oldString: "Run checks." });
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxTokens: 1_500 }), {}, expect.objectContaining({
      primaryRoute: route, fallbackChain: [], sessionId: "session", signal: expect.any(AbortSignal),
      usage: expect.objectContaining({ executionSessionId: "session", visibleTurnId: "turn", sessionBudgetScopeId: "scope", sourceKind: "auxiliary" })
    }));
    expect(complete.mock.calls[0]![0].tools).toBeUndefined();
  });

  it.each([
    { abstain: true }, { oldString: '"name":"test"', newString: '"name":"other"' },
    { oldString: "missing passage", newString: "new passage" }, { oldString: "Run checks.", newString: "Run checks." }
  ])("refuses unsupported generated changes: %j", async (result) => {
    const complete = vi.fn().mockResolvedValue(response(result));
    expect(await createSkillDrafter({ executor: { complete }, route, profileId: "work" })(input)).toBeUndefined();
  });

  it("does not dispatch when policy, cancellation, or the cost ceiling blocks drafting", async () => {
    const complete = vi.fn();
    const draft = createSkillDrafter({ executor: { complete }, route, profileId: "work" });
    await draft({ ...input, policy: deriveAgentEvolutionPolicy("suggest") });
    await draft({ ...input, signal: AbortSignal.abort() });
    await draft({ ...input, policy: deriveAgentEvolutionPolicy("proactive", { budgets: { maxProviderCostUsd: 0 } }) });
    expect(complete).not.toHaveBeenCalled();
  });
});
