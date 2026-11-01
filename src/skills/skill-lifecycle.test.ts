import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { renderSkillsIndex } from "../prompt/prompt-assembly.js";
import { createSkillTools } from "../tools/skill-tools.js";
import { SkillEvolutionStore } from "./skill-evolution.js";
import { SkillRegistry } from "./skill-registry.js";
import { SkillLearningManager } from "./skill-learning.js";
import { parseSkillFile } from "./skill-loader.js";
import { SkillProposalService, runSkillEvalGate } from "./skill-proposal-service.js";
import { skillContentHash, validateSkillTaskEvaluation, type SkillTaskEvaluation } from "./skill-task-evaluation.js";
import { skillCatalogDelta, snapshotSkillCatalog } from "./skill-catalog-delta.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const content = `---\n${JSON.stringify({ name: "checks", description: "Verify generated changes.", requiredToolsets: ["files"], playbook: [], evaluations: [] })}\n---\nRun the checks.\n`;
const patch = { type: "text_patch" as const, oldString: "Run the checks.", newString: "Run the checks and inspect the result before reporting completion." };

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "skill-lifecycle-")); roots.push(root);
  const skillPath = join(root, "checks", "SKILL.md"); await mkdir(join(root, "checks")); await writeFile(skillPath, content);
  const registry = new SkillRegistry();
  const skill = parseSkillFile(skillPath, content, { sourceRoot: root, sourceKind: "local" }); registry.register(skill);
  const store = new SkillEvolutionStore({ usagePath: join(root, ".usage.json"), evolutionRoot: join(root, ".evolution") });
  const service = new SkillProposalService({ registry, localSkillsRoot: root, skillEvolutionStore: store });
  return { root, skillPath, registry, skill, store, service };
}

function taskReport(): SkillTaskEvaluation {
  return {
    version: 1, baselineHash: skillContentHash(content), candidateHash: skillContentHash(content.replace(patch.oldString, patch.newString)),
    suiteId: "checks-v1", modelId: "test-model-fixed", graderId: "independent-file-checks-v1", environmentHash: "a".repeat(64),
    cases: ["repair", "regression"].map((id) => ({ id, fixtureHash: skillContentHash(id),
      baseline: { score: id === "repair" ? 0.5 : 1, safetyPassed: true, artifact: `${id}-baseline.json` },
      candidate: { score: 1, safetyPassed: true, artifact: `${id}-candidate.json` } }))
  };
}

