import { describe, expect, it } from "vitest";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { SessionEvent } from "../contracts/session.js";
import {
  diagnoseSessionExecution,
  MAX_REPEATED_OBSERVATION_GROUPS,
} from "./session-execution-diagnostics.js";

describe("diagnoseSessionExecution", () => {
  it("projects bounded execution facts without copying sensitive event fields", () => {
    const sensitiveValues = [
      "raw prompt sentinel",
      "tool input sentinel",
      "tool result sentinel",
      "mission objective sentinel",
      "mission item sentinel",
      "blocker summary sentinel",
      "target summary sentinel",
      "protected label sentinel",
      "https://private.example/account",
      "secret-call-id",
    ];
    const events: SessionEvent[] = [
      {
        kind: "tool-called",
        tool: "browser.snapshot",
        input: { prompt: sensitiveValues[1] },
        toolCallId: sensitiveValues[9],
      },
      {
        kind: "tool-called",
        tool: "postman.update_collection",
        input: { url: sensitiveValues[8] },
      },
      {
        kind: "tool-result",
        tool: "browser.snapshot",
        result: { ok: true, content: sensitiveValues[2]! },
      },
      {
        kind: "tool-result",
        tool: "postman.update_collection",
        result: { ok: false, content: sensitiveValues[2]! },
      },
      evidence("browser.snapshot", "success", "read-only-network", sensitiveValues[6]),
      evidence("browser.snapshot", "success", "read-only-network", sensitiveValues[6]),
      evidence("https://private.example/account", "success", "read-only-network", sensitiveValues[6]),
      evidence("https://private.example/account", "success", "read-only-network", sensitiveValues[6]),
      evidence("browser.status", "blocked", "read-only-network", sensitiveValues[6]),
      evidence("postman.update_collection", "success", "external-side-effect", sensitiveValues[6]),
      {
        kind: "execution-plan-started",
        plan: {
          objective: sensitiveValues[3]!,
          originTurnId: sensitiveValues[9]!,
          revision: 1,
          status: "active",
          items: [{ id: "secret-item", content: sensitiveValues[4]!, status: "in_progress" }],
        },
      },
      {
        kind: "execution-plan-blocked",
        plan: {
          objective: sensitiveValues[3]!,
          originTurnId: sensitiveValues[9]!,
          revision: 2,
          status: "blocked",
          items: [{
            id: "secret-item",
            content: sensitiveValues[4]!,
            status: "blocked",
            blocker: { kind: "missing_capability", summary: sensitiveValues[5]! },
          }],
        },
      },
      {
        kind: "authentication-evidence-assessed",
        stage: "credentials",
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        submissionToolCallId: sensitiveValues[9]!,
        evidenceToolCallId: sensitiveValues[9]!,
        challengeDeparted: true,
        stateTransitionObserved: true,
        postSubmitEvidence: true,
        preexistingEvidence: false,
        navigationInterrupted: false,
        sensitiveInputActive: false,
      },
      providerCompletion(12_500),
    ];

    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-safe",
      events,
      providerUsage: [providerUsage()],
    });

    expect(diagnosis).toMatchObject({
      provider: {
        calls: 1,
        totalTokens: 30,
        usageComplete: true,
        estimatedCostUsd: 0.002,
        costComplete: true,
        timedCalls: 1,
        slowCalls: 1,
        slowestCallMs: 12_500,
      },
      tools: { calls: 2, results: 2, failedResults: 1 },
      observations: {
        repeatedCalls: 2,
        blocked: 1,
        repeatedGroups: [
          { tool: "[redacted]", calls: 2 },
          { tool: "browser.snapshot", calls: 2 },
        ],
      },
      mission: {
        activationObserved: true,
        progressTransitions: 1,
        status: "blocked",
        items: { pending: 0, in_progress: 0, completed: 0, blocked: 1, cancelled: 0 },
      },
      evidence: { mutations: 1, verifications: 4 },
      finalCause: "Mission blocked (missing capability)",
      authentication: {
        submissionObserved: "yes",
        challenge: "departed",
        documentTransitionOccurred: "yes",
        causalEvidence: "verified",
        sensitiveState: "released",
        providerSeam: "no",
      },
    });
    const serialized = JSON.stringify(diagnosis);
    for (const sensitive of sensitiveValues) expect(serialized).not.toContain(sensitive);
  });

  it("reports protected state as unknown without a valid atomic receipt", () => {
    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-empty",
      events: [{
        kind: "authentication-evidence-assessed",
        outcome: "verified",
        submissionToolCallId: "incomplete",
      } as unknown as SessionEvent],
      providerUsage: [],
    });

    expect(diagnosis.authentication).toEqual({
      submissionObserved: "no",
      challenge: "unknown",
      documentTransitionOccurred: "unknown",
      causalEvidence: "unknown",
      sensitiveState: "unknown",
      providerSeam: "unknown",
    });
    expect(diagnosis.provider).toMatchObject({
      calls: 0,
      totalTokens: 0,
      usageComplete: false,
      costComplete: false,
      timedCalls: 0,
    });
    expect(diagnosis.finalCause).toBe("Unknown");
  });

  it("keeps the provider seam unknown for an inconclusive protected settlement", () => {
    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-inconclusive",
      events: [{
        kind: "authentication-evidence-assessed",
        stage: "credentials",
        outcome: "inconclusive",
        reason: "protected-settlement-inconclusive",
        submissionToolCallId: "call-inconclusive",
        evidenceToolCallId: "call-inconclusive",
        challengeDeparted: false,
        stateTransitionObserved: false,
        postSubmitEvidence: false,
        preexistingEvidence: false,
        navigationInterrupted: false,
        sensitiveInputActive: true,
      }],
      providerUsage: [],
    });

    expect(diagnosis.authentication).toMatchObject({
      submissionObserved: "yes",
      causalEvidence: "inconclusive",
      sensitiveState: "remained active",
      providerSeam: "unknown",
    });
  });

  it("reports a terminal provider failure when the latest Mission remains active", () => {
    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-budget",
      events: [{
        kind: "execution-plan-started",
        plan: {
          objective: "continue the work",
          originTurnId: "turn-1",
          revision: 1,
          status: "active",
          items: [{ id: "step-1", content: "work", status: "in_progress" }],
        },
      }, {
        kind: "provider-budget-exhausted",
        budget: "provider-iterations",
        limit: 10,
        observed: 10,
        reason: "untrusted dynamic reason",
      }],
      providerUsage: [],
    });

    expect(diagnosis.finalCause).toBe("Provider budget exhausted");
  });

  it("caps repeated observation details while retaining the aggregate", () => {
    const events = Array.from({ length: MAX_REPEATED_OBSERVATION_GROUPS + 3 }, (_, index) => [
      evidence(`observer.${index}`, "success", "read-only-local"),
      evidence(`observer.${index}`, "success", "read-only-local"),
    ]).flat();

    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-bounded",
      events,
      providerUsage: [],
    });

    expect(diagnosis.observations.repeatedCalls).toBe(MAX_REPEATED_OBSERVATION_GROUPS + 3);
    expect(diagnosis.observations.repeatedGroups).toHaveLength(MAX_REPEATED_OBSERVATION_GROUPS);
  });

  it("counts only linked verification receipts as verification evidence", () => {
    const events: SessionEvent[] = [{
      ...evidence("mcp.postman.read", "success", "read-only-network"),
      executionEffect: { kind: "read", connector: { kind: "mcp", id: "postman" } },
    }, {
      ...evidence("mcp.postman.update", "success", "external-side-effect"),
      executionEffect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } },
    }, {
      ...evidence("mcp.postman.verify-unlinked", "success", "read-only-network"),
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.update"],
        connector: { kind: "mcp", id: "postman" },
      },
    }, {
      ...evidence("mcp.postman.verify-linked", "success", "read-only-network"),
      executionEffect: {
        kind: "verification",
        verifies: ["mcp.postman.update"],
        connector: { kind: "mcp", id: "postman" },
      },
      verifiedMutation: {
        toolCallId: "call-mcp.postman.update-success",
        tool: "mcp.postman.update",
      },
    } as Extract<SessionEvent, { kind: "execution-evidence-recorded" }>];

    const diagnosis = diagnoseSessionExecution({
      sessionId: "session-effects",
      events,
      providerUsage: [],
    });

    expect(diagnosis.evidence).toEqual({ mutations: 1, verifications: 1 });
    expect(diagnosis.observations.repeatedCalls).toBe(0);
  });
});

