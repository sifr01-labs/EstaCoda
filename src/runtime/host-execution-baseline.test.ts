import { describe, expect, it } from "vitest";
import { hostBaselineScenarios, runHostBaselineSample } from "../test/host-execution-baseline.js";

describe("real host workflow baseline with scripted inference", () => {
  it.each(hostBaselineScenarios)("completes %s through real tools and records usage", async (scenario) => {
    const sample = await runHostBaselineSample(scenario);
    expect(sample.success).toBe(true);
    expect(sample.metrics.toolFailures).toBe(0);
    expect(sample.metrics.inputTokens).toBe(sample.providerInvocations * 100);
    expect(sample.metrics.outputTokens).toBe(sample.providerInvocations * 10);
    expect(sample.metrics.estimatedCostUsd).toBeNull();
    expect(sample.providerInvocations).toBe(scenario === "interrupted-resume" ? 5 : 4);
    expect(sample.metrics.toolCalls).toBe(scenario === "interrupted-resume" ? 4 : 3);
    expect(sample.commandMs).toHaveLength(1);
    expect(sample.runtimeStartupMs.length).toBe(scenario === "interrupted-resume" ? 2 : 1);
    if (scenario === "interrupted-resume") {
      expect(sample.metrics.agentCancelled).toBe(true);
      expect(sample.persistedMessagesBeforeResume).toBeGreaterThan(0);
      expect(sample.recoveryMs).not.toBeNull();
    }
  }, 30_000);
});
