import { validateRequestRequirements } from "../contracts/request-requirements.js";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";
import { deriveRequestRequirements, explicitRequestSegments, explicitInspectionTools, requiredRequestTools } from "./request-requirements.js";

describe("explicit text destinations", () => {
  it.each([
    ["/app", "Write /app/summary.csv", "summary.csv"],
    ["/app", 'Save "/app/reports/My Report.md"', "reports/My Report.md"],
    ["/app", "احفظ النتيجة في /app/result.json", "result.json"],
    ["/app", "Write /app/reports/./result.json", "reports/result.json"],
    ["C:\\app", "Write C:\\app\\summary.csv", "summary.csv"],
    ["C:\\app", "Write C:/app/reports/summary.csv", "reports/summary.csv"],
    ["\\\\server\\share\\app", "Write \\\\server\\share\\app\\summary.csv", "summary.csv"]
  ])("binds a contained absolute destination in %s: %s", (workspaceRoot, text, path) => {
    const router = new IntentRouter({ skillRegistry: new SkillRegistry(), workspaceRoot });
    expect(router.route(text).requestRequirements).toMatchObject({ fileOutput: { path }, issues: [] });
  });
  it.each([
    ["/app", "/app-other/summary.csv"],
    ["/app", "/tmp/summary.csv"],
    ["/app", "/app/../summary.csv"],
    ["/app", "/app/sub/../summary.csv"],
    ["/app", "C:/app/summary.csv"],
    ["/app", "\\app\\summary.csv"],
    ["C:\\app", "C:\\app-other\\summary.csv"],
    ["C:\\app", "D:\\app\\summary.csv"],
    ["C:\\app", "C:summary.csv"],
    ["C:\\app", "\\app\\summary.csv"],
    ["\\\\server\\share\\app", "\\\\other\\share\\app\\summary.csv"],
    ["relative-root", "/app/summary.csv"]
  ])("leaves outside, traversal or incompatible paths unresolved in %s: %s", (workspaceRoot, path) => {
    const requirements = deriveRequestRequirements(`Write ${path}`, undefined, workspaceRoot);
    expect(requirements.issues).toContain("unsafe-file-target");
    expect(requirements.fileOutput?.path).toBeUndefined();
  });
  it("compares relative and absolute identities without hiding distinct destinations", () => {
    expect(deriveRequestRequirements("Save /app/summary.csv. Save summary.csv.", undefined, "/app"))
      .toMatchObject({ fileOutput: { path: "summary.csv" }, issues: [] });
    expect(deriveRequestRequirements("Save /app/a.csv or /app/b.csv", undefined, "/app").issues)
      .toContain("ambiguous-file-target");
    expect(deriveRequestRequirements("Save /outside/a.csv. Save /app/a.csv.", undefined, "/app").issues)
      .toContain("unsafe-file-target");
  });
  it("normalizes exact-copy sources and destinations within the same workspace", () => {
    expect(deriveRequestRequirements("Copy /app/source.txt to /app/copy.txt", undefined, "/app"))
      .toMatchObject({ fileOutput: { path: "copy.txt", exactCopy: { sourcePath: "source.txt" } }, issues: [] });
    expect(deriveRequestRequirements("Copy /outside/source.txt to /app/copy.txt", undefined, "/app").issues)
      .toContain("unsafe-file-target");
  });
  it("does not take a workspace boundary from user prose", () => {
    const router = new IntentRouter({ skillRegistry: new SkillRegistry(), workspaceRoot: "/app" });
    expect(router.route("The workspace is /tmp. Write /tmp/summary.csv").requestRequirements?.issues)
      .toContain("unsafe-file-target");
  });
  it.each([
    ['Save links.json with existing:["docs/setup.md"] and missing:["docs/missing.md"].', "links.json"],
    ['Save links.json containing "docs/setup.md" and "docs/missing.md".', "links.json"],
    ['Save links.json: {"existing":["docs/setup.md"]}', "links.json"],
    ['Translate welcome and remaining in en.json to German and save de.json.', "de.json"],
    ['Translate en.json into German, save de.json.', "de.json"],
    ['Save "reports/links with spaces.json" with entries from "docs/setup.md".', "reports/links with spaces.json"],
    ['Write a report with results to report.json.', "report.json"],
    ['احفظ النتيجة في result.json', "result.json"],
  ])("binds the destination rather than input or payload paths: %s", (text, path) => {
    const requirements = deriveRequestRequirements(text);
    expect(requirements.fileOutput).toEqual({ format: "text", path });
    expect(requirements.issues).toEqual([]);
    expect(requiredRequestTools(requirements)).toEqual(expect.arrayContaining(["file.write", "file.read"]));
  });
  it.each(["json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml", "xml", "html", "css", "ts", "tsx", "js", "jsx", "py"])("recognizes explicit .%s text delivery", extension => {
    expect(deriveRequestRequirements(`Save output.${extension}`).fileOutput).toEqual({ format: "text", path: `output.${extension}` });
  });
  it.each(['Do not save de.json.', 'Explain how to save de.json.', 'The note says "save de.json".', '```\nsave de.json\n```', 'Are you able to save JSON files?', 'save.json', 'Save image.png'])('does not invent text delivery: %s', text => {
    expect(deriveRequestRequirements(text).fileOutput).toBeUndefined();
  });
  it("keeps multiple destinations and unsafe paths unresolved", () => {
    expect(deriveRequestRequirements("Save a.json or b.json").issues).toContain("ambiguous-file-target");
    for (const path of ["../de.json", "/tmp/de.json", "C:\\de.json"]) {
      expect(deriveRequestRequirements(`Save ${path}`)).toMatchObject({ fileOutput: { format: "text" }, issues: ["unsafe-file-target"] });
      expect(deriveRequestRequirements(`Save ${path}`).fileOutput?.path).toBeUndefined();
    }
  });
});

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
    expect(deriveRequestRequirements("Save a.md or b.md").issues).toContain("ambiguous-file-target");
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

