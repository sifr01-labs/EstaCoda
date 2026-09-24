// Offline PR 0 measurements. Writes JSON to stdout; no live accounts or models.
// Run: node --import tsx scripts/measure-research-reliability-baseline.ts
import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildResearchCapabilityBaseline } from "../src/eval/fixtures/research-capability-baseline.js";
import { installIsolatedStateHome } from "../src/test/state-home.js";
import { answer, createResearchWorkflowHarness, nativeCall, REPORT, RESEARCH_PROMPT, SOURCE_URL } from "../src/test/fakes/research-workflow-harness.js";

const isolatedStateHome = installIsolatedStateHome("estacoda-research-measurement-");
const originalFetch = globalThis.fetch;
let unexpectedFetches = 0;
globalThis.fetch = async () => { unexpectedFetches++; throw new Error("Unexpected network access"); };
let harness: Awaited<ReturnType<typeof createResearchWorkflowHarness>> | undefined;
try {
  harness = await createResearchWorkflowHarness();
  harness.enqueue(nativeCall("web_search", { query: "battery recycling" }), nativeCall("web_extract", { url: SOURCE_URL }), answer(REPORT));
  const research = await harness.turn(RESEARCH_PROMPT);
  harness.enqueue(answer("The research workflow has been followed."));
  const rerun = await harness.turn("Rerun this task but this time use the research skill.");
  harness.enqueue(answer(REPORT));
  const save = await harness.turn("Please prepare a markdown file");
  assert.deepEqual(harness.scriptErrors, []);
  assert.equal(harness.remainingSteps(), 0);
  const inventory = harness.events.filter((event) => event.kind === "provider-tool-inventory");
  const schemaTokens = inventory.map((event) => event.nativeSchemaTokens).sort((a, b) => a - b);
  const reportFileExists = await stat(join(harness.workspaceRoot, "report.md")).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
  console.log(JSON.stringify({
    routing: buildResearchCapabilityBaseline(),
    workflow: {
      scope: "Scripted three-turn failure chain through createRuntime with real tool schemas, bundled skills and disposable SQLite/profile/workspace; not live-model performance.",
      providerCalls: harness.requests.length,
      toolCalls: [research, rerun, save].map((response) => response.toolExecutions.length),
      tasksCreated: harness.store.listTasks().length,
      outcomes: [research, rerun, save].map((response) => response.finalOutcome?.status),
      reportFileExists,
      schemaTokensRough: { median: schemaTokens[Math.floor(schemaTokens.length / 2)], p95: schemaTokens[Math.ceil(schemaTokens.length * 0.95) - 1] },
      inventory: inventory.map((event) => ({ phase: event.phase, tools: event.tools, nativeSchemaTokens: event.nativeSchemaTokens })),
      requestRequirementTelemetry: "not yet implemented",
      detailedOmissionTelemetry: "not yet implemented"
    }
  }, null, 2));
} finally {
  try { await harness?.dispose(); }
  finally {
    globalThis.fetch = originalFetch;
    await rm(isolatedStateHome, { recursive: true, force: true });
  }
  assert.equal(unexpectedFetches, 0);
}
