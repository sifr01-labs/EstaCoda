const ANSI_PATTERN =
  /(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b[ -/]*[@-~])/gu;
const SINGLE_CELL_TERMINAL_SYMBOLS = new Set(["✓", "✗", "×"]);

const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function stringWidth(value: string): number {
  if (value.length === 0) return 0;

  let ascii = true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b || code >= 0x7f) {
      ascii = false;
      break;
    }
  }

  if (ascii) {
    let width = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code > 0x1f && code !== 0x7f) width += 1;
    }
    return width;
  }

  const stripped = value.includes("\x1b") ? stripAnsi(value) : value;
  if (stripped.length === 0) return 0;

  let width = 0;
  for (const grapheme of segmentGraphemes(stripped)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

function segmentGraphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0) return 0;
  if (isEmojiGrapheme(grapheme)) return emojiWidth(grapheme);

  for (const char of grapheme) {
    const codePoint = char.codePointAt(0)!;
    if (!isZeroWidth(codePoint)) return isWideCodePoint(codePoint) ? 2 : 1;
  }
  return 0;
}

function emojiWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0);
  const second = grapheme.codePointAt(1);
  if (
    second === 0xfe0f &&
    !grapheme.includes("\u20e3") &&
    first !== undefined &&
    ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
  ) {
    return 1;
  }
  if (first !== undefined && first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0;
    for (const _ of grapheme) count += 1;
    return count === 1 ? 1 : 2;
  }
  return 2;
}

function isEmojiGrapheme(grapheme: string): boolean {
  if (SINGLE_CELL_TERMINAL_SYMBOLS.has(grapheme)) return false;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0)!;
    if (
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
      (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
    ) {
      return true;
    }
  }
  return grapheme.includes("\ufe0f") && /[0-9#*©®™]/u.test(grapheme);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function isZeroWidth(codePoint: number): boolean {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  if (codePoint === 0x00ad) return true;
  if ((codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)) return true;
  if ((codePoint >= 0x1dc0 && codePoint <= 0x1dff) || (codePoint >= 0x20d0 && codePoint <= 0x20ff)) return true;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)) return true;
  if ((codePoint >= 0x200b && codePoint <= 0x200f) || (codePoint >= 0x202a && codePoint <= 0x202e)) return true;
  if ((codePoint >= 0x2060 && codePoint <= 0x2064) || (codePoint >= 0x2066 && codePoint <= 0x2069)) return true;
  if (codePoint === 0xfeff) return true;
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true;
  return false;
}
