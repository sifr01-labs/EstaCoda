import { describe, expect, it } from "vitest";
import {
  assertDeterministicBrowserPerceptionPass,
  buildBrowserPerceptionEvaluationReport,
  type BrowserPerceptionEvaluationRun
} from "./browser-perception-evaluation.js";

const runs: BrowserPerceptionEvaluationRun[] = [
  { harness: "existing", model: "kimi", successfulTargeting: false, taskCompleted: false, totalBrowserCalls: 12, unnecessaryCalls: 7, repeatedObservations: 4 },
  { harness: "corrected", model: "kimi", successfulTargeting: true, taskCompleted: true, totalBrowserCalls: 4, unnecessaryCalls: 0, repeatedObservations: 0 },
  { harness: "corrected", model: "stronger", successfulTargeting: true, taskCompleted: true, totalBrowserCalls: 3, unnecessaryCalls: 0, repeatedObservations: 0 }
];

describe("browser perception evaluation matrix", () => {
  it("compares the required harness/model cells using task and efficiency metrics", () => {
    const report = buildBrowserPerceptionEvaluationReport({ deterministicPassed: 10, deterministicTotal: 10, runs });

    expect(report.deterministicPerception.passRate).toBe(1);
    expect(report.matrix).toEqual([
      expect.objectContaining({ harness: "existing", model: "kimi", successfulTargetingRate: 0, averageBrowserCalls: 12 }),
      expect.objectContaining({ harness: "corrected", model: "kimi", taskCompletionRate: 1, averageUnnecessaryCalls: 0 }),
      expect.objectContaining({ harness: "corrected", model: "stronger", taskCompletionRate: 1, averageRepeatedObservations: 0 })
    ]);
    expect(() => assertDeterministicBrowserPerceptionPass(report)).not.toThrow();
  });

  it("rejects an incomplete comparison or any deterministic perception regression", () => {
    expect(() => buildBrowserPerceptionEvaluationReport({ deterministicPassed: 10, deterministicTotal: 10, runs: runs.slice(1) }))
      .toThrow(/matrix is incomplete/u);
    const report = buildBrowserPerceptionEvaluationReport({ deterministicPassed: 9, deterministicTotal: 10, runs });
    expect(() => assertDeterministicBrowserPerceptionPass(report)).toThrow(/must pass 100%/u);
  });
});
