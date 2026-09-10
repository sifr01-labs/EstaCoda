/** Shared scoping for routing/completion heuristics, never execution authority.
 * Negation extends through coordinated actions until a sentence or contrast.
 * Quoted values cannot supply actions or negation boundaries. */
export function affirmativeRequestSegments(text: string): string[] {
  return text.replace(/"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, " ")
    .split(/[.!?;؛،\n]+(?=\s|$)|\bbut\b|ولكن/iu)
    .map((sentence) => sentence.split(/\b(?:do\s+not|don[’']t|never|without|avoid)\b|(?:^|\s)(?:لا|بدون|دون)(?:\s|$)/iu, 1)[0]!);
}