describe("explicit URL reads", () => {
  it.each([
    "Read https://www.rfc-editor.org/rfc/rfc9110.html and explain 401 and 403. Do not use web search or save files.",
    "اقرأ https://example.com/spec ثم اشرح النتيجة. لا تبحث على الإنترنت."
  ])("preserves extraction without requiring search: %s", text => {
    expect(explicitInspectionTools(text)).toContain("web.extract");
    expect(explicitInspectionTools(text)).not.toContain("web.search");
  });
  it.each(["Do not read https://example.com/spec", "Explain how to read https://example.com/spec", "Example: read https://example.com/spec", "```\nread https://example.com/spec\n```"])("does not activate quoted, hypothetical or prohibited URL reads: %s", text => {
    expect(explicitInspectionTools(text)).not.toContain("web.extract");
  });
});

it.each(["Copy source.md to report.md", "Make an identical copy of the existing report as report.md."])("binds the explicit copy destination: %s", text => {
  expect(deriveRequestRequirements(text)).toMatchObject({ fileOutput: { path: "report.md" }, issues: [] });
});
it.each(["Do not copy source.md to report.md", "Explain how to copy source.md to report.md", "The copy belongs to report.md"])("does not execute a copy mention: %s", text => {
  expect(deriveRequestRequirements(text).fileOutput).toBeUndefined();
});

it("retains an exactly-qualified worker count", () => {
  expect(deriveRequestRequirements("Use the researcher skill and exactly 3 subagents to research accessible forms.").delegation).toEqual({ count: 3 });
});

