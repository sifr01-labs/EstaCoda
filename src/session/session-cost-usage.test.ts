import { describe, expect, it, vi } from "vitest";
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

  it("scopes unrelated Tasks out before applying the Task page limit", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "session", "turn");
    const listTasks = vi.fn(() => []);
    const taskStore = {
      listTasks,
      listProviderUsageEntries: () => [],
    };

    const usage = await loadSessionCostUsage({
      sessionDb: db,
      taskStore: taskStore as never,
      profileId: "alpha",
      sessionId: "session",
    });
    expect(usage).toMatchObject({ costComplete: true, usageComplete: true, incompleteReasons: [] });
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({
      originSessionIds: ["session"],
      rootOnly: true,
      order: "created_asc",
      limit: 1_000
    }));
  });

  it("continues session-scoped Task spend through keyset pages", async () => {
    const db = new InMemorySessionDB();
    await createTurn(db, "session", "turn");
    const firstPage = Array.from({ length: 1_000 }, (_, index) => task(`root-${String(index).padStart(4, "0")}`, "session"));
    const finalTask = task("root-final", "session");
    const listTasks = vi.fn((options: { cursor?: unknown }) => options.cursor === undefined ? firstPage : [finalTask]);
    const taskStore = {
      listTasks,
      listProviderUsageEntries: ({ rootTaskId }: { rootTaskId?: string }) => rootTaskId === finalTask.id
        ? [usageEntry("task-session", "task-turn", "paginated-task-request", 0.6, {
            taskId: finalTask.id,
            rootTaskId: finalTask.id
          })]
        : []
    };

    await expect(loadSessionCostUsage({
      sessionDb: db,
      taskStore: taskStore as never,
      profileId: "alpha",
      sessionId: "session",
    })).resolves.toMatchObject({
      providerCalls: 1,
      estimatedCostUsd: 0.6,
      costComplete: true,
      usageComplete: true
    });
    expect(listTasks).toHaveBeenCalledTimes(2);
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

function task(
  id: string,
  originSessionId: string
): Pick<Task, "id" | "rootTaskId" | "originSessionId" | "createdAt" | "updatedAt"> {
  return {
    id,
    rootTaskId: id,
    originSessionId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}
