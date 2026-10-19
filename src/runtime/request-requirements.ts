import { MAX_FILE_OUTPUTS, MAX_REQUEST_REQUIREMENTS_CHARS, requestedFileOutputs } from "../contracts/request-requirements.js";
import type { FileOutputRequirement, RequestRequirements } from "../contracts/intent.js";
import { posix, win32 } from "node:path";
import { interpretRequest, splitRequestClauses, isCapabilityQuestion } from "./request-interpretation.js";
import { affirmativeRequestSegments } from "./request-action-segments.js";

const MAX_REQUEST_CHARS = 32_768;
// Text deliverables use the existing file tools and materialized read-back contract.
const TEXT_EXTENSIONS = "md|markdown|txt|json|jsonl|ndjson|csv|tsv|yaml|yml|xml|html|css|ts|tsx|js|jsx|py";
const FILE_NAME = new RegExp("`([^`\\n]{1,240}\\.(?:" + TEXT_EXTENSIONS + "))`|" + String.raw`(?:[\p{L}\p{N}_./\\:-]+\.(?:${TEXT_EXTENSIONS}))\b`, "giu");
const QUOTED_FILE_NAME = new RegExp(String.raw`^[\p{L}\p{N}_ ./\\:-]{1,240}\.(?:${TEXT_EXTENSIONS})$`, "iu");
const OUTPUT_ACTION = /\b(?:prepare|save|export|write|create|generate|clear|empty|truncate)\s+|(?:احفظ(?:ها|ه)?|صدّر(?:ها|ه)?|صدر(?:ها|ه)?|أنشئ|اكتب(?:ها|ه)?|جهّز|جهز|أعد|أفرغ|افرغ)\s+/iu;
const FILE_OPERAND = new RegExp(String.raw`[\p{L}\p{N}_./\\:-]+\.(?:${TEXT_EXTENSIONS})\b`, "giu");
const INERT_CONTEXT = /\b(?:hypothetically|imagine|what\s+if|if\s+(?:we|you|I)|example|said|says|quoted?)\b|(?:افترض|ماذا لو|مثال|قال)/iu;
const INFORMATIONAL = /\b(?:explain|describe|hypothetically|imagine|what\s+if|how\s+(?:would|could|to)|if\s+(?:we|you|I)|example|said|says|quoted?)\b|(?:اشرح|افترض|ماذا لو|مثال|قال)/iu;

// An invocation can own a coordinated noun list; ordinary skill mentions cannot.
const SKILL_NAME = String.raw`[\p{L}\p{N}_-]{1,80}`;
const SKILL_SEPARATOR = String.raw`\s*(?:,\s*(?:and\s+)?|(?:\band\b|&)\s+)`;
const SKILL_OBJECT = String.raw`(?:the\s+)?${SKILL_NAME}\s+skills?`;
const ENGLISH_SKILL_INVOCATION = String.raw`\b(?:use|using|invoke|load|apply)\s+(?:both\s+)?(${SKILL_OBJECT}(?:${SKILL_SEPARATOR}${SKILL_OBJECT})*|(?:the\s+)?${SKILL_NAME}(?:${SKILL_SEPARATOR}(?:the\s+)?${SKILL_NAME})+\s+skills)\b`;

function explicitSkillReferences(segment: string): string[] {
  const references: string[] = [];
  // Keep matches in request order, including slash commands and Arabic.
  const invocations = new RegExp(`${ENGLISH_SKILL_INVOCATION}|(?:استخدم|حمّل|فعّل)\\s+مهارة\\s+(${SKILL_NAME})|^\\s*/(${SKILL_NAME})(?:\\s|$)`, "giu");
  for (const match of segment.matchAll(invocations)) {
    if (match[1] !== undefined) {
      references.push(...match[1].split(new RegExp(SKILL_SEPARATOR, "iu"))
        .map(name => name.replace(/^the\s+/iu, "").replace(/\s+skills?$/iu, "")));
    } else references.push((match[2] ?? match[3])!);
  }
  return references;
}

/** Only affirmative user clauses may supply new requirements. Quoted filenames
 * are operands; other quoted material, fenced code and blockquotes are inert. */
