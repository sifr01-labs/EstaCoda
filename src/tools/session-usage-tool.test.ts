import { describe, expect, it, vi } from "vitest";
import { createSessionUsageTool } from "./session-usage-tool.js";

describe("session.usage", () => {
  it("reads current-session usage without invoking a provider", async () => {
    const inspectSession = vi.fn(async () => ({
      scope: "session" as const,
      sessionId: "session-1",
      usage: usage(120, 0.25),
      contextWindow: { usedTokens: 4_000, totalTokens: 16_000, provider: "openai", model: "gpt-test" },
      asOf: "latest-settled-provider-call" as const
    }));
    const [tool] = createSessionUsageTool({
      inspector: { inspectSession, inspectLatestTurn: vi.fn(), inspectRepliedTurn: vi.fn(), inspectLinkedTurn: vi.fn(), inspectTurn: vi.fn(), inspectTask: vi.fn() },
      currentSessionId: () => "session-1"
    });

    const result = await tool!.run({ scope: "session" });
    expect(inspectSession).toHaveBeenCalledWith("session-1");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Usage — current session");
    expect(result.content).toContain("120");
    expect(result.content).toContain("$0.25");
    expect(result.content).toContain("25.0%");
  });

  it("excludes the current tool-calling turn when inspecting the latest completed turn", async () => {
    const inspectLatestTurn = vi.fn(async () => ({
      scope: "turn" as const,
      selection: "latest" as const,
      sessionId: "session-1",
      usage: {
        turnId: "prior-turn",
        mainAgent: usage(100, 0.2),
        auxiliaryModels: usage(20, 0.05),
        delegatedWork: usage(0, 0),
        total: usage(120, 0.25),
        provisional: false
      },
      originatingTasks: { active: 0, settled: 0, scanTruncated: false },
      asOf: "latest-settled-provider-call" as const
    }));
    const [tool] = createSessionUsageTool({
      inspector: { inspectSession: vi.fn(), inspectLatestTurn, inspectRepliedTurn: vi.fn(), inspectLinkedTurn: vi.fn(), inspectTurn: vi.fn(), inspectTask: vi.fn() },
      currentSessionId: () => "session-1"
    });

    const result = await tool!.run({ scope: "latest_turn" }, { visibleTurnId: "current-turn" });
    expect(inspectLatestTurn).toHaveBeenCalledWith("session-1", { excludeTurnId: "current-turn" });
    expect(result.content).toContain("Usage — latest completed turn");
    expect(result.content).toContain("Delegated Task usage is included");
  });

  it("uses runtime-owned reply attribution for the current channel turn", async () => {
    const inspectRepliedTurn = vi.fn(async () => ({
      scope: "turn" as const,
      selection: "replied" as const,
      sessionId: "session-1",
      usage: {
        turnId: "replied-turn",
        mainAgent: usage(100, 0.2),
        auxiliaryModels: usage(0, 0),
        delegatedWork: usage(0, 0),
        total: usage(100, 0.2),
        provisional: false
      },
      originatingTasks: { active: 0, settled: 0, scanTruncated: false },
      asOf: "latest-settled-provider-call" as const
    }));
    const [tool] = createSessionUsageTool({
      inspector: {
        inspectSession: vi.fn(),
        inspectLatestTurn: vi.fn(),
        inspectRepliedTurn,
        inspectLinkedTurn: vi.fn(),
        inspectTurn: vi.fn(),
        inspectTask: vi.fn()
      },
      currentSessionId: () => "session-1"
    });

    const result = await tool!.run({ scope: "replied_turn" }, { visibleTurnId: "current-turn" });
    expect(inspectRepliedTurn).toHaveBeenCalledWith("session-1", "current-turn");
    expect(result.content).toContain("Usage — replied message");
  });

  it("rejects malformed scopes and reports an empty history deterministically", async () => {
    const inspectLatestTurn = vi.fn(async () => undefined);
    const [tool] = createSessionUsageTool({
      inspector: { inspectSession: vi.fn(), inspectLatestTurn, inspectRepliedTurn: vi.fn(), inspectLinkedTurn: vi.fn(), inspectTurn: vi.fn(), inspectTask: vi.fn() },
      currentSessionId: () => "session-1"
    });

    await expect(tool!.run({ scope: "task" } as never)).resolves.toMatchObject({ ok: false, metadata: { error: "invalid-input" } });
    await expect(tool!.run({ scope: "latest_turn" })).resolves.toMatchObject({
      ok: false,
      content: "No completed turn usage is available in this session."
    });
  });

  it("turns local accounting failures into a bounded structured error", async () => {
    const [tool] = createSessionUsageTool({
      inspector: {
        inspectSession: vi.fn(async () => { throw new Error("private database path"); }),
        inspectLatestTurn: vi.fn(),
        inspectRepliedTurn: vi.fn(),
        inspectLinkedTurn: vi.fn(),
        inspectTurn: vi.fn(),
        inspectTask: vi.fn()
      },
      currentSessionId: () => "session-1"
    });

    await expect(tool!.run({ scope: "session" })).resolves.toEqual({
      ok: false,
      content: "Usage could not be read from local accounting records.",
      metadata: { error: "usage-read-failed" }
    });
  });
});

function usage(totalTokens: number, estimatedCostUsd: number) {
  return {
    providerCalls: totalTokens === 0 ? 0 : 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    estimatedCostUsd,
    usageComplete: true,
    costComplete: true,
    incompleteReasons: []
  };
}
