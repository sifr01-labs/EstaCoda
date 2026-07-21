import { describe, expect, it } from "vitest";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { Task } from "../contracts/task.js";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import { loadSessionCostUsage } from "./session-cost-usage.js";

describe("loadSessionCostUsage", () => {
  it("restores direct spend across verified compression ancestry", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "parent", "parent-turn", { endReason: "compression" });
    await createTurn(db, "child", "child-turn", {
      parentSessionId: "parent",
      metadata: { compactedFromSessionId: "parent" },
    });
    await db.recordProviderUsageEntries([
      usageEntry("parent", "parent-turn", "parent-request", 0.5),
      usageEntry("child", "child-turn", "child-request", 0.2),
    ]);

    await expect(loadSessionCostUsage({
      sessionDb: db,
      profileId: "alpha",
      sessionId: "child",
    })).resolves.toMatchObject({
      providerCalls: 2,
      estimatedCostUsd: 0.7,
      costComplete: true,
    });
  });

  it("does not follow an arbitrary parent session", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "delegator", "delegator-turn");
    await createTurn(db, "worker", "worker-turn", { parentSessionId: "delegator" });
    await db.recordProviderUsageEntries([
      usageEntry("delegator", "delegator-turn", "delegator-request", 0.5),
      usageEntry("worker", "worker-turn", "worker-request", 0.2),
    ]);

    await expect(loadSessionCostUsage({
      sessionDb: db,
      profileId: "alpha",
      sessionId: "worker",
    })).resolves.toMatchObject({
      providerCalls: 1,
      estimatedCostUsd: 0.2,
    });
  });

  it("projects the logical session limit with settled and reserved capacity", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({
      id: "budgeted",
      profileId: "alpha",
      spendingLimit: { maxEstimatedCostUsd: 2, warningThresholdPercent: 75 }
    });

    await expect(loadSessionCostUsage({
      sessionDb: db,
      profileId: "alpha",
      sessionId: "budgeted",
      spendingScope: (ownerId) => ({
        profileId: "alpha",
        kind: "session",
        ownerId,
        maxEstimatedCostUsd: 2,
        warningThresholdPercent: 75,
        spentCostUsd: 0.8,
        reservedCostUsd: 0.3,
        state: "available",
        ownerCreatedAt: "2030-01-01T00:00:00.000Z",
        createdAt: "2030-01-01T00:00:00.000Z"
      })
    })).resolves.toMatchObject({
      budget: {
        spentCostUsd: 0.8,
        reservedCostUsd: 0.3,
        remainingCostUsd: 0.9,
        maxEstimatedCostUsd: 2
      }
    });
  });

  it("adds originating asynchronous Task trees once and ignores unrelated Tasks", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "session", "turn");
    await db.recordProviderUsageEntries([usageEntry("session", "turn", "direct", 0.3)]);
    const taskEntries = [
      usageEntry("task-session", "task-turn", "task-request", 0.4, { taskId: "task-1", rootTaskId: "task-1" }),
      usageEntry("task-session", "task-turn", "task-request", 0.4, { taskId: "task-1", rootTaskId: "task-1" }),
    ];
    const taskStore = {
      listTasks: () => [task("task-1", "session"), task("unrelated", "other-session")],
      listProviderUsageEntries: ({ rootTaskId }: { rootTaskId?: string }) => rootTaskId === "task-1" ? taskEntries : [],
    };

    await expect(loadSessionCostUsage({
      sessionDb: db,
      taskStore: taskStore as never,
      profileId: "alpha",
      sessionId: "session",
    })).resolves.toMatchObject({
      providerCalls: 2,
      estimatedCostUsd: 0.7,
    });
  });

  it("fails closed for a cross-profile current session", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "other", profileId: "other" });
    await expect(loadSessionCostUsage({
      sessionDb: db,
      profileId: "alpha",
      sessionId: "other",
    })).resolves.toBeUndefined();
  });

  it("marks a bounded Task scan as unavailable instead of a false complete zero", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "session", "turn");
    const taskStore = {
      listTasks: () => Array.from({ length: 1_000 }, (_, index) => task(`unrelated-${index}`, "other-session")),
      listProviderUsageEntries: () => [],
    };

    await expect(loadSessionCostUsage({
      sessionDb: db,
      taskStore: taskStore as never,
      profileId: "alpha",
      sessionId: "session",
    })).resolves.toMatchObject({
      costComplete: false,
      usageComplete: false,
      incompleteReasons: ["session-task-scan-truncated"],
    });
    expect(await loadSessionCostUsage({
      sessionDb: db,
      taskStore: taskStore as never,
      profileId: "alpha",
      sessionId: "session",
    })).not.toHaveProperty("estimatedCostUsd");
  });
});

async function createTurn(
  db: InMemorySessionDB,
  sessionId: string,
  turnId: string,
  options: { endReason?: "compression"; parentSessionId?: string; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  await db.createSession({ id: sessionId, profileId: "alpha", ...options });
  await db.appendMessage({ id: turnId, sessionId, role: "user", content: "run" });
}

function usageEntry(
  sessionId: string,
  visibleTurnId: string,
  requestKey: string,
  estimatedCostUsd: number,
  overrides: Partial<ProviderUsageEntry> = {}
): ProviderUsageEntry {
  return {
    id: `usage-${requestKey}`,
    profileId: "alpha",
    sessionId,
    visibleTurnId,
    requestKey,
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind: "main",
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
    ...overrides,
  };
}

function task(id: string, originSessionId: string): Pick<Task, "id" | "rootTaskId" | "originSessionId"> {
  return { id, rootTaskId: id, originSessionId };
}
