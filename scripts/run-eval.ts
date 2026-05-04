import { runEvalCases } from "../src/eval/eval-runner.js";
import { defaultEvalFixtures } from "../src/eval/fixtures/index.js";

const report = await runEvalCases(defaultEvalFixtures);

for (const result of report.results) {
  const status = result.passed ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name}`);
  if (!result.passed) {
    for (const assertion of result.assertions) {
      if (!assertion.passed) {
        console.log(`  - ${assertion.name}: expected ${assertion.expected}, got ${assertion.actual}`);
      }
    }
  }
}

console.log(`\nTotal: ${report.results.length} | Passed: ${report.passed} | Failed: ${report.failed} | Duration: ${report.durationMs}ms`);

if (report.failed > 0) {
  process.exit(1);
}
