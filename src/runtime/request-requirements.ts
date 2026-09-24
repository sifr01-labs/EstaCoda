import type { RequestRequirements } from "../contracts/intent.js";
import { affirmativeRequestSegments } from "./request-action-segments.js";

const MAX_REQUEST_CHARS = 32_768;
const FILE_NAME = /`([^`\n]{1,240}\.(?:md|markdown|txt))`|(?:[\p{L}\p{N}_./\\:-]+\.(?:md|markdown|txt))\b/giu;
const INFORMATIONAL = /\b(?:explain|describe|hypothetically|imagine|what\s+if|how\s+(?:would|could|to)|if\s+(?:we|you|I)|example|said|says|quoted?)\b|(?:اشرح|افترض|ماذا لو|مثال|قال)/iu;

/** Only affirmative user clauses may supply new requirements. Quoted filenames
 * are operands; other quoted material, fenced code and blockquotes are inert. */
export function explicitRequestSegments(text: string): string[] {
  const operands: string[] = [];
  const sanitized = text.normalize("NFKC")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/`([^`\n]*)`|"([^"\n]*)"|“([^”\n]*)”|'([^'\n]*)'|‘([^’\n]*)’/gu, (match, ...groups: unknown[]) => {
      const value = groups.slice(0, 5).find((group) => typeof group === "string") as string | undefined;
      if (value !== undefined && /^[\p{L}\p{N}_ ./\\:-]{1,240}\.(?:md|markdown|txt)$/iu.test(value)) {
        operands.push(value);
        return ` FILEOPERAND${operands.length - 1} `;
      }
      return " ";
    });
  return affirmativeRequestSegments(sanitized)
    .filter((segment) => {
      const informational = INFORMATIONAL.exec(segment);
      // A topic such as "how to recycle" does not cancel an earlier action.
      const action = /\b(?:research|investigate|find|search|survey|save|export|write|create|generate|prepare|use|using|invoke|load|apply|launch|spawn)\b|(?:ابحث|احفظ|استخدم|اكتب|أنشئ)/iu.exec(segment);
      return informational === null || (/^how\s+(?:to|could|would)$/iu.test(informational[0]) && action !== null && action.index < informational.index);
    })
    .map((segment) => segment.replace(/FILEOPERAND(\d+)/gu, (_, index: string) => operands[Number(index)] === undefined ? " " : `\`${operands[Number(index)]}\``));
}

export function deriveRequestRequirements(userText: string, originTurnId?: string): RequestRequirements {
  const result: RequestRequirements = { skillReferences: [], issues: [], ...(originTurnId === undefined ? {} : { originTurnId }) };
  if (userText.length > MAX_REQUEST_CHARS) {
    result.issues.push("request-too-long");
    return result;
  }
  for (const segment of explicitRequestSegments(userText)) {
    const actionSegment = segment.replace(/`[^`]*`/gu, " ");
    for (const skill of actionSegment.matchAll(/(?:\b(?:use|using|invoke|load|apply)\s+(?:the\s+)?([\p{L}\p{N}_-]{1,80})\s+skill\b|(?:استخدم|حمّل|فعّل)\s+مهارة\s+([\p{L}\p{N}_-]{1,80})|^\s*\/([\p{L}\p{N}_-]{1,80})(?:\s|$))/giu)) {
      const reference = skill[1] ?? skill[2] ?? skill[3];
      if (reference === undefined || result.skillReferences.includes(reference.toLocaleLowerCase("en-US"))) continue;
      if (result.skillReferences.length >= 4) { result.issues.push("request-too-long"); break; }
      result.skillReferences.push(reference.toLocaleLowerCase("en-US"));
    }
    const delegation = actionSegment.match(/\b(?:use|using|launch|spawn|delegate\s+to|assign\s+to)\s+(?:(\d{1,9}|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:sub[- ]?agents?|workers?|agents?)\b|(?:استخدم|شغّل|شغل|كلّف)\s+(?:(\d{1,9}|[٠-٩]{1,9}|ثلاثة|ثلاث|اثنين|اثنان)\s+)?(?:وكلاء|عمال|وكيل|sub[- ]?agents?|workers?)(?:\s+فرعيين)?/iu);
    if (delegation !== null) {
      const countText = delegation[1] ?? delegation[2];
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, ثلاثة: 3, ثلاث: 3, اثنين: 2, اثنان: 2 };
      result.delegation = countText === undefined ? {} : { count: words[countText.toLowerCase()] ?? Number(countText.replace(/[٠-٩]/gu, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))) };
    }
    if (/\b(?:research|investigate|find|search|survey)\b|(?:ابحث|بحث)/iu.test(actionSegment)) {
      const domain = /\b(?:write|draft|author)\s+(?:a\s+)?(?:paper|manuscript)\b|\bexperiment\b/iu.test(actionSegment) ? "paper"
        : /\b(?:papers?|arxiv|literature|academic|publications?)\b|(?:أوراق|أبحاث|أدبيات)/iu.test(actionSegment) ? "literature" : "general";
      result.research = { domain: domain === "general" ? result.research?.domain ?? domain : domain, fresh: result.research?.fresh === true || /\b(?:latest|recent|current|fresh|newest)\b|(?:أحدث|حديث|الحالية)/iu.test(actionSegment) };
    }
    if (!/\b(?:prepare|save|export|write|create|generate)\s+|(?:احفظ(?:ها|ه)?|صدّر(?:ها|ه)?|صدر(?:ها|ه)?|أنشئ|اكتب(?:ها|ه)?|جهّز|جهز|أعد)\s+/iu.test(actionSegment)) continue;
    const paths = [...segment.matchAll(FILE_NAME)].map((match) => match[1] ?? match[0]);
    const markdown = /\bmarkdown\b|\bmd\s+file\b/iu.test(actionSegment) || paths.some((path) => /\.(?:md|markdown)$/iu.test(path));
    if (paths.length === 0 && !(markdown && /\bfile\b|ملف/iu.test(actionSegment)) && !/\btext\s+file\b|ملف\s+نصي/iu.test(actionSegment)) continue;
    const path = paths[0];
    if (new Set([...paths, ...(result.fileOutput?.path === undefined ? [] : [result.fileOutput.path])]).size > 1) result.issues.push("ambiguous-file-target");
    const safePath = path !== undefined && path.length <= 240 && !/^(?:[/\\]|[a-z]:)/iu.test(path) && !path.split(/[/\\]/u).includes("..");
    if (path !== undefined && !safePath) result.issues.push("unsafe-file-target");
    result.fileOutput = { format: markdown ? "markdown" : "text", ...(safePath ? { path: path!.replaceAll("\\", "/") } : {}) };
  }
  result.skillReferences = [...new Set(result.skillReferences)];
  result.issues = [...new Set(result.issues)];
  return result;
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
    !/\b(?:new topic|instead|forget|unrelated|another|about)\b|موضوع جديد/iu.test(segments)) return "save";
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
