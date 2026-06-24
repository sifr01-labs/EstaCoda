import type { NamedColor, TextStyle, UnderlineStyle } from "./types.js";
import { defaultStyle } from "./types.js";

const NAMED_COLORS: NamedColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

const UNDERLINE_STYLES: UnderlineStyle[] = ["none", "single", "double", "curly", "dotted", "dashed"];

type Param = { value: number | null; subparams: number[]; colon: boolean };

function parseParams(value: string): Param[] {
  if (value === "") return [{ value: 0, subparams: [], colon: false }];

  const result: Param[] = [];
  let current: Param = { value: null, subparams: [], colon: false };
  let numberBuffer = "";
  let inSubparams = false;

  for (let i = 0; i <= value.length; i += 1) {
    const char = value[i];
    if (char === ";" || char === undefined) {
      const n = numberBuffer === "" ? null : Number.parseInt(numberBuffer, 10);
      if (inSubparams) {
        if (n !== null) current.subparams.push(n);
      } else {
        current.value = n;
      }
      result.push(current);
      current = { value: null, subparams: [], colon: false };
      numberBuffer = "";
      inSubparams = false;
    } else if (char === ":") {
      const n = numberBuffer === "" ? null : Number.parseInt(numberBuffer, 10);
      if (!inSubparams) {
        current.value = n;
        current.colon = true;
        inSubparams = true;
      } else if (n !== null) {
        current.subparams.push(n);
      }
      numberBuffer = "";
    } else if (char >= "0" && char <= "9") {
      numberBuffer += char;
    }
  }

  return result;
}

function parseExtendedColor(
  params: Param[],
  index: number,
): { r: number; g: number; b: number } | { index: number } | null {
  const current = params[index];
  if (!current) return null;

  if (current.colon && current.subparams.length >= 1) {
    if (current.subparams[0] === 5 && current.subparams.length >= 2) {
      return { index: current.subparams[1]! };
    }
    if (current.subparams[0] === 2 && current.subparams.length >= 4) {
      const offset = current.subparams.length >= 5 ? 1 : 0;
      return {
        r: current.subparams[1 + offset]!,
        g: current.subparams[2 + offset]!,
        b: current.subparams[3 + offset]!,
      };
    }
  }

  const next = params[index + 1];
  if (!next) return null;
  if (next.value === 5 && params[index + 2]?.value !== null && params[index + 2]?.value !== undefined) {
    return { index: params[index + 2]!.value! };
  }
  if (next.value === 2) {
    const r = params[index + 2]?.value;
    const g = params[index + 3]?.value;
    const b = params[index + 4]?.value;
    if (r !== null && r !== undefined && g !== null && g !== undefined && b !== null && b !== undefined) {
      return { r, g, b };
    }
  }

  return null;
}

export function applySGR(paramString: string, style: TextStyle): TextStyle {
  const params = parseParams(paramString);
  let nextStyle = { ...style };
  let i = 0;

  while (i < params.length) {
    const param = params[i]!;
    const code = param.value ?? 0;

    if (code === 0) {
      nextStyle = defaultStyle();
    } else if (code === 1) {
      nextStyle.bold = true;
    } else if (code === 2) {
      nextStyle.dim = true;
    } else if (code === 3) {
      nextStyle.italic = true;
    } else if (code === 4) {
      nextStyle.underline = param.colon ? (UNDERLINE_STYLES[param.subparams[0]!] ?? "single") : "single";
    } else if (code === 5 || code === 6) {
      nextStyle.blink = true;
    } else if (code === 7) {
      nextStyle.inverse = true;
    } else if (code === 8) {
      nextStyle.hidden = true;
    } else if (code === 9) {
      nextStyle.strikethrough = true;
    } else if (code === 21) {
      nextStyle.underline = "double";
    } else if (code === 22) {
      nextStyle.bold = false;
      nextStyle.dim = false;
    } else if (code === 23) {
      nextStyle.italic = false;
    } else if (code === 24) {
      nextStyle.underline = "none";
    } else if (code === 25) {
      nextStyle.blink = false;
    } else if (code === 27) {
      nextStyle.inverse = false;
    } else if (code === 28) {
      nextStyle.hidden = false;
    } else if (code === 29) {
      nextStyle.strikethrough = false;
    } else if (code === 53) {
      nextStyle.overline = true;
    } else if (code === 55) {
      nextStyle.overline = false;
    } else if (code >= 30 && code <= 37) {
      nextStyle.fg = { type: "named", name: NAMED_COLORS[code - 30]! };
    } else if (code === 39) {
      nextStyle.fg = { type: "default" };
    } else if (code >= 40 && code <= 47) {
      nextStyle.bg = { type: "named", name: NAMED_COLORS[code - 40]! };
    } else if (code === 49) {
      nextStyle.bg = { type: "default" };
    } else if (code >= 90 && code <= 97) {
      nextStyle.fg = { type: "named", name: NAMED_COLORS[code - 90 + 8]! };
    } else if (code >= 100 && code <= 107) {
      nextStyle.bg = { type: "named", name: NAMED_COLORS[code - 100 + 8]! };
    } else if (code === 38 || code === 48 || code === 58) {
      const color = parseExtendedColor(params, i);
      if (color) {
        const parsed = "index" in color ? { type: "indexed" as const, index: color.index } : { type: "rgb" as const, ...color };
        if (code === 38) nextStyle.fg = parsed;
        else if (code === 48) nextStyle.bg = parsed;
        else nextStyle.underlineColor = parsed;
        i += param.colon ? 1 : "index" in color ? 3 : 5;
        continue;
      }
    } else if (code === 59) {
      nextStyle.underlineColor = { type: "default" };
    }

    i += 1;
  }

  return nextStyle;
}
