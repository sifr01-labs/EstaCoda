import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hostBaselineScenarios, runHostBaselineSample } from "../src/test/host-execution-baseline.js";

const { values } = parseArgs({ options: { samples: { type: "string", default: "5" }, out: { type: "string" } } });
const count = Number(values.samples);
if (!Number.isSafeInteger(count) || count < 1 || count > 20 || !values.out) {
  throw new Error("Usage: node --import tsx scripts/measure-host-execution-baseline.ts --samples 1..20 --out report.json");
}
const repository = fileURLToPath(new URL("../", import.meta.url));
const digest = async (relative: string) => createHash("sha256").update(await readFile(resolve(repository, relative))).digest("hex");
const samples: Awaited<ReturnType<typeof runHostBaselineSample>>[] = [];
// Each sample has fresh temporary state. Imports/JIT and OS caches are warm after
// the first sample; this is not a process cold-start or live inference benchmark.
for (let index = 0; index < count; index += 1) {
  for (const scenario of hostBaselineScenarios) {
    samples.push(await runHostBaselineSample(scenario));
    console.log(`${scenario}: sample ${index + 1}/${count} passed`);
  }
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1) };
};
const report = {
  schemaVersion: 1,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  harnessSha256: await digest("src/test/host-execution-baseline.ts"),
  generatorSha256: await digest("scripts/measure-host-execution-baseline.ts"),
  lockfileSha256: await digest("pnpm-lock.yaml"),
  environment: { node: process.version, pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    platform: platform(), arch: arch(), osRelease: release() },
  methodology: {
    clock: "performance.now; milliseconds", state: "Fresh workspace, trust store, SQLite and profile per sample",
    timing: "Setup excludes imports; execution includes runtime acquisition, tools and delivery; cleanup excluded. Command start/result events include executor overhead.",
    inference: "Scripted provider; 100 input and 10 output tokens per response are synthetic accounting fixtures",
    channel: "Real gateway authorization with fake Telegram delivery; no external account",
    scheduledWork: "Real cron runtime runner; no daemon or wall-clock scheduling wait",
    recovery: "Cooperative abort after completed file.patch; dispose, reopen SQLite and resume same session. No process crash or uncertain-mutation replay claim.",
    liveProviderRequests: 0, productionCostEstimate: null,
    regressionBudgets: "Not set: small local fixture sample, not a production percentile estimate",
  },
  summary: hostBaselineScenarios.map((scenario) => {
    const selected = samples.filter((sample) => sample.scenario === scenario);
    return { scenario, successes: selected.filter((sample) => sample.success).length, samples: selected.length,
      executionMs: distribution(selected.map((sample) => sample.executionMs)),
      runtimeStartupMs: distribution(selected.flatMap((sample) => sample.runtimeStartupMs)),
      commandMs: distribution(selected.flatMap((sample) => sample.commandMs)),
      ...(scenario === "interrupted-resume" ? { recoveryMs: distribution(selected.map((sample) => sample.recoveryMs!)) } : {}),
      providerCalls: distribution(selected.map((sample) => sample.providerInvocations)),
      syntheticTotalTokens: distribution(selected.map((sample) => sample.metrics.totalTokens)),
      approvalRequests: distribution(selected.map((sample) => sample.approvalRequests)) };
  }),
  samples,
};
// Only publish a report after all scenarios pass; a failure exits nonzero and
// leaves an existing baseline untouched. Focused tests provide failure details.
const output = resolve(values.out);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
