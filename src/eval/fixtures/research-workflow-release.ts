import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase } from "../../contracts/eval.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";
import { TaskResultService } from "../../tasks/task-result-service.js";
import { TaskScheduler } from "../../tasks/task-scheduler.js";
import { assertTrue, buildResult } from "../eval-runner.js";
import { answer, createResearchWorkflowHarness, nativeCall, CLAIM_TABLE, REPORT, SOURCE_URL } from "./research-workflow-harness.js";

export async function measureResearchWorkflow() {
  const h = await createResearchWorkflowHarness();
  try {
    h.enqueue(nativeCall("delegate_task", { tasks: ["collection", "processing", "reuse"].map((scope) => ({
      task: `Research battery recycling: ${scope}.`, allowedTools: ["web.search"],
      research: { scope, requireLiveSources: true, requireRepositoryEvidence: false }
    })) }));
    await h.turn("Use the researcher skill and use 3 subagents to research current battery recycling. Save report.md");
    const task = h.store.listTasks()[0]; assert(task);
    const steps = h.store.listSteps(task.id, task.activePlanRevisionId!);
    const workers = steps.filter((step) => step.executor.role === "worker");
    const synthesis = steps.find((step) => step.executor.role === "synthesis")!;
    assert.equal(workers.length, 3); assert.deepEqual(new Set(synthesis.dependsOn), new Set(workers.map((step) => step.id)));
    assert(h.store.acquireTaskHostLease({ taskId: task.id, workspaceIdentityHash: task.workspace.identityHash, ownerId: "release-fixture", kind: "foreground", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const resultService = new TaskResultService({ store: h.store, profileId: "baseline", sessionDb: h.sessionDb, contentRoot: resolveProfileStateHome({ homeDir: h.homeDir, profileId: "baseline" }).taskResultsPath });
    const scheduler = new TaskScheduler({ store: h.store, resultService, ownerId: "release-fixture", limits: { maxProfileConcurrentAttempts: 1 }, resolveExecutor: () => h.runtime.taskAgentExecutor });
    for (let index = 0; index < 3; index++) {
      h.enqueue(nativeCall("web_search", { query: `battery recycling ${index}` }), answer(`Scope ${index}: ${SOURCE_URL}\n${CLAIM_TABLE}`));
      assert.equal((await scheduler.runOnce()).completed, 1);
    }
    for (const result of h.store.listResults(task.id).filter((result) => result.disposition === "accepted")) h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: result.id }));
    h.enqueue(answer(`${REPORT}\n${CLAIM_TABLE}`));
    assert.equal((await scheduler.runOnce()).completed, 1);
    assert.equal(h.store.getTask(task.id)?.status, "partial"); // Still owes the file.
    const final = h.store.listResults(task.id).find((result) => result.stepId === synthesis.id && result.disposition === "accepted")!;
    const content = (await resultService.readText({ taskId: task.id, resultId: final.id, sessionId: h.runtime.sessionId })).content;
    await h.restart();
    h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: final.id }), nativeCall("file_write", { path: "report.md", content }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    const saved = await h.turn("Save this report to report.md");
    assert.equal(saved.finalOutcome?.status, "completed");
    assert.equal(await readFile(join(h.workspaceRoot, "report.md"), "utf8"), content);
    assert.equal(h.store.listTasks().length, 1); assert.equal(h.searches.length, 3);
    assert.equal(h.remainingSteps(), 0); assert.deepEqual(h.scriptErrors, []);
    const sessionIds = new Set([h.runtime.sessionId, ...h.store.listAttempts(task.id).flatMap((attempt) => attempt.workerSessionId ? [attempt.workerSessionId] : [])]);
    const persistedEvents = (await Promise.all([...sessionIds].map((id) => h.sessionDb.listEvents(id)))).flat();
    return { workers: workers.length, acceptedResults: h.store.listResults(task.id).filter((result) => result.disposition === "accepted").length,
      providerCalls: h.requests.length, searches: h.searches.length, tasks: h.store.listTasks().length, restarted: true,
      outputBytes: Buffer.byteLength(content), finalOutcome: saved.finalOutcome.status, sourceTable: content.includes("| Retrieved |"),
      actualToolCalls: persistedEvents.filter((event) => event.kind === "tool-result").length, liveModelCalls: 0 };
  } finally { await h.dispose(); }
}
export const researchWorkflowReleaseCase: EvalCase = {
  id: "research-workflow-release", name: "Research worker, synthesis and restart delivery acceptance", description: "Real runtime and durable Task executor with scripted provider/network fixtures.", tags: ["research", "workflow", "release"],
  async run() {
    const start = Date.now(); const report = await measureResearchWorkflow();
    return buildResult(this.id, this.name, [assertTrue("three workers, accepted synthesis, one Task", report.workers === 3 && report.acceptedResults === 4 && report.tasks === 1),
      assertTrue("restart save-only delivery verified", report.restarted && report.finalOutcome === "completed" && report.outputBytes > 0 && report.sourceTable)], Date.now() - start);
  }
};