export function explicitRequestSegments(text: string): string[] {
  const operands: string[] = [];
  const sanitized = text.normalize("NFKC")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    // URL words are operands, not informational markers or research verbs.
    .replace(/https?:\/\/[^\s<>"“”`]+/giu, url => ` [URL] ${url.match(/[.!?;؛]+$/u)?.[0] ?? ""}`)
    .replace(/`([^`\n]*)`|"([^"\n]*)"|“([^”\n]*)”|'([^'\n]*)'|‘([^’\n]*)’/gu, (match, ...groups: unknown[]) => {
      const value = groups.slice(0, 5).find((group) => typeof group === "string") as string | undefined;
      if (value !== undefined && QUOTED_FILE_NAME.test(value)) {
        operands.push(value);
        return ` FILEOPERAND${operands.length - 1} `;
      }
      return " ";
    });
  return affirmativeRequestSegments(sanitized)
    .flatMap(segment => INERT_CONTEXT.test(segment.replace(FILE_OPERAND, " [file] ")) ? [segment] : splitRequestClauses(segment))
    .map(segment => {
      // Invoking a skill to explain something still invokes the skill. Keep the
      // purpose informational: "explain how to save" must not require a write.
      const purpose = /\s+to\s+(?:explain|describe)\b/iu.exec(segment);
      if (purpose && !INERT_CONTEXT.test(segment) && explicitSkillReferences(segment.slice(0, purpose.index)).length > 0) {
        return segment.slice(0, purpose.index);
      }
      return segment;
    })
    .filter((segment) => {
      if (isCapabilityQuestion(segment.trim()) && interpretRequest(segment) === "information") return false;
      const informational = INFORMATIONAL.exec(segment.replace(FILE_OPERAND, " [file] "));
      // A topic such as "how to recycle" does not cancel an earlier action.
      const action = /\b(?:research|investigate|find|search|survey|save|export|write|create|generate|prepare|use|using|invoke|load|apply|launch|spawn)\b|(?:ابحث|احفظ|استخدم|اكتب|أنشئ)/iu.exec(segment);
      return informational === null || (/^how\s+(?:to|could|would)$/iu.test(informational[0]) && action !== null && action.index < informational.index);
    })
    .map((segment) => segment.replace(/FILEOPERAND(\d+)/gu, (_, index: string) => operands[Number(index)] === undefined ? " " : `\`${operands[Number(index)]}\``));
}

