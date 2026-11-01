import { createHash } from "node:crypto";

/** Operator-attested results from paired, independently graded task runs.
 * These are deliberately separate from the declarative metadata checks. */
export type SkillTaskEvaluation = {
  version: 1;
  baselineHash: string;
  candidateHash: string;
  suiteId: string;
  modelId: string;
  environmentHash: string;
  graderId: string;
  cases: Array<{
    id: string;
    fixtureHash: string;
    baseline: SkillTaskResult;
    candidate: SkillTaskResult;
  }>;
};

type SkillTaskResult = {
  score: number;
  safetyPassed: boolean;
  artifact: string;
};

export function skillContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validateSkillTaskEvaluation(value: unknown, baseline: string, candidate: string): SkillTaskEvaluation {
  const report = value as SkillTaskEvaluation | undefined;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const label = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
  if (!report || report.version !== 1 || report.baselineHash !== skillContentHash(baseline) ||
      report.candidateHash !== skillContentHash(candidate) || !hash(report.environmentHash) ||
      !label(report.suiteId) || !label(report.modelId) || !label(report.graderId) ||
      !Array.isArray(report.cases) || report.cases.length < 2 || report.cases.length > 100) {
    throw new Error("Task evaluation requires matching baseline/candidate hashes, a model, environment, grader, and 2–100 paired cases.");
  }
  const ids = new Set<string>();
  let improvement = false;
  for (const test of report.cases) {
    if (!test || !label(test.id) || ids.has(test.id) || !hash(test.fixtureHash)) {
      throw new Error("Task evaluation cases require unique IDs and fixture hashes.");
    }
    ids.add(test.id);
    for (const result of [test.baseline, test.candidate]) {
      if (!result || !Number.isFinite(result.score) || result.score < 0 || result.score > 1 ||
          typeof result.safetyPassed !== "boolean" || !label(result.artifact)) {
        throw new Error(`Task evaluation case ${test.id} requires bounded scores, safety results, and run artifacts.`);
      }
    }
    if (test.baseline.artifact === test.candidate.artifact) throw new Error("Paired runs require distinct artifacts.");
    if (!test.candidate.safetyPassed || test.candidate.score < 0.8 || test.candidate.score < test.baseline.score) {
      throw new Error(`Task evaluation case ${test.id} fails safety, quality, or non-regression requirements.`);
    }
    improvement ||= test.candidate.score > test.baseline.score;
  }
  if (!improvement) throw new Error("Task evaluation must demonstrate a task-score improvement; metadata-only or tied results are insufficient.");
  // Copy only the contract; do not persist arbitrary report fields or task content.
  return {
    version: 1, baselineHash: report.baselineHash, candidateHash: report.candidateHash,
    suiteId: report.suiteId, modelId: report.modelId, environmentHash: report.environmentHash, graderId: report.graderId,
    cases: report.cases.map(({ id, fixtureHash, baseline, candidate }) => ({
      id, fixtureHash,
      baseline: { score: baseline.score, safetyPassed: baseline.safetyPassed, artifact: baseline.artifact },
      candidate: { score: candidate.score, safetyPassed: candidate.safetyPassed, artifact: candidate.artifact }
    }))
  };
}
