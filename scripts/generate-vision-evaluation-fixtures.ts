import { resolve } from "node:path";
import { generateVisionEvaluationFixtures } from "../src/eval/vision-evaluation-fixtures.js";

const outputDir = resolve(process.argv[2] ?? ".estacoda/eval-fixtures/vision");
const manifest = await generateVisionEvaluationFixtures(outputDir);

console.log(`Generated ${manifest.fixtures.length} deterministic vision fixtures in ${outputDir}`);
console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
