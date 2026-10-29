import { continueRequestRequirements } from "./request-requirements.js";
import { validateRequestRequirements, requiresAnyFileContentVerification } from "../contracts/request-requirements.js";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";
import { deriveRequestRequirements, explicitRequestSegments, explicitInspectionTools, requiredRequestTools } from "./request-requirements.js";


describe("explicit output directories", () => {
  it.each([
    "From attendance.json create attendees.json sorted unique attended names, absent.json sorted absent names, and ATTENDANCE.md listing counts.",
    "Write attendees.json comparing old.json and new.json."
  ])("does not turn uncertain descriptive operands into hard requirements: %s", text => {
    const result = deriveRequestRequirements(text);
    expect(result.issues).toEqual([]);
    expect(result.fileOutput?.path).toBe("attendees.json");
    expect(result.fileOutput?.additionalFiles).toBeUndefined();
    expect(validateRequestRequirements(result)).toEqual(result);
  });
  it("keeps definite list prefixes and separately stated output actions", () => {
    expect(deriveRequestRequirements("Write a.json and b.json comparing source.json. Write summary.md."))
      .toMatchObject({ issues: [], fileOutput: { path: "a.json", additionalFiles: [{ path: "b.json" }, { path: "summary.md" }] } });
  });
  it("binds multiple bare outputs to the declared document root", () => {
    expect(deriveRequestRequirements("Create the document root directory `/var/www/html` if it doesn't exist. Create a simple index.html file in the document root with content. Create a custom 404.html page with content.", undefined, "/"))
      .toMatchObject({ issues: [], fileOutput: { path: "var/www/html/index.html", additionalFiles: [{ path: "var/www/html/404.html" }] } });
  });
  it.each(["Create output directory `/app/reports`. Write result.json", "Write result.json in `/app/reports`", "Create output directory ./reports. Write result.json"])("resolves %s inside the actual workspace", text => {
    expect(deriveRequestRequirements(text, undefined, "/app")).toMatchObject({ issues: [], fileOutput: { path: "reports/result.json" } });
  });
  it("leaves conflicting declarations unresolved", () => {
    expect(deriveRequestRequirements("Create output directory /app/a. Create output directory /app/b. Write result.json", undefined, "/app").issues).toContain("ambiguous-file-target");
  });
  it.each(["/elsewhere", "/app/../outside"])("does not authorize an outside directory %s", path => {
    expect(deriveRequestRequirements(`Create output directory ${path}. Write result.json`, undefined, "/app").issues).toContain("unsafe-file-target");
  });
  it.each(['Example: create output directory /elsewhere.', 'Do not create output directory /elsewhere.', '> Create output directory /elsewhere.\n', '"Create output directory /elsewhere."'])('does not use inert directory declarations: %s', prefix => {
    expect(deriveRequestRequirements(`${prefix}\nWrite result.json`, undefined, "/app")).toMatchObject({ issues: [], fileOutput: { path: "result.json" } });
  });
  it("keeps an explicitly pathed destination and exact-copy source independent", () => {
    expect(deriveRequestRequirements("Create output directory /app/reports. Copy source.json to result.json. Write other/final.json", undefined, "/app"))
      .toMatchObject({ issues: [], fileOutput: { path: "reports/result.json", exactCopy: { sourcePath: "source.json" }, additionalFiles: [{ path: "other/final.json" }] } });
  });
});

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
    expect(requirements.fileOutput).toEqual({ format: "text", verification: "execution", path, ...(!path.includes("/") ? { directoryUnspecified: true } : {}) });
    expect(requirements.issues).toEqual([]);
    expect(requiredRequestTools(requirements)).toEqual(expect.arrayContaining(["file.write", "file.read"]));
  });
  it.each(["json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml", "xml", "html", "css", "ts", "tsx", "js", "jsx", "py"])("recognizes explicit .%s text delivery", extension => {
    expect(deriveRequestRequirements(`Save output.${extension}`).fileOutput).toEqual({ format: "text", verification: "execution", path: `output.${extension}`, directoryUnspecified: true });
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
      fileOutput: { format: "markdown", verification: "execution", path: "report.md", ...(!prompt.includes("/app/") ? { directoryUnspecified: true } : {}), additionalFiles: [{ format: "text", verification: "execution", path: "data.json", ...(!prompt.includes("/app/") ? { directoryUnspecified: true } : {}) }] } });
  });
  it("deduplicates equivalent workspace paths", () => {
    expect(deriveRequestRequirements("Save a.md and /app/a.md and b.md", undefined, "/app")).toMatchObject({ issues: [],
      fileOutput: { path: "a.md", additionalFiles: [{ path: "b.md" }] } });
  });
  it.each(["Save a.md or b.md", "Save a.md or save b.md", "احفظ a.md أو b.md", "Copy a.md and b.md to c.md", "Prepare a markdown file. Save a.md."])("keeps genuinely ambiguous targets unresolved: %s", prompt => {
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
    expect(deriveRequestRequirements(prompt)).toMatchObject({ issues: ["file-output-limit"] });
    expect(deriveRequestRequirements(prompt).fileOutput?.additionalFiles).toHaveLength(7);
  });
});


