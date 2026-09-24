import { ToolRegistry } from "../../tools/tool-registry.js";
import { SessionCapabilityRecovery, MAX_CAPABILITY_ROUNDS } from "../../tools/capability-tools.js";
import { createSkillTools } from "../../tools/skill-tools.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "../../contracts/eval.js";
import { loadSkillsFromDirectory } from "../../skills/skill-loader.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { IntentRouter } from "../../runtime/intent-router.js";
import { selectProviderToolsForTurn } from "../../runtime/provider-tool-narrowing.js";
import { continueRequestRequirements, requirementFollowUp } from "../../runtime/request-requirements.js";
import { buildProviderToolSchemaCatalog } from "../../tools/tool-schema.js";
import { estimateTextTokensRough } from "../../prompt/token-estimator.js";
import { assertTrue, buildResult } from "../eval-runner.js";
import { createResearchWorkflowHarness } from "./research-workflow-harness.js";

export type ReleaseRoutingCase = {
  id: string; seed: string; split: "development" | "heldout"; language: "en" | "ar" | "mixed";
  prompt: string; category: string; requiredTools: string[]; expectedSkill: string | null;
  delegationCount?: number; fileOutput?: boolean; previousPrompt?: string; noActions?: boolean; unresolvedSkill?: boolean;
};
export const ROUTING_CORPUS_SHA256 = "0e46fe4054651739ec55222b4c948414370212e94ec8c08db5791d25c7613900";
export async function readReleaseRoutingCorpus() {
  const raw = await readFile(new URL("../../../assets/evals/research-routing-v1.json", import.meta.url), "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== ROUTING_CORPUS_SHA256) throw new Error("Frozen routing corpus changed; version and independently review a replacement corpus.");
  return JSON.parse(raw) as { version: number; cases: ReleaseRoutingCase[] };
}

export async function measureReleaseRouting(split?: ReleaseRoutingCase["split"]) {
  const corpus = await readReleaseRoutingCorpus();
  const loaded = await loadSkillsFromDirectory(fileURLToPath(new URL("../../../skills/official", import.meta.url)), { sourceKind: "bundled" });
  if (loaded.errors.length) throw new Error(`Bundled skill loader errors: ${loaded.errors.length}`);
  const skills = new SkillRegistry();
  for (const skill of loaded.skills) skills.register(skill);
  const router = new IntentRouter({ skillRegistry: skills });
  const h = await createResearchWorkflowHarness();
  try {
    // Real runtime tool definitions, including the recovery schema cost. No calls are dispatched by this classifier probe.
    const catalog = buildProviderToolSchemaCatalog({ tools: h.runtime.tools() });
    const cases = corpus.cases.filter((row) => split === undefined || row.split === split).map((row) => {
      const intent = router.route(row.prompt);
      if (row.previousPrompt) {
        const previous = router.route(row.previousPrompt).requestRequirements!;
        const mode = requirementFollowUp(row.prompt, previous);
        if (mode) intent.requestRequirements = continueRequestRequirements(previous, intent.requestRequirements!, mode);
      }
      const selection = selectProviderToolsForTurn({ catalog, intent, userText: row.prompt, selectedSkill: intent.primarySkill });
      const exposed = selection.initialTools.map((schema) => catalog.aliases.get(schema.function.name)!);
      const requirements = intent.requestRequirements!;
      const violations = [
        ...(row.noActions && (requirements.delegation || requirements.fileOutput) ? ["unrequested-action"] : []),
        ...(row.fileOutput && !requirements.fileOutput ? ["missing-file-requirement"] : []),
        ...(row.delegationCount && requirements.delegation?.count !== row.delegationCount ? ["wrong-worker-count"] : []),
        ...(row.unresolvedSkill && !intent.skillRequests?.some((request) => request.status === "unavailable" || request.status === "ambiguous") ? ["unresolved-skill-not-reported"] : []),
        ...(row.category === "greeting" && exposed.length ? ["greeting-exposes-tools"] : [])
      ];
      return { id: row.id, seed: row.seed, split: row.split, language: row.language, category: row.category,
        expectedSkill: row.expectedSkill, selectedSkill: intent.primarySkill?.name ?? null,
        requiredTools: row.requiredTools, missingTools: row.requiredTools.filter((name) => !exposed.includes(name)),
        violations, schemaTokensRough: exposed.length ? estimateTextTokensRough(JSON.stringify(selection.initialTools)) : 0,
        exposedTools: exposed, schemaCount: exposed.length };
    });
    // Recovery is scored independently; it never repairs the first-pass numerator.
    const registry = new ToolRegistry();
    for (const tool of h.runtime.tools()) {
      // Recovery-schema probe only: unrelated handlers must never execute here.
      registry.register({ ...tool, isAvailable: () => true, run: async () => { throw new Error("Schema-only fixture handler dispatched"); } });
    }
    const recovery = new SessionCapabilityRecovery({ registry, skills });
    const read = createSkillTools({ registry: skills, localSkillsRoot: h.homeDir, capabilityRecovery: recovery }).find((tool) => tool.name === "skill.read")!;
    registry.unregister(read.name); registry.register(read);
    recovery.bindCatalog(buildProviderToolSchemaCatalog({ tools: registry.list() }));
    const recoveryCases = [];
    for (const row of cases) {
      const ids = [...row.missingTools.map((name) => `tool:${name}`), ...(row.expectedSkill && row.selectedSkill !== row.expectedSkill ? [`skill:${row.expectedSkill}`] : [])];
      if (!ids.length) continue;
      const context = { profileId: "baseline", sessionId: h.runtime.sessionId, visibleTurnId: row.id, toolCallId: `${row.id}-request` };
      const active = catalog.entries.filter((entry) => row.exposedTools.includes(entry.tool.name)).map((entry) => entry.schema);
      recovery.beginTurn({ ...context, tools: active });
      const discovered = recovery.discover({ ids }, context);
      const requested = recovery.request({ ids, reason: "Frozen expected capability was missed by first-pass selection" }, context);
      const proposals = recovery.takeRequests([{ tool: registry.get("capability.request")!, decision: "allow", riskClass: "read-only-local", result: requested, toolCallId: context.toolCallId }]);
      const applied = await recovery.applyRequests(proposals, active);
      let loaded = !ids.some((id) => id.startsWith("skill:"));
      if (row.expectedSkill && ids.includes(`skill:${row.expectedSkill}`)) {
        const skillContext = { ...context, toolCallId: `${row.id}-read` };
        const result = await read.run({ name: row.expectedSkill }, skillContext);
        loaded = recovery.takeSkillLoads([{ tool: read, decision: "allow", riskClass: "read-only-local", result, toolCallId: skillContext.toolCallId }]).some((load) => load.receipt.name === row.expectedSkill && load.content.length > 0);
      }
      recoveryCases.push({ id: row.id, requested: ids, applied: applied.applied, rounds: MAX_CAPABILITY_ROUNDS - recovery.roundsRemaining,
        passed: discovered.ok && ids.every((id) => applied.applied.includes(id)) && loaded });
      recovery.endTurn();
    }
    const summarize = (rows: typeof cases) => {
      const selected = rows.filter((row) => row.selectedSkill !== null);
      const requested = rows.reduce((sum, row) => sum + row.requiredTools.length, 0);
      const missed = rows.reduce((sum, row) => sum + row.missingTools.length, 0);
      const tokens = rows.map((row) => row.schemaTokensRough).sort((a, b) => a - b);
      const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
      return { cases: rows.length, requestedCapabilityRecall: ratio(requested - missed, requested),
        primarySkillPrecision: ratio(selected.filter((row) => row.selectedSkill === row.expectedSkill).length, selected.length),
        primarySkillRecall: ratio(rows.filter((row) => row.expectedSkill && row.selectedSkill === row.expectedSkill).length, rows.filter((row) => row.expectedSkill).length),
        safetyViolations: rows.reduce((sum, row) => sum + row.violations.length + (row.expectedSkill === null && row.selectedSkill !== null ? 1 : 0), 0),
        schemaTokensRough: { median: tokens[Math.floor(tokens.length / 2)] ?? 0, p95: tokens[Math.ceil(tokens.length * .95) - 1] ?? 0 } };
    };
    return { version: 1, corpusSha256: ROUTING_CORPUS_SHA256, skillsLoaded: loaded.skills.length,
      definitions: h.runtime.tools().length, scope: "Real bundled skill loader, IntentRouter and provider narrowing; registered runtime definitions offered as available for this classification probe; actual readiness is checked by the separate execution fixtures; no live model calls.",
      recovery: recoveryCases, metrics: summarize(cases), splits: Object.fromEntries(["development", "heldout"].map((split) => [split, summarize(cases.filter((row) => row.split === split))])),
      perSplitLanguage: Object.fromEntries(["development", "heldout"].map((split) => [split, Object.fromEntries(["en", "ar", "mixed"].map((language) => [language, summarize(cases.filter((row) => row.split === split && row.language === language))]))])),
      perLanguage: Object.fromEntries(["en", "ar", "mixed"].map((language) => [language, summarize(cases.filter((row) => row.language === language))])), cases };
  } finally { await h.dispose(); }
}

export const researchRoutingReleaseCase: EvalCase = {
  id: "research-routing-release", name: "Frozen research routing release gates", description: "First-pass capability and primary-skill metrics; recovery and execution are separate gates.", tags: ["routing", "research", "release"],
  async run() {
    const start = Date.now();
    const report = await measureReleaseRouting("heldout");
    return buildResult(this.id, this.name, [
      assertTrue("held-out requested-capability recall >= 95%", (report.metrics.requestedCapabilityRecall.value ?? 0) >= .95),
      assertTrue("held-out primary-skill precision >= 98%", (report.metrics.primarySkillPrecision.value ?? 0) >= .98),
      assertTrue("zero safety/requirement violations", report.metrics.safetyViolations === 0),
      assertTrue("all first-pass misses recover within two rounds", report.recovery.every((row) => row.passed && row.rounds <= 2))
    ], Date.now() - start);
  }
};
