/** Shared scoping for routing/completion heuristics, never execution authority.
 * Negation extends through coordinated actions until a sentence or contrast.
 * Quoted values cannot supply actions or negation boundaries. */
export function affirmativeRequestSegments(text: string): string[] {
  return text.replace(/"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, " ")
    .split(/[.!?;؛،\n]+(?=\s|$)|\bbut\b|ولكن/iu)
    .map((sentence) => sentence.slice(0, requestNegationStart(sentence)));
}

/** Shared negative-clause boundary: a later prohibition must not hide an earlier
 * "no research" clause or turn that clause into an affirmative requirement. */
export function requestNegationStart(sentence: string): number | undefined {
  if (/^\s*no\s+(?:(?:(?:additional|further|new|more|web|online|external)\s+)*(?:research|search(?:es|ing)?|browsing)\b|[^,]*\b(?:needed|required)\b)/iu.test(sentence)) return 0;
  return /\b(?:do\s+not|don[’']t|never|without|avoid)\b|(?:^|\s)(?:لا|بدون|دون)(?:\s|$)/iu.exec(sentence)?.index;
}
