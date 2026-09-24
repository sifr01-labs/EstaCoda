import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { TaskResultService } from "../tasks/task-result-service.js";
import { TaskScheduler } from "../tasks/task-scheduler.js";
import { selectSkillPromptContent } from "../skills/skill-contract.js";
import { isLoadedSkill } from "./runtime-router.js";
import { answer, createResearchWorkflowHarness, nativeCall, CLAIM_TABLE, REPORT, RESEARCH_PROMPT, SOURCE_URL } from "../test/fakes/research-workflow-harness.js";

type Harness = Awaited<ReturnType<typeof createResearchWorkflowHarness>>;
const harnesses: Harness[] = [];
async function harness(options: Parameters<typeof createResearchWorkflowHarness>[0] = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network access in research baseline"); }));
  const value = await createResearchWorkflowHarness(options);
  harnesses.push(value);
  return value;
}
afterEach(async () => {
  try {
    for (const value of harnesses.splice(0)) await value.dispose();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }
  finally { vi.unstubAllGlobals(); }
});

function scriptConsumed(value: Harness) {
  expect(value.scriptErrors).toEqual([]);
  expect(value.remainingSteps()).toBe(0);
}

function schedulerFor(h: Harness, taskId: string) {
  const task = h.store.getTask(taskId)!;
  const ownerId = "baseline-scheduler";
  expect(h.store.acquireTaskHostLease({ taskId, workspaceIdentityHash: task.workspace.identityHash, ownerId, kind: "foreground",
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBeTruthy();
  const resultService = new TaskResultService({ store: h.store, profileId: "baseline", sessionDb: h.sessionDb,
    contentRoot: resolveProfileStateHome({ homeDir: h.homeDir, profileId: "baseline" }).taskResultsPath });
  return { resultService, scheduler: new TaskScheduler({ store: h.store, resultService, ownerId, limits: { maxProfileConcurrentAttempts: 1 },
    resolveExecutor: (candidate, step) => h.runtime.taskAgentExecutor?.canExecute(candidate, step) ? h.runtime.taskAgentExecutor : undefined }) };
}

describe.sequential("research workflow acceptance harness", () => {
  it("blocks missing fresh-search prerequisites before spending a provider iteration", async () => {
    const h = await harness({ searchAvailable: false });
    const result = await h.turn("Use the researcher skill and use 3 subagents to research current battery recycling. Save report.md.");
    expect(result.finalOutcome).toMatchObject({ status: "blocked", terminationCause: "user_input_required" });
    expect(result.text).toContain("web.search is unavailable");
    expect(result.text).toContain("config.web.setup");
    expect(result.text).toContain("not been written or verified");
    expect(h.requests).toHaveLength(0);
    expect(result.toolExecutions).toHaveLength(0);
    expect(h.store.listTasks()).toHaveLength(0);
    await expect(readFile(join(h.workspaceRoot, "report.md"))).rejects.toThrow();
    scriptConsumed(h);
  });

  it("reports all missing research prerequisites without delegation retries", async () => {
    const h = await harness({ searchAvailable: false });
    const result = await h.turn("Use the nonexistent-skill skill and use 3 subagents to research current batteries. Save report.md.");
    expect(result.text).toContain("skill instructions are unavailable");
    expect(result.text).toContain("web.search is unavailable");
    expect(result.finalOutcome?.status).toBe("blocked");
    expect(h.requests).toHaveLength(0);
    expect(result.toolExecutions).toHaveLength(0);
    scriptConsumed(h);
  });

  it("does not erase affirmative how-to requirements or accept a no-tool completion", async () => {
    const h = await harness();
    h.enqueue(answer("Done. All requested work is complete."));
    const result = await h.turn("Research how to recycle batteries and save report.md using 3 subagents");
    expect(result.intent.requestRequirements).toMatchObject({ research: { domain: "general" }, fileOutput: { path: "report.md" }, delegation: { count: 3 } });
    expect(result.finalOutcome?.status).toBe("blocked");
    scriptConsumed(h);
  });

  it("requires observed source claims for foreground fresh research", async () => {
    const h = await harness();
    h.enqueue(nativeCall("web_search", { query: "unrelated weather" }), answer("Research complete with no citations."));
    const result = await h.turn("Research the latest battery recycling methods.");
    expect(result.finalOutcome?.status).toBe("partially_completed");
    expect(result.text).toContain("source-claim-table-missing");
    h.enqueue(nativeCall("web_search", { query: "battery recycling" }), answer(`${REPORT}\n${CLAIM_TABLE}`));
    const valid = await h.turn("Research the latest battery recycling methods.");
    expect(valid.finalOutcome?.status).toBe("completed");
    expect(valid.text).toContain("snippet; full text unavailable");
    scriptConsumed(h);
  });

  it.each(["Use the researcher skill. Use the research-discovery skill.", "Use the researcher skill and use the research-discovery skill."])("requires every explicit skill and accepts owned recovery reads: %s", async (prompt) => {
    const h = await harness();
    h.enqueue(answer("Done."));
    expect((await h.turn(prompt)).finalOutcome?.status).toBe("blocked");
    h.enqueue(nativeCall("capability_request", { ids: ["skill:research-discovery"], reason: "Second explicitly requested skill" }),
      nativeCall("skill_read", { name: "research-discovery" }), answer("Both skill instructions loaded."));
    expect((await h.turn(prompt)).finalOutcome?.status).toBe("completed");
    scriptConsumed(h);
  });

  it.each(["denied", "wrong-target", "wrong-content", "no-readback", "claim-only"])("keeps report delivery incomplete for %s", async (mode) => {
    const h = await harness({ denyWrites: mode === "denied" });
    h.enqueue(nativeCall("delegate_task", { tasks: [{ task: "Research recycling.", allowedTools: ["web.search"], research: { scope: "methods", requireLiveSources: false, requireRepositoryEvidence: false } }] }));
    await h.turn("Use 1 worker to research recycling. Save report.md");
    const task = h.store.listTasks()[0]!;
    const { scheduler } = schedulerFor(h, task.id);
    h.enqueue(answer(REPORT));
    expect((await scheduler.runOnce()).completed).toBe(1);
    const worker = h.store.listResults(task.id)[0]!;
    h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: worker.id }), answer(REPORT));
    expect((await scheduler.runOnce()).completed).toBe(1);
    const synthesis = h.store.listSteps(task.id, task.activePlanRevisionId!).find((step) => step.executor.role === "synthesis")!;
    const result = h.store.listResults(task.id).find((item) => item.stepId === synthesis.id)!;
    if (mode !== "claim-only") {
      h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: result.id }),
        nativeCall("file_write", { path: mode === "wrong-target" ? "other.md" : "report.md", content: mode === "wrong-content" ? "unrelated bytes" : REPORT }));
      if (mode === "wrong-content") h.enqueue(nativeCall("file_read", { path: "report.md" }));
    }
    h.enqueue(answer("Saved report.md."));
    expect((await scheduler.runOnce()).failed).toBe(1);
    expect(h.store.getTask(task.id)?.status).not.toBe("completed");
    if (["denied", "wrong-target", "claim-only"].includes(mode)) await expect(readFile(join(h.workspaceRoot, "report.md"))).rejects.toThrow();
    if (mode === "wrong-target") await expect(readFile(join(h.workspaceRoot, "other.md"))).rejects.toThrow();
    scriptConsumed(h);
  });

  it("rejects a completed research claim without the requested workers and retains requirements on rerun", async () => {
    const h = await harness();
    h.enqueue(nativeCall("web_search", { query: "battery recycling" }), nativeCall("web_extract", { url: SOURCE_URL }), answer(REPORT));
    const research = await h.turn(RESEARCH_PROMPT);
    expect(h.runtime.tools().map((tool) => tool.name)).toContain("delegate_task");
    expect(research.intent.taskClass).toBe("research");
    expect(research.toolExecutions.map((execution) => execution.tool.name)).toEqual(["web.search", "web.extract"]);
    expect(research.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    expect(research.finalOutcome?.status).toBe("partially_completed");
    expect(research.text).toContain("requested-worker-evidence");
    expect(h.store.listTasks()).toEqual([]);
    expect(h.searches).toEqual(["battery recycling"]);
    expect(h.extracts).toEqual([SOURCE_URL]);
    const inventory = h.events.find((event) => event.kind === "provider-tool-inventory");
    expect(inventory).toMatchObject({ phase: "initial", nativeSchemaTokens: expect.any(Number) });
    if (inventory?.kind !== "provider-tool-inventory") throw new Error("Missing tool inventory");
    expect(inventory.tools).toEqual(expect.arrayContaining(["delegate_task", "task_status", "task_result_read"]));
    expect(inventory.nativeSchemaTokens).toBeGreaterThan(0);
    const receipts = (await h.sessionDb.listEvents(h.runtime.sessionId)).filter((event) => event.kind === "execution-evidence-recorded");
    for (const execution of research.toolExecutions) {
      expect(receipts).toContainEqual(expect.objectContaining({ tool: execution.tool.name, toolCallId: execution.toolCallId, status: "success" }));
    }

    h.enqueue(answer("The research workflow has been followed."));
    const rerun = await h.turn("Rerun this task but this time use the research skill.");
    expect(rerun.toolExecutions).toEqual([]);
    expect(rerun.finalOutcome?.status).toBe("blocked");
    expect(rerun.intent.requestRequirements).toMatchObject({ delegation: { count: 3 }, research: { fresh: true } });
    expect(h.events.filter((event) => event.kind === "skill")).toEqual([{ kind: "skill", name: "research-discovery" }]);

    h.enqueue(answer(REPORT));
    const save = await h.turn("Please prepare a markdown file");
    expect(save.toolExecutions).toEqual([]);
    expect(save.finalOutcome?.status).toBe("blocked");
    expect(save.text).toContain("File output is incomplete");
    expect(save.finalOutcome?.confirmedActions).toEqual([]);
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.store.listTasks()).toEqual([]);
    expect(h.requests).toHaveLength(5);
    scriptConsumed(h);
  });

  it("proves native file writes and readback are observable through real execution (positive control)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    const result = await h.turn("Please prepare a markdown file at report.md");
    expect(result.toolExecutions.map((execution) => execution.tool.name)).toEqual(["file.write", "file.read"]);
    expect(result.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    expect(new Set(result.toolExecutions.map((execution) => execution.toolCallId)).size).toBe(2);
    expect(result.toolExecutions[1]?.result?.content).toContain("Synthetic research fixture");
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).resolves.toBe(REPORT);
    expect(result.finalOutcome?.status).toBe("completed");
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.write", verification: "verified" }));
    scriptConsumed(h);
  });

  it("keeps a denied write from creating a file or a confirmed action (negative control)", async () => {
    const h = await harness({ denyWrites: true });
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), answer("Writing was denied."));
    const result = await h.turn("Write documentation in report.md for the project");
    expect(result.toolExecutions[0]).toMatchObject({ decision: "deny" });
    expect(result.finalOutcome?.confirmedActions).toEqual([]);
    await expect(readFile(join(h.workspaceRoot, "report.md"))).rejects.toMatchObject({ code: "ENOENT" });
    scriptConsumed(h);
  });

  it.each([false, true])("accounts for three workers and distinguishes a pending file from settled research (file=%s)", async (fileRequested) => {
    const h = await harness();
    h.enqueue(nativeCall("delegate_task", {
      tasks: ["collection", "processing", "reuse"].map((scope) => ({
        task: `Research battery recycling: ${scope}.`, allowedTools: ["web.search"],
        research: { scope, requireLiveSources: true, requireRepositoryEvidence: false }
      }))
    }));
    const dispatch = await h.turn(`Use the researcher skill and use 3 subagents to research battery recycling.${fileRequested ? " Save report.md" : ""}`);
    expect(dispatch.finalOutcome?.status).toBe("completed"); // Successful dispatch; Task still owns the objective.
    expect(dispatch.toolExecutions.find((execution) => execution.tool.name === "delegate_task")?.result?.ok).toBe(true);
    const task = h.store.listTasks()[0]!;
    expect(task).toBeDefined();
    const steps = h.store.listSteps(task.id, task.activePlanRevisionId!);
    const workers = steps.filter((step) => step.executor.role === "worker");
    const synthesis = steps.find((step) => step.executor.role === "synthesis")!;
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.executor.requestContract?.requirements.delegation?.count === 3)).toBe(true);
    expect(synthesis.executor.requestContract?.skillName).toBe("researcher");
    expect(new Set(synthesis.dependsOn)).toEqual(new Set(workers.map((step) => step.id)));
    expect(h.store.listResults(task.id)).toEqual([]); // Dispatch is not completed research.
    expect(h.events).toContainEqual({ kind: "skill", name: "researcher" });
    const skill = h.runtime.resolveSkill?.("researcher");
    if (skill === undefined || !isLoadedSkill(skill)) throw new Error("Bundled researcher not loaded");
    const selectedContent = selectSkillPromptContent(skill);
    expect(h.requests[0]?.messages.some((message) => typeof message.content === "string" && message.content.includes(selectedContent.content))).toBe(true);
    scriptConsumed(h);

    const { scheduler, resultService } = schedulerFor(h, task.id);
    for (let index = 0; index < 3; index++) {
      h.enqueue(nativeCall("web_search", { query: `battery recycling scope ${index}` }), answer(`Scope ${index}: observed synthetic evidence [source](${SOURCE_URL}).\n\n${CLAIM_TABLE}`));
      expect(await scheduler.runOnce()).toMatchObject({ completed: 1, failed: 0 });
      scriptConsumed(h);
    }
    const results = h.store.listResults(task.id).filter((result) => result.kind === "text" && result.disposition === "accepted");
    expect(results).toHaveLength(3);
    expect(new Set(results.map((result) => result.stepId))).toEqual(new Set(workers.map((step) => step.id)));
    for (const result of results) h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: result.id }));
    h.enqueue(answer(`${REPORT}\n${CLAIM_TABLE}`));
    const settled = await scheduler.runOnce();
    expect(settled, JSON.stringify({ errors: h.scriptErrors, failures: h.store.listAttempts(task.id).flatMap((attempt) => attempt.failure ? [attempt.failure] : []) })).toMatchObject({ completed: 1, failed: 0 });
    expect(h.store.getTask(task.id)?.status).toBe(fileRequested ? "running" : "completed");
    expect(h.store.listResults(task.id).some((result) => result.stepId === synthesis.id && result.kind === "text" && result.disposition === "accepted")).toBe(true);
    expect(new Set(h.store.listAttempts(task.id).map((attempt) => attempt.workerSessionId)).size).toBe(4);
    expect(h.searches).toHaveLength(3);
    expect(h.store.listTasks()).toHaveLength(1);
    scriptConsumed(h);

    const final = h.store.listResults(task.id).find((result) => result.stepId === synthesis.id)!;
    const savedResult = await resultService.readText({ taskId: task.id, resultId: final.id, sessionId: h.runtime.sessionId });
    expect(savedResult.content).toContain("Synthetic research fixture");
    if (fileRequested) {
      await h.restart();
      const deliveryScheduler = schedulerFor(h, task.id).scheduler;
      h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: final.id }),
        nativeCall("file_write", { path: "report.md", content: savedResult.content }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
      expect(await deliveryScheduler.runOnce(), JSON.stringify(h.scriptErrors)).toMatchObject({ completed: 1, failed: 0 });
      expect(h.store.getTask(task.id)?.status).toBe("completed");
      await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).resolves.toBe(savedResult.content);
    }
    h.enqueue(nativeCall("task_status", { task_id: task.id }), nativeCall("task_result_read", { task_id: task.id, result_id: final.id }),
      nativeCall("file_write", { path: "report.md", content: savedResult.content, overwrite: true }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    const saved = await h.turn("Save this report to report.md");
    expect(saved.intent.requestRequirements?.sourceTaskId).toBe(task.id);
    expect(saved.finalOutcome?.status, JSON.stringify({ text: saved.text, errors: h.scriptErrors })).toBe("completed");
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).resolves.toBe(savedResult.content);
    expect(h.store.listTasks()).toHaveLength(1);
    scriptConsumed(h);
    // An accepted research result satisfies prior research, not a newly requested skill.
    h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: final.id }),
      nativeCall("file_write", { path: "report.md", content: savedResult.content, overwrite: true }), nativeCall("file_read", { path: "report.md" }), answer("All done."));
    const newSkill = await h.turn("Save this report to report.md. Use the researcher skill. Use the research-discovery skill.");
    expect(newSkill.finalOutcome?.status).not.toBe("completed");
    expect(newSkill.text).toContain("requested-skill-instructions");
    scriptConsumed(h);
    if (fileRequested) {
      // A restarted runtime must observe the current file, not trust the old path or digest.
      await h.restart();
      await writeFile(join(h.workspaceRoot, "report.md"), "Unrelated replacement");
      h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: final.id }), nativeCall("file_read", { path: "report.md" }), answer("The report is saved."));
      const stale = await h.turn("Save this report to report.md");
      expect(stale.finalOutcome?.status).not.toBe("completed");
      expect(stale.text).toContain("File output is incomplete");
      h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: final.id }),
        nativeCall("file_write", { path: "report.md", content: savedResult.content, overwrite: true }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
      const repaired = await h.turn("Save this report to report.md");
      expect(repaired.finalOutcome?.status, JSON.stringify({ text: repaired.text, errors: h.scriptErrors })).toBe("completed");
      expect(h.store.listTasks()).toHaveLength(1);
      expect(h.searches).toHaveLength(3);
      scriptConsumed(h);
    }
  });

  it("rejects live-source delegation when web.search is unavailable (A9 control)", async () => {
    const h = await harness({ searchAvailable: false });
    // Registered metadata may still include an unavailable tool; provider exposure must not.
    h.enqueue(nativeCall("delegate_task", {
      task: "Research battery recycling.", allowedTools: ["web.search", "web.extract"],
      research: { scope: "recycling", requireLiveSources: true, requireRepositoryEvidence: false }
    }), answer("Live research is blocked because search is unavailable."));
    const result = await h.turn("/researcher Research battery recycling with live sources.");
    expect(result.toolExecutions.find((execution) => execution.tool.name === "delegate_task")?.result?.ok).toBe(false);
    expect(h.store.listTasks()).toEqual([]);
    expect(h.searches).toEqual([]);
    expect(h.requests[0]?.tools).not.toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: "web_search" }) }));
    scriptConsumed(h);
  });

  it("settles failed research coverage as partial and synthesizes only accepted worker results", async () => {
    const h = await harness();
    h.enqueue(nativeCall("delegate_task", { tasks: ["collection", "processing", "reuse"].map((scope) => ({
      task: `Research ${scope}.`, allowedTools: ["web.search"], research: { scope, requireLiveSources: true, requireRepositoryEvidence: false }
    })) }));
    const dispatch = await h.turn(RESEARCH_PROMPT);
    expect(dispatch.finalOutcome?.status).toBe("completed");
    const task = h.store.listTasks()[0]!;
    const { scheduler, resultService } = schedulerFor(h, task.id);
    for (let index = 0; index < 3; index++) {
      if (index === 1) h.enqueue(answer("I have no source evidence."));
      else h.enqueue(nativeCall("web_search", { query: `battery recycling ${index}` }), answer(`Observed source: ${SOURCE_URL}\n\n${CLAIM_TABLE}`));
      expect(await scheduler.runOnce()).toMatchObject(index === 1 ? { failed: 1 } : { completed: 1 });
    }
    const accepted = h.store.listResults(task.id).filter((result) => result.disposition === "accepted");
    expect(accepted).toHaveLength(2);
    for (const result of accepted) h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: result.id }));
    h.enqueue((request) => {
      expect(JSON.stringify(request.messages)).toContain("Partial synthesis boundary");
      expect(JSON.stringify(request.messages)).toContain("current sources required");
      return { content: `${REPORT}\n${CLAIM_TABLE}\n\nMissing coverage: processing failed; conclusions are partial.` };
    });
    expect(await scheduler.runOnce()).toMatchObject({ completed: 1 });
    expect(h.store.getTask(task.id)?.status).toBe("partial");
    const primary = h.store.listResults(task.id).find((result) => h.store.getStep(result.stepId!)?.executor.role === "synthesis" && result.disposition === "accepted")!;
    const report = await resultService.readText({ taskId: task.id, resultId: primary.id, sessionId: h.runtime.sessionId });
    expect(report.content).toContain("Research coverage is partial");
    h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: primary.id }),
      nativeCall("file_write", { path: "report.md", content: report.content }), nativeCall("file_read", { path: "report.md" }), answer("Saved."));
    const saved = await h.turn("Save this report to report.md");
    expect(saved.finalOutcome?.status).toBe("completed");
    expect(saved.text).toContain("Research coverage remains partial");
    expect(h.store.listTasks()).toHaveLength(1);
    expect(h.store.listSteps(task.id, task.activePlanRevisionId!).filter((step) => step.executor.role === "worker" && step.status === "completed")).toHaveLength(2);
    scriptConsumed(h);
  });

  it.each(["too-few", "missing-contracts", "no-live-search", "no-synthesis"])("rejects delegation that weakens user requirements: %s", async (kind) => {
    const h = await harness();
    const tasks = ["collection", "processing", "reuse"].slice(0, kind === "too-few" ? 2 : 3).map((scope) => ({
      task: `Research ${scope}.`, allowedTools: ["web.search"],
      ...(kind === "missing-contracts" ? {} : { research: { scope, requireLiveSources: kind !== "no-live-search", requireRepositoryEvidence: false } })
    }));
    h.enqueue(nativeCall("delegate_task", { tasks, ...(kind === "no-synthesis" ? { synthesis: false } : {}) }), answer("All three workers completed."));
    const result = await h.turn(RESEARCH_PROMPT);
    expect(h.store.listTasks()).toEqual([]);
    expect(result.toolExecutions[0]?.result).toMatchObject({ ok: false, metadata: { code: "request-requirements-unsatisfied" } });
    expect(result.finalOutcome?.status).not.toBe("completed");
    expect(result.text).toContain("requested-worker-evidence");
    scriptConsumed(h);
  });

  it("ignores a provider-supplied replacement contract at the delegation boundary", async () => {
    const h = await harness();
    h.enqueue(nativeCall("delegate_task", { tasks: ["one", "two", "three"].map((scope) => ({
      task: `Research ${scope}.`, research: { scope, requireLiveSources: false, requireRepositoryEvidence: false }
    })), requestContract: { requirements: {} } }), answer("The workers are running."));
    const result = await h.turn(RESEARCH_PROMPT);
    expect(h.store.listTasks()).toEqual([]);
    expect(result.toolExecutions[0]?.result).toMatchObject({ ok: false, metadata: { code: "request-requirements-unsatisfied" } });
    expect(result.finalOutcome?.status).not.toBe("completed");
    scriptConsumed(h);
  });

  it.each([true, false])("grounds browser claims in the current status despite stale memory (available=%s)", async (available) => {
    const h = await harness({ browserAvailable: available, memoryText: "- Browser tools are unavailable.\n- Do not browse without asking me." });
    h.enqueue(nativeCall("browser_status", {}), (request) => {
      const prompt = JSON.stringify(request.messages);
      expect(prompt).toContain("Browser tools are unavailable");
      expect(prompt).toContain("Do not browse without asking me");
      expect(prompt).toContain(available ? "reported_available" : "reported_unavailable");
      expect(prompt).toContain("Current tool observations supersede");
      return { content: "I cannot browse." };
    });
    const result = await h.turn("Check the browser status");
    expect(result.text).toContain(available ? "current browser status reports an available backend" : "I cannot browse");
    expect(result.toolExecutions.map((execution) => execution.tool.name)).toEqual(["browser.status"]);
    scriptConsumed(h);
  });

  it("reuses a successful identical extract with the original receipt (A12)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("web_extract", { url: SOURCE_URL }), nativeCall("web_extract", { url: SOURCE_URL }), answer(REPORT));
    const response = await h.turn("Research battery recycling.");
    expect(h.extracts).toEqual([SOURCE_URL]);
    expect(response.toolExecutions[1]?.readReuseOf).toBe(response.toolExecutions[0]?.toolCallId);
    expect(response.toolExecutions).toHaveLength(2);
    expect(new Set(response.toolExecutions.map((execution) => execution.toolCallId)).size).toBe(2);
    expect(response.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    scriptConsumed(h);
  });
  it("delivers the latest duplicate five-source batch with full prior observations", async () => {
    const h = await harness({ maxToolCalls: 20 });
    const urls = [1, 2, 3, 4, 5].map((n) => `${SOURCE_URL}?source=${n}`);
    const batch = (request: Parameters<ReturnType<typeof nativeCall>>[0]) => ({ content: "", toolCalls: urls.flatMap((url) => nativeCall("web_extract", { url })(request).toolCalls!) });
    h.enqueue(batch, batch, (request) => {
      const prompt = JSON.stringify(request);
      expect(prompt).toContain("Prior observation reused from");
      for (const url of urls) expect(prompt).toContain(url);
      expect(prompt).toContain("Fixture abstract: compare recycling methods");
      return { content: REPORT };
    });
    const response = await h.turn("Research battery recycling.");
    expect([...h.extracts].sort()).toEqual(urls);
    expect(response.toolExecutions).toHaveLength(10);
    for (let i = 0; i < 5; i++) {
      const original = response.toolExecutions[i]!;
      const reuse = response.toolExecutions[i + 5]!;
      expect(reuse.readReuseOf).toBe(original.toolCallId);
      expect(reuse.result?.metadata?.retrievedAt).toBe(original.result?.metadata?.retrievedAt);
    }
    scriptConsumed(h);
  });

  it("refreshes explicitly, clears between turns and rechecks denial before a hit", async () => {
    let deny = false;
    const h = await harness({ toolDecision: () => deny ? "deny" : "allow" });
    h.enqueue(nativeCall("web_extract", { url: SOURCE_URL }), nativeCall("web_extract", { url: SOURCE_URL, refresh: true }), answer(REPORT));
    await h.turn("Research battery recycling.");
    expect(h.extracts).toHaveLength(2);
    h.enqueue(nativeCall("web_extract", { url: SOURCE_URL }), (request) => {
      deny = true;
      return nativeCall("web_extract", { url: SOURCE_URL })(request);
    }, answer("The read was denied."));
    const response = await h.turn("Research battery recycling again.");
    expect(h.extracts).toHaveLength(3);
    expect(response.toolExecutions[1]?.decision).toBe("deny");
    expect(response.toolExecutions[1]?.readReuseOf).toBeUndefined();
    scriptConsumed(h);
  });

});

