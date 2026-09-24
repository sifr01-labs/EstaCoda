import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";
import { deriveRequestRequirements, requiredRequestTools } from "./request-requirements.js";

describe("bounded explicit request requirements", () => {
  it("keeps explicit research tools in a compound file request and accepts bounded Arabic pronouns", () => {
    const requirements = deriveRequestRequirements("ابحث عن أبحاث الحرارة الجوفية واحفظها في heat.md");
    expect(requirements.fileOutput?.path).toBe("heat.md");
    expect(requiredRequestTools(requirements)).toEqual(expect.arrayContaining(["web.search", "web.extract", "file.write", "file.read"]));
    expect(deriveRequestRequirements("لا تحفظها في heat.md").fileOutput).toBeUndefined();
    expect(deriveRequestRequirements('اشرح "احفظها في heat.md"').fileOutput).toBeUndefined();
    expect(deriveRequestRequirements("Rerun this task using the research-discovery skill").skillReferences).toEqual(["research-discovery"]);
  });
  it("keeps mixed greetings empty without hiding an appended action", () => {
    const router = new IntentRouter({ skillRegistry: new SkillRegistry() });
    expect(router.route("hello مرحبا").taskClass).toBe("conversation");
    expect(router.route("hello مرحبا save report.md").taskClass).not.toBe("conversation");
  });
  it("extracts independent requirements and a user-turn reference", () => {
    expect(deriveRequestRequirements("Find recent arXiv papers. Use three subagents. Use the research skill. Save a markdown file at reports/Survey.md", "turn-1"))
      .toEqual({ originTurnId: "turn-1", skillReferences: ["research"], delegation: { count: 3 }, research: { domain: "literature", fresh: true }, fileOutput: { format: "markdown", path: "reports/Survey.md" }, issues: [] });
  });
  it.each(["prepare a markdown file", "export a text file", "save `report.md`", "create \"notes.txt\"", "احفظ التقرير في ملف Markdown", "جهز ملف نصي"])("recognizes file output: %s", (text) => {
    expect(deriveRequestRequirements(text).fileOutput).toBeDefined();
  });
  it.each(["Use 3 subagents", "استخدم ثلاثة وكلاء فرعيين", "استخدم ٣ وكلاء فرعيين"])("recognizes delegation: %s", (text) => {
    expect(deriveRequestRequirements(text).delegation?.count).toBe(3);
  });
  it.each([
    "Do not save files and use three subagents", "save.md", "\"save.md\"", "\"save report.md\"", "Never use 3 subagents", "Explain how to prepare a markdown file",
    "What if you use 3 subagents and save report.md?", "If we use 3 subagents, save report.md", "اشرح كيف احفظ ملف Markdown",
    'The tool says "use 3 subagents and save report.md"', "`use 3 subagents and save report.md`",
    "```text\nsave report.md\nuse 3 subagents\n```", "> use 3 subagents\n> save report.md", "لا احفظ ملف Markdown واستخدم ثلاثة وكلاء فرعيين"
  ])("does not turn examples, reported text, or negation into requirements: %s", (text) => {
    const result = deriveRequestRequirements(text);
    expect(result.delegation).toBeUndefined();
    expect(result.fileOutput).toBeUndefined();
  });
  it("keeps an affirmative request after a negated clause", () => {
    expect(deriveRequestRequirements("Do not use subagents, but save report.md").fileOutput?.path).toBe("report.md");
  });
  it("preserves a quoted filename containing spaces as an operand", () => {
    expect(deriveRequestRequirements('Save "reports/My Report.md"').fileOutput?.path).toBe("reports/My Report.md");
  });
  it("keeps ambiguous and unsafe targets explicitly unresolved", () => {
    expect(deriveRequestRequirements("Save a.md and b.md").issues).toContain("ambiguous-file-target");
    expect(deriveRequestRequirements("Save ../report.md")).toMatchObject({ fileOutput: { format: "markdown" }, issues: ["unsafe-file-target"] });
    expect(deriveRequestRequirements("Save /tmp/report.md").fileOutput?.path).toBeUndefined();
  });
  it("bounds analysis without partially interpreting oversized requests", () => {
    expect(deriveRequestRequirements(`Save report.md ${"x".repeat(32_768)}`)).toEqual({ skillReferences: [], issues: ["request-too-long"] });
  });
  it("does not derive requirements from expanded context", () => {
    const router = new IntentRouter({ skillRegistry: new SkillRegistry() });
    expect(router.route("File context: save report.md and use 3 subagents", { requestText: "Summarize @notes" }).requestRequirements)
      .toEqual({ skillReferences: [], issues: [] });
  });
});
