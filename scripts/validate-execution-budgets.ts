import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hostBaselineScenarios, runHostBaselineSample } from "../src/test/host-execution-baseline.js";
const baseline = JSON.parse(await readFile(new URL("../evals/baselines/workspace-host.json", import.meta.url), "utf8"));
// Reviewed after PR8 measurement: exact fixture quality/friction; generous local
// latency ceilings, not production percentiles or live-model token budgets.
for (const scenario of hostBaselineScenarios) {
  const expected = baseline.summary.find((entry: { scenario: string }) => entry.scenario === scenario);
  assert(expected, "Missing PR0 comparator");
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const sample = await runHostBaselineSample(scenario);
    assert(sample.success && sample.approvalRequests === 0, "Completion or approval-friction regression");
    assert(sample.providerInvocations <= expected.providerCalls.max, "Provider-call regression");
    assert(sample.metrics.totalTokens <= expected.syntheticTotalTokens.max, "Fixture token-accounting regression");
    samples.push(sample);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const startup = median(samples.flatMap((s) => s.runtimeStartupMs));
  const execution = median(samples.map((s) => s.executionMs));
  assert(startup <= 1000 && execution <= 2000, "Host fixture latency budget exceeded; investigate before release");
  console.log(`PASS: ${scenario}: 3/3; zero approvals; startup median ${Math.round(startup)}ms; execution median ${Math.round(execution)}ms; PR0 call/token ceilings preserved`);
}
