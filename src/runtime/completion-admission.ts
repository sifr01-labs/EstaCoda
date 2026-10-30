/** A final-answer admission can reject completion, never prove it or authorize
 * another action. Quoted examples, code and optional future work are inert. */
export function completionAdmissionFeedback(text: string | undefined, expectsWork: boolean): string | undefined {
  if (!expectsWork || text === undefined) return undefined;
  const prose = text.slice(0, 32_768).normalize("NFKC")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/gu, " ")
    .replace(/\*\*|__/gu, "");
  const incomplete = prose.split(/\n|(?<=[.!?])\s+/u).some(line => {
    if (/\b(?:optional|out of scope|future work|previously|earlier|example|hypothetical)\b|(?:اختياري|مثال|سابقا)/iu.test(line)) return false;
    return /\b(?:does not|doesn't|cannot|can't)\s+(?:yet\s+|fully\s+)?(?:satisfy|meet|fulfil[l]?|complete)\s+(?:(?:the|that|this|all|every|requested|mandatory)\s+){0,3}(?:requirements?|request|task)\b/iu.test(line) ||
      /\b(?:required|requested|mandatory)\s+[^.!?\n]{0,160}\b(?:is|are|remains?)\s+(?:still\s+)?(?:missing|unfinished|incomplete|not implemented|not applied|not verified)\b/iu.test(line) ||
      /^\s*(?:[-*]\s*)?(?:remaining limitation|unfinished requirement)\s*:/iu.test(line) ||
      /^\s*(?:I(?: am|['’]m)\s+)?blocked(?:\s+by\b|:)/iu.test(line) ||
      /(?:المتطلب المطلوب لم يكتمل|لم أتمكن من إكمال المهمة|لا يفي بالمتطلبات المطلوبة)/u.test(line);
  });
  return incomplete
    ? "Your final answer acknowledges unfinished required work or a blocker. Reconcile it with the original request and observed evidence. If productive work remains authorized, complete it and verify the requested behavior (including output schemas and relevant negative cases), not merely file existence or parameter names. Otherwise state the concrete blocker and remaining work. Do not invent results, repeat denied actions, or bypass approval; a blocker remains partial/blocked, not completed."
    : undefined;
}
