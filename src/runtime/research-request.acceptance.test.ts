import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { TaskResultService } from "../tasks/task-result-service.js";
import { TaskScheduler } from "../tasks/task-scheduler.js";
import { selectSkillPromptContent } from "../skills/skill-contract.js";
import { isLoadedSkill } from "./runtime-router.js";
import { answer, createResearchWorkflowHarness, nativeCall, REPORT, RESEARCH_PROMPT, SOURCE_URL } from "../test/fakes/research-workflow-harness.js";

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

describe.sequential("research workflow acceptance harness — PR 0 characterization", () => {
  it("observes real reads but no workers or file despite a completed research claim (A1–A3 gap)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("web_search", { query: "battery recycling" }), nativeCall("web_extract", { url: SOURCE_URL }), answer(REPORT));
    const research = await h.turn(RESEARCH_PROMPT);
    expect(h.runtime.tools().map((tool) => tool.name)).toContain("delegate_task");
    expect(research.intent.taskClass).toBe("research");
    expect(research.toolExecutions.map((execution) => execution.tool.name)).toEqual(["web.search", "web.extract"]);
    expect(research.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    expect(research.finalOutcome?.status).toBe("completed"); // PR 4: require worker evidence.
    expect(h.store.listTasks()).toEqual([]);
    expect(h.searches).toEqual(["battery recycling"]);
    expect(h.extracts).toEqual([SOURCE_URL]);
    const inventory = h.events.find((event) => event.kind === "provider-tool-inventory");
    expect(inventory).toMatchObject({ phase: "initial", nativeSchemaTokens: expect.any(Number) });
    if (inventory?.kind !== "provider-tool-inventory") throw new Error("Missing tool inventory");
    expect(inventory.tools).not.toContain("delegate_task");
    expect(inventory.nativeSchemaTokens).toBeGreaterThan(0);
    const receipts = (await h.sessionDb.listEvents(h.runtime.sessionId)).filter((event) => event.kind === "execution-evidence-recorded");
    for (const execution of research.toolExecutions) {
      expect(receipts).toContainEqual(expect.objectContaining({ tool: execution.tool.name, toolCallId: execution.toolCallId, status: "success" }));
    }

    h.enqueue(answer("The research workflow has been followed."));
    const rerun = await h.turn("Rerun this task but this time use the research skill.");
    expect(rerun.toolExecutions).toEqual([]); // PR 3/4: actually load the skill and rerun.
    expect(h.events.filter((event) => event.kind === "skill")).toEqual([]);

    h.enqueue(answer(REPORT));
    const save = await h.turn("Please prepare a markdown file");
    expect(save.toolExecutions).toEqual([]);
    expect(save.finalOutcome?.status).toBe("completed"); // PR 1: no false completion.
    expect(save.finalOutcome?.confirmedActions).toEqual([]);
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.store.listTasks()).toEqual([]);
    expect(h.requests).toHaveLength(5);
    scriptConsumed(h);
  });

  it("proves native file writes and readback are observable through real execution (positive control)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("file_write", { path: "report.md", content: REPORT }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    const result = await h.turn("Write documentation in report.md for the project");
    expect(result.toolExecutions.map((execution) => execution.tool.name)).toEqual(["file.write", "file.read"]);
    expect(result.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    expect(new Set(result.toolExecutions.map((execution) => execution.toolCallId)).size).toBe(2);
    expect(result.toolExecutions[1]?.result?.content).toContain("Synthetic research fixture");
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).resolves.toBe(REPORT);
    expect(result.finalOutcome?.confirmedActions).toContainEqual(expect.objectContaining({ tool: "file.write" }));
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

  it("creates three durable workers and settles their real child runs before synthesis (positive control)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("delegate_task", {
      tasks: ["collection", "processing", "reuse"].map((scope) => ({
        task: `Research battery recycling: ${scope}.`, allowedTools: ["web.search"],
        research: { scope, requireLiveSources: true, requireRepositoryEvidence: false }
      }))
    }));
    const dispatch = await h.turn("/researcher Use 3 subagents to research battery recycling.");
    expect(dispatch.toolExecutions.find((execution) => execution.tool.name === "delegate_task")?.result?.ok).toBe(true);
    const task = h.store.listTasks()[0]!;
    expect(task).toBeDefined();
    const steps = h.store.listSteps(task.id, task.activePlanRevisionId!);
    const workers = steps.filter((step) => step.executor.role === "worker");
    const synthesis = steps.find((step) => step.executor.role === "synthesis")!;
    expect(workers).toHaveLength(3);
    expect(new Set(synthesis.dependsOn)).toEqual(new Set(workers.map((step) => step.id)));
    expect(h.store.listResults(task.id)).toEqual([]); // Dispatch is not completed research.
    expect(h.events).toContainEqual({ kind: "skill", name: "researcher" });
    const skill = h.runtime.resolveSkill?.("researcher");
    if (skill === undefined || !isLoadedSkill(skill)) throw new Error("Bundled researcher not loaded");
    const selectedContent = selectSkillPromptContent(skill);
    expect(h.requests[0]?.messages.some((message) => typeof message.content === "string" && message.content.includes(selectedContent.content))).toBe(true);
    scriptConsumed(h);

    const ownerId = "baseline-scheduler";
    expect(h.store.acquireTaskHostLease({
      taskId: task.id, workspaceIdentityHash: task.workspace.identityHash, ownerId, kind: "foreground",
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).toBeTruthy();
    const resultService = new TaskResultService({
      store: h.store, profileId: "baseline", sessionDb: h.sessionDb,
      contentRoot: resolveProfileStateHome({ homeDir: h.homeDir, profileId: "baseline" }).taskResultsPath
    });
    const scheduler = new TaskScheduler({
      store: h.store, resultService, ownerId,
      limits: { maxProfileConcurrentAttempts: 1 },
      resolveExecutor: (task, step) => h.runtime.taskAgentExecutor?.canExecute(task, step) ? h.runtime.taskAgentExecutor : undefined
    });
    for (let index = 0; index < 3; index++) {
      h.enqueue(nativeCall("web_search", { query: `battery recycling scope ${index}` }), answer(`Scope ${index}: observed synthetic evidence [source](${SOURCE_URL}).`));
      expect(await scheduler.runOnce()).toMatchObject({ completed: 1, failed: 0 });
      scriptConsumed(h);
    }
    const results = h.store.listResults(task.id).filter((result) => result.kind === "text" && result.disposition === "accepted");
    expect(results).toHaveLength(3);
    expect(new Set(results.map((result) => result.stepId))).toEqual(new Set(workers.map((step) => step.id)));
    for (const result of results) h.enqueue(nativeCall("task_result_read", { task_id: task.id, result_id: result.id }));
    h.enqueue(answer(REPORT));
    const settled = await scheduler.runOnce();
    expect(settled, JSON.stringify({ errors: h.scriptErrors, failures: h.store.listAttempts(task.id).flatMap((attempt) => attempt.failure ? [attempt.failure] : []) })).toMatchObject({ completed: 1, failed: 0 });
    expect(h.store.getTask(task.id)?.status).toBe("completed");
    expect(h.store.listResults(task.id).some((result) => result.stepId === synthesis.id && result.kind === "text" && result.disposition === "accepted")).toBe(true);
    expect(new Set(h.store.listAttempts(task.id).map((attempt) => attempt.workerSessionId)).size).toBe(4);
    expect(h.searches).toHaveLength(3);
    expect(h.store.listTasks()).toHaveLength(1);
    scriptConsumed(h);

    const final = h.store.listResults(task.id).find((result) => result.stepId === synthesis.id)!;
    const savedResult = await resultService.readText({ taskId: task.id, resultId: final.id, sessionId: h.runtime.sessionId });
    expect(savedResult.content).toContain("Synthetic research fixture");
    h.enqueue(nativeCall("file_write", { path: "report.md", content: savedResult.content }), nativeCall("file_read", { path: "report.md" }), answer("Saved report.md."));
    await h.turn("Write documentation in report.md for the project");
    await expect(readFile(join(h.workspaceRoot, "report.md"), "utf8")).resolves.toBe(savedResult.content);
    expect(h.store.listTasks()).toHaveLength(1);
    scriptConsumed(h);
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

  it("currently fetches a successful identical extract twice (A12 gap, PR 5)", async () => {
    const h = await harness();
    h.enqueue(nativeCall("web_extract", { url: SOURCE_URL }), nativeCall("web_extract", { url: SOURCE_URL }), answer(REPORT));
    const response = await h.turn("Research battery recycling.");
    expect(h.extracts).toEqual([SOURCE_URL, SOURCE_URL]);
    expect(response.toolExecutions).toHaveLength(2);
    expect(new Set(response.toolExecutions.map((execution) => execution.toolCallId)).size).toBe(2);
    expect(response.toolExecutions.every((execution) => execution.result?.ok)).toBe(true);
    scriptConsumed(h);
  });
});
