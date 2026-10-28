import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../contracts/tool.js";
import { parseSkillFile } from "../skills/skill-loader.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { buildProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import { IntentRouter } from "./intent-router.js";
import { deriveExecutionCompletionFloor, deriveExecutionFinalOutcome } from "./execution-outcome.js";
import { selectProviderToolsForTurn } from "./provider-tool-narrowing.js";

// PR 0 cases migrated to PR 1 and PR 2 desired behavior.
// Synthetic requests preserve the failure shape without embedding a private chat.
const registry = new SkillRegistry();
for (const name of ["researcher", "research-discovery"]) {
  const path = fileURLToPath(new URL(`../../skills/official/${name}/SKILL.md`, import.meta.url));
  registry.register(parseSkillFile(path, readFileSync(path, "utf8"), { sourceKind: "bundled" }));
}
const router = new IntentRouter({ skillRegistry: registry });

function tool(name: string, toolsets: ToolDefinition["toolsets"], riskClass: ToolDefinition["riskClass"] = "read-only-local"): ToolDefinition {
  return { name, toolsets, riskClass, description: name, inputSchema: { type: "object" }, progressLabel: name, maxResultSizeChars: 1_000 };
}

const definitions = [
  tool("web.extract", ["web"], "read-only-network"),
  tool("file.read", ["files"]),
  tool("file.write", ["files"], "workspace-write"),
  tool("delegate_task", ["core", "research", "coding"], "shared-state-mutation"),
  tool("skill.list", ["core", "research"]),
  tool("skill.read", ["core", "research"]),
  tool("task.status", ["core"]),
  tool("task.result.read", ["core"]),
  tool("file.patch", ["files"], "workspace-write"),
  tool("terminal.run", ["shell-write"], "workspace-write"),
  tool("unrelated.mutate", ["core"], "shared-state-mutation")
];
const catalog = buildProviderToolSchemaCatalog({ tools: definitions });

function inspect(prompt: string) {
  const intent = router.route(prompt);
  const selection = selectProviderToolsForTurn({ catalog, intent, userText: prompt, selectedSkill: intent.primarySkill });
  return { intent, selection, names: selection.initialTools.map((schema) => catalog.aliases.get(schema.function.name)) };
}

describe("research routing regression (PR 1 and PR 2)", () => {
  it("selects report discovery and exposes explicit research delegation (PR 1)", () => {
    const { intent, names, selection } = inspect("Do deep research on the latest battery recycling methods and prepare a report. Use 3 subagents");
    expect(intent.taskClass).toBe("research");
    expect(intent.primarySkill?.name).toBe("research-discovery");
    expect(catalog.entries.some(({ tool }) => tool.name === "delegate_task")).toBe(true);
    expect(names).toContain("web.extract");
    expect(names).toContain("delegate_task");
    expect(selection.expansionCandidates).toEqual([]);
  });

  it("exposes skill inspection for an unresolved generic research request (PR 1)", () => {
    const { intent, names } = inspect("Rerun this task but this time use the research skill.");
    expect(intent.primarySkill).toBeUndefined();
    expect(names).toContain("skill.read");
  });

  it("selects literature discovery for a noncontiguous find-papers phrase (PR 1)", () => {
    expect(inspect("Find recent arXiv papers on battery recycling.").intent.primarySkill?.name).toBe("research-discovery");
  });

  it("blocks a prepare-file request without a write or receipt (PR 1)", () => {
    const prompt = "Please prepare a markdown file";
    const completionFloor = deriveExecutionCompletionFloor({ userText: prompt });
    expect(inspect(prompt).names).toContain("file.write");
    expect(completionFloor).toBe("mutation");
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: { ok: true, attempts: [], fallbackUsed: false, toolCalls: [], response: { ok: true, provider: "baseline", model: "fake", content: "Copy this Markdown into a file." } },
      toolExecutions: [], executionReceipts: [], completionFloor
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.confirmedActions).toEqual([]);
  });

  it("exposes file.write for an Arabic save requirement (PR 1)", () => {
    const prompt = "احفظ التقرير في ملف Markdown";
    expect(deriveExecutionCompletionFloor({ userText: prompt })).toBe("mutation");
    expect(inspect(prompt).names).toContain("file.write");
  });

  it("classifies Arabic research (PR 1)", () => {
    expect(inspect("ابحث بعمق عن أحدث تقنيات البطاريات واستخدم ثلاثة وكلاء فرعيين").intent.taskClass).toBe("research");
  });

  it("selects a relevant tool after 100 catalog entries (PR 2)", () => {
    const tools = [...Array.from({ length: 100 }, (_, index) => tool(`read.${index}`, ["test"])), definitions[3]!];
    const capped = buildProviderToolSchemaCatalog({ tools });
    const intent = router.route("/researcher research battery recycling");
    const selection = selectProviderToolsForTurn({ catalog: capped, intent, selectedSkill: intent.primarySkill });
    expect(tools).toHaveLength(101);
    expect(capped.entries).toHaveLength(101);
    expect(capped.entries.some(({ tool }) => tool.name === "delegate_task")).toBe(true);
    expect(selection.initialTools.some((schema) => schema.function.name === "delegate_task")).toBe(true);
  });
});

