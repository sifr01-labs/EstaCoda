import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IntentTaskClass } from "../../contracts/intent.js";
import type { ToolDefinition } from "../../contracts/tool.js";
import { estimateTextTokensRough } from "../../prompt/token-estimator.js";
import { IntentRouter } from "../../runtime/intent-router.js";
import { selectProviderToolsForTurn } from "../../runtime/provider-tool-narrowing.js";
import { deriveExecutionCompletionFloor, deriveExecutionFinalOutcome } from "../../runtime/execution-outcome.js";
import { parseSkillFile } from "../../skills/skill-loader.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { buildProviderToolSchemaCatalog } from "../../tools/tool-schema.js";

type ResearchRoutingCase = {
  id: string;
  language: "en" | "ar" | "mixed";
  prompt: string;
  expectedSkill?: string;
  expectedTaskClass: IntentTaskClass;
  requiredTools: string[];
  forbiddenTools?: string[];
  requiresExecution?: true;
};

// Development characterization only, not the PR 6 held-out release corpus.
// Desired labels are independent of the router's observed output. No private
// transcript, model-authored success labels, or live provider calls are used.
export const researchRoutingCases: readonly ResearchRoutingCase[] = [
  { id: "compound-research", language: "en", prompt: "Do deep research on the latest battery recycling methods and prepare a report. Use 3 subagents", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["web.search", "delegate_task"], requiresExecution: true },
  { id: "research-skill-rerun", language: "en", prompt: "Rerun this literature review but this time use the research skill.", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["skill.read", "web.search"], requiresExecution: true },
  { id: "prepare-markdown", language: "en", prompt: "Please prepare a markdown file", expectedTaskClass: "docs-writing", requiredTools: ["file.write", "file.read"], requiresExecution: true },
  { id: "save-named-file", language: "en", prompt: "Please save this report as report.md", expectedTaskClass: "docs-writing", requiredTools: ["file.write", "file.read"], requiresExecution: true },
  { id: "discovery-paraphrase", language: "en", prompt: "Find recent arXiv papers on battery recycling.", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["web.search"] },
  { id: "researcher-name", language: "en", prompt: "Use the researcher skill to research battery recycling", expectedSkill: "researcher", expectedTaskClass: "research", requiredTools: ["skill.read"] },
  { id: "researcher-slash", language: "en", prompt: "/researcher research battery recycling", expectedSkill: "researcher", expectedTaskClass: "research", requiredTools: ["web.search"] },
  { id: "discovery-slash", language: "en", prompt: "/research-discovery find papers about battery recycling", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["web.search"] },
  { id: "arabic-research", language: "ar", prompt: "ابحث بعمق عن أحدث تقنيات البطاريات واستخدم ثلاثة وكلاء فرعيين", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["web.search", "delegate_task"], requiresExecution: true },
  { id: "arabic-save", language: "ar", prompt: "احفظ التقرير في ملف نصي", expectedTaskClass: "docs-writing", requiredTools: ["file.write", "file.read"], requiresExecution: true },
  { id: "mixed-save", language: "mixed", prompt: "احفظ التقرير في ملف Markdown", expectedTaskClass: "docs-writing", requiredTools: ["file.write", "file.read"], requiresExecution: true },
  { id: "mixed-delegation", language: "mixed", prompt: "ابحث عن battery recycling واستخدم 3 subagents", expectedSkill: "research-discovery", expectedTaskClass: "research", requiredTools: ["delegate_task", "web.search"], requiresExecution: true },
  { id: "docs-control", language: "en", prompt: "Write documentation for the project", expectedTaskClass: "docs-writing", requiredTools: ["file.write", "file.read"], requiresExecution: true },
  { id: "greeting-control", language: "en", prompt: "hello", expectedTaskClass: "conversation", requiredTools: [], forbiddenTools: ["file.write", "delegate_task"] },
  { id: "negated-save-control", language: "en", prompt: "Do not save any files; explain the topic", expectedTaskClass: "general", requiredTools: [], forbiddenTools: ["file.write", "delegate_task"] },
  { id: "informational-delegation", language: "en", prompt: "What are subagents?", expectedTaskClass: "general", requiredTools: [], forbiddenTools: ["delegate_task"] },
  { id: "quoted-save", language: "en", prompt: "Explain the phrase ‘save a markdown file’ without taking action.", expectedTaskClass: "general", requiredTools: [], forbiddenTools: ["file.write", "delegate_task"] },
  { id: "negated-arabic-save", language: "ar", prompt: "لا تحفظ أي ملفات، اشرح الفكرة فقط", expectedTaskClass: "general", requiredTools: [], forbiddenTools: ["file.write", "delegate_task"] }
];

function tool(name: string, toolsets: ToolDefinition["toolsets"], riskClass: ToolDefinition["riskClass"] = "read-only-local"): ToolDefinition {
  return { name, toolsets, riskClass, description: name, inputSchema: { type: "object" }, progressLabel: name, maxResultSizeChars: 1_000 };
}