export function deriveRequestRequirements(userText: string, originTurnId?: string, workspaceRoot?: string): RequestRequirements {
  const result: RequestRequirements = { skillReferences: [], issues: [], ...(originTurnId === undefined ? {} : { originTurnId }) };
  if (userText.length > MAX_REQUEST_CHARS) {
    result.issues.push("request-too-long");
    return result;
  }
  for (const segment of explicitRequestSegments(userText)) {
    const actionSegment = segment.replace(/`[^`]*`/gu, " ").replace(FILE_OPERAND, " [file] ");
    // Cancelling an old objective does not request its named work again.
    if (/^\s*(?:(?:please|just)\s+)?(?:forget|cancel|stop|abandon|discard|ignore)\b|^\s*(?:انسَ?|ألغ|الغ|توقف|تجاهل)/iu.test(actionSegment)) continue;
    for (const reference of explicitSkillReferences(actionSegment)) {
      if (reference === undefined || result.skillReferences.includes(reference.toLocaleLowerCase("en-US"))) continue;
      if (result.skillReferences.length >= 4) { result.issues.push("request-too-long"); break; }
      result.skillReferences.push(reference.toLocaleLowerCase("en-US"));
    }
    // A coordinated object inherits the explicit use verb ("use the X skill
    // and three workers"). Keep the antecedent bounded to a skill request;
    // arbitrary mentions, quoted text and negated clauses remain inert.
    const delegationSegment = actionSegment
      .replace(new RegExp(`${ENGLISH_SKILL_INVOCATION}\\s*(?:,\\s*)?(?:and|&)\\s+`, "giu"), "use ")
      .replace(/استخدم\s+مهارة\s+[\p{L}\p{N}_-]{1,80}\s+و\s*/gu, "استخدم ");
    const delegation = delegationSegment.match(/\b(?:use|using|launch|spawn|delegate\s+to|assign\s+to)\s+(?:exactly\s+)?(?:(\d{1,9}|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:sub[- ]?agents?|workers?|agents?)\b|(?:استخدم|شغّل|شغل|كلّف)\s+(?:(\d{1,9}|[٠-٩]{1,9}|ثلاثة|ثلاث|اثنين|اثنان)\s+)?(?:وكلاء|عمال|وكيل|sub[- ]?agents?|workers?)(?:\s+فرعيين)?/iu);
    if (delegation !== null) {
      const countText = delegation[1] ?? delegation[2];
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, ثلاثة: 3, ثلاث: 3, اثنين: 2, اثنان: 2 };
      result.delegation = countText === undefined ? {} : { count: words[countText.toLowerCase()] ?? Number(countText.replace(/[٠-٩]/gu, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))) };
    }
    if (explicitInspectionTools(segment).length === 0 && /\b(?:research|investigate|find|search|survey)\b|(?:ابحث|بحث)/iu.test(actionSegment)) {
      const domain = /\b(?:write|draft|author)\s+(?:a\s+)?(?:paper|manuscript)\b|\bexperiment\b/iu.test(actionSegment) ? "paper"
        : /\b(?:papers?|arxiv|literature|academic|publications?)\b|(?:أوراق|أبحاث|أدبيات)/iu.test(actionSegment) ? "literature" : "general";
      result.research = { domain: domain === "general" ? result.research?.domain ?? domain : domain, fresh: result.research?.fresh === true || /\b(?:latest|recent|current|fresh|newest)\b|(?:أحدث|حديث|الحالية)/iu.test(actionSegment) };
    }
    const copy = /^\s*(?:(?:can|could|would)\s+you\s+)?(?:(?:please|just)\s+)?(?:copy\b|(?:make|create|save)\s+(?:(?:an?|the|identical|exact|unchanged)\s+)*copy\b)/iu.test(actionSegment) && new RegExp(String.raw`\b(?:as|to)\s+(?:\x60[^\x60]+\x60|[^\s]+\.(?:${TEXT_EXTENSIONS}))\s*(?:[.!]|,?\s*(?:preserving|while preserving)\b|$)`, "iu").test(segment);
    // Locate the output action without treating a filename as a verb. Keep
    // offsets stable so input paths preceding the action are not destinations.
    const masked = segment.replace(/`[^`]*`/gu, value => " ".repeat(value.length)).replace(FILE_OPERAND, value => " ".repeat(value.length));
    const outputAction = OUTPUT_ACTION.exec(masked);
    if (!copy && outputAction === null) continue;
    const outputStart = copy ? 0 : outputAction!.index;
    // A payload introduced by with/containing (or a JSON colon) is content,
    // even when it includes quoted filenames. It cannot add output targets.
    const contentStart = /\b(?:with|containing)\s+|:\s*(?=[{\[])/iu.exec(masked.slice(outputStart));
    const beforeContent = contentStart ? segment.slice(outputStart, outputStart + contentStart.index) : undefined;
    const outputSegment = beforeContent !== undefined && [...beforeContent.matchAll(FILE_NAME)].length > 0
      ? beforeContent : segment.slice(outputStart);
    const pathMatches = [...outputSegment.matchAll(FILE_NAME)];
    const namedPaths = pathMatches.map((match) => match[1] ?? match[0]);
    // In an explicit copy, the final as/to operand is the destination; the
    // preceding source is not a second output. Multiple sources stay ambiguous.
    const paths = copy && namedPaths.length <= 2 ? namedPaths.slice(-1) : namedPaths;
    const markdown = /\bmarkdown\b|\bmd\s+file\b/iu.test(actionSegment) || paths.some((path) => /\.(?:md|markdown)$/iu.test(path));
    if (paths.length === 0 && !(markdown && /\bfile\b|ملف/iu.test(actionSegment)) && !/\btext\s+file\b|ملف\s+نصي/iu.test(actionSegment)) continue;
    // Conjunctive destinations are separate obligations. Alternatives and
    // ambiguous copy sources must not silently become a choice or a merge.
    const conjunctive = pathMatches.slice(1).every((match, index) => {
      const previous = pathMatches[index]!;
      const separator = outputSegment.slice(previous.index! + previous[0].length, match.index);
      return /^\s*(?:,\s*(?:and\s+)?|and\s+|&\s*|و\s*)$/iu.test(separator);
    });
    if ((!copy && paths.length > 1 && !conjunctive) || (copy && namedPaths.length > 2)) {
      result.issues.push("ambiguous-file-target");
    }
    const sourcePath = copy && namedPaths.length === 2 ? namedPaths[0] : undefined;
    const normalizedSource = sourcePath === undefined ? undefined : workspaceRelativeRequirementPath(sourcePath, workspaceRoot);
    if (sourcePath !== undefined && normalizedSource === undefined) result.issues.push("unsafe-file-target");
    const outputs = requestedFileOutputs(result);
    for (const candidate of paths.length === 0 ? [undefined] : paths) {
      const path = candidate === undefined ? undefined : workspaceRelativeRequirementPath(candidate, workspaceRoot);
      if (candidate !== undefined && path === undefined) result.issues.push("unsafe-file-target");
      const output: FileOutputRequirement = {
        format: candidate === undefined ? (markdown ? "markdown" : "text") : /\.(?:md|markdown)$/iu.test(candidate) ? "markdown" : "text",
        ...(path === undefined ? {} : { path }),
        ...(copy ? { exactCopy: normalizedSource === undefined ? {} : { sourcePath: normalizedSource } } : {})
      };
      const existing = outputs.find(value => value.path === path);
      if (existing !== undefined) {
        if (JSON.stringify(existing.exactCopy) !== JSON.stringify(output.exactCopy) || existing.format !== output.format) result.issues.push("ambiguous-file-target");
        continue;
      }
      if (outputs.length > 0 && (path === undefined || outputs.some(value => value.path === undefined))) {
        result.issues.push("ambiguous-file-target");
        continue;
      }
      if (outputs.length >= MAX_FILE_OUTPUTS) { result.issues.push("request-too-long"); continue; }
      outputs.push(output);
    }
    if (outputs.length > 0) result.fileOutput = { ...outputs[0], ...(outputs.length > 1 ? { additionalFiles: outputs.slice(1) } : {}) };
  }
  result.skillReferences = [...new Set(result.skillReferences)];
  // Several long copy source/destination pairs can exceed the persistence
  // budget before reaching the count limit. Retain a bounded, unresolved prefix.
  if (JSON.stringify(result).length > MAX_REQUEST_REQUIREMENTS_CHARS) {
    result.issues.push("request-too-long");
    while (result.fileOutput?.additionalFiles?.length && JSON.stringify(result).length > MAX_REQUEST_REQUIREMENTS_CHARS) {
      result.fileOutput.additionalFiles.pop();
      if (result.fileOutput.additionalFiles.length === 0) delete result.fileOutput.additionalFiles;
    }
  }
  result.issues = [...new Set(result.issues)];
  return result;
}

/** Lexical identity for completion evidence, never filesystem authorization.
 * File tools still enforce canonical containment (including symlinks) at dispatch. */
function workspaceRelativeRequirementPath(value: string, workspaceRoot?: string): string | undefined {
  if (value.length === 0 || value.length > 240 || value.split(/[/\\]/u).includes("..")) return undefined;
  if (!/^(?:[/\\]|[a-z]:)/iu.test(value)) return posix.normalize(value.replaceAll("\\", "/"));
  if (workspaceRoot === undefined) return undefined;
  // Select the execution workspace's syntax, not the operator host's platform.
  const paths = /^(?:[a-z]:|\\\\)/iu.test(workspaceRoot) ? win32 : posix;
  if (!paths.isAbsolute(workspaceRoot) || !paths.isAbsolute(value)) return undefined;
  if (paths === posix && value.includes("\\")) return undefined;
  if (paths === win32 && paths.parse(value).root.replaceAll("\\", "/").toLowerCase() !==
    paths.parse(workspaceRoot).root.replaceAll("\\", "/").toLowerCase()) return undefined;
  const relativePath = paths.relative(workspaceRoot, value).replaceAll("\\", "/");
  return relativePath === "" || paths.isAbsolute(relativePath) || relativePath.split("/").includes("..")
    ? undefined : relativePath;
}

/** Read-only inspection prerequisites from affirmative current requests. These
 * names are intersected with the session catalog, never execution authority. */
export function explicitInspectionTools(text: string): string[] {
  if (text.length > MAX_REQUEST_CHARS) return [];
  const tools = new Set<string>();
  for (const segment of explicitRequestSegments(text)) {
    const action = segment.replace(/`[^`]*`/gu, " ");
    if (/^\s*(?:forget|cancel|stop|ignore)\b|^\s*(?:انسَ?|ألغ|الغ|توقف|تجاهل)/iu.test(action)) continue;
    const inspect = /\b(?:check|show|inspect|read|retrieve|fetch|review)\b|(?:تحقق|تحقّق|اعرض|افحص|اقرأ|راجع)/iu.test(action);
    const specificQuestion = /\b(?:what|how|is|has)\b/iu.test(action) && /\b(?:task_[\w-]+|my|our|this|that|existing|current|previous)\b/iu.test(action);
    if (!(inspect || specificQuestion)) continue;
    if (inspect && /\[URL\]/u.test(action)) tools.add("web.extract");
    if (/\b(?:tasks?|task_[\w-]+|workers?)\b|(?:المهمة|مهمة|المهام)/iu.test(action) &&
      /\b(?:status|progress|results?|outputs?|finished|done|completed)\b|(?:حالة|تقدم|نتيجة|نتائج|مخرجات|انتهت)/iu.test(action)) {
      tools.add("task.status");
      if (/\b(?:results?|outputs?)\b|(?:نتيجة|نتائج|مخرجات)/iu.test(action)) tools.add("task.result.read");
    }
    if (/\b(?:web|search|browser)\b|(?:البحث|المتصفح)/iu.test(action) &&
      /\b(?:config(?:ured|uration)?|settings?|setup|backend|options)\b|(?:إعداد|اعداد|مهيأ|خيارات)/iu.test(action)) tools.add("config.provider.status");
    if (/\bgit\s+(?:diff|status|log)\b/iu.test(action)) tools.add("terminal.inspect");
  }
  return [...tools];
}

/** Adds only exact capabilities to an already session-filtered catalog. */
export function requiredRequestTools(requirements: RequestRequirements | undefined): string[] {
  if (requirements === undefined) return [];
  return [
    ...(requirements.research === undefined ? [] : ["web.search", "web.extract"]),
    ...(requirements.sourceTaskId !== undefined ? ["task.status", "task.result.read"] : requirements.delegation === undefined ? [] : ["delegate_task", "task.status", "task.result.read"]),
    ...(requirements.fileOutput === undefined ? [] : ["file.write", "file.patch", "file.read"]),
    ...(requirements.skillReferences.length === 0 ? [] : ["skill.list", "skill.read"])
  ];
}

export function requirementFollowUp(text: string, previous: RequestRequirements | undefined): "save" | "rerun" | undefined {
  if (previous === undefined || text.length > MAX_REQUEST_CHARS) return undefined;
  const segments = explicitRequestSegments(text).join(" ");
  if (previous.research !== undefined && /\b(?:rerun|re-run|redo|repeat)\s+(?:this|that|the|it|research|task)\b|(?:أعد|اعد)\s+(?:البحث|المهمة)/iu.test(segments)) return "rerun";
  const next = deriveRequestRequirements(text);
  if (next.fileOutput !== undefined && next.research === undefined && next.delegation === undefined &&
    (previous.research !== undefined || previous.fileOutput !== undefined) &&
    /\b(?:save|export|prepare|this|that|existing|above)\b|(?:احفظ|صدر|صدّر|جهز|جهّز)/iu.test(segments) &&
    !/\b(?:new topic|instead|forget|unrelated|another|about|clear|empty|truncate)\b|موضوع جديد|أفرغ|افرغ/iu.test(segments)) return "save";
  return undefined;
}

export function continueRequestRequirements(previous: RequestRequirements, next: RequestRequirements, mode?: "save" | "rerun"): RequestRequirements {
  if (mode === "save") return structuredClone(next);
  return {
    ...structuredClone(previous), ...structuredClone(next),
    ...(previous.research === undefined ? {} : { research: {
      domain: next.research?.domain !== undefined && next.research.domain !== "general" ? next.research.domain : previous.research.domain,
      fresh: previous.research.fresh || next.research?.fresh === true
    } }),
    skillReferences: next.skillReferences.length > 0 ? [...next.skillReferences] : [...previous.skillReferences],
    issues: [...new Set([...previous.issues, ...next.issues])]
  };
}

export function requiredSkillsDelivered(intent: import("../contracts/intent.js").IntentRoute, delivered: readonly string[]): boolean {
  return (intent.requestRequirements?.skillReferences ?? []).every((reference) => {
    const request = intent.skillRequests?.find((item) => item.reference === reference);
    if (request !== undefined) return request.status === "resolved" && request.candidates.length === 1 && delivered.includes(request.candidates[0]!);
    return intent.primarySkill !== undefined && reference === intent.primarySkill.name && delivered.includes(reference);
  });
}
