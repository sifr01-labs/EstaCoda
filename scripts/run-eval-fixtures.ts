import { runEvalCases, formatEvalReport } from "../src/eval/eval-runner.js";
import { defaultEvalFixtures } from "../src/eval/fixtures/index.js";
import { installIsolatedStateHome } from "../src/test/state-home.js";

installIsolatedStateHome("estacoda-eval-home-");

const fixtureId = process.argv[2];
const cases = fixtureId === undefined
  ? defaultEvalFixtures
  : defaultEvalFixtures.filter((c) => c.id === fixtureId);

if (cases.length === 0) {
  console.error(`Unknown fixture: ${fixtureId}`);
  console.error(`Available: ${defaultEvalFixtures.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const report = await runEvalCases(cases);
console.log(formatEvalReport(report));
process.exit(report.failed === 0 ? 0 : 1);