describe("governed skill lifecycle", () => {
  it("retains every name beyond the old category limit, with explicit description compression", () => {
    const catalog = Array.from({ length: 100 }, (_, i) => ({ name: `skill-${i}`, category: "files", version: "1", requiredToolsets: [], description: "A useful description that is intentionally long enough to exceed the total description budget." }));
    expect(renderSkillsIndex(catalog.slice(0, 12))).toContain("A useful description");
    expect(renderSkillsIndex(catalog.slice(0, 12))).toContain("skill-11");
    const compressed = renderSkillsIndex(catalog);
    expect(compressed).toContain("compressed");
    for (const skill of catalog) expect(compressed).toContain(`${skill.name} (`);
    expect(compressed).not.toContain("useful description");
  });

  it("detects same-length instruction edits and only compares the visible catalog", async () => {
    const h = await harness();
    const before = snapshotSkillCatalog(h.registry.catalog(), (name) => h.registry.get(name));
    h.registry.replaceLoaded({ ...h.skill, instructions: "Try the checks." });
    const after = snapshotSkillCatalog(h.registry.catalog(), (name) => h.registry.get(name));
    expect(skillCatalogDelta(before, after)).toEqual({ added: [], removed: [], changed: ["checks"] });
    expect(skillCatalogDelta(after, new Map())).toEqual({ added: [], removed: ["checks"], changed: [] });
    expect(snapshotSkillCatalog([], (name) => h.registry.get(name)).size).toBe(0);
  });

  it("counts root/resource reads across aliases, excludes failed reads, and keeps uses and outcomes separate", async () => {
    const h = await harness();
    await mkdir(join(h.root, "checks", "references")); await writeFile(join(h.root, "checks", "references", "guide.md"), "Guide");
    h.registry.replaceLoaded({ ...h.skill, resources: [{ kind: "reference", path: "references/guide.md" }] });
    const tools = createSkillTools({ registry: h.registry, localSkillsRoot: h.root, skillEvolutionStore: h.store });
    const run = async (name: string, input: unknown) => tools.find((tool) => tool.name === name)!.run(input as never);
    expect((await run("skill.read", { name: "checks" })).ok).toBe(true);
    expect((await run("skill.view", { name: "checks", path: "references/guide.md" })).ok).toBe(true);
    expect((await run("skill.read", { name: "checks", path: "../../secret" })).ok).toBe(false);
    expect(await h.store.getUsage("checks")).toMatchObject({ viewCount: 2, rootReadCount: 1, resourceReadCount: 1, useCount: 0, successCount: 0, failureCount: 0 });
    await h.store.recordSkillUsed({ skill: h.skill });
    expect(await h.store.getUsage("checks")).toMatchObject({ viewCount: 2, useCount: 1, successCount: 0 });
  });

  it("automatically prepares one evidence-linked draft after repeated failures, never mutating the live skill", async () => {
    const h = await harness();
    const drafter = vi.fn().mockResolvedValue(patch);
    const sessionDb = new InMemorySessionDB();
    for (const id of ["one", "two", "three", "four"]) await sessionDb.createSession({ id, profileId: "default" });
    const manager = new SkillLearningManager({ autonomy: "proactive", registry: h.registry, localSkillsRoot: h.root,
      storePath: join(h.root, ".learning.json"), sessionDb, skillEvolutionStore: h.store, drafter, proposalService: h.service });
    const observe = (sessionId: string, mode: "suggest" | "proactive" = "proactive") => manager.observeTurn({ profileId: "default", sessionId,
      userText: "Private task details must never go to drafting", promptHash: "same-task", selectedSkill: h.skill,
      outcomeStatus: "failed", toolExecutions: [], agentEvolutionPolicy: deriveAgentEvolutionPolicy(mode) });
    await observe("one"); expect(drafter).not.toHaveBeenCalled();
    await observe("one"); expect(drafter).not.toHaveBeenCalled();
    await observe("two", "suggest"); expect(drafter).not.toHaveBeenCalled();
    await observe("three");
    expect(drafter).not.toHaveBeenCalled();
    manager.startBackgroundReview({ profileId: "default", sessionId: "three", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
    await manager.waitForBackgroundReview();
    expect((await manager.inspect())[0]?.draftStatus).toBe("proposed");
    expect(JSON.stringify(drafter.mock.calls)).not.toContain("Private task details");
    await observe("four"); expect(drafter).toHaveBeenCalledTimes(1);
    const [proposal] = await h.store.listProposals();
    expect(proposal).toMatchObject({ patch, requiresHumanApproval: true, mayPromoteAutomatically: false, requiresTaskEvaluation: true, baseContentHash: skillContentHash(content) });
    expect(proposal!.evidenceIds!.length).toBeGreaterThanOrEqual(2);
    expect(await readFile(h.skillPath, "utf8")).toBe(content);
    // Approval alone cannot establish task performance.
    await h.service.approveProposal(proposal!.id);
    expect(await h.service.promoteProposal(proposal!.id)).toMatchObject({ ok: false, reason: expect.stringContaining("paired cases") });
    await h.service.recordTaskEvaluation(proposal!.id, taskReport());
    expect((await h.service.findProposal(proposal!.id))?.approvedAt).toBeUndefined();
    await h.service.approveProposal(proposal!.id);
    expect(await h.service.promoteProposal(proposal!.id)).toMatchObject({ ok: true });
    expect((h.registry.get("checks") as typeof h.skill).instructions).toContain("inspect the result");
  });

  it("retains parallel read counters across usage-store reloads", async () => {
    const h = await harness();
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.store.recordSkillViewed({ skillName: "checks", resource: i % 2 === 0 })));
    const reloaded = new SkillEvolutionStore({ usagePath: join(h.root, ".usage.json"), evolutionRoot: join(h.root, ".evolution") });
    expect(await reloaded.getUsage("checks")).toMatchObject({ viewCount: 12, rootReadCount: 6, resourceReadCount: 6, useCount: 0 });
  });

  it("refuses stale drafts and authority expansion even with approval", async () => {
    const h = await harness();
    const candidate = await h.store.appendLearningCandidate({ kind: "selected_skill_refinement", selectedSkill: "checks", suggestedTarget: "skill_patch", evidenceIds: [], reason: "Verify results" });
    const options = { candidate, agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), baseContentHash: skillContentHash(content) };
    // A stale registry must not grant authority removed from the actual source.
    h.registry.replaceLoaded({ ...h.skill, requiredToolsets: ["files", "shell-write"] });
    expect(await h.service.createProposalFromLearningCandidate({ ...options, patch: { type: "json_frontmatter_patch", path: "/requiredToolsets", value: ["files", "shell-write"] } })).toMatchObject({ ok: false, reason: expect.stringContaining("authority") });
    const drafted = await h.service.createProposalFromLearningCandidate({ ...options, patch });
    if (!drafted.ok) throw new Error(drafted.reason);
    await h.service.approveProposal(drafted.proposal.id);
    await writeFile(h.skillPath, `${content}\nNew operator instruction.\n`);
    expect(await h.service.promoteProposal(drafted.proposal.id)).toMatchObject({ ok: false, reason: expect.stringContaining("changed after drafting") });
  });

  it.each(["tie", "regression", "safety", "hash", "missing-case", "same-artifact"])("rejects inadequate paired task evidence: %s", (failure) => {
    const report = taskReport();
    if (failure === "tie") report.cases[0]!.baseline.score = 1;
    if (failure === "regression") report.cases[1]!.candidate.score = 0.9;
    if (failure === "safety") report.cases[0]!.candidate.safetyPassed = false;
    if (failure === "hash") report.candidateHash = "b".repeat(64);
    if (failure === "missing-case") report.cases.pop();
    if (failure === "same-artifact") report.cases[0]!.candidate.artifact = report.cases[0]!.baseline.artifact;
    expect(() => validateSkillTaskEvaluation(report, content, content.replace(patch.oldString, patch.newString))).toThrow();
  });

  it("does not treat unexecuted end-state assertions as passing metadata checks", async () => {
    const h = await harness();
    await mkdir(join(h.root, "checks", "evals"));
    await writeFile(join(h.root, "checks", "evals", "behavior.json"), JSON.stringify({ id: "behavior", expected: { mustEndState: "tests passed" } }));
    expect(await runSkillEvalGate(h.skill)).toMatchObject({ evaluationKind: "metadata", status: "failed", failures: expect.arrayContaining([expect.stringContaining("metadata cannot establish")]) });
  });
});


