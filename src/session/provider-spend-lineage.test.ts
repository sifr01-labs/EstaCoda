import { describe, expect, it } from "vitest";
import type { ProviderSpendRequest } from "../contracts/provider-spend.js";
import { assertProviderSpendRequest } from "../contracts/provider-spend.js";
import { InMemorySessionDB } from "./in-memory-session-db.js";
import { assertProviderSpendLineage } from "./provider-spend-lineage.js";

describe("provider spend contracts", () => {
  it("accepts complete leaf Task attribution and rejects partial attribution", () => {
    const complete = request({
      sourceKind: "task",
      executionSessionId: "worker-session",
      taskId: "task-child",
      rootTaskId: "task-root",
      planRevisionId: "revision-child",
      stepId: "step-child",
      attemptId: "attempt-child"
    });

    expect(() => assertProviderSpendRequest(complete)).not.toThrow();
    expect(() => assertProviderSpendRequest({ ...complete, attemptId: undefined }))
      .toThrow(/Task attribution must be complete/i);
  });

  it("requires every dispatched-capacity bound to be finite and non-negative", () => {
    expect(() => assertProviderSpendRequest(request({ maximumEstimatedCostUsd: Number.POSITIVE_INFINITY })))
      .toThrow(/maximum estimated cost/i);
    expect(() => assertProviderSpendRequest(request({ boundedMaximumOutputTokens: -1 })))
      .toThrow(/maximum output tokens/i);
    expect(() => assertProviderSpendRequest(request({
      pricing: { currency: "USD", fingerprint: "pricing-v1", inputPerMillionTokens: Number.NaN }
    }))).toThrow(/pricing snapshot input rate/i);
  });

  it("rejects an unrelated same-profile visible turn", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "execution", profileId: "alpha" });
    await db.createSession({ id: "unrelated", profileId: "alpha" });
    await db.appendMessage({ id: "unrelated-turn", sessionId: "unrelated", role: "user", content: "Other work" });

    await expect(assertProviderSpendLineage(db, request({
      executionSessionId: "execution",
      visibleTurnId: "unrelated-turn"
    }))).rejects.toThrow(/compression lineage/i);
  });

  it("does not treat an ordinary child Session as compression lineage", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "parent", profileId: "alpha" });
    await db.appendMessage({ id: "parent-turn", sessionId: "parent", role: "user", content: "Delegated work" });
    await db.createSession({ id: "worker", profileId: "alpha", parentSessionId: "parent" });

    await expect(assertProviderSpendLineage(db, request({
      executionSessionId: "worker",
      visibleTurnId: "parent-turn"
    }))).rejects.toThrow(/compression lineage/i);
  });

  it("accepts a Task worker turn attributed to its originating Session budget scope", async () => {
    const db = new InMemorySessionDB();
    const limit = { maxEstimatedCostUsd: 5, warningThresholdPercent: 80 };
    await db.createSession({ id: "origin", profileId: "alpha", spendingLimit: limit });
    await db.appendMessage({ id: "origin-turn", sessionId: "origin", role: "user", content: "Delegated work" });
    await db.createSession({
      id: "worker",
      profileId: "alpha",
      parentSessionId: "origin",
      spendingScopeSessionId: "origin",
      spendingLimit: limit
    });

    await expect(assertProviderSpendLineage(db, request({
      sourceKind: "task",
      executionSessionId: "worker",
      sessionBudgetScopeId: "origin",
      visibleTurnId: "origin-turn",
      taskId: "task-child",
      rootTaskId: "task-root",
      planRevisionId: "revision-child",
      stepId: "step-child",
      attemptId: "attempt-child"
    }))).resolves.toBeUndefined();
  });

  it("accepts a visible turn from verified compression ancestry", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "parent", profileId: "alpha", endReason: "compression" });
    await db.appendMessage({ id: "parent-turn", sessionId: "parent", role: "user", content: "Original work" });
    await db.createSession({
      id: "compressed-child",
      profileId: "alpha",
      parentSessionId: "parent",
      metadata: { compactedFromSessionId: "parent" }
    });

    await expect(assertProviderSpendLineage(db, request({
      executionSessionId: "compressed-child",
      visibleTurnId: "parent-turn"
    }))).resolves.toBeUndefined();
  });

  it("allows Session-level auxiliary work to omit a visible turn", async () => {
    const db = new InMemorySessionDB();
    await db.createSession({ id: "execution", profileId: "alpha" });

    await expect(assertProviderSpendLineage(db, request({
      sourceKind: "auxiliary",
      auxiliaryKind: "compression",
      executionSessionId: "execution",
      visibleTurnId: undefined
    }))).resolves.toBeUndefined();
  });
});

function request(overrides: Partial<ProviderSpendRequest> = {}): ProviderSpendRequest {
  return {
    requestKey: "provider-request-1",
    profileId: "alpha",
    executionSessionId: "execution",
    visibleTurnId: "visible-turn",
    sourceKind: "main",
    provider: "openai",
    model: "gpt-test",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    pricing: { currency: "USD", fingerprint: "pricing-v1" },
    estimatedInputTokens: 100,
    boundedMaximumOutputTokens: 200,
    maximumEstimatedCostUsd: 1,
    ...overrides
  };
}
