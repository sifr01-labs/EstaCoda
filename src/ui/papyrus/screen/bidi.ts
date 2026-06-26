export type ClusteredChar = {
  value: string;
  width: number;
  styleId: number;
  hyperlink: string | undefined;
};

export type BidiMode = "auto" | "software" | "native" | "off";

type BidiOptions = {
  mode?: BidiMode;
};

type Direction = "ltr" | "rtl" | "neutral";

export function reorderBidi<T extends ClusteredChar>(characters: readonly T[], options?: BidiOptions): T[] | readonly T[] {
  if (characters.length === 0 || !shouldUseSoftwareBidi(options?.mode)) return characters;

  const plainText = characters.map((character) => character.value).join("");
  if (!hasRTLCharacters(plainText)) return characters;

  const reordered = [...characters];
  let start = 0;

  while (start < reordered.length) {
    const direction = directionOf(reordered[start]!.value);
    if (direction !== "rtl") {
      start += 1;
      continue;
    }

    let end = start + 1;
    while (end < reordered.length && directionOf(reordered[end]!.value) === "rtl") end += 1;
    reverseRange(reordered, start, end - 1);
    start = end;
  }

  return reordered;
}

export function hasRTLCharacters(text: string): boolean {
  return /[\u0590-\u05ff\ufb1d-\ufb4f\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u0780-\u07bf\u0700-\u074f]/u.test(
    text,
  );
}

export function shouldUseSoftwareBidi(mode: BidiMode = "auto"): boolean {
  if (mode === "software") return true;
  if (mode === "native" || mode === "off") return false;
  return process.platform === "win32" || process.env.WT_SESSION !== undefined || process.env.TERM_PROGRAM === "vscode";
}

function directionOf(value: string): Direction {
  if (hasRTLCharacters(value)) return "rtl";
  if (/[A-Za-z0-9]/u.test(value)) return "ltr";
  return "neutral";
}

function reverseRange<T>(values: T[], start: number, end: number): void {
  while (start < end) {
    const current = values[start]!;
    values[start] = values[end]!;
    values[end] = current;
    start += 1;
    end -= 1;
  }
}