describe("research routing baseline healthy controls", () => {
  it.each(["/researcher research battery recycling", "Use the researcher skill to research battery recycling"])("loads the named researcher: %s", (prompt) => {
    expect(inspect(prompt).intent.primarySkill?.name).toBe("researcher");
    expect(inspect(prompt).names).toContain("delegate_task");
  });

  it("keeps the core working set available for a greeting", () => {
    expect(inspect("hello").names).toEqual(["file.read", "file.write", "skill.list", "skill.read", "file.patch", "terminal.run"]);
  });

  it("exposes file.write for recognized document creation", () => {
    expect(inspect("Write documentation for the project").names).toContain("file.write");
  });

  it("does not infer a file output obligation from a negated save request", () => {
    expect(inspect("Do not save any files; explain the topic").intent.requestRequirements?.fileOutput).toBeUndefined();
  });
});

describe("explicit research skill resolution", () => {
  it("returns candidates for the ambiguous generic research skill", () => {
    expect(inspect("Use the research skill").intent.skillRequests).toEqual([{ reference: "research", status: "ambiguous", candidates: ["researcher", "research-discovery"] }]);
  });
  it.each([
    ["Use the research skill for this literature review", "research-discovery"],
    ["Use the research skill to draft a paper", "researcher"],
    ["Use the RESEARCHER skill to find recent papers", "researcher"],
    ["ابحث عن أحدث أوراق البطاريات", "research-discovery"]
  ])("resolves %s", (prompt, name) => {
    expect(inspect(prompt).intent.primarySkill?.name).toBe(name);
  });
  it.each(["Do not use the researcher skill", "Explain the researcher skill", "What if we use the researcher skill?", "Research the market for new shoes"])("avoids unintended academic workflow: %s", (prompt) => {
    expect(inspect(prompt).intent.primarySkill).toBeUndefined();
  });
});

describe("exact requested tools stay within the session catalog", () => {
  it("adds delegation companions without unrelated core tools", () => {
    const { names } = inspect("Use 3 subagents to investigate battery recycling");
    expect(names).toEqual(expect.arrayContaining(["delegate_task", "task.status", "task.result.read"]));
    expect(names).not.toContain("unrelated.mutate");
    expect(names).toContain("terminal.run");
  });
  it.each(["Prepare report.md", "Find papers and save report.md", "احفظ التقرير في ملف Markdown"])("exposes file and shell tools: %s", (prompt) => {
    const { names } = inspect(prompt);
    expect(names).toEqual(expect.arrayContaining(["file.write", "file.patch", "file.read"]));
    expect(names).toContain("terminal.run");
  });
  it("cannot add a delegation capability excluded from a child/session catalog", () => {
    const filtered = buildProviderToolSchemaCatalog({ tools: definitions.filter((entry) => entry.name !== "delegate_task") });
    const intent = router.route("Use three subagents");
    expect(selectProviderToolsForTurn({ catalog: filtered, intent }).initialTools.some((tool) => tool.function.name === "delegate_task")).toBe(false);
  });
  it.each(["Do not use 3 subagents", "Explain how to use 3 subagents", "What if we save report.md and use 3 subagents?", "لا تستخدم ثلاثة وكلاء فرعيين"])("keeps negatives and hypothetical requests bounded: %s", (prompt) => {
    const { names } = inspect(prompt);
    expect(names).not.toContain("delegate_task");
    expect(inspect(prompt).intent.requestRequirements?.fileOutput).toBeUndefined();
  });
});

// Required capabilities must survive a saturated catalog under natural phrasing.
it("reserves delegation and delivery tools for coordinated explicit requests", () => {
  const prompt = "Use the researcher skill and 3 subagents to research current battery recycling methods. Save a cited report to report.md.";
  const crowded = buildProviderToolSchemaCatalog({ tools: [
    ...Array.from({ length: 120 }, (_, index) => tool(`optional.${index}`, ["core"])), ...definitions,
    tool("web.search", ["web"], "read-only-network")
  ] });
  const intent = router.route(prompt);
  const selected = selectProviderToolsForTurn({ catalog: crowded, intent, userText: prompt, selectedSkill: intent.primarySkill });
  expect(intent.requestRequirements?.delegation?.count).toBe(3);
  expect(selected.initialTools.length).toBeLessThanOrEqual(100);
  expect(selected.initialTools.some(schema => crowded.aliases.get(schema.function.name)?.startsWith("optional."))).toBe(false);
  expect(selected.initialTools.map(schema => crowded.aliases.get(schema.function.name))).toEqual(expect.arrayContaining([
    "delegate_task", "task.status", "task.result.read", "file.write", "file.read", "web.search", "skill.read"
  ]));
});
