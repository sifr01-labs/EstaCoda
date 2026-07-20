import { describe, expect, it } from "vitest";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { SessionEvent } from "../contracts/session.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";
import {
  taskUsageEntriesFromSessionEvents,
  taskUsageFromAgentResponse,
  taskUsageFromEntries
} from "./task-agent-usage.js";

describe("taskUsageFromAgentResponse", () => {
  it("counts every provider Attempt and applies each route's pricing", () => {
    const execution: ProviderExecutionResult = {
      ok: true,
      response: { ok: true, content: "done", provider: "openai", model: "primary" },
      fallbackUsed: true,
      attempts: [
        {
          provider: "openai",
          model: "primary",
          ok: false,
          content: "",
          usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, reasoningTokens: 40 }
        },
        {
          provider: "deepseek",
          model: "fallback",
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
        { provider: "openai", model: "primary", ok: false, content: "" },
        {
          provider: "unknown",
          model: "unpriced",
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
        ok: true,
        content: "done",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 15 }
      }],
      toolCalls: []
    };

    expect(taskUsageFromAgentResponse(execution, routes())).toMatchObject({
      totalTokens: 120,
      reasoningTokens: 15,
      estimatedCostUsd: 0.00028
    });
  });
});

describe("task usage ledger", () => {
  it("meters completion and continuation provider calls with stable request identities", () => {
    const events: SessionEvent[] = [
      {
        kind: "provider-completion",
        iteration: 1,
        ok: true,
        fallbackUsed: false,
        attempts: [{
          provider: "openai",
          model: "primary",
          ok: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
        }]
      },
      {
        kind: "provider-continuation",
        iteration: 1,
        ok: true,
        toolPlans: [],
        attempts: [{
          provider: "deepseek",
          model: "fallback",
          ok: true,
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }
        }]
      }
    ];
    const entries = taskUsageEntriesFromSessionEvents(events, routes(), {
      profileId: "alpha",
      taskId: "task-alpha",
      planRevisionId: "revision-alpha",
      stepId: "step-alpha",
      id: "attempt-alpha",
      workerSessionId: "worker-alpha",
      occurredAt: "2030-01-01T00:00:00.000Z"
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.routeRole, entry.routeIndex, entry.requestKey])).toEqual([
      ["primary", 0, "worker-alpha:000000:provider-completion:1:0"],
      ["fallback", 1, "worker-alpha:000001:provider-continuation:1:0"]
    ]);
    const totals = taskUsageFromEntries(entries);
    expect(totals).toMatchObject({
      providerCalls: 2,
      totalTokens: 180,
      usageComplete: true,
      pricingComplete: true
    });
    expect(totals.estimatedCostUsd).toBeCloseTo(0.00035, 12);
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
      cost: { inputPerMillionTokens: 2, outputPerMillionTokens: 4 }
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
      cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }
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