export function buildResearchCapabilityBaseline() {
  const skills = new SkillRegistry();
  for (const name of ["researcher", "research-discovery"]) {
    const path = fileURLToPath(new URL(`../../../skills/official/${name}/SKILL.md`, import.meta.url));
    skills.register(parseSkillFile(path, readFileSync(path, "utf8"), { sourceKind: "bundled" }));
  }
  const router = new IntentRouter({ skillRegistry: skills });
  const tools = [
    tool("web.search", ["web"], "read-only-network"), tool("web.extract", ["web"], "read-only-network"),
    tool("file.read", ["files"]), tool("file.write", ["files"], "workspace-write"),
    tool("delegate_task", ["core", "research", "coding"], "shared-state-mutation"),
    tool("skill.list", ["core", "research"]), tool("skill.read", ["core", "research"])
  ];
  const catalog = buildProviderToolSchemaCatalog({ tools });
  const cases = researchRoutingCases.map((testCase) => {
    const intent = router.route(testCase.prompt);
    const selection = selectProviderToolsForTurn({ catalog, intent, userText: testCase.prompt, selectedSkill: intent.primarySkill });
    const exposedTools = selection.initialTools.map((schema) => catalog.aliases.get(schema.function.name)!);
    const completionFloor = deriveExecutionCompletionFloor({ userText: testCase.prompt });
    const noExecutionOutcome = deriveExecutionFinalOutcome({
      completionFloor, toolExecutions: [], executionReceipts: [],
      providerExecution: { ok: true, attempts: [], toolCalls: [], fallbackUsed: false, response: { ok: true, provider: "baseline", model: "synthetic", content: "Here is the report." } }
    });
    return {
      id: testCase.id, language: testCase.language,
      expectedSkill: testCase.expectedSkill ?? null, selectedSkill: intent.primarySkill?.name ?? null,
      expectedTaskClass: testCase.expectedTaskClass, taskClass: intent.taskClass,
      requiredTools: testCase.requiredTools, exposedTools,
      missingTools: testCase.requiredTools.filter((name) => !exposedTools.includes(name)),
      forbiddenExposures: (testCase.forbiddenTools ?? []).filter((name) => exposedTools.includes(name)),
      schemaTokensRough: selection.initialTools.length === 0 ? 0 : estimateTextTokensRough(JSON.stringify(selection.initialTools)),
      expansionCandidates: selection.expansionCandidates.length,
      completionFloor,
      requiresExecution: testCase.requiresExecution === true,
      // Counterfactual function probe, not an observed live-model completion rate.
      falseCompleteWithoutExecution: testCase.requiresExecution === true && noExecutionOutcome.status === "completed"
    };
  });
  const summarize = (rows: typeof cases) => {
    const expectedSkills = rows.filter((row) => row.expectedSkill !== null);
    const selectedSkills = rows.filter((row) => row.selectedSkill !== null);
    const correct = rows.filter((row) => row.selectedSkill !== null && row.selectedSkill === row.expectedSkill).length;
    const required = rows.reduce((sum, row) => sum + row.requiredTools.length, 0);
    const missed = rows.reduce((sum, row) => sum + row.missingTools.length, 0);
    return {
      caseCount: rows.length,
      primarySkillPrecision: ratio(correct, selectedSkills.length),
      primarySkillRecall: ratio(correct, expectedSkills.length),
      requestedCapabilityRecall: ratio(required - missed, required),
      taskClassAccuracy: ratio(rows.filter((row) => row.taskClass === row.expectedTaskClass).length, rows.length),
      forbiddenExposureCount: rows.reduce((sum, row) => sum + row.forbiddenExposures.length, 0),
      falseCompleteWithoutExecution: ratio(rows.filter((row) => row.falseCompleteWithoutExecution).length, rows.filter((row) => row.requiresExecution).length)
    };
  };
  const tokens = cases.map((row) => row.schemaTokensRough).sort((a, b) => a - b);
  return {
    version: 1,
    scope: "Development probes: two real bundled skills, seven synthetic available tool definitions; no live model, no held-out claims.",
    omissions: "missingTools means available in this controlled catalog but not exposed; production omission reasons and persisted request requirements are not yet instrumented.",
    availableTools: tools.map((tool) => tool.name),
    metrics: summarize(cases),
    perLanguage: Object.fromEntries((["en", "ar", "mixed"] as const).map((language) => [language, summarize(cases.filter((row) => row.language === language))])),
    schemaTokensRough: { median: (tokens[Math.floor((tokens.length - 1) / 2)]! + tokens[Math.floor(tokens.length / 2)]!) / 2, p95: tokens[Math.ceil(tokens.length * 0.95) - 1]! },
    cases
  };
}

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}
