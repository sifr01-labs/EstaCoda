const DEFAULT_TASK_RESULT_SUMMARY_CHARS = 200;

/**
 * Derive a compact, presentation-ready summary from the beginning of a complete
 * Task result. This is intentionally extractive: it never invents findings.
 */
export function deriveTaskResultSummary(
  value: string | undefined,
  maxChars = DEFAULT_TASK_RESULT_SUMMARY_CHARS
): string | undefined {
  if (value === undefined || maxChars <= 0) return undefined;

  const withoutFencedCode = value
    .replace(/```[^\n]*\n[\s\S]*?```/gu, "\n\n")
    .replace(/```[\s\S]*$/gu, "");
  const paragraphs = withoutFencedCode
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/gu);

  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .filter((line) => !isPresentationOnlyLine(line))
      .map(cleanMarkdownLine)
      .filter((line) => line.length > 0);
    const candidate = cleanSummaryText(lines.join(" "));
    if (candidate.length === 0) continue;
    return boundSummary(candidate, maxChars);
  }

  return undefined;
}

function isPresentationOnlyLine(value: string): boolean {
  const line = value.trim();
  return line.length === 0 ||
    /^#{1,6}(?:\s+|$)/u.test(line) ||
    /^(?:[-*_]\s*){3,}$/u.test(line) ||
    /^\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?$/u.test(line) ||
    /^\|.*\|$/u.test(line);
}

function cleanMarkdownLine(value: string): string {
  return value
    .trim()
    .replace(/^>+\s*/u, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/`{1,3}([^`]*)`{1,3}/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/[*~]+/gu, "");
}

function cleanSummaryText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/^(?:…|\.\.\.)/u.test(normalized)) return "";
  return normalized.replace(/^[•·|:;,\-–—\s]+/u, "").trim();
}

function boundSummary(value: string, maxChars: number): string {
  if ([...value].length <= maxChars) return value;

  const prefix = [...value].slice(0, maxChars).join("");
  const minimumCompleteLength = Math.min(40, Math.floor(maxChars * 0.45));
  let sentenceEnd = -1;
  for (const match of prefix.matchAll(/[.!?؟。！](?=\s|$)/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimumCompleteLength) sentenceEnd = end;
  }
  if (sentenceEnd >= 0) return prefix.slice(0, sentenceEnd).trimEnd();

  const lastSpace = prefix.lastIndexOf(" ");
  const wordSafePrefix = lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix;
  return `${wordSafePrefix.replace(/[\s,;:–—-]+$/u, "")}…`;
}