it("keeps long multi-copy requirements persistable and explicitly incomplete", () => {
  const prompt = Array.from({ length: 8 }, (_, i) => `Copy ${"s".repeat(230)}${i}.md to ${"d".repeat(230)}${i}.md.`).join(" ");
  const requirements = deriveRequestRequirements(prompt);
  expect(requirements.issues).toContain("file-output-limit");
  expect(() => validateRequestRequirements(requirements)).not.toThrow();
});


describe("completion target parsing regressions", () => {
  it.each([
    ["Write a.md using b.md", "a.md"],
    ["Write me data.comp that's compressed such that running cat data.comp gives data.txt.", "data.comp"],
    ["Write a script, named jump_analyzer.py, and place it in `/app/jump_analyzer.py`.", "jump_analyzer.py"],
    ["Save your implementation in a file named \"/app/ars.R\"", "ars.R"],
    ["Save report.toml in `/app`", "report.toml"]
  ])("binds actual destination: %s", (prompt, path) => {
    expect(deriveRequestRequirements(prompt, "turn", "/app")).toEqual({ originTurnId: "turn", skillReferences: [], issues: [], fileOutput: { format: path.endsWith(".md") ? "markdown" : path === "data.comp" ? "artifact" : "text", verification: "execution", path, ...(["a.md", "data.comp"].includes(path) ? { directoryUnspecified: true } : {}) } });
  });
  it("retains an explicit choice as one obligation alongside required outputs", () => {
    const requirements = deriveRequestRequirements('Save ars.R. Generate at least one sample file named "/app/normal_samples.txt" or "/app/exponential_samples.txt" containing samples.', "turn", "/app");
    expect(requirements).toMatchObject({ issues: [], fileOutput: { path: "ars.R", additionalFiles: [{ path: "normal_samples.txt", alternativePaths: ["exponential_samples.txt"] }] } });
    expect(validateRequestRequirements(requirements)).toEqual(requirements);
  });
});


it("keeps bullet output requirements independent of earlier payloads", () => {
  const prompt = '- The function must be able to generate valid samples from distributions (e.g., normal)\n- Save the implementation in "/app/ars.R"\n- Your test should print results with statistics\n- Generate at least one sample file named "/app/normal_samples.txt" or "/app/exponential_samples.txt" containing samples';
  expect(deriveRequestRequirements(prompt, "turn", "/app")).toMatchObject({ issues: [], fileOutput: { path: "ars.R", additionalFiles: [{ path: "normal_samples.txt", alternativePaths: ["exponential_samples.txt"] }] } });
  expect(deriveRequestRequirements('Do not:\n- Save a.md\n- Write b.md').fileOutput).toBeUndefined();
  expect(deriveRequestRequirements('Example:\n- Save a.md\n- Write b.md').fileOutput).toBeUndefined();
});


describe("unspecified output directories", () => {
  it.each(["Write extract.js", "اكتب result.json"])("retains a bare name without inventing a directory: %s", text => {
    expect(deriveRequestRequirements(text, "turn", "/").fileOutput?.directoryUnspecified).toBe(true);
  });
  it.each(["Write ./extract.js", "Write /extract.js", "Write app/extract.js", "Write extract.js in /app", "Write extract.js in the current directory", "Write extract.js in the current working directory", "Write extract.js at the workspace root", "Create output directory /app. Write extract.js", "Copy source.js to extract.js", "Write extract.js. Write ./extract.js", "Write ./extract.js. Write extract.js"])("preserves exact destination constraints: %s", text => {
    expect(deriveRequestRequirements(text, "turn", "/").fileOutput?.directoryUnspecified).toBeUndefined();
  });
});

describe("file production policy", () => {
  it.each(["readback.txt", "re-read.txt"])("does not infer verification from a filename: %s", path => {
    expect(requiresAnyFileContentVerification(deriveRequestRequirements(`Write ${path}`))).toBe(false);
  });
  it.each(["pt", "npy", "parquet", "key", "custom"])("does not prescribe text readback for .%s", extension => {
    const requirements = deriveRequestRequirements(`Generate output.${extension} and verify it works.`);
    expect(requirements.fileOutput).toMatchObject({ format: "artifact", verification: "execution" });
    expect(requiresAnyFileContentVerification(requirements)).toBe(false);
    expect(requiredRequestTools(requirements)).toContain("terminal.run");
    const route = new IntentRouter({ skillRegistry: new SkillRegistry() }).route(`Generate output.${extension}`);
    expect(route.taskClass).not.toBe("docs-writing");
  });
  it.each(["Save notes.txt. Read back the file.", "Save notes.txt and re-read it.", "احفظ notes.txt ثم أعد قراءة الملف.", "Copy source.txt to notes.txt", "Research batteries and save notes.txt"])("retains content checks for %s", prompt => {
    const requirements = deriveRequestRequirements(prompt);
    expect(requiresAnyFileContentVerification(requirements)).toBe(true);
    expect(requiredRequestTools(requirements)).toContain("file.read");
  });
  it.each(['Do not read back files.', 'The note says "read back".', '> Read back the file.\n', '```\nread back\n```'])("does not infer readback from inert prose: %s", prefix => {
    expect(requiresAnyFileContentVerification(deriveRequestRequirements(`${prefix}\nWrite notes.txt`))).toBe(false);
  });
});