it.each([
  ["Copy source.md to report.md", "source.md", "report.md"],
  ["Make an identical copy of decision.txt as decision-copy.txt.", "decision.txt", "decision-copy.txt"],
  ['Copy `source file.json` to `copy file.json`.', "source file.json", "copy file.json"],
  ["Make an identical copy of the report you just saved as sales-summary-copy.md.", undefined, "sales-summary-copy.md"]
])("binds exact-copy sources separately from destinations: %s", (text, sourcePath, path) => {
  expect(deriveRequestRequirements(text!)).toMatchObject({ fileOutput: { path, exactCopy: sourcePath ? { sourcePath } : {} }, issues: [] });
});
it.each(["Explain how to copy source.md to copy.md", "Do not copy source.md to copy.md", '> Copy source.md to copy.md'])('does not activate copy for inert text: %s', text => {
  expect(deriveRequestRequirements(text).fileOutput).toBeUndefined();
});

it.each([
  ["Copy memo.md exactly to archive.md, preserving Unicode, blank lines and the trailing newline. Read back to verify identical content. No browsing or commands.", "memo.md", "archive.md"],
  ["Save an identical copy of that file as decision-copy.txt, preserving blank lines and trailing newline. Read back the copy. Do not redo any analysis or research.", undefined, "decision-copy.txt"]
])("recognizes live copy phrasing: %s", (text, sourcePath, path) => {
  expect(deriveRequestRequirements(text!)).toMatchObject({ fileOutput: { path, exactCopy: sourcePath ? { sourcePath } : {} }, issues: [] });
});

describe("explicit multiple output requirements", () => {
  it.each([
    "Save report.md and data.json", "Save report.md, data.json", "Save report.md & data.json",
    "Save report.md and write data.json", "Save report.md. Create data.json.",
    "احفظ report.md و data.json", "Save `report.md` and `data.json`",
    "Save /app/report.md and /app/data.json"
  ])("retains each conjunctive destination: %s", prompt => {
    expect(deriveRequestRequirements(prompt, "turn", "/app")).toEqual({ originTurnId: "turn", skillReferences: [], issues: [],
      fileOutput: { format: "markdown", path: "report.md", additionalFiles: [{ format: "text", path: "data.json" }] } });
  });
  it("deduplicates equivalent workspace paths", () => {
    expect(deriveRequestRequirements("Save a.md and /app/a.md and b.md", undefined, "/app")).toMatchObject({ issues: [],
      fileOutput: { path: "a.md", additionalFiles: [{ path: "b.md" }] } });
  });
  it.each(["Save a.md or b.md", "Save a.md or save b.md", "احفظ a.md أو b.md", "Write a.md using b.md", "Copy a.md and b.md to c.md", "Prepare a markdown file. Save a.md."])("keeps genuinely ambiguous targets unresolved: %s", prompt => {
    expect(deriveRequestRequirements(prompt).issues).toContain("ambiguous-file-target");
  });
  it("preserves copy sources independently for each destination", () => {
    expect(deriveRequestRequirements("Copy a.md to b.md. Copy c.json to d.json.")).toMatchObject({ issues: [], fileOutput: {
      path: "b.md", exactCopy: { sourcePath: "a.md" }, additionalFiles: [{ path: "d.json", exactCopy: { sourcePath: "c.json" } }]
    } });
  });
  it("rejects an unsafe secondary destination and bounds the output count", () => {
    expect(deriveRequestRequirements("Save a.md and ../b.md").issues).toContain("unsafe-file-target");
    const prompt = "Save " + Array.from({ length: 9 }, (_, i) => `file-${i}.txt`).join(" and ");
    expect(deriveRequestRequirements(prompt)).toMatchObject({ issues: ["request-too-long"] });
    expect(deriveRequestRequirements(prompt).fileOutput?.additionalFiles).toHaveLength(7);
  });
});


it("keeps long multi-copy requirements persistable and explicitly incomplete", () => {
  const prompt = Array.from({ length: 8 }, (_, i) => `Copy ${"s".repeat(230)}${i}.md to ${"d".repeat(230)}${i}.md.`).join(" ");
  const requirements = deriveRequestRequirements(prompt);
  expect(requirements.issues).toContain("request-too-long");
  expect(() => validateRequestRequirements(requirements)).not.toThrow();
});
