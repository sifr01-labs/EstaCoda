import { describe, expect, it } from "vitest";
import { formatUsageInspection } from "./usage-inspection-format.js";

describe("formatUsageInspection", () => {
  it("does not present unknown provisional cost as recorded zero", () => {
    const text = formatUsageInspection({
      scope: "turn",
      selection: "latest",
      sessionId: "session-1",
      usage: {
        turnId: "turn-1",
        mainAgent: usage(0, undefined, false),
        auxiliaryModels: usage(0, 0, true),
        delegatedWork: usage(0, undefined, false),
        total: usage(0, undefined, false),
        provisional: true
      },
      originatingTasks: { active: 1, settled: 0, scanTruncated: false },
      asOf: "latest-settled-provider-call"
    });

    expect(text).toContain("Total: at least 0 tokens · unavailable");
    expect(text).not.toContain("Total: at least 0 tokens · $0.00");
    expect(text).toContain("1 originating Task is still active");
    expect(text).toContain("As of: latest settled provider call");
    expect(text).toContain("do not add it again");
  });

  it("labels reply-attributed turn usage distinctly", () => {
    const text = formatUsageInspection({
      scope: "turn",
      selection: "replied",
      sessionId: "session-1",
      usage: {
        turnId: "turn-1",
        mainAgent: usage(10, 0.01, true),
        auxiliaryModels: usage(0, 0, true),
        delegatedWork: usage(0, 0, true),
        total: usage(10, 0.01, true),
        provisional: false
      },
      originatingTasks: { active: 0, settled: 0, scanTruncated: false },
      asOf: "latest-settled-provider-call"
    });

    expect(text).toContain("Usage — replied message");
  });

  it("does not claim zero active Tasks when the originating Task scan is truncated", () => {
    const text = formatUsageInspection({
      scope: "turn",
      selection: "specific",
      sessionId: "session-1",
      usage: {
        turnId: "turn-1",
        mainAgent: usage(10, 0.01, true),
        auxiliaryModels: usage(0, 0, true),
        delegatedWork: usage(0, 0, true),
        total: usage(10, 0.01, false),
        provisional: true
      },
      originatingTasks: { active: 0, settled: 0, scanTruncated: true },
      asOf: "latest-settled-provider-call"
    });

    expect(text).toContain("originating Task scan was truncated");
    expect(text).not.toContain("0 originating Tasks are still active");
  });

  it("renders recorded zero exactly for a settled Task", () => {
    const text = formatUsageInspection({
      scope: "task",
      sessionId: "session-1",
      taskId: "task-1",
      status: "completed",
      usage: usage(0, 0, true),
      budget: {
        spentCostUsd: 0,
        reservedCostUsd: 0.25,
        remainingCostUsd: 0.75,
        maxEstimatedCostUsd: 1,
        warningThresholdPercent: 80,
        state: "available"
      },
      provisional: false,
      asOf: "latest-settled-provider-call"
    });

    expect(text).toContain("Total: 0 tokens · $0.00");
    expect(text).toContain("Task budget: $0.00 spent · $0.25 reserved · $0.75 remaining");
    expect(text).toContain("As of: latest settled provider call");
    expect(text).toContain("may already be included");
  });
});

function usage(totalTokens: number, estimatedCostUsd: number | undefined, complete: boolean) {
  return {
    providerCalls: totalTokens === 0 ? 0 : 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    usageComplete: complete,
    costComplete: complete,
    incompleteReasons: complete ? [] : ["provider-pricing-unavailable"]
  };
}
