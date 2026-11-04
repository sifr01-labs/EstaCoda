import { describe, expect, it, vi } from "vitest";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import { buildSkillReviewContext, createSkillDrafter, type SkillDraftInput } from "./skill-draft.js";
import type { SessionMessage } from "../contracts/session.js";

const route: ResolvedModelRoute = { provider: "mock", id: "mock", profile: {
  provider: "mock", id: "mock", contextWindowTokens: 32_000, supportsTools: true, supportsVision: false,
  supportsStructuredOutput: false, cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }
} };
const input: SkillDraftInput = { content: '---\n{"name":"test"}\n---\nRun checks.', evidence: [],
  candidateId: "candidate", sessionId: "session", usage: { visibleTurnId: "turn", sessionBudgetScopeId: "scope" },
  policy: deriveAgentEvolutionPolicy("proactive") };
const response = (content: unknown) => ({ ok: true, toolCalls: [], response: { content: JSON.stringify(content) } });

describe("bounded skill drafting", () => {
  it("gathers scoped evidence before proposing, uses configured fallback and unique round keys", async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, content: "The accepted result confirms the corrected check order." });
    const complete = vi.fn().mockResolvedValueOnce({ ok: true, toolCalls: [
      { id: "read-1", name: "task_result_read", argumentsText: '{"task_id":"task","result_id":"result"}' }
    ], response: { content: "" } }).mockResolvedValueOnce(response({ oldString: "Run checks.", newString: "Run checks and inspect their results." }));
    const draft = createSkillDrafter({ executor: { complete }, route, fallbackChain: [{ ...route, id: "backup" }], profileId: "work" });
    expect(await draft({ ...input, readTools: [{ name: "task.result.read", description: "Scoped read", inputSchema: {},
      riskClass: "read-only-local", toolsets: ["core"], progressLabel: "reading", maxResultSizeChars: 8000,
      isAvailable: () => true, run: read }] })).toMatchObject({ type: "text_patch" });
    expect(read).toHaveBeenCalledWith({ task_id: "task", result_id: "result" });
    expect(complete.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", toolCallId: "read-1", content: expect.stringContaining("accepted result") })
    ]));
    expect(complete.mock.calls[0]![2].fallbackChain).toEqual([{ ...route, id: "backup" }]);
    expect(complete.mock.calls[0]![2].usage.requestKey).not.toBe(complete.mock.calls[1]![2].usage.requestKey);
  });

  it("distinguishes provider failure from abstention and refuses an unprovided tool", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: false, toolCalls: [], errorClass: "rate-limit" });
    const draft = createSkillDrafter({ executor: { complete }, route, profileId: "work" });
    await expect(draft(input)).rejects.toMatchObject({ reason: "provider-failure" });
    complete.mockResolvedValue({ ok: true, toolCalls: [{ id: "x", name: "terminal_run", argumentsText: "{}" }] });
    await expect(draft(input)).rejects.toMatchObject({ reason: "evidence-unavailable" });
  });
  it("keeps corrections, commands and failure receipts while bounding and redacting replay", () => {
    const message = (id: string, role: SessionMessage["role"], content: string, metadata?: Record<string, unknown>): SessionMessage =>
      ({ id, sessionId: "session", role, content, createdAt: "2026-11-02T00:00:00Z", metadata });
    const messages = [message("system", "system", "Private system instruction"),
      message("task", "user", "Use the current procedure."),
      message("correction", "user", 'Correction: credit amounts must subtract. API_KEY="sk-123456789012345678901234567890"'),
      ...Array.from({ length: 220 }, (_, i) => message(`tool-${i}`, "tool", "x".repeat(8_000) + "\nFailure at the tail", { tool: "terminal.run", ok: false })),
      message("command", "agent", "", { providerToolCalls: [{ name: "terminal_run", argumentsText: '{"command":"node verify.mjs","password":"do-not-send-this"}' }] }),
      message("result", "tool", "3 tests passed; 1 failed", { tool: "terminal.run", ok: false })];
    const context = buildSkillReviewContext(messages);
    const text = JSON.stringify(context);
    expect(text).toContain("credit amounts must subtract");
    expect(text).toContain("node verify.mjs");
    expect(text).toContain("3 tests passed; 1 failed");
    expect(text).toContain("Failure at the tail");
    expect(text).not.toContain("Private system instruction");
    expect(text).not.toContain("sk-123456789012345678901234567890");
    expect(text).not.toContain("do-not-send-this");
    expect(context.omittedMessages).toBeGreaterThan(0);
    expect(context.clippedMessages).toBeGreaterThan(0);
    expect(context.messages.length).toBeLessThanOrEqual(24);
    expect(context.messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(24_000);
  });
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
    { oldString: '"name":"test"', newString: '"name":"other"' },
    { oldString: "missing passage", newString: "new passage" }, { oldString: "Run checks.", newString: "Run checks." },
    { oldString: "Run checks.", newString: 'Use API_KEY="sk-123456789012345678901234567890".' }
  ])("refuses unsupported generated changes: %j", async (result) => {
    const complete = vi.fn().mockResolvedValue(response(result));
    await expect(createSkillDrafter({ executor: { complete }, route, profileId: "work" })(input)).rejects.toMatchObject({ reason: "invalid-response" });
  });

  it("records deliberate abstention without a technical failure", async () => {
    const complete = vi.fn().mockResolvedValue(response({ abstain: true }));
    expect(await createSkillDrafter({ executor: { complete }, route, profileId: "work" })(input)).toBeUndefined();
  });

  it("does not dispatch when policy, cancellation, or the cost ceiling blocks drafting", async () => {
    const complete = vi.fn();
    const draft = createSkillDrafter({ executor: { complete }, route, profileId: "work" });
    await draft({ ...input, policy: deriveAgentEvolutionPolicy("suggest") });
    await draft({ ...input, signal: AbortSignal.abort() });
    await expect(draft({ ...input, policy: deriveAgentEvolutionPolicy("proactive", { budgets: { maxProviderCostUsd: 0 } }) })).rejects.toMatchObject({ reason: "policy-blocked" });
    expect(complete).not.toHaveBeenCalled();
  });
});
