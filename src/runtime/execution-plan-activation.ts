const MUTATION_OR_EXECUTION_PATTERN = /\b(?:add|apply|build|change|commit|configure|create|delete|deploy|edit|execute|fix|implement|install|modify|publish|push|remove|renew|replace|revoke|run|save|send|set[ -]?up|test|update|upload|write)\b|(?:أنشئ|انشئ|غيّر|غير|حدّث|حدث|عدّل|عدل|اكتب|احذف|أزل|ازل|ثبّت|ثبت|هيّئ|هيئ|نفّذ|نفذ|شغّل|شغل|اختبر|تحقق|أصلح|اصلح|طبّق|طبق|ابنِ|ابني)/giu;
const VERIFICATION_PATTERN = /\b(?:confirm|read\s+back|validate|verification|verify)\b|(?:أكد|اكّد|تحقق|راجع النتيجة)/iu;
const SEQUENCE_PATTERN = /\b(?:after(?:wards)?|before|finally|first|next|then)\b|(?:أولاً|أولا|ثم|بعد ذلك|أخيراً|أخيرا|قبل ذلك)/iu;
const QUANTIFIED_TARGET_PATTERN = /\b(?:all\s+(?:of\s+)?(?:the\s+)?|[3-9]|[1-9]\d+)\b|(?:كل|جميع|[٣-٩]|[١-٩][٠-٩]+)/iu;
const REASONING_ONLY_REQUEST_PATTERN = /^(?:can|could|would) you (?:explain|describe|tell me how)|^(?:explain|describe|tell me how|how (?:can|do|should|would) i|what (?:is|are|should|would))\b|^(?:اشرح|صف|أخبرني كيف|اخبرني كيف|كيف|ما هو|ما هي|ماذا)\b/iu;
const AUTHENTICATION_EXECUTION_PATTERN = /\b(?:(?:log|sign)\s+(?:me|us)\s+in|sign\s+in\s+to|log\s+in\s+to|get\s+(?:me|us)\s+logged\s+in\s*to|get\s+(?:me|us)\s+into.{0,80}\b(?:account|portal|console|dashboard)|authenticate\s+(?:me|us|with)|complete\s+(?:the\s+)?(?:login|sign[ -]?in|authentication|2fa|mfa))\b|(?:سجّل\s+دخولي|سجل\s+دخولي|سجّل\s+دخولنا|سجل\s+دخولنا|سجّلنا\s+الدخول|سجلنا\s+الدخول|أدخلني.{0,60}(?:الحساب|حساب|البوابة)|ادخلني.{0,60}(?:الحساب|حساب|البوابة)|أدخلنا.{0,60}(?:الحساب|حساب|البوابة)|ادخلنا.{0,60}(?:الحساب|حساب|البوابة)|أكمل.{0,40}(?:تسجيل الدخول|المصادقة)|اكمل.{0,40}(?:تسجيل الدخول|المصادقة))/iu;

export type ExecutionPlanActivationAssessment = {
  required: boolean;
  reasons: Array<
    | "multiple-actions"
    | "multiple-systems"
    | "multiple-targets"
    | "sequenced-work"
    | "verification"
    | "authentication"
  >;
};

/**
 * Conservatively identifies foreground requests that need an execution plan.
 * A mutation/execution signal is mandatory so multi-part read-only questions
 * do not acquire Mission overhead merely because the model batches lookups.
 */
export function assessExecutionPlanActivation(input: {
  userText: string;
  proposedToolNames?: readonly string[];
}): ExecutionPlanActivationAssessment {
  const text = input.userText.normalize("NFKC");
  if (REASONING_ONLY_REQUEST_PATTERN.test(text.trim())) return { required: false, reasons: [] };
  if (AUTHENTICATION_EXECUTION_PATTERN.test(text)) {
    return { required: true, reasons: ["authentication"] };
  }
  const actions = distinctMatches(text, MUTATION_OR_EXECUTION_PATTERN);
  if (actions.length === 0) return { required: false, reasons: [] };

  const substantiveTools = (input.proposedToolNames ?? []).filter(isSubstantiveToolName);
  const systems = new Set(substantiveTools.map(toolSystem));
  const reasons: ExecutionPlanActivationAssessment["reasons"] = [];
  if (actions.length >= 2 || substantiveTools.length >= 2) reasons.push("multiple-actions");
  if (systems.size >= 2) reasons.push("multiple-systems");
  if (QUANTIFIED_TARGET_PATTERN.test(text)) reasons.push("multiple-targets");
  if (SEQUENCE_PATTERN.test(text)) reasons.push("sequenced-work");
  if (VERIFICATION_PATTERN.test(text)) reasons.push("verification");

  return { required: reasons.length > 0, reasons };
}

export function isPlanToolName(name: string | undefined): boolean {
  return name === "plan";
}

function isSubstantiveToolName(name: string): boolean {
  return name.length > 0 &&
    !isPlanToolName(name) &&
    name !== "memory.curate" &&
    !name.startsWith("skill.") &&
    !name.startsWith("knowledge.memory.");
}

function toolSystem(name: string): string {
  if (name.startsWith("mcp.")) return name.split(".").slice(0, 2).join(".");
  return name.split(".")[0] ?? name;
}

function distinctMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...new Set([...text.matchAll(pattern)].map((match) => match[0]!.toLocaleLowerCase("en-US")))];
}
