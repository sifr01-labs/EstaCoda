import { runSmokeCases, parseSmokeArgs } from "./smoke-runner.js";
import { allSmokeCases } from "./cases/index.js";

const options = parseSmokeArgs(process.argv.slice(2));
const report = await runSmokeCases(allSmokeCases, options);

if (report.failed > 0) {
  process.exit(1);
}
