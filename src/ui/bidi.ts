// Bidi isolation and render-time preparation helpers for terminal text.
// These helpers preserve logical text order; full visual reordering belongs to
// the terminal or a separately selected UAX #9 backend.

export const LRI = "\u2066";
export const RLI = "\u2067";
export const FSI = "\u2068";
export const PDI = "\u2069";

const RTL_TEXT_PATTERN = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const UNSAFE_UNTRUSTED_BIDI_CONTROLS = new Set([
  "\u061c", // Arabic Letter Mark
  "\u200e", // Left-to-Right Mark
  "\u200f", // Right-to-Left Mark
  "\u202a", // Left-to-Right Embedding
  "\u202b", // Right-to-Left Embedding
  "\u202c", // Pop Directional Formatting
  "\u202d", // Left-to-Right Override
  "\u202e", // Right-to-Left Override
  "\u206a", // Inhibit Symmetric Swapping (deprecated)
  "\u206b", // Activate Symmetric Swapping (deprecated)
  "\u206c", // Inhibit Arabic Form Shaping (deprecated)
  "\u206d", // Activate Arabic Form Shaping (deprecated)
  "\u206e", // National Digit Shapes (deprecated)
  "\u206f", // Nominal Digit Shapes (deprecated)
]);

const COMMON_TECHNICAL_TOKEN_SOURCES = [
  "`[^`\\r\\n]+`",
  "https?:\\/\\/[^\\s<>{}\\[\\]()]+",
  "(?:~|\\.{1,2})?\\/[^\\s<>{}\\[\\]()]+",
  "\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b",
  "\\b(?:Ctrl|Alt|Shift|Cmd|Meta)\\+[A-Za-z0-9]+\\b",
  "\\bv?\\d+(?:\\.\\d+)+(?:[-+][A-Za-z0-9.-]+)?\\b",
  "\\b[A-Za-z][A-Za-z0-9]*(?:[-_.:/][A-Za-z0-9]+)+\\b",
  "\\b[A-Za-z][A-Za-z0-9]*(?:[ \\t]+[A-Za-z][A-Za-z0-9]*)*\\b",
  "\\b\\d+(?:[.,:/]\\d+)*(?:[kKmMgG%])?\\b",
];

export type BidiTextSource = "trusted" | "untrusted";

export type TechnicalTokenIsolationOptions = {
  readonly tokens?: readonly string[];
  readonly detectCommonTokens?: boolean;
};

export type BidiTextPreparationOptions = TechnicalTokenIsolationOptions & {
  readonly source?: BidiTextSource;
};

/**
 * Wraps a value in Left-to-Right Isolate (LRI) and Pop Directional Isolate (PDI)
 * so it stays LTR-stable when embedded in RTL (Arabic) text.
 */
export function isolateLtr(value: string): string {
  return `${LRI}${value}${PDI}`;
}

/**
 * Wraps natural-language RTL text in Right-to-Left Isolate (RLI) and
 * Pop Directional Isolate (PDI) for render-time terminal stability.
 */
export function isolateRtl(value: string): string {
  return `${RLI}${value}${PDI}`;
}

/**
 * Wraps text in First Strong Isolate (FSI), allowing the Unicode bidi
 * algorithm to select the direction from the text rather than its container.
 */
export function isolateAuto(value: string): string {
  return `${FSI}${value}${PDI}`;
}

export function hasRtlText(value: string): boolean {
  return RTL_TEXT_PATTERN.test(value);
}

/**
 * Keeps app-authored controls intact, while containing untrusted text to each
 * logical line. Untrusted legacy marks/overrides and unmatched PDIs are
 * removed; balanced isolates are preserved and open isolates are closed.
 */
export function sanitizeBidiControls(value: string, source: BidiTextSource = "untrusted"): string {
  if (source === "trusted") return value;
  return mapLogicalLines(value, sanitizeUntrustedBidiLine);
}

/**
 * Isolates explicit technical spans, plus high-confidence common spans when
 * embedded in RTL text. Existing isolates and ANSI sequences remain intact.
 */
export function isolateTechnicalTokens(
  value: string,
  options: TechnicalTokenIsolationOptions = {}
): string {
  const explicitTokens = [...new Set(options.tokens ?? [])]
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length);
  if (explicitTokens.length === 0 && !RTL_TEXT_PATTERN.test(value)) return value;

  const sources: string[] = [];
  if (explicitTokens.length > 0) {
    sources.push(explicitTokens.map(escapeRegExp).join("|"));
  }
  if (options.detectCommonTokens !== false) {
    sources.push(...COMMON_TECHNICAL_TOKEN_SOURCES);
  }
  if (sources.length === 0) return value;

  const tokenPattern = new RegExp(`(?:${sources.join("|")})`, "gu");
  let result = "";
  let index = 0;
  let isolateDepth = 0;

  while (index < value.length) {
    const ansi = readAnsiSequence(value, index);
    if (ansi !== undefined) {
      result += ansi;
      index += ansi.length;
      continue;
    }

    const nextAnsi = value.indexOf("\x1b", index);
    const end = nextAnsi === -1 ? value.length : nextAnsi;
    const text = value.slice(index, end);
    result += text.replace(tokenPattern, (token, offset: number) => (
      isolationDepthAt(text, offset, isolateDepth) > 0 ? token : isolateLtr(token)
    ));
    isolateDepth = isolationDepthAt(text, text.length, isolateDepth);
    index = end;
  }

  return result;
}

