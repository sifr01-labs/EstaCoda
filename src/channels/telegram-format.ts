import type { ChannelTextOptions } from "../contracts/channel.js";

export function formatTelegramReply(
  text: string,
  options?: ChannelTextOptions
): {
  text: string;
  format: "plain" | "html";
} {
  if (options?.format !== undefined) {
    return {
      text,
      format: options.format
    };
  }

  return {
    text: renderTelegramHtml(text),
    format: "html"
  };
}

function renderTelegramHtml(input: string): string {
  const normalized = input.replaceAll("\r\n", "\n").trimEnd();

  if (normalized.length === 0) {
    return "";
  }

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let textBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let codeLanguage = "";
  let inCodeFence = false;

  const flushText = () => {
    if (textBuffer.length === 0) {
      return;
    }

    blocks.push(renderTextLines(textBuffer));
    textBuffer = [];
  };

  const flushCode = () => {
    const code = codeBuffer.join("\n");
    const languageLabel = codeLanguage.length > 0 ? `<b>${escapeHtml(titleCaseLanguage(codeLanguage))}</b>\n` : "";

    blocks.push(`${languageLabel}<pre>${escapeHtml(code)}</pre>`);
    codeBuffer = [];
    codeLanguage = "";
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w.+-]+)?\s*$/u);

    if (fenceMatch !== null) {
      if (inCodeFence) {
        flushCode();
        inCodeFence = false;
      } else {
        flushText();
        inCodeFence = true;
        codeLanguage = fenceMatch[1] ?? "";
      }
      continue;
    }

    if (inCodeFence) {
      codeBuffer.push(line);
      continue;
    }

    textBuffer.push(line);
  }

  if (inCodeFence) {
    flushCode();
  } else {
    flushText();
  }

  return blocks.filter((block) => block.length > 0).join("\n\n");
}

function renderTextLines(lines: string[]): string {
  const rendered: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headers = tableCells(lines[index]);
    const separator = tableCells(lines[index + 1]);
    if (headers !== undefined && separator?.length === headers.length
      && separator.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      let rowIndex = index + 2;
      const rows: string[] = [];
      while (rowIndex < lines.length) {
        const cells = tableCells(lines[rowIndex]);
        if (cells === undefined || cells.length !== headers.length) break;
        rows.push(cells.map((cell, column) => `${renderInline(headers[column]!)}: ${renderInline(cell)}`).join("\n"));
        rowIndex += 1;
      }
      if (rows.length > 0) {
        rendered.push(rows.join("\n\n"));
        index = rowIndex - 1;
        continue;
      }
    }
    rendered.push(renderTextLine(lines[index]!, { previous: lines[index - 1], next: lines[index + 1] }));
  }
  return rendered.join("\n");
}

// Only used by the legacy HTML fallback. Native rich Markdown retains its tables.
function tableCells(line: string | undefined): string[] | undefined {
  if (line === undefined || !line.includes("|")) return undefined;
  const trimmed = line.trim().replace(/^\|/u, "").replace(/(?<!\\)\|$/u, "");
  const cells = trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
  return cells.length > 1 ? cells : undefined;
}

function renderTextLine(
  line: string,
  context: {
    previous?: string;
    next?: string;
  }
): string {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/u);

  if (headingMatch !== null) {
    return `<b>${renderInline(headingMatch[1])}</b>`;
  }

  if (isStandaloneSectionHeading(trimmed, context)) {
    return `<b>${renderInline(trimmed)}</b>`;
  }

  if (/^[-*_]{3,}\s*$/u.test(trimmed)) {
    return "────────";
  }

  return renderInline(line);
}

function isStandaloneSectionHeading(
  line: string,
  context: {
    previous?: string;
    next?: string;
  }
): boolean {
  const previousBlank = context.previous === undefined || context.previous.trim().length === 0;
  const nextBlank = context.next === undefined || context.next.trim().length === 0;

  if (!previousBlank || !nextBlank) {
    return false;
  }

  if (line.length > 80 || line.startsWith("-") || /^\d+\./u.test(line) || line.includes("|")) {
    return false;
  }

  return /^[A-Z0-9][A-Za-z0-9/&+ .:_-]*$/u.test(line);
}

function renderInline(input: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < input.length) {
    if (input[cursor] === "[") {
      const link = readMarkdownLink(input, cursor);
      if (link !== undefined) {
        output += `<a href="${escapeHtml(link.url).replaceAll('"', "&quot;")}">${renderInline(link.label)}</a>`;
        cursor = link.end;
        continue;
      }
    }
    if (input.startsWith("**", cursor)) {
      const close = input.indexOf("**", cursor + 2);

      if (close > cursor + 2) {
        output += `<b>${renderInline(input.slice(cursor + 2, close))}</b>`;
        cursor = close + 2;
        continue;
      }
    }

    if (input[cursor] === "`") {
      const close = input.indexOf("`", cursor + 1);

      if (close > cursor + 1) {
        output += `<code>${escapeHtml(input.slice(cursor + 1, close))}</code>`;
        cursor = close + 1;
        continue;
      }
    }

    output += escapeHtml(input[cursor]);
    cursor += 1;
  }

  return output;
}

function titleCaseLanguage(language: string): string {
  if (language.toLowerCase() === "tsx") {
    return "Tsx";
  }

  if (language.toLowerCase() === "ts") {
    return "Ts";
  }

  return language.charAt(0).toUpperCase() + language.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readMarkdownLink(input: string, start: number): { label: string; url: string; end: number } | undefined {
  const labelEnd = input.indexOf("](", start + 1);
  if (labelEnd < 0) return undefined;
  const urlStart = labelEnd + 2;
  let depth = 1;
  for (let end = urlStart; end < input.length; end += 1) {
    if (input[end] === "\n") return undefined;
    if (input[end] === "(") depth += 1;
    if (input[end] !== ")" || --depth !== 0) continue;
    const url = input.slice(urlStart, end);
    // Render links only; never fetch them or allow active/local URI schemes.
    // Keep opening tags bounded so the existing HTML chunk balancer can reopen them safely.
    if (escapeHtml(url).replaceAll('"', "&quot;").length > 512 || /[\s<>\x00-\x1f]/u.test(url)) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    } catch { return undefined; }
    return { label: input.slice(start + 1, labelEnd), url, end: end + 1 };
  }
  return undefined;
}

export function containsTelegramTable(text: string): boolean {
  return /^\s*\|?.*\|.*\n\s*\|?\s*:?-{3,}/mu.test(text);
}
