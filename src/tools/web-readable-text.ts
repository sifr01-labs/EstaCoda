/** Conservative HTML cleanup for documentation reads, not a browser or an HTML
 * sanitizer. Keep a whole-body fallback when no usable main region is present. */
export function webReadableText(raw: string, contentType?: string, baseUrl?: string): { text: string; contentKind: "main" | "body" | "navigation-only" } {
  const html = contentType?.toLowerCase().includes("html") || (!contentType && /<(?:html|body|main|article|nav)\b/iu.test(raw));
  if (!html) return { text: raw.trim(), contentKind: "body" };
  const cleaned = raw.replace(/<!--[^]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[^]*?<\/\1\s*>/giu, " ");
  const regions = [...cleaned.matchAll(/<(main|article)\b[^>]*>([^]*?)<\/\1\s*>/giu)]
    .map(match => textFromHtml(match[2]!, baseUrl)).filter(Boolean);
  if (regions.length) return { text: regions.join("\n\n"), contentKind: "main" };
  const body = /<body\b[^>]*>([^]*?)<\/body\s*>/iu.exec(cleaned)?.[1] ?? cleaned;
  const withoutNavigation = body.replace(/<(nav|header|footer|aside)\b[^>]*>[^]*?<\/\1\s*>/giu, " ");
  const text = textFromHtml(withoutNavigation, baseUrl);
  if (text) return { text, contentKind: "body" };
  return { text: textFromHtml(body, baseUrl), contentKind: "navigation-only" };
}

function textFromHtml(html: string, baseUrl?: string): string {
  // Keep destinations so a moved documentation page can be followed rather
  // than guessed. These are untrusted source links, never navigation authority.
  const linked = html.replace(/<a\b([^>]*)>([^]*?)<\/a\s*>/giu, (_match, attrs: string, label: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
    const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").replace(/&amp;/giu, "&");
    const text = label.replace(/<[^>]+>/gu, " ").trim();
    if (!text || !target || target.startsWith("#") || target.length > 2048) return text;
    try {
      const url = new URL(target, baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        [...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api.?key/iu.test(key))) return text;
      return `[${text}](${url.href})`;
    } catch { return text; }
  });
  return linked.replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"').replace(/&#39;/giu, "'")
    .replace(/&#(x[\da-f]+|\d+);/giu, (match, code: string) => {
      const value = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
    }).replace(/\s+/gu, " ").trim();
}
