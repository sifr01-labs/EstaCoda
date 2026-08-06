import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import {
  DEFAULT_VISION_LIVE_MAX_COST_USD,
  renderVisionLiveEvaluationMarkdown,
  runVisionLiveEvaluation,
  type VisionLiveEvaluationBaseline,
} from "../src/eval/vision-live-evaluation.js";
import { generateVisionEvaluationFixtures } from "../src/eval/vision-evaluation-fixtures.js";

const workspaceRoot = process.cwd();
const args = process.argv.slice(2);
const consentHosted = args.includes("--consent-hosted");
const maximumEstimatedCostUsd = numberValueAfter(args, "--max-cost-usd") ?? DEFAULT_VISION_LIVE_MAX_COST_USD;
const fixtureRoot = resolve(workspaceRoot, ".estacoda/eval-fixtures/vision");
const outputRoot = resolve(valueAfter(args, "--output") ?? join(
  workspaceRoot,
  ".estacoda/eval-runs",
  `vision-live-${timestamp(new Date())}`
));
const baselinePath = resolve(valueAfter(args, "--baseline") ?? join(
  workspaceRoot,
  "evals/baselines/vision-live.json"
));

try {
  const [config, manifest, baseline] = await Promise.all([
    loadRuntimeConfig({ workspaceRoot }),
    generateVisionEvaluationFixtures(fixtureRoot),
    readBaseline(baselinePath),
  ]);
  const fixtures = manifest.fixtures.map((fixture) => ({
    ...fixture,
    path: join(fixtureRoot, fixture.file),
  }));
  const report = await runVisionLiveEvaluation({
    config,
    fixtures,
    baseline,
    consentHosted,
    maximumEstimatedCostUsd,
  });
  await mkdir(outputRoot, { recursive: true });
  const jsonPath = join(outputRoot, "vision-live-report.json");
  const markdownPath = join(outputRoot, "vision-live-report.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderVisionLiveEvaluationMarkdown(report), "utf8"),
  ]);
  console.log([
    `Vision live evaluation: ${report.passed ? "PASS" : "FAIL"}`,
    `Route: ${report.provider}/${report.model} (${report.inference})`,
    `Configuration fingerprint: ${report.configurationFingerprint}`,
    `Maximum estimated cost: $${report.consent.maximumEstimatedCostUsd.toFixed(2)}`,
    `JSON report: ${jsonPath}`,
    `Markdown report: ${markdownPath}`,
    ...(report.regressions.length === 0 ? [] : report.regressions.map((failure) => `Regression: ${failure}`)),
  ].join("\n"));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function readBaseline(path: string): Promise<VisionLiveEvaluationBaseline> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as VisionLiveEvaluationBaseline;
  if (parsed.schemaVersion !== 1 || typeof parsed.name !== "string" || parsed.metrics === undefined || parsed.thresholds === undefined) {
    throw new Error(`Invalid vision evaluation baseline: ${path}`);
  }
  const metrics = [
    parsed.metrics.characterErrorRate,
    parsed.metrics.wordErrorRate,
    parsed.metrics.groundedFactAccuracy,
    parsed.metrics.hallucinationRate,
    parsed.metrics.latencyMs,
    parsed.metrics.estimatedCostUsd,
    parsed.metrics.normalizedPayloadBytes,
    parsed.metrics.fallbackSuccess,
    parsed.metrics.approvalFrequency,
  ];
  const thresholds = Object.values(parsed.thresholds);
  if ([...metrics, ...thresholds].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error(`Invalid numeric value in vision evaluation baseline: ${path}`);
  }
  if (typeof parsed.metrics.estimatedCostAvailable !== "boolean") {
    throw new Error(`Invalid estimated cost availability in vision evaluation baseline: ${path}`);
  }
  return parsed;
}

function valueAfter(input: readonly string[], flag: string): string | undefined {
  const index = input.indexOf(flag);
  const value = index < 0 ? undefined : input[index + 1];
  if (index >= 0 && (value === undefined || value.startsWith("--"))) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function numberValueAfter(input: readonly string[], flag: string): number | undefined {
  const raw = valueAfter(input, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} requires a positive USD amount.`);
  return value;
}

function timestamp(value: Date): string {
  return value.toISOString().replaceAll(/[-:]/gu, "").replace("T", "-").slice(0, 15);
}
