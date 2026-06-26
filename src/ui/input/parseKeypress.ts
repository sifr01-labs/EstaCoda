export type ParsedKeyName =
  | "enter"
  | "tab"
  | "backspace"
  | "escape"
  | "up"
  | "down"
  | "right"
  | "left"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "delete"
  | "insert"
  | ControlKeyName;

export type ControlKeyName =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

export type ParsedKeypress =
  | {
      type: "text";
      text: string;
      alt?: boolean;
    }
  | {
      type: "key";
      key: ParsedKeyName;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
    }
  | {
      type: "paste";
      text: string;
    }
  | {
      type: "unknown";
      sequence: string;
    };

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function parseKeypress(input: string): ParsedKeypress[] {
  const events: ParsedKeypress[] = [];
  let index = 0;

  while (index < input.length) {
    if (input.startsWith(BRACKETED_PASTE_START, index)) {
      const pasteStart = index + BRACKETED_PASTE_START.length;
      const pasteEnd = input.indexOf(BRACKETED_PASTE_END, pasteStart);
      if (pasteEnd === -1) {
        events.push({ type: "unknown", sequence: input.slice(index) });
        break;
      }
      events.push({ type: "paste", text: input.slice(pasteStart, pasteEnd) });
      index = pasteEnd + BRACKETED_PASTE_END.length;
      continue;
    }

    const char = input[index]!;

    if (char === ESC) {
      const parsed = parseEscapeSequence(input, index);
      events.push(parsed.event);
      index += parsed.length;
      continue;
    }

    const control = parseControl(input, index);
    if (control !== undefined) {
      events.push(control.event);
      index += control.length;
      continue;
    }

    const textStart = index;
    while (index < input.length) {
      if (input.startsWith(BRACKETED_PASTE_START, index)) break;
      const nextChar = input[index]!;
      if (nextChar === ESC || parseControl(input, index) !== undefined) break;
      index += readGrapheme(input, index).length;
    }
    if (index > textStart) events.push({ type: "text", text: input.slice(textStart, index) });
  }

  return events;
}

function parseControl(input: string, index: number): { event: ParsedKeypress; length: number } | undefined {
  const code = input.charCodeAt(index);

  if (input[index] === "\r" && input[index + 1] === "\n") {
    return { event: { type: "key", key: "enter" }, length: 2 };
  }
  if (input[index] === "\r" || input[index] === "\n") {
    return { event: { type: "key", key: "enter" }, length: 1 };
  }
  if (input[index] === "\t") return { event: { type: "key", key: "tab" }, length: 1 };
  if (input[index] === "\b" || input[index] === "\x7f") {
    return { event: { type: "key", key: "backspace" }, length: 1 };
  }
  if (code >= 0x01 && code <= 0x1a) {
    return {
      event: { type: "key", key: String.fromCharCode(0x60 + code) as ControlKeyName, ctrl: true },
      length: 1,
    };
  }
  if (code === 0x00 || (code >= 0x1c && code <= 0x1f)) {
    return { event: { type: "unknown", sequence: input[index]! }, length: 1 };
  }

  return undefined;
}

function parseEscapeSequence(input: string, index: number): { event: ParsedKeypress; length: number } {
  const next = input[index + 1];
  if (next === undefined) return { event: { type: "key", key: "escape" }, length: 1 };

  if (next === "[") {
    const csi = readCsiSequence(input, index);
    if (csi === undefined) return { event: { type: "unknown", sequence: input.slice(index) }, length: input.length - index };
    return { event: parseCsiEvent(csi) ?? { type: "unknown", sequence: csi }, length: csi.length };
  }

  if (next === "O") {
    const sequence = input.slice(index, Math.min(input.length, index + 3));
    if (sequence.length < 3) return { event: { type: "unknown", sequence }, length: sequence.length };
    return { event: parseApplicationCursorEvent(sequence) ?? { type: "unknown", sequence }, length: sequence.length };
  }

  const altGrapheme = readGrapheme(input, index + 1);
  const altControl = parseControl(input, index + 1);
  if (altControl !== undefined && altControl.event.type === "key") {
    return { event: { ...altControl.event, alt: true }, length: 1 + altControl.length };
  }
  if (altGrapheme.length > 0 && parseControl(altGrapheme, 0) === undefined && altGrapheme !== ESC) {
    return { event: { type: "text", text: altGrapheme, alt: true }, length: 1 + altGrapheme.length };
  }

  return { event: { type: "unknown", sequence: input.slice(index, index + 2) }, length: 2 };
}

function readCsiSequence(input: string, index: number): string | undefined {
  for (let cursor = index + 2; cursor < input.length; cursor += 1) {
    const code = input.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return input.slice(index, cursor + 1);
  }
  return undefined;
}

function parseApplicationCursorEvent(sequence: string): ParsedKeypress | undefined {
  const final = sequence[2];
  if (final === "A") return { type: "key", key: "up" };
  if (final === "B") return { type: "key", key: "down" };
  if (final === "C") return { type: "key", key: "right" };
  if (final === "D") return { type: "key", key: "left" };
  if (final === "H") return { type: "key", key: "home" };
  if (final === "F") return { type: "key", key: "end" };
  return undefined;
}

function parseCsiEvent(sequence: string): ParsedKeypress | undefined {
  const final = sequence[sequence.length - 1]!;
  const body = sequence.slice(2, -1);
  const params = body.length > 0 ? body.split(";") : [];
  const modifiers = modifiersFromParams(params);

  if (final === "A") return { type: "key", key: "up", ...modifiers };
  if (final === "B") return { type: "key", key: "down", ...modifiers };
  if (final === "C") return { type: "key", key: "right", ...modifiers };
  if (final === "D") return { type: "key", key: "left", ...modifiers };
  if (final === "H") return { type: "key", key: "home", ...modifiers };
  if (final === "F") return { type: "key", key: "end", ...modifiers };
  if (final === "Z") return { type: "key", key: "tab", shift: true };

  if (final !== "~") return undefined;

  const keyCode = Number(params[0] ?? "");
  const key = tildeKeyName(keyCode);
  if (key === undefined) return undefined;
  return { type: "key", key, ...modifiers };
}

function modifiersFromParams(params: string[]): Pick<Extract<ParsedKeypress, { type: "key" }>, "alt" | "ctrl" | "shift"> {
  if (params.length < 2) return {};
  const encoded = Number(params[params.length - 1]);
  if (!Number.isFinite(encoded) || encoded <= 1) return {};
  const bits = encoded - 1;
  return {
    ...(bits & 1 ? { shift: true } : {}),
    ...(bits & 2 ? { alt: true } : {}),
    ...(bits & 4 ? { ctrl: true } : {}),
  };
}

function tildeKeyName(code: number): ParsedKeyName | undefined {
  if (code === 1 || code === 7) return "home";
  if (code === 2) return "insert";
  if (code === 3) return "delete";
  if (code === 4 || code === 8) return "end";
  if (code === 5) return "pageup";
  if (code === 6) return "pagedown";
  return undefined;
}

function readGrapheme(text: string, index: number): string {
  const value = text.slice(index);
  if (graphemeSegmenter !== undefined) {
    const next = graphemeSegmenter.segment(value)[Symbol.iterator]().next();
    if (!next.done) return next.value.segment;
  }
  return Array.from(value)[0] ?? "";
}
