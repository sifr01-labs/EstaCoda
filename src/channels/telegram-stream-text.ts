export type TelegramStreamTextChunk = {
  visibleText: string;
  visibleCharCount: number;
  escapedHtml: string;
  escapedUtf16Length: number;
};

export type TelegramStreamTextSnapshot = {
  visibleText: string;
  visibleCharCount: number;
  escapedHtml: string;
  escapedUtf16Length: number;
};

export type TelegramStreamTextSanitizer = {
  append(delta: string): TelegramStreamTextChunk;
  snapshot(): TelegramStreamTextSnapshot;
  reset(): void;
};

type ThinkMode = "visible" | "hidden";

const OPEN_THINK = "<think>";
const CLOSE_THINK = "</think>";
const THINK_PREFIXES = prefixes(OPEN_THINK);
const CLOSE_THINK_PREFIXES = prefixes(CLOSE_THINK);
const MEDIA_MARKER = "media:";
const MEDIA_DIRECTIVE_LINE = /^[ \t]*MEDIA:[ \t]*\S+[^\r\n]*(?:\r?\n|$)/gimu;

export function createTelegramStreamTextSanitizer(): TelegramStreamTextSanitizer {
  let mode: ThinkMode = "visible";
  let pending = "";
  let mediaPending = "";
  let visibleText = "";

  function applyVisible(text: string): string {
    const stripped = filterMediaDirectives(text);
    visibleText += stripped;
    return stripped;
  }

  function filterMediaDirectives(text: string): string {
    const combined = mediaPending + text;
    mediaPending = "";

    const lastLineStart = combined.lastIndexOf("\n") + 1;
    const stableLines = combined.slice(0, lastLineStart);
    const tail = combined.slice(lastLineStart);
    let emitted = stripTelegramMediaDirectives(stableLines);

    if (isPossibleMediaDirectiveTail(tail)) {
      mediaPending = tail;
      return emitted;
    }

    emitted += stripTelegramMediaDirectives(tail);
    return emitted;
  }

  function process(input: string): string {
    let emitted = "";
    let cursor = 0;

    while (cursor < input.length) {
      const remaining = input.slice(cursor);

      if (mode === "hidden") {
        const closeIndex = remaining.toLowerCase().indexOf(CLOSE_THINK);
        if (closeIndex >= 0) {
          cursor += closeIndex + CLOSE_THINK.length;
          mode = "visible";
          continue;
        }

        const hiddenTail = longestSuffixPrefix(remaining, CLOSE_THINK_PREFIXES);
        pending = hiddenTail;
        cursor = input.length;
        break;
      }

      const lowerRemaining = remaining.toLowerCase();
      const openIndex = lowerRemaining.indexOf(OPEN_THINK);
      const safeEnd = openIndex >= 0
        ? cursor + openIndex
        : input.length - longestSuffixPrefix(remaining, THINK_PREFIXES).length;

      if (safeEnd > cursor) {
        emitted += applyVisible(input.slice(cursor, safeEnd));
        cursor = safeEnd;
      }

      if (openIndex >= 0 && cursor === input.length - remaining.length + openIndex) {
        cursor += OPEN_THINK.length;
        mode = "hidden";
        pending = "";
        continue;
      }

      if (cursor < input.length) {
        pending = input.slice(cursor);
        cursor = input.length;
      }
    }

    return emitted;
  }

  return {
    append(delta) {
      const input = pending + delta;
      pending = "";
      const emitted = process(input);
      return textChunk(emitted);
    },
    snapshot() {
      return textSnapshot(visibleText);
    },
    reset() {
      mode = "visible";
      pending = "";
      mediaPending = "";
      visibleText = "";
    }
  };
}

export function escapeTelegramPartialHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function getUtf16Length(text: string): number {
  return text.length;
}

export function getVisibleCharCount(text: string): number {
  return Array.from(text).length;
}

export function escapedTelegramPartialHtmlExceedsLimit(text: string, maxUtf16Length: number): boolean {
  return getUtf16Length(escapeTelegramPartialHtml(text)) > maxUtf16Length;
}

export function stripTelegramMediaDirectives(text: string): string {
  return text.replace(MEDIA_DIRECTIVE_LINE, "");
}

function textChunk(visibleText: string): TelegramStreamTextChunk {
  const escapedHtml = escapeTelegramPartialHtml(visibleText);
  return {
    visibleText,
    visibleCharCount: getVisibleCharCount(visibleText),
    escapedHtml,
    escapedUtf16Length: getUtf16Length(escapedHtml)
  };
}

function textSnapshot(visibleText: string): TelegramStreamTextSnapshot {
  const escapedHtml = escapeTelegramPartialHtml(visibleText);
  return {
    visibleText,
    visibleCharCount: getVisibleCharCount(visibleText),
    escapedHtml,
    escapedUtf16Length: getUtf16Length(escapedHtml)
  };
}

function prefixes(value: string): string[] {
  const result: string[] = [];
  for (let index = 1; index < value.length; index += 1) {
    result.push(value.slice(0, index).toLowerCase());
  }
  return result;
}

function longestSuffixPrefix(text: string, candidates: readonly string[]): string {
  const lower = text.toLowerCase();
  let longest = "";
  for (const candidate of candidates) {
    if (candidate.length > longest.length && lower.endsWith(candidate)) {
      longest = text.slice(text.length - candidate.length);
    }
  }
  return longest;
}

function isPossibleMediaDirectiveTail(text: string): boolean {
  if (text.length === 0) {
    return false;
  }

  const markerCandidate = text.replace(/^[ \t]*/, "").toLowerCase();
  return markerCandidate.length === 0
    || MEDIA_MARKER.startsWith(markerCandidate)
    || markerCandidate.startsWith(MEDIA_MARKER);
}
