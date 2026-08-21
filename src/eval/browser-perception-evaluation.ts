export type BrowserPerceptionHarness = "existing" | "corrected";
export type BrowserPerceptionModelClass = "kimi" | "stronger";

export type BrowserPerceptionEvaluationRun = {
  harness: BrowserPerceptionHarness;
  model: BrowserPerceptionModelClass;
  successfulTargeting: boolean;
  taskCompleted: boolean;
  totalBrowserCalls: number;
  unnecessaryCalls: number;
  repeatedObservations: number;
};

export type BrowserPerceptionEvaluationCell = {
  harness: BrowserPerceptionHarness;
  model: BrowserPerceptionModelClass;
  runs: number;
  successfulTargetingRate: number;
  taskCompletionRate: number;
  averageBrowserCalls: number;
  averageUnnecessaryCalls: number;
  averageRepeatedObservations: number;
};

export type BrowserPerceptionEvaluationReport = {
  deterministicPerception: { passed: number; total: number; passRate: number };
  matrix: BrowserPerceptionEvaluationCell[];
};

const REQUIRED_MATRIX = [
  "existing:kimi",
  "corrected:kimi",
  "corrected:stronger"
] as const;

export function buildBrowserPerceptionEvaluationReport(input: {
  deterministicPassed: number;
  deterministicTotal: number;
  runs: readonly BrowserPerceptionEvaluationRun[];
}): BrowserPerceptionEvaluationReport {
  if (!Number.isSafeInteger(input.deterministicPassed) || !Number.isSafeInteger(input.deterministicTotal) ||
      input.deterministicTotal <= 0 || input.deterministicPassed < 0 || input.deterministicPassed > input.deterministicTotal) {
    throw new TypeError("Browser perception deterministic counts are invalid.");
  }
  for (const run of input.runs) validateRun(run);
  const grouped = new Map<string, BrowserPerceptionEvaluationRun[]>();
  for (const run of input.runs) {
    const key = `${run.harness}:${run.model}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  const missing = REQUIRED_MATRIX.filter((key) => (grouped.get(key)?.length ?? 0) === 0);
  if (missing.length > 0) throw new TypeError(`Browser perception evaluation matrix is incomplete: ${missing.join(", ")}`);

  return {
    deterministicPerception: {
      passed: input.deterministicPassed,
      total: input.deterministicTotal,
      passRate: input.deterministicPassed / input.deterministicTotal
    },
    matrix: REQUIRED_MATRIX.map((key) => summarize(grouped.get(key)![0]!.harness, grouped.get(key)![0]!.model, grouped.get(key)!))
  };
}

export function assertDeterministicBrowserPerceptionPass(report: BrowserPerceptionEvaluationReport): void {
  if (report.deterministicPerception.passRate !== 1) {
    throw new Error(`Deterministic browser perception acceptance must pass 100%; received ${(report.deterministicPerception.passRate * 100).toFixed(1)}%.`);
  }
}

function summarize(
  harness: BrowserPerceptionHarness,
  model: BrowserPerceptionModelClass,
  runs: readonly BrowserPerceptionEvaluationRun[]
): BrowserPerceptionEvaluationCell {
  const average = (select: (run: BrowserPerceptionEvaluationRun) => number): number =>
    runs.reduce((total, run) => total + select(run), 0) / runs.length;
  return {
    harness,
    model,
    runs: runs.length,
    successfulTargetingRate: average((run) => Number(run.successfulTargeting)),
    taskCompletionRate: average((run) => Number(run.taskCompleted)),
    averageBrowserCalls: average((run) => run.totalBrowserCalls),
    averageUnnecessaryCalls: average((run) => run.unnecessaryCalls),
    averageRepeatedObservations: average((run) => run.repeatedObservations)
  };
}

function validateRun(run: BrowserPerceptionEvaluationRun): void {
  for (const [name, value] of Object.entries({
    totalBrowserCalls: run.totalBrowserCalls,
    unnecessaryCalls: run.unnecessaryCalls,
    repeatedObservations: run.repeatedObservations
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Browser perception run ${name} must be a non-negative integer.`);
  }
  if (run.unnecessaryCalls > run.totalBrowserCalls || run.repeatedObservations > run.totalBrowserCalls) {
    throw new TypeError("Browser perception run counters cannot exceed total browser calls.");
  }
}