describe("input roles are not output obligations", () => {
  it.each([
    ["Write CONFIGURATION.md documenting every key in schema.json with its type and default. Preserve schema.json.", "CONFIGURATION.md"],
    ["Create docs/index.md listing each document below docs, excluding index.md.", "docs/index.md"],
    ["Write summary.md summarizing changes.json.", "summary.md"],
    ["Write index.md excluding draft.md.", "index.md"],
    ["Write index.md except for draft.md.", "index.md"]
  ])("keeps topics and exclusions out of the destination list: %s", (text, path) => {
    const result = deriveRequestRequirements(text!);
    expect(result).toMatchObject({ issues: [], fileOutput: { path } });
    expect(result.fileOutput?.additionalFiles).toBeUndefined();
  });
  it("retains explicit destinations after a source or exclusion clause", () => {
    for (const clause of ["documenting schema.json", "excluding draft.md"]) {
      const result = deriveRequestRequirements(`Write index.md ${clause}. Save summary.json.`);
      expect(result).toMatchObject({ issues: [], fileOutput: { path: "index.md", additionalFiles: [{ path: "summary.json" }] } });
    }
    expect(deriveRequestRequirements("Write documenting.md and excluding.json.")).toMatchObject({
      issues: [], fileOutput: { path: "documenting.md", additionalFiles: [{ path: "excluding.json" }] }
    });
    expect(deriveRequestRequirements("Copy listing.json to documenting.json.")).toMatchObject({
      issues: [], fileOutput: { path: "documenting.json", exactCopy: { sourcePath: "listing.json" } }
    });
  });
  it.each([
    "Create a redirect service using redirects.json. Preserve redirects.json. Save server.py.",
    "Create a report from source.csv. Save report.md.",
    "Create a report based on source.csv. Save report.md.",
    "Create a service preserving settings.json. Save server.py."
  ])("does not promote source operands: %s", text => {
    const result = deriveRequestRequirements(text);
    expect(result.issues).toEqual([]);
    expect(result.fileOutput?.path).toBe(text.includes("report") ? "report.md" : "server.py");
    expect(result.fileOutput?.additionalFiles).toBeUndefined();
  });
  it("still requires an explicitly saved input and exact copy destination", () => {
    expect(deriveRequestRequirements("Create a service using settings.json. Save settings.json.").fileOutput?.path).toBe("settings.json");
    expect(deriveRequestRequirements("Copy source.json to result.json.").fileOutput).toMatchObject({path: "result.json", exactCopy: {sourcePath: "source.json"}});
    expect(deriveRequestRequirements("Write a.py and b.py using input.csv.").fileOutput).toMatchObject({path: "a.py", additionalFiles: [{path: "b.py"}]});
  });
});


describe("research intent rather than incidental words", () => {
  it.each([
    "Here is some information you may find useful. Write result.csv.",
    "These research notes may help. Write result.csv.",
    "ابحث عن أعلى قيمة في data.csv. Write result.csv.",
    "Find the largest value in data.csv and write result.csv.",
    "Search the local log for errors and save summary.txt.",
    "Investigate the failing unit tests and write result.json."
  ])("keeps ordinary output verification for %s", text => {
    const requirements = deriveRequestRequirements(text);
    expect(requirements.research).toBeUndefined();
    expect(requirements.fileOutput?.verification).toBe("execution");
  });
  it.each(["Research current battery recycling", "Find recent arXiv papers", "Investigate current release notes", "ابحث عن أحدث الدراسات"])("preserves research for %s", text => {
    expect(deriveRequestRequirements(text).research?.fresh).toBe(true);
  });
  it("retains explicit web search across continuation and persistence", () => {
    const requirements = deriveRequestRequirements("Search the web for current releases", "turn");
    expect(requirements.research?.searchRequired).toBe(true);
    expect(validateRequestRequirements(requirements)).toEqual(requirements);
    expect(continueRequestRequirements(requirements, deriveRequestRequirements("Rerun this research")).research?.searchRequired).toBe(true);
  });
});
