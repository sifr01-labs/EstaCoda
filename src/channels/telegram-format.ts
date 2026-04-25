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
  return lines
    .map((line, index) => renderTextLine(line, {
      previous: lines[index - 1],
      next: lines[index + 1]
    }))
    .join("\n");
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
    if (input.startsWith("**", cursor)) {
      const close = input.indexOf("**", cursor + 2);

      if (close > cursor + 2) {
        output += `<b>${escapeHtml(input.slice(cursor + 2, close))}</b>`;
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
