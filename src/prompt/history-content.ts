/** Truncation must never turn an observed URL into a different, plausible URL. */
export function truncateHistoryContent(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`|]+/gu)) {
    if (match.index >= end) break;
    if (match.index + match[0].length > end) { end = match.index; break; }
  }
  return `${value.slice(0, end)}\n[truncated ${value.length - end} chars]`;
}

export function historyContentLimit(role: string, metadata?: Record<string, unknown>): number {
  if ((role === "agent" || role === "assistant") && metadata?.completionCandidate === true && metadata.accepted === false) return 32_000;
  return role === "tool" ? 12_000 : 900;
}
