import { describe, expect, it } from "vitest";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";
import { providerUsageEntriesFromExecution } from "../providers/provider-usage-ledger.js";
import {
  taskUsageFromAgentResponse,
  taskUsageFromEntries
} from "./task-agent-usage.js";

const DISPATCHED_AT = "2030-01-01T00:00:00.000Z";

describe("taskUsageFromAgentResponse", () => {
  it("rejects injected provider Attempts that omit dispatch state", () => {
    const malformed = {
      ok: false,
      fallbackUsed: false,
      attempts: [{ provider: "openai", model: "primary", ok: false, content: "" }],
      toolCalls: []
    } as unknown as ProviderExecutionResult;

    expect(() => taskUsageFromAgentResponse(malformed, routes())).toThrow(/dispatch state/i);
  });

  it("excludes preflight failures and retains failed requests that reached a provider", () => {
    const execution: ProviderExecutionResult = {
      ok: false,
      fallbackUsed: true,
      attempts: [
        { provider: "openai", model: "primary", state: "preflight", ok: false, errorClass: "auth", content: "" },
        {
          provider: "deepseek",
          model: "fallback",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          errorClass: "timeout",
          content: ""
        }
      ],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, routes())).toMatchObject({
      providerCalls: 1,
      usageComplete: false,
      pricingComplete: false
    });
  });

  it("prices uncached input, cache reads, and cache writes on the exact route", () => {
    const cacheRoutes = routes();
    cacheRoutes.primaryModelRoute!.profile.cost = {
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 4,
      reasoningPerMillionTokens: 0,
      cacheReadPerMillionTokens: 0.5,
      cacheWritePerMillionTokens: 1
    };
    const execution: ProviderExecutionResult = {
      ok: true,
      fallbackUsed: false,
      attempts: [{
        provider: "openai",
        model: "primary",
        state: "dispatched",
        dispatchedAt: DISPATCHED_AT,
        ok: true,
        content: "done",
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          cacheReadTokens: 400,
          cacheWriteTokens: 100
        }
      }],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, cacheRoutes)).toMatchObject({
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      usageComplete: true,
      pricingComplete: true
    });
    expect(taskUsageFromAgentResponse(execution, cacheRoutes).estimatedCostUsd).toBeCloseTo(0.0017, 12);
  });

  it("counts every provider Attempt and applies each route's pricing", () => {
    const execution: ProviderExecutionResult = {
      ok: true,
      response: { ok: true, content: "done", provider: "openai", model: "primary" },
      fallbackUsed: true,
      attempts: [
        {
          provider: "openai",
          model: "primary",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          content: "",
          usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, reasoningTokens: 40 }
        },
        {
          provider: "deepseek",
          model: "fallback",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "done",
          usage: { inputTokens: 2_000, outputTokens: 300, totalTokens: 2_300, reasoningTokens: 50 }
        }
      ],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, routes())).toEqual({
      providerCalls: 2,
      inputTokens: 3_000,
      outputTokens: 400,
      reasoningTokens: 90,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3_400,
      estimatedCostUsd: 0.005,
      usageComplete: true,
      pricingComplete: true,
      incompleteReasons: []
    });
  });

  it("keeps known totals while marking missing usage and pricing incomplete", () => {
    const execution: ProviderExecutionResult = {
      ok: false,
      fallbackUsed: false,
      attempts: [
        { provider: "openai", model: "primary", state: "dispatched", dispatchedAt: DISPATCHED_AT, ok: false, content: "" },
        {
          provider: "unknown",
          model: "unpriced",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          content: "",
          usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 }
        }
      ],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, routes())).toMatchObject({
      providerCalls: 2,
      inputTokens: 25,
      outputTokens: 5,
      totalTokens: 30,
      estimatedCostUsd: 0,
      usageComplete: false,
      pricingComplete: false
    });
    expect(taskUsageFromAgentResponse(execution, routes()).incompleteReasons).toEqual([
      "provider-attempt-1-usage-missing",
      "provider-attempt-1-token-breakdown-incomplete",
      "provider-attempt-1-total-tokens-missing",
      "provider-attempt-2-input-pricing-missing",
      "provider-attempt-2-output-pricing-missing"
    ]);
  });

  it("does not double-count reasoning tokens in total tokens or cost", () => {
    const execution: ProviderExecutionResult = {
      ok: true,
      response: { ok: true, content: "done", provider: "openai", model: "primary" },
      fallbackUsed: false,
      attempts: [{
        provider: "openai",
        model: "primary",
        state: "dispatched",
        dispatchedAt: DISPATCHED_AT,
        ok: true,
        content: "done",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 15 }
      }],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, routes())).toMatchObject({
      totalTokens: 120,
      reasoningTokens: 15
    });
    expect(taskUsageFromAgentResponse(execution, routes()).estimatedCostUsd).toBeCloseTo(0.00028, 12);
  });
});