function evidence(
  tool: string,
  status: "success" | "blocked",
  riskClass: "read-only-local" | "read-only-network" | "external-side-effect",
  targetSummary?: string
): Extract<SessionEvent, { kind: "execution-evidence-recorded" }> {
  return {
    kind: "execution-evidence-recorded",
    toolCallId: `call-${tool}-${status}`,
    tool,
    status,
    riskClass,
    ...(targetSummary === undefined ? {} : { targetSummary }),
  };
}

function providerCompletion(durationMs: number): Extract<SessionEvent, { kind: "provider-completion" }> {
  return {
    kind: "provider-completion",
    ok: true,
    fallbackUsed: false,
    attempts: [{
      state: "dispatched",
      dispatchedAt: "2026-08-16T08:00:00.000Z",
      provider: "test",
      model: "test-model",
      ok: true,
      streamDiagnostics: {
        stream: true,
        startedAtMs: 0,
        endedAtMs: durationMs,
        durationMs,
        eventCount: 1,
        tokenChunks: 1,
        visibleChars: 1,
        toolCallChunks: 0,
        transportDone: true,
        finish: "done",
      },
    }],
  };
}

function providerUsage(): ProviderUsageEntry {
  return {
    id: "usage-id",
    profileId: "default",
    sessionId: "session-safe",
    requestKey: "sha256:request",
    provider: "test",
    model: "test-model",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 0,
    sourceKind: "main",
    pricing: { currency: "USD", fingerprint: "sha256:pricing" },
    pricingFingerprint: "sha256:pricing",
    inputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 30,
    estimatedCostUsd: 0.002,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    dispatchedAt: "2026-08-16T08:00:00.000Z",
  };
}
