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
      inputTokens: 150,
      outputTokens: 50,
      totalTokens: 200,
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
