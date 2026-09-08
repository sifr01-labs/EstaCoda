import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import { createUsageInspector } from "./usage-inspector.js";

describe("UsageInspector", () => {
  it("projects session usage and the latest provider context window", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "run" });
    await db.appendEvent("session-1", {
      kind: "context-window-usage",
      usedTokens: 4_000,
      totalTokens: 16_000,
      provider: "openai",
      model: "gpt-test"
    });
    await db.recordProviderUsageEntries([usageEntry("turn-1", "main-1", "main", 0.25)]);

    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });
    await expect(inspector.inspectSession("session-1")).resolves.toMatchObject({
      scope: "session",
      asOf: "latest-settled-provider-call",
      usage: { totalTokens: 120, estimatedCostUsd: 0.25, costComplete: true },
      contextWindow: { usedTokens: 4_000, totalTokens: 16_000 }
    });
  });

  it("finds the latest completed visible turn and partitions direct, auxiliary, and delegated usage", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "first" });
    await db.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "done",
      metadata: { respondingToTurnId: "turn-1" }
    });
    await db.appendMessage({ id: "turn-2", sessionId: "session-1", role: "user", content: "current query" });
    await db.recordProviderUsageEntries([
      usageEntry("turn-1", "main-1", "main", 0.2),
      usageEntry("turn-1", "aux-1", "auxiliary", 0.1),
      usageEntry("turn-1", "task-1", "task", 0.3, { taskId: "task-1", rootTaskId: "task-1" })
    ]);

    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });
    const inspection = await inspector.inspectLatestTurn("session-1", { excludeTurnId: "turn-2" });
    expect(inspection).toMatchObject({
      scope: "turn",
      selection: "latest",
      asOf: "latest-settled-provider-call",
      originatingTasks: { active: 0, settled: 0, scanTruncated: false },
      usage: {
        turnId: "turn-1",
        mainAgent: { providerCalls: 1, estimatedCostUsd: 0.2 },
        auxiliaryModels: { providerCalls: 1, estimatedCostUsd: 0.1 },
        delegatedWork: { providerCalls: 1, estimatedCostUsd: 0.3 },
        total: { providerCalls: 3 },
        provisional: false
      }
    });
    expect(inspection?.usage.total.estimatedCostUsd).toBeCloseTo(0.6);
  });

  it("resolves a runtime-owned replied turn only within the current session lineage", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "original" });
    await db.appendMessage({
      id: "turn-2",
      sessionId: "session-1",
      role: "user",
      content: "what did this cost?",
      metadata: { usageReplyToTurnId: "turn-1" }
    });
    await db.recordProviderUsageEntries([usageEntry("turn-1", "main-1", "main", 0.25)]);
    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });

    await expect(inspector.inspectRepliedTurn("session-1", "turn-2")).resolves.toMatchObject({
      scope: "turn",
      selection: "replied",
      usage: { turnId: "turn-1", total: { estimatedCostUsd: 0.25 } }
    });

    await db.createSession({ id: "other-session", profileId: "alpha" });
    await db.appendMessage({ id: "other-turn", sessionId: "other-session", role: "user", content: "private" });
    await db.appendMessage({
      id: "turn-3",
      sessionId: "session-1",
      role: "user",
      content: "cross-session",
      metadata: { usageReplyToTurnId: "other-turn" }
    });
    await expect(inspector.inspectRepliedTurn("session-1", "turn-3")).resolves.toBeUndefined();
  });

  it("authorizes linked turns only when the mapped session is in the active compression lineage", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "parent", profileId: "alpha", endReason: "compression" });
    await db.appendMessage({ id: "parent-turn", sessionId: "parent", role: "user", content: "original" });
    await db.createSession({
      id: "child",
      profileId: "alpha",
      parentSessionId: "parent",
      metadata: { compactedFromSessionId: "parent" }
    });
    await db.appendMessage({ id: "child-turn", sessionId: "child", role: "user", content: "continued" });
    await db.createSession({ id: "reset", profileId: "alpha" });
    await db.recordProviderUsageEntries([usageEntry("parent-turn", "main-1", "main", 0.25, {
      sessionId: "parent"
    })]);
    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });

    await expect(inspector.inspectLinkedTurn("child", "parent", "parent-turn")).resolves.toMatchObject({
      usage: { turnId: "parent-turn", total: { estimatedCostUsd: 0.25 } }
    });
    await expect(inspector.inspectLinkedTurn("child", "child", "child-turn")).resolves.toBeDefined();
    await expect(inspector.inspectLinkedTurn("child", "child", "parent-turn")).resolves.toBeUndefined();
    await expect(inspector.inspectLinkedTurn("reset", "parent", "parent-turn")).resolves.toBeUndefined();
    await expect(inspector.inspectLinkedTurn("child", "reset", "parent-turn")).resolves.toBeUndefined();
  });

  it("ignores a dangling completion link and finds the preceding valid completed turn", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "first" });
    await db.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "done",
      metadata: { respondingToTurnId: "turn-1" }
    });
    await db.appendMessage({
      sessionId: "session-1",
      role: "agent",
      content: "orphaned",
      metadata: { respondingToTurnId: "missing-turn" }
    });
    await db.recordProviderUsageEntries([usageEntry("turn-1", "main-1", "main", 0.25)]);

    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });
    await expect(inspector.inspectLatestTurn("session-1")).resolves.toMatchObject({
      scope: "turn",
      usage: { turnId: "turn-1", total: { estimatedCostUsd: 0.25 } }
    });
  });

  it("uses authorized Task status and fails closed when the Task is not linked to the session", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    const status = vi.fn((taskId: string, sessionId: string) => {
      if (taskId !== "task-1" || sessionId !== "session-1") throw new Error("not authorized");
      return {
        taskId,
        status: "running",
        usage: {
          providerCalls: 1,
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          totalTokens: 120,
          estimatedCostUsd: 0.25,
          usageComplete: true,
          pricingComplete: true,
          incompleteReasons: []
        },
        spending: {
          spentCostUsd: 0.25,
          reservedCostUsd: 0.1,
          remainingCostUsd: 0.65,
          maxEstimatedCostUsd: 1,
          warningThresholdPercent: 80,
          state: "available" as const
        }
      };
    });
    const inspector = createUsageInspector({
      sessionDb: db,
      profileId: "alpha",
      taskOperatorService: { status } as never
    });

    await expect(inspector.inspectTask("session-1", "task-1")).resolves.toMatchObject({
      scope: "task",
      status: "running",
      provisional: true,
      usage: { totalTokens: 120, estimatedCostUsd: 0.25 },
      budget: { spentCostUsd: 0.25, reservedCostUsd: 0.1, remainingCostUsd: 0.65 },
      asOf: "latest-settled-provider-call"
    });
    await expect(inspector.inspectTask("session-1", "other")).resolves.toBeUndefined();
  });

  it("keeps turn accounting provisional while a descendant Task can still add usage", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "session-1", profileId: "alpha" });
    await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "delegate" });
    const listTasks = vi.fn(() => [{
      id: "child-task",
      originTurnId: "turn-1",
      status: "running",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }]);
    const inspector = createUsageInspector({
      sessionDb: db,
      profileId: "alpha",
      taskStore: { listTasks } as never
    });

    await expect(inspector.inspectTurn("session-1", "turn-1")).resolves.toMatchObject({
      usage: { provisional: true },
      originatingTasks: { active: 1, settled: 0, scanTruncated: false }
    });
    expect(listTasks).toHaveBeenCalledWith(expect.not.objectContaining({ rootOnly: true }));
  });

  it("does not expose turns from another profile", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "other", profileId: "other" });
    await db.appendMessage({ id: "turn-other", sessionId: "other", role: "user", content: "private" });
    const inspector = createUsageInspector({ sessionDb: db, profileId: "alpha" });

    await expect(inspector.inspectTurn("other", "turn-other")).resolves.toBeUndefined();
  });
});

function usageEntry(
  visibleTurnId: string,
  requestKey: string,
  sourceKind: ProviderUsageEntry["sourceKind"],
  estimatedCostUsd: number,
  overrides: Partial<ProviderUsageEntry> = {}
): ProviderUsageEntry {
  return {
    id: `usage-${requestKey}`,
    profileId: "alpha",
    sessionId: "session-1",
    visibleTurnId,
    requestKey,
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind,
    pricing: { currency: "USD", fingerprint: "test-pricing" },
    pricingFingerprint: "test-pricing",
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    dispatchedAt: "2030-01-01T00:00:00.000Z",
    ...overrides
  };
}
