import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { aggregateBenchmarkMetrics, estimateBenchmarkCostUsd } from "./metrics.js";

describe("aggregateBenchmarkMetrics", () => {
  it("counts providers, provider tool calls, tool starts, and token usage", () => {
    const events: RuntimeEvent[] = [
      { kind: "provider-result", provider: "openai", model: "gpt-5", ok: true, fallback: false, willFallback: false, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
      { kind: "provider-tool-call", provider: "openai", model: "gpt-5", name: "terminal.run" },
      { kind: "tool-start", tool: "terminal.run" },
      { kind: "tool-result", tool: "terminal.run", ok: true },
      { kind: "provider-result", provider: "openai", model: "gpt-5", ok: true, fallback: false, willFallback: false, usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }
    ];

    expect(aggregateBenchmarkMetrics(events)).toEqual({
      providerCalls: 2,
      providerToolCalls: 1,
      toolCalls: 1,
      toolFailures: 0,
      providerBudgetExhaustions: 0,
      securityEscalations: 0,
      contextUsageEvents: 0,
      inputTokens: 150,
      outputTokens: 50,
      totalTokens: 200,
      estimatedCostUsd: null
    });
  });

  it("counts native runtime eval signals from direct and delegated events", () => {
    const events: RuntimeEvent[] = [
      { kind: "tool-start", tool: "terminal.run" },
      { kind: "tool-result", tool: "terminal.run", ok: false },
      { kind: "tool-result", tool: "file.read", ok: true },
      { kind: "provider-budget-exhausted", budget: "iterations", limit: 5, observed: 6, reason: "loop limit reached" },
      { kind: "security-risk-escalated", from: "read-only-local", to: "workspace-write", reason: "write requested after inspection" },
      { kind: "context-usage", filled: 1200, total: 4096, source: "assembled-prompt" },
      {
        kind: "delegation-progress",
        subagentId: "subagent-1",
        childSessionId: "child-session",
        parentSessionId: "parent-session",
        role: "leaf",
        depth: 1,
        childEvent: {
          kind: "tool-result",
          tool: "file.search",
          ok: false
        }
      },
      {
        kind: "delegation-progress",
        subagentId: "subagent-1",
        childSessionId: "child-session",
        parentSessionId: "parent-session",
        role: "leaf",
        depth: 1,
        childEvent: {
          kind: "provider-budget-exhausted",
          budget: "tool-calls",
          limit: 10,
          observed: 11,
          reason: "child limit reached"
        }
      }
    ];

    expect(aggregateBenchmarkMetrics(events)).toMatchObject({
      toolCalls: 1,
      toolFailures: 2,
      providerBudgetExhaustions: 2,
      securityEscalations: 1,
      contextUsageEvents: 1,
      estimatedCostUsd: null
    });
  });

  it("handles missing provider usage as zero", () => {
    const events: RuntimeEvent[] = [
      { kind: "provider-result", provider: "openai", model: "gpt-5", ok: true, fallback: false, willFallback: false }
    ];

    expect(aggregateBenchmarkMetrics(events).totalTokens).toBe(0);
  });

  it("can estimate cost when rates are available", () => {
    expect(estimateBenchmarkCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { inputPerMillionTokens: 2, outputPerMillionTokens: 10 }
    )).toBe(7);
  });

  it("keeps cost null when rates are unavailable", () => {
    expect(estimateBenchmarkCostUsd({ inputTokens: 1_000, outputTokens: 1_000 })).toBeNull();
  });
});