/**
 * Prepares complete logical lines before a renderer wraps them. This does not
 * visually reorder text or add an outer paragraph isolate; renderers can wrap
 * first and then use isolateAuto() for each resulting visual segment.
 */
export function prepareBidiTextForWrapping(
  value: string,
  options: BidiTextPreparationOptions = {}
): string {
  const sanitized = sanitizeBidiControls(value, options.source);
  return mapLogicalLines(sanitized, (line) => isolateTechnicalTokens(line, options));
}

/**
 * Reopens isolates that span a visual wrap boundary and closes them at the end
 * of each segment. The logical isolate stack is carried forward unchanged.
 */
export function balanceBidiIsolatesAcrossSegments(
  segments: readonly string[]
): readonly string[] {
  const openIsolates: string[] = [];
  return segments.map((segment) => {
    const prefix = openIsolates.join("");
    updateIsolateStack(segment, openIsolates);
    return `${prefix}${segment}${PDI.repeat(openIsolates.length)}`;
  });
}

export function closeOpenBidiIsolates(value: string): string {
  const openIsolates = isolationDepthAt(value, value.length, 0);
  return openIsolates === 0 ? value : `${value}${PDI.repeat(openIsolates)}`;
}

function sanitizeUntrustedBidiLine(value: string): string {
  let result = "";
  let index = 0;
  let isolateDepth = 0;

  while (index < value.length) {
    const ansi = readAnsiSequence(value, index);
    if (ansi !== undefined) {
      result += ansi;
      index += ansi.length;
      continue;
    }

    const char = value[index]!;
    if (UNSAFE_UNTRUSTED_BIDI_CONTROLS.has(char)) {
      index += char.length;
      continue;
    }
    if (isIsolateOpener(char)) {
      isolateDepth += 1;
      result += char;
    } else if (char === PDI) {
      if (isolateDepth > 0) {
        isolateDepth -= 1;
        result += char;
      }
    } else {
      result += char;
    }
    index += char.length;
  }

  return isolateDepth === 0 ? result : `${result}${PDI.repeat(isolateDepth)}`;
}

function mapLogicalLines(value: string, formatLine: (line: string) => string): string {
  return value
    .split(/(\r\n|\n|\r)/u)
    .map((part, index) => index % 2 === 0 ? formatLine(part) : part)
    .join("");
}

function isolationDepthAt(value: string, offset: number, initialDepth: number): number {
  let depth = initialDepth;
  for (let index = 0; index < offset;) {
    const ansi = readAnsiSequence(value, index);
    if (ansi !== undefined) {
      index += ansi.length;
      continue;
    }

    const char = value[index]!;
    if (isIsolateOpener(char)) {
      depth += 1;
    } else if (char === PDI && depth > 0) {
      depth -= 1;
    }
    index += char.length;
  }
  return depth;
}

function updateIsolateStack(value: string, stack: string[]): void {
  for (let index = 0; index < value.length;) {
    const ansi = readAnsiSequence(value, index);
    if (ansi !== undefined) {
      index += ansi.length;
      continue;
    }

    const char = value[index]!;
    if (isIsolateOpener(char)) {
      stack.push(char);
    } else if (char === PDI && stack.length > 0) {
      stack.pop();
    }
    index += char.length;
  }
}

function isIsolateOpener(value: string): boolean {
  return value === LRI || value === RLI || value === FSI;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAnsiSequence(value: string, index: number): string | undefined {
  if (value.charCodeAt(index) !== 0x1b) return undefined;
  const next = value[index + 1];
  if (next === undefined) return value[index];

  if (next === "[") {
    for (let cursor = index + 2; cursor < value.length; cursor += 1) {
      const code = value.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return value.slice(index, cursor + 1);
    }
    return value.slice(index);
  }

  if (next === "]") {
    for (let cursor = index + 2; cursor < value.length; cursor += 1) {
      if (value.charCodeAt(cursor) === 0x07) return value.slice(index, cursor + 1);
      if (value.charCodeAt(cursor) === 0x1b && value[cursor + 1] === "\\") {
        return value.slice(index, cursor + 2);
      }
    }
    return value.slice(index);
  }

  return value.slice(index, Math.min(value.length, index + 2));
}
