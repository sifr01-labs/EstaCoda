import { buildResearchCapabilityBaseline } from "../src/eval/fixtures/research-capability-baseline.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { measureReleaseRouting } from "../src/eval/fixtures/research-routing-release.js";
import { measureResearchWorkflow } from "../src/eval/fixtures/research-workflow-release.js";

// Existing owning suites remain executable gates, not checklist assertions.
export const acceptanceSuites = [
  "src/prompt/prompt-assembly.test.ts",
  "src/runtime/provider-turn-loop.test.ts",
  "src/runtime/tool-loop-progress-guard.test.ts",
  "src/tasks/task-operator-service.test.ts",
  "src/tasks/task-scheduler.test.ts",
  "src/tasks/task-session-completion.test.ts",
  "src/control-service/review-corrections.test.ts",
  "src/eval/fixtures/research-routing-release.test.ts",
  "src/runtime/research-request.acceptance.test.ts",
  "src/runtime/research-prerequisites.test.ts",
  "src/runtime/research-surfaces.acceptance.test.ts",
  "src/acp/server.test.ts",
  "src/acp/approval-ownership.test.ts",
  "src/acp/session-ownership.test.ts",
  "src/cron/cron-runner.test.ts",
  "src/gateway/desktop-approvals.test.ts",
  "src/gateway/supervisor.test.ts",
  "src/tasks/task-completion-delivery.test.ts",
  "src/tasks/task-approval-service.test.ts",
  "src/delegation/durable-delegation-service.test.ts",
  "src/runtime/request-requirements.test.ts",
  "src/channels/delivery-router.test.ts",
  "src/channels/telegram-adapter.test.ts",
  "src/channels/channel-session-store.test.ts",
  "src/security/security-policy-factory.test.ts",
  "src/runtime/capability-recovery.test.ts",
  "src/runtime/provider-tool-narrowing.test.ts",
  "src/tools/tool-schema.test.ts",
  "src/tools/capability-tools.test.ts",
  "src/tools/skill-tools.test.ts",
  "src/tools/tool-executor.test.ts",
  "src/runtime/capability-state.test.ts",
  "src/tools/web-read-reuse.test.ts",
  "src/memory/memory-fact-extractor.test.ts",
  "src/memory/memory-reviewer.test.ts",
  "src/memory/memory-curation-service.test.ts",
  "src/tasks/research-result-evidence.test.ts",
  "src/runtime/file-output-evidence.test.ts",
  "src/tools/workspace-tools.test.ts",
  "src/browser/url-safety.test.ts", "src/tools/web-tools.test.ts",
  "src/tasks/task-result-service.test.ts",
  "src/tasks/agent-step-executor.test.ts",
  "src/runtime/execution-outcome.test.ts",
  "src/cli/session-loop.test.ts",
  "src/channels/channel-gateway.test.ts",
  "src/channels/surface-adapters/surface-adapters.test.ts"
];
const dir = await mkdtemp(join(tmpdir(), "research-release-gates-"));
try {
  const routing = await measureReleaseRouting();
  const workflow = await measureResearchWorkflow();
  const path = join(dir, "tests.json");
  let testExit = 0;
  try { execFileSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.node.config.ts", ...acceptanceSuites, "--reporter=json", `--outputFile=${path}`], { stdio: ["ignore", "pipe", "inherit"], timeout: 180000 }); }
  catch { testExit = 1; }
  const tests = JSON.parse(await readFile(path, "utf8"));
  const heldout = routing.splits.heldout!;
  const passed = testExit === 0 && tests.numFailedTests === 0 && tests.numTotalTests > 0 &&
    (heldout.requestedCapabilityRecall.value ?? 0) >= .95 && (heldout.primarySkillPrecision.value ?? 0) >= .98 &&
    routing.metrics.safetyViolations === 0 && routing.recovery.every((row) => row.passed && row.rounds <= 2);
  const legacy = JSON.parse(await readFile(new URL("../evals/baselines/research-reliability-v1.json", import.meta.url), "utf8"));
  const currentLegacy = buildResearchCapabilityBaseline();
  const report = { version: 1, pairedDevelopmentBaseline: { before: legacy.routing.metrics, after: currentLegacy.metrics,
    beforeSchemaTokens: legacy.routing.schemaTokensRough, afterSchemaTokens: currentLegacy.schemaTokensRough,
    scope: "Same 18 development prompts and seven-tool catalog. Counterfactual no-execution floor probe is not the real runtime completion guard. Token estimates are not comparable to the 109-definition release corpus." }, deterministicPassed: passed, routing: { ...routing, cases: routing.cases.map(({ exposedTools: _exposed, ...row }) => row) }, workflow,
    suites: acceptanceSuites, tests: { passed: tests.numPassedTests, failed: tests.numFailedTests, total: tests.numTotalTests },
    liveAssessment: { status: "not-run", reason: "Requires approved provider, sources and predeclared spend limit; deterministic fixtures do not measure live factual quality." },
    packagedDesktop: { status: "separate-gate", command: "pnpm run desktop:research-release" } };
  const output = resolve(process.argv.slice(2).find((arg) => arg !== "--") ?? join(dir, "report.json"));
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed, output, tests: report.tests, heldout, workflow }, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally { await rm(dir, { recursive: true, force: true }); }
