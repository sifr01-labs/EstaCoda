import type { RequestInterpretation } from "../contracts/intent.js";
import { affirmativeRequestSegments } from "./request-action-segments.js";

/** Shared, bounded request semantics. This is neither authority nor evidence of
 * completion. Unknown wording remains unknown; tool availability is irrelevant. */
export function interpretRequest(text: string): RequestInterpretation {
  if (text.length > 32_768) return "unspecified";
  const clauses = affirmativeRequestSegments(text.normalize("NFKC")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|^\s*>.*$|`[^`\n]*`/gmu, " "))
    .flatMap(splitRequestClauses)
    .map(clause => clause.trim()).filter(Boolean);
  const information = clauses.filter(isInformationClause).length;
  if (information === clauses.length && information > 0) return "information";
  if (information > 0) return "mixed";
  return clauses.some(clause => /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:review|inspect|check|read|research|find|list|show|save|write|create|update|fix|implement|send|delete|use|run|open|build)\b|^(?:من فضلك\s+)?(?:راجع|افحص|اقرأ|ابحث|احفظ|اكتب|أنشئ|نفذ)/iu.test(clause)) ? "action" : "unspecified";
}

/** Split coordinated instructions without turning "able to read and write" into
 * two commands. Used by both explicit requirement extraction and interpretation. */
export function splitRequestClauses(clause: string): string[] {
  if (/^(?:what\s+if|if\s+(?:we|you|I)|hypothetically|imagine|ماذا لو|افترض)/iu.test(clause.trim())) return [clause];
  if ((isCapabilityQuestion(clause.trim()) || /^(?:how\s|(?:explain|describe)\s+how\s|tell\s+me\s+how\s|كيف\s)/iu.test(clause.trim())) && !/\b(?:then|and\s+please)\b|ثم/iu.test(clause)) return [clause];
  return clause.split(/(?:,|\b(?:and|then)\b|ثم)\s*(?=(?:please\s+)?(?:review|inspect|read|check|research|save|write|create|update|fix|implement|send|delete|use|احفظ|اكتب|راجع|افحص|ابحث)(?:\s|$))/iu);
}

export function isCapabilityQuestion(text: string): boolean {
  // A concrete target turns "are you able" into a polite request. Access and
  // support questions remain questions even when they name a resource.
  if (/^are\s+you\s+(?:able|capable)\b/iu.test(text) &&
    /\b(?:this|these|following|attached|please)\b|(?:[\w-]+\.(?:md|ts|tsx|js|py|json|txt))\b/iu.test(text)) return false;
  return /^(?:are\s+you\s+(?:able\s+t+o\b|capable\s+of\b)|do\s+you\s+(?:have\s+(?:the\s+)?(?:ability|access)|support\b))|^هل\s+(?:لديك\s+(?:القدرة|إمكانية)|أنت\s+قادر)/iu.test(text);
}

function isInformationClause(text: string): boolean {
  // "Can you review this?" remains a polite action request. Explicit capability
  // questions are different; a coordinated action or "do it now" still wins.
  if (/\b(?:now|go ahead|do it|make the change)\b|(?:الآن|نفذ ذلك)/iu.test(text)) return false;
  return isCapabilityQuestion(text) || /^(?:how\s+(?:do|can|would|should)|explain\b|describe\b|what\s+(?:is|are)|tell\s+me\s+how|should\s+i)|^(?:اشرح|صف\s|كيف\s|ما\s+(?:هو|هي))/iu.test(text);
}