it("reviews successful tasks across different prompts, can abstain, and leaves suggest mode idle", async () => {
  const h = await harness();
  const drafter = vi.fn().mockResolvedValue(undefined);
  const db = new InMemorySessionDB();
  for (const id of ["success-a", "success-b"]) await db.createSession({ id, profileId: "default" });
  const manager = new SkillLearningManager({ autonomy: "proactive", registry: h.registry, localSkillsRoot: h.root,
    storePath: join(h.root, ".learning.json"), sessionDb: db, skillEvolutionStore: h.store, drafter, proposalService: h.service });
  for (const sessionId of ["success-a", "success-b"]) await manager.observeTurn({ profileId: "default", sessionId,
    userText: `Private task ${sessionId}`, promptHash: sessionId, selectedSkill: h.skill, outcomeStatus: "succeeded",
    agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), toolExecutions: [] });
  expect(await manager.inspect()).toHaveLength(1);
  manager.startBackgroundReview({ profileId: "default", sessionId: "success-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("suggest"), validateAuthority: async () => {} });
  await manager.waitForBackgroundReview(); expect(drafter).not.toHaveBeenCalled();
  manager.startBackgroundReview({ profileId: "default", sessionId: "success-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
  await manager.waitForBackgroundReview();
  expect(drafter).toHaveBeenCalledTimes(1);
  expect(drafter.mock.calls[0]![0].evidence[0]).toMatchObject({ outcome: "succeeded", lesson: expect.stringContaining("preserve") });
  expect(JSON.stringify(drafter.mock.calls)).not.toContain("Private task");
  expect((await manager.inspect())[0]?.draftStatus).toBe("abstained");
  expect(await h.service.listProposals()).toHaveLength(0);
});

it("cancels background model review for foreground work and preserves a retryable candidate", async () => {
  const h = await harness(); const db = new InMemorySessionDB();
  for (const id of ["cancel-a", "cancel-b"]) await db.createSession({ id, profileId: "default" });
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const drafter = vi.fn(async ({ signal }) => { started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return patch; });
  const manager = new SkillLearningManager({ autonomy: "proactive", registry: h.registry, localSkillsRoot: h.root,
    storePath: join(h.root, ".learning.json"), sessionDb: db, skillEvolutionStore: h.store, drafter, proposalService: h.service });
  for (const sessionId of ["cancel-a", "cancel-b"]) await manager.observeTurn({ profileId: "default", sessionId,
    userText: "Run checks", selectedSkill: h.skill, outcomeStatus: "failed", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), toolExecutions: [] });
  manager.startBackgroundReview({ profileId: "default", sessionId: "cancel-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
  await entered; await manager.cancelBackgroundReview();
  expect((await manager.inspect())[0]).toMatchObject({ draftStatus: "pending" });
  expect((await manager.inspect())[0]?.draftAttemptedAt).toBeDefined();
  manager.startBackgroundReview({ profileId: "default", sessionId: "cancel-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
  await manager.waitForBackgroundReview();
  expect(drafter).toHaveBeenCalledTimes(1);
  expect(await h.service.listProposals()).toHaveLength(0);
  expect(await readFile(h.skillPath, "utf8")).toBe(content);
});

it("serializes shared profile observations and draft claims across managers", async () => {
  const h = await harness(); const db = new InMemorySessionDB(); const drafter = vi.fn().mockResolvedValue(patch);
  const managers = [0, 1].map(() => new SkillLearningManager({ autonomy: "proactive", registry: h.registry, localSkillsRoot: h.root,
    storePath: join(h.root, ".learning.json"), sessionDb: db, skillEvolutionStore: h.store, drafter, proposalService: h.service }));
  for (const id of ["parallel-a", "parallel-b"]) await db.createSession({ id, profileId: "default" });
  await Promise.all(managers.map((manager, i) => manager.observeTurn({ profileId: "default", sessionId: i ? "parallel-b" : "parallel-a",
    userText: "Run checks", selectedSkill: h.skill, outcomeStatus: "failed", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), toolExecutions: [] })));
  expect((await managers[0]!.inspect())[0]?.occurrences).toBe(2);
  for (const manager of managers) manager.startBackgroundReview({ profileId: "default", sessionId: "parallel-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
  await Promise.all(managers.map(manager => manager.waitForBackgroundReview()));
  expect(drafter).toHaveBeenCalledTimes(1);
  expect(await h.service.listProposals()).toHaveLength(1);
});


it("records runner provenance and invalidates earlier passing evidence when a rerun ties", async () => {
  const h = await harness();
  const candidate = await h.store.appendLearningCandidate({ kind: "selected_skill_refinement", selectedSkill: "checks", suggestedTarget: "skill_patch", evidenceIds: [], reason: "Verify results" });
  const drafted = await h.service.createProposalFromLearningCandidate({ candidate, agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), patch, baseContentHash: skillContentHash(content) });
  if (!drafted.ok) throw new Error(drafted.reason);
  const suite = { version: 1, id: "task-output", cases: ["a", "b"].map(id => ({ id, instruction: "Produce the result.", input: "fixture", expected: { done: true } })) };
  const complete = vi.fn(async (request) => ({ ok: true, toolCalls: [], response: { content: JSON.stringify({ done: request.messages[0].content.includes("inspect the result") }) } }));
  const options = { suite, executor: { complete } as never, route: { provider: "test", id: "fixed" } as never };
  expect((await h.service.runTaskEvaluation(drafted.proposal.id, options)).passed).toBe(true);
  expect(await h.service.findProposal(drafted.proposal.id)).toMatchObject({ taskEvaluationSource: "runner_executed", requiresHumanApproval: true });
  await h.service.approveProposal(drafted.proposal.id);
  complete.mockImplementation(async () => ({ ok: true, toolCalls: [], response: { content: '{"done":true}' } }));
  expect((await h.service.runTaskEvaluation(drafted.proposal.id, options)).passed).toBe(false);
  const after = await h.service.findProposal(drafted.proposal.id);
  expect(after?.approvedAt).toBeUndefined();
  await h.service.approveProposal(drafted.proposal.id);
  expect(await h.service.promoteProposal(drafted.proposal.id)).toMatchObject({ ok: false, reason: expect.stringContaining("improvement") });
  expect(await readFile(h.skillPath, "utf8")).toBe(content);
});


it("queues missing workflow proposals without creating executable skills", async () => {
  const h = await harness(); const db = new InMemorySessionDB(); const drafter = vi.fn();
  const manager = new SkillLearningManager({ autonomy: "proactive", registry: h.registry, localSkillsRoot: h.root,
    storePath: join(h.root, ".learning.json"), sessionDb: db, skillEvolutionStore: h.store, drafter, proposalService: h.service });
  for (const sessionId of ["missing-a", "missing-b"]) {
    await db.createSession({ id: sessionId, profileId: "default" });
    await manager.observeTurn({ profileId: "default", sessionId, userText: "Run the release checks and write a report", selectedSkill: undefined,
      outcomeStatus: "succeeded", noSkillResult: "missed", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"),
      toolExecutions: ["file.read", "file.write"].map(name => ({ tool: { name, toolsets: ["files"] }, decision: "allow", riskClass: "workspace-write", result: { ok: true } })) as never });
  }
  manager.startBackgroundReview({ profileId: "default", sessionId: "missing-b", agentEvolutionPolicy: deriveAgentEvolutionPolicy("proactive"), validateAuthority: async () => {} });
  await manager.waitForBackgroundReview();
  const [proposal] = await h.service.listProposals();
  expect(proposal).toMatchObject({ changeKind: "skill_create", mayPromoteAutomatically: false, requiresHumanApproval: true });
  expect(proposal?.patch).toBeUndefined();
  expect(drafter).not.toHaveBeenCalled();
  expect(h.registry.list()).toHaveLength(1);
});
