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

// PR 0 characterization, not desired acceptance behavior. Replace each known-gap
// assertion with the desired contract in its owning fix (PR 1 or PR 2).
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
  tool("skill.read", ["core", "research"])
];
const catalog = buildProviderToolSchemaCatalog({ tools: definitions });

function inspect(prompt: string) {
  const intent = router.route(prompt);
  const selection = selectProviderToolsForTurn({ catalog, intent, userText: prompt, selectedSkill: intent.primarySkill });
  return { intent, selection, names: selection.initialTools.map((schema) => catalog.aliases.get(schema.function.name)) };
}

describe("research routing baseline (known gaps, PR 0)", () => {
  it("recognizes research but misses the skill and explicitly requested delegation (PR 1)", () => {
    const { intent, names, selection } = inspect("Do deep research on the latest battery recycling methods and prepare a report. Use 3 subagents");
    expect(intent.taskClass).toBe("research");
    expect(intent.primarySkill).toBeUndefined();
    expect(catalog.entries.some(({ tool }) => tool.name === "delegate_task")).toBe(true);
    expect(names).toContain("web.extract");
    expect(names).not.toContain("delegate_task");
    expect(selection.expansionCandidates).toEqual([]);
  });

  it("cannot load an explicitly requested generic research skill on a rerun (PR 1/3)", () => {
    const { intent, names } = inspect("Rerun this task but this time use the research skill.");
    expect(intent.primarySkill).toBeUndefined();
    expect(names).not.toContain("skill.read");
  });

  it("selects literature discovery for a noncontiguous find-papers phrase (PR 1)", () => {
    expect(inspect("Find recent arXiv papers on battery recycling.").intent.primarySkill?.name).toBe("research-discovery");
  });

  it("reports a prepare-file request complete without a write or receipt (PR 1/4)", () => {
    const prompt = "Please prepare a markdown file";
    const completionFloor = deriveExecutionCompletionFloor({ userText: prompt });
    expect(inspect(prompt).names).not.toContain("file.write");
    expect(completionFloor).toBe("none");
    const outcome = deriveExecutionFinalOutcome({
      providerExecution: { ok: true, attempts: [], fallbackUsed: false, toolCalls: [], response: { ok: true, provider: "baseline", model: "fake", content: "Copy this Markdown into a file." } },
      toolExecutions: [], executionReceipts: [], completionFloor
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.confirmedActions).toEqual([]);
  });

  it("detects an Arabic save requirement while still hiding file.write (PR 1)", () => {
    const prompt = "احفظ التقرير في ملف Markdown";
    expect(deriveExecutionCompletionFloor({ userText: prompt })).toBe("mutation");
    expect(inspect(prompt).names).not.toContain("file.write");
  });

  it("classifies Arabic research (PR 1)", () => {
    expect(inspect("ابحث بعمق عن أحدث تقنيات البطاريات واستخدم ثلاثة وكلاء فرعيين").intent.taskClass).toBe("research");
  });

  it("drops a relevant tool after 100 catalog entries before routing can select it (PR 2)", () => {
    const tools = [...Array.from({ length: 100 }, (_, index) => tool(`read.${index}`, ["files"])), definitions[3]!];
    const capped = buildProviderToolSchemaCatalog({ tools });
    const intent = router.route("/researcher research battery recycling");
    const selection = selectProviderToolsForTurn({ catalog: capped, intent, selectedSkill: intent.primarySkill });
    expect(tools).toHaveLength(101);
    expect(capped.entries).toHaveLength(100);
    expect(capped.entries.some(({ tool }) => tool.name === "delegate_task")).toBe(false);
    expect(selection.initialTools.some((schema) => schema.function.name === "delegate_task")).toBe(false);
  });
});

describe("research routing baseline healthy controls", () => {
  it.each(["/researcher research battery recycling", "Use the researcher skill to research battery recycling"])("loads the named researcher: %s", (prompt) => {
    expect(inspect(prompt).intent.primarySkill?.name).toBe("researcher");
    expect(inspect(prompt).names).toContain("delegate_task");
  });

  it("keeps a greeting at zero exposed tools", () => {
    expect(inspect("hello").names).toEqual([]);
  });

  it("exposes file.write for recognized document creation", () => {
    expect(inspect("Write documentation for the project").names).toContain("file.write");
  });

  it("does not expose writes for a negated save request", () => {
    expect(inspect("Do not save any files; explain the topic").names).not.toContain("file.write");
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
