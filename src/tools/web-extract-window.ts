/** Bounded views of retrieved text. Offsets refer to extracted text in this
 * retrieval, not HTML byte positions or a guarantee that later fetches match. */
export type WebExtractWindow = { startChar?: number; query?: string };
export const MAX_EXTRACT_SOURCE_CHARS = 1_000_000;

export function webExtractWindow(text: string, limit: number, options: WebExtractWindow, upstreamTruncated = false) {
  const bounded = text.slice(0, MAX_EXTRACT_SOURCE_CHARS);
  const sourceTruncated = upstreamTruncated || bounded.length < text.length;
  const start = options.startChar ?? 0;
  const query = options.query?.trim();
  const budget = Math.floor(limit);
  const windows: Array<{ start: number; end: number; text: string }> = [];
  let nextStartChar: number | undefined;
  if (query) {
    // Escaped literal matching preserves offsets even when Unicode lowercasing
    // would change the string length (for example, Turkish capital dotted I).
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
    const find = (offset: number) => { pattern.lastIndex = offset; return pattern.exec(bounded); };
    let cursor = start;
    let remaining = budget;
    while (windows.length < 6 && remaining > 0) {
      const match = find(cursor);
      if (match === null) break;
      const size = Math.min(remaining, 2000);
      const from = Math.max(start, match.index - Math.min(160, Math.max(0, size - match[0].length)));
      const end = Math.min(bounded.length, from + size);
      windows.push({ start: from, end, text: bounded.slice(from, end) });
      remaining -= end - from;
      cursor = Math.max(match.index + match[0].length, end);
      if (find(cursor) !== null) nextStartChar = cursor;
      else { nextStartChar = undefined; break; }
    }
  } else if (start < bounded.length) {
    const end = Math.min(bounded.length, start + budget);
    windows.push({ start, end, text: bounded.slice(start, end) });
    if (end < bounded.length) nextStartChar = end;
  }
  const truncated = sourceTruncated || !!query || start > 0 || nextStartChar !== undefined;
  const notice = query && windows.length === 0
    ? "No literal query match in the retrieved text at or after startChar. This is not evidence that the full source lacks the claim."
    : windows.length === 0 ? "startChar is past the retrieved text. No passage returned." : undefined;
  const guidance = truncated
    ? `Partial source view. Cite only passages returned here, not unseen sections. Use query for literal text search or startChar to continue; maxContentChars is capped. Retrieved text length: ${bounded.length}.${nextStartChar === undefined ? "" : ` Next startChar: ${nextStartChar}.`}${sourceTruncated ? " The retrieved source itself was truncated; later content is unavailable in this observation." : ""}`
    : undefined;
  const content = query || start > 0
    ? windows.map(window => `[Characters ${window.start}-${window.end}]\n${window.text}`).join("\n\n")
    : windows[0]?.text ?? "";
  return {
    content, notice, ...(notice === undefined ? {} : { reason: query ? "query-not-found" : "offset-out-of-range" }), guidance, truncated, sourceTruncated, retrievedTextChars: bounded.length,
    windows: windows.map(({ start, end }) => ({ start, end })),
    ...(nextStartChar === undefined ? {} : { nextStartChar })
  };
}
