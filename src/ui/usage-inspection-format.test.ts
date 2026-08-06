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
      }
    });

    expect(text).toContain("Total: at least 0 tokens · unavailable");
    expect(text).not.toContain("Total: at least 0 tokens · $0.00");
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
      }
    });

    expect(text).toContain("Usage — replied message");
  });

  it("renders recorded zero exactly for a settled Task", () => {
    const text = formatUsageInspection({
      scope: "task",
      sessionId: "session-1",
      taskId: "task-1",
      status: "completed",
      usage: usage(0, 0, true),
      provisional: false
    });

    expect(text).toContain("Total: 0 tokens · $0.00");
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
