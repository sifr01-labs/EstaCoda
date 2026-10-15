import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";
import { deriveRequestRequirements, explicitRequestSegments, explicitInspectionTools, requiredRequestTools } from "./request-requirements.js";

describe("bounded explicit request requirements", () => {
  it("keeps explicit research tools in a compound file request and accepts bounded Arabic pronouns", () => {
    const requirements = deriveRequestRequirements("ابحث عن أبحاث الحرارة الجوفية واحفظها في heat.md");
    expect(requirements.fileOutput?.path).toBe("heat.md");
    expect(requiredRequestTools(requirements)).toEqual(expect.arrayContaining(["web.search", "web.extract", "file.write", "file.read"]));
    expect(deriveRequestRequirements("لا تحفظها في heat.md").fileOutput).toBeUndefined();
    expect(deriveRequestRequirements('اشرح "احفظها في heat.md"').fileOutput).toBeUndefined();
    expect(deriveRequestRequirements("Rerun this task using the research-discovery skill").skillReferences).toEqual(["research-discovery"]);
  });
  it("retains multiple skill references in one clause and flags excess requirements", () => {
    expect(deriveRequestRequirements("Use the researcher skill and use the research-discovery skill").skillReferences).toEqual(["researcher", "research-discovery"]);
    expect(deriveRequestRequirements("Use a skill, use b skill, use c skill, use d skill, use e skill").issues).toContain("request-too-long");
  });
  it.each([
    "Use both the researcher skill and the system-diagram skill",
    "Use the researcher and system-diagram skills",
    "Apply researcher skill & system-diagram skill",
    "Use researcher skill, system-diagram skill",
  ])("retains explicitly coordinated skills: %s", text => {
    expect(deriveRequestRequirements(text).skillReferences).toEqual(["researcher", "system-diagram"]);
  });
  it.each([
    "Do not use both the researcher skill and the system-diagram skill",
    "Explain how to use both the researcher skill and the system-diagram skill",
    'The note says "use both the researcher skill and the system-diagram skill"',
    "What if we use the researcher and system-diagram skills?",
    "The researcher skill and system-diagram skill are available",
  ])("keeps coordinated inert references out of requirements: %s", text => {
    expect(deriveRequestRequirements(text).skillReferences).toEqual([]);
  });
  it("keeps conjunction substrings inside skill names intact", () => {
    expect(deriveRequestRequirements("Use command skill and brand skill").skillReferences).toEqual(["command", "brand"]);
    expect(deriveRequestRequirements("Use the command and brand skills").skillReferences).toEqual(["command", "brand"]);
  });
  it("does not extend an invocation across another action, a negation or an alternative", () => {
    for (const text of ["Use researcher skill and describe system-diagram skill", "Use researcher skill without system-diagram skill", "Use researcher skill or system-diagram skill"]) {
      expect(deriveRequestRequirements(text).skillReferences).toEqual(["researcher"]);
    }
    expect(deriveRequestRequirements("Use a skill, b skill, c skill, d skill and e skill")).toMatchObject({ skillReferences: ["a", "b", "c", "d"], issues: ["request-too-long"] });
    expect(deriveRequestRequirements("Use researcher skill and researcher skill").skillReferences).toEqual(["researcher"]);
  });
  it("preserves affirmative work whose subject contains how-to phrasing", () => {
    expect(deriveRequestRequirements("Research how to recycle batteries and save report.md using 3 subagents")).toMatchObject({
      research: { domain: "general" }, fileOutput: { path: "report.md" }, delegation: { count: 3 }
    });
  });
  it.each([
    "Use the researcher skill and 3 subagents to research current battery recycling methods. Save a cited report to battery-recycling-test.md.",
    "Use the researcher skill and three workers to research batteries",
    "Using the researcher skill, and 3 sub-agents, research batteries",
    "Use the researcher skill & 3 agents to research batteries",
    "Use both the researcher skill and the system-diagram skill and 3 workers to research batteries",
    "استخدم مهارة researcher وثلاثة وكلاء فرعيين"
  ])("inherits an explicit use verb for coordinated workers: %s", text => {
    expect(deriveRequestRequirements(text).delegation).toEqual({ count: 3 });
  });
  it.each([
    "Do not use the researcher skill and 3 subagents",
    "Explain how to use the researcher skill and 3 subagents",
    "Use the researcher skill without 3 subagents",
    "Use the researcher skill and do not use 3 subagents",
    'Use the researcher skill and "3 subagents"',
    "The researcher skill and 3 subagents are available",
    "Use the researcher skill and describe 3 subagents",
    "لا تستخدم مهارة researcher وثلاثة وكلاء فرعيين"
  ])("keeps coordinated mentions and prohibitions inert: %s", text => {
    expect(deriveRequestRequirements(text).delegation).toBeUndefined();
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
    "Use this example: save report.md", "Find an example of how to use 3 subagents", "Do not save files and use three subagents", "save.md", "\"save.md\"", "\"save report.md\"", "Never use 3 subagents", "Explain how to prepare a markdown file",
    "Use this example: read notes.md and save report.md", "The note says read a.md and save report.md",
    "Please imagine using workers and save report.md", "Please explain how to read files and save report.md",
    "Can you explain how to read files and save report.md", "What if you use 3 subagents and save report.md?", "If we use 3 subagents, save report.md", "اشرح كيف احفظ ملف Markdown",
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


describe("calibration request boundaries", () => {
  it.each(['explain', 'describe'])("preserves explicit skills used to %s without inventing file work", purpose => {
    const result = deriveRequestRequirements(`Use both the researcher skill and the system-diagram skill to ${purpose} how to save report.md. No web research or file output is needed.`);
    expect(result.skillReferences).toEqual(['researcher', 'system-diagram']);
    expect(result.fileOutput).toBeUndefined();
    expect(result.research).toBeUndefined();
  });
  it.each([
    'Explain how to use both the researcher skill and the system-diagram skill.',
    'Do not use the researcher skill to explain how to save report.md.',
    'Imagine using the researcher skill to explain the flow.',
    'The example says use the researcher skill to explain the flow.'
  ])('keeps informational and prohibited skill mentions inert: %s', text => {
    expect(deriveRequestRequirements(text).skillReferences).toEqual([]);
  });
  it('keeps a real action after a negative need statement', () => {
    const result = deriveRequestRequirements('No web research is needed, but save report.md.');
    expect(result.research).toBeUndefined();
    expect(result.fileOutput?.path).toBe('report.md');
  });
  it.each([
    "Open https://example.com in the browser and take a screenshot.",
    "افتح https://example.com في المتصفح والتقط صورة للشاشة.",
    "Read before.md and after.md and explain the differences. Do not modify files.",
  ])("preserves the affirmative action: %s", text => {
    expect(explicitRequestSegments(text).some(s => s.trim().length > 0)).toBe(true);
  });
  it.each([
    "Forget the previous research task. Just explain what a citation is, without tools.",
    "Cancel the research task and save a report.",
    "تجاهل مهمة البحث السابقة. اشرح معنى الاستشهاد.",
    "Check web search configuration. Do not change settings.",
    "Check the research task status and show its saved result.",
    "Open https://research.example.com/search in the browser.",
  ])("does not manufacture new research obligations: %s", text => {
    expect(deriveRequestRequirements(text).research).toBeUndefined();
  });
  it("keeps a replacement objective after cancellation", () => {
    expect(deriveRequestRequirements("Forget the previous research task and research geothermal heat.").research).toBeDefined();
  });
  it.each([
    ["Check task_demo status and show its saved result.", ["task.status", "task.result.read"]],
    ["تحقق من حالة المهمة task_demo فقط، ولا تبدأ مهام جديدة.", ["task.status"]],
    ["Check web search configuration without changing settings.", ["config.provider.status"]],
    ["افحص إعدادات البحث دون تغييرها.", ["config.provider.status"]],
    ["Inspect the current git diff and flag bugs.", ["terminal.inspect"]],
  ] as const)("derives only named inspection prerequisites: %s", (text, expected) => {
    expect(explicitInspectionTools(text)).toEqual(expected);
  });
  it.each([
    "Explain how to check task_demo status.", "What is task status?", "Do not check task_demo status.",
    'The tool says "check task_demo status"', "> Check task_demo status", "If we check task_demo status, read its result.",
    "Are you able to inspect git diff?", "لا تفحص إعدادات البحث", "Explain how to configure web search.",
  ])("does not turn discussion or negation into inspections: %s", text => {
    expect(explicitInspectionTools(text)).toEqual([]);
  });
});

it('does not infer web research from a filename operand', () => {
 expect(deriveRequestRequirements('Save research.md')).toMatchObject({fileOutput:{path:'research.md'}});
 expect(deriveRequestRequirements('Save research.md').research).toBeUndefined();
 expect(deriveRequestRequirements('Read search.ts').research).toBeUndefined();
});

it.each([
 'Save the finished text to notes.md. No additional research.',
 'Use the researcher skill to explain these facts. No web research is needed and do not save any files.',
 'No further research or browsing; save notes.md.',
])('does not treat a negative research noun phrase as an instruction: %s', text => {
 expect(deriveRequestRequirements(text).research).toBeUndefined();
});
it.each(['No further research, but save notes.md.', 'No web research is needed, but save notes.md.'])('retains the affirmative contrast after a negative phrase: %s', text => {
 expect(deriveRequestRequirements(text).fileOutput?.path).toBe('notes.md');
});