describe("task usage ledger", () => {
  it("meters completion and continuation provider calls with stable request identities", () => {
    const first = providerUsageEntriesFromExecution({
      execution: {
        ok: true,
        fallbackUsed: false,
        attempts: [{
          provider: "openai",
          model: "primary",
          state: "dispatched",
          dispatchedAt: "2030-01-01T00:00:00.000Z",
          ok: true,
          content: "done",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
        }],
        toolCalls: []
      },
      profileId: "alpha",
      sessionId: "worker-alpha",
      visibleTurnId: "message-alpha",
      requestSequence: 0,
      routes: [routes().primaryModelRoute!, ...routes().modelFallbackRoutes!],
      task: {
        taskId: "task-alpha",
        rootTaskId: "task-alpha",
        planRevisionId: "revision-alpha",
        stepId: "step-alpha",
        attemptId: "attempt-alpha"
      }
    });
    const second = providerUsageEntriesFromExecution({
      execution: {
        ok: true,
        fallbackUsed: true,
        attempts: [{
          provider: "deepseek",
          model: "fallback",
          state: "dispatched",
          dispatchedAt: "2030-01-01T00:00:01.000Z",
          ok: true,
          content: "done",
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }
        }],
        toolCalls: []
      },
      profileId: "alpha",
      sessionId: "worker-alpha",
      visibleTurnId: "message-alpha",
      requestSequence: 1,
      routes: [routes().primaryModelRoute!, ...routes().modelFallbackRoutes!],
      task: {
      taskId: "task-alpha",
      rootTaskId: "task-alpha",
      planRevisionId: "revision-alpha",
      stepId: "step-alpha",
        attemptId: "attempt-alpha"
      }
    });
    const entries = [...first, ...second];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.routeRole, entry.routeIndex])).toEqual([
      ["primary", 0],
      ["fallback", 1]
    ]);
    expect(entries.map((entry) => entry.requestKey)).toEqual([
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    ]);
    expect(entries[0]!.requestKey).not.toBe(entries[1]!.requestKey);
    const totals = taskUsageFromEntries(entries);
    expect(totals).toMatchObject({
      providerCalls: 2,
      totalTokens: 180,
      usageComplete: true,
      pricingComplete: true
    });
    expect(totals.estimatedCostUsd).toBeCloseTo(0.00035, 12);
  });

  it("uses dispatch-time route identity when duplicate provider/model routes have different pricing", () => {
    const primary = routes().primaryModelRoute!;
    const duplicateFallback = {
      ...primary,
      profile: {
        ...primary.profile,
        cost: { inputPerMillionTokens: 10, outputPerMillionTokens: 20 }
      }
    };
    const [entry] = providerUsageEntriesFromExecution({
      execution: {
        ok: true,
        fallbackUsed: true,
        attempts: [{
          provider: primary.provider,
          model: primary.id,
          routeIndex: 1,
          routeRole: "fallback",
          state: "dispatched",
          dispatchedAt: "2030-01-01T00:00:00.000Z",
          ok: true,
          content: "done",
          usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 }
        }],
        toolCalls: []
      },
      profileId: "alpha",
      sessionId: "worker-alpha",
      visibleTurnId: "message-alpha",
      requestSequence: 0,
      routes: [primary, duplicateFallback]
    });

    expect(entry).toMatchObject({ routeRole: "fallback", routeIndex: 1 });
    expect(entry!.estimatedCostUsd).toBeCloseTo(0.012, 12);
  });
});

function routes(): AgentLoopRouteInput {
  const primary = {
    provider: "openai",
    id: "primary",
    profile: {
      id: "primary",
      provider: "openai",
      contextWindowTokens: 100_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
      cost: { inputPerMillionTokens: 2, outputPerMillionTokens: 4, reasoningPerMillionTokens: 0 }
    }
  } as const;
  const fallback = {
    provider: "deepseek",
    id: "fallback",
    profile: {
      id: "fallback",
      provider: "deepseek",
      contextWindowTokens: 100_000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true,
      cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2, reasoningPerMillionTokens: 0 }
    }
  } as const;
  return {
    model: primary.profile,
    mainRoute: primary,
    primaryModelRoute: primary,
    modelFallbackRoutes: [fallback],
    providerPreferences: {}
  };
}