describe("explicit delegation limit admission", () => {
  it("blocks an oversized user count before any provider or worker execution", async () => {
    const h = await harness({ maxBatchTasks: 2 });
    const result = await h.turn("Use 3 subagents to research battery recycling");
    expect(result.finalOutcome?.status).toBe("blocked");
    expect(result.text).toContain("1–2");
    expect(h.requests).toHaveLength(0);
    expect(h.store.listTasks()).toHaveLength(0);
  });
});

describe.sequential("file output completion requirements", () => {
  it("replaces a false saved claim when the file was written without readback", async () => {
    const h = await harness();
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), answer("Saved and verified report.md."));
    const result = await h.turn("Save report.md");
    expect(result.finalOutcome?.status).toBe("partially_completed");
    expect(result.text).toContain("matching readback");
    expect(result.text).not.toContain("Saved and verified");
    expect(result.providerExecution?.response?.content ?? "").not.toContain("Saved and verified");
    scriptConsumed(h);
  });
  it("accepts an unchanged file only after matching readback", async () => {
    const h = await harness();
    await writeFile(join(h.workspaceRoot, "report.md"), REPORT);
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), nativeCall("file_read", { path: "report.md" }), answer("Verified report.md."));
    const result = await h.turn("Export the report to report.md");
    expect(result.toolExecutions[0]?.result?.metadata?.changed).toBe(false);
    expect(result.finalOutcome?.status).toBe("completed");
    scriptConsumed(h);
  });
  it("accepts a patch-created report and matching readback", async () => {
    const h = await harness();
    h.enqueue(nativeCall("file_patch", { mode: "patch", patch: "*** Begin Patch\n*** Add File: report.md\n+# Report\n+Evidence fixture\n*** End Patch" }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    const result = await h.turn("Prepare a markdown file at report.md");
    expect(result.finalOutcome?.status).toBe("completed");
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.patch", verification: "verified" }));
    scriptConsumed(h);
  });
  it("does not count a partial read as complete readback", async () => {
    const h = await harness();
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), nativeCall("file_read", { path: "report.md", lineStart: 1, lineEnd: 1 }), answer("Saved and verified."));
    const result = await h.turn("Save report.md");
    expect(result.finalOutcome?.status).toBe("partially_completed");
    expect(result.text).toContain("matching readback");
    scriptConsumed(h);
  });
  it("reports a missing file tool rather than accepting pasted markdown", async () => {
    const h = await harness({ fileToolsAvailable: false });
    h.enqueue(answer("Saved report.md.\n" + REPORT));
    const result = await h.turn("Prepare a markdown file");
    expect(result.finalOutcome?.status).toBe("blocked");
    expect(result.text).toContain("file-writing tool is unavailable");
    expect(result.toolExecutions).toEqual([]);
    scriptConsumed(h);
  });
  it("keeps a durable handoff complete while the file objective remains with the Task", async () => {
    const h = await harness();
    h.enqueue(nativeCall("delegate_task", { tasks: ["collection", "processing", "reuse"].map((scope) => ({ task: `Research batteries: ${scope}`, allowedTools: ["web.search"], research: { scope, requireLiveSources: true, requireRepositoryEvidence: false } })) }));
    const result = await h.turn("Use 3 subagents to research batteries and save report.md");
    expect(result.toolExecutions[0]?.result?.ok, result.toolExecutions[0]?.result?.content).toBe(true);
    expect(result.finalOutcome?.status).toBe("completed");
    expect(h.store.listTasks()).toHaveLength(1);
    await expect(readFile(join(h.workspaceRoot, "report.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.text).not.toContain("File output is incomplete");
    scriptConsumed(h);
  });
});
