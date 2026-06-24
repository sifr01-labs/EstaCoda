import { C0, ESC_TYPE } from "./ansi.js";
import { CSI, CURSOR_STYLES, ERASE_DISPLAY, ERASE_LINE_REGION } from "./csi.js";
import { DEC } from "./dec.js";
import { parseEsc } from "./esc.js";
import { parseOSC } from "./osc.js";
import { applySGR } from "./sgr.js";
import { createTokenizer, type Token, type Tokenizer } from "./tokenize.js";
import type { Action, Grapheme, TextStyle } from "./types.js";
import { defaultStyle } from "./types.js";

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe1f) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

function graphemeWidth(value: string): 1 | 2 {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && isWideCodePoint(codePoint) ? 2 : 1;
}

function segmentText(text: string): Grapheme[] {
  return Array.from(text, (value) => ({ value, width: graphemeWidth(value) }));
}

function parseCSIParams(paramString: string): number[] {
  if (paramString === "") return [];
  return paramString.split(/[;:]/).map((value) => (value === "" ? 0 : Number.parseInt(value, 10)));
}

function parseCSI(rawSequence: string): Action | null {
  const inner = rawSequence.slice(2);
  if (inner.length === 0) return null;

  const finalByte = inner.charCodeAt(inner.length - 1);
  const beforeFinal = inner.slice(0, -1);
  let privateMode = "";
  let paramString = beforeFinal;
  let intermediate = "";

  if (beforeFinal.length > 0 && "?>=".includes(beforeFinal[0]!)) {
    privateMode = beforeFinal[0]!;
    paramString = beforeFinal.slice(1);
  }

  const intermediateMatch = paramString.match(/([^0-9;:]+)$/);
  if (intermediateMatch) {
    intermediate = intermediateMatch[1]!;
    paramString = paramString.slice(0, -intermediate.length);
  }

  const params = parseCSIParams(paramString);
  const p0 = params[0] ?? 1;
  const p1 = params[1] ?? 1;

  if (finalByte === CSI.SGR && privateMode === "") return { type: "sgr", params: paramString };
  if (finalByte === CSI.CUU) return { type: "cursor", action: { type: "move", direction: "up", count: p0 } };
  if (finalByte === CSI.CUD) return { type: "cursor", action: { type: "move", direction: "down", count: p0 } };
  if (finalByte === CSI.CUF) return { type: "cursor", action: { type: "move", direction: "forward", count: p0 } };
  if (finalByte === CSI.CUB) return { type: "cursor", action: { type: "move", direction: "back", count: p0 } };
  if (finalByte === CSI.CNL) return { type: "cursor", action: { type: "nextLine", count: p0 } };
  if (finalByte === CSI.CPL) return { type: "cursor", action: { type: "prevLine", count: p0 } };
  if (finalByte === CSI.CHA) return { type: "cursor", action: { type: "column", col: p0 } };
  if (finalByte === CSI.CUP || finalByte === CSI.HVP) return { type: "cursor", action: { type: "position", row: p0, col: p1 } };
  if (finalByte === CSI.VPA) return { type: "cursor", action: { type: "row", row: p0 } };
  if (finalByte === CSI.ED) return { type: "erase", action: { type: "display", region: ERASE_DISPLAY[params[0] ?? 0] ?? "toEnd" } };
  if (finalByte === CSI.EL) return { type: "erase", action: { type: "line", region: ERASE_LINE_REGION[params[0] ?? 0] ?? "toEnd" } };
  if (finalByte === CSI.ECH) return { type: "erase", action: { type: "chars", count: p0 } };
  if (finalByte === CSI.SU) return { type: "scroll", action: { type: "up", count: p0 } };
  if (finalByte === CSI.SD) return { type: "scroll", action: { type: "down", count: p0 } };
  if (finalByte === CSI.DECSTBM) return { type: "scroll", action: { type: "setRegion", top: p0, bottom: p1 } };
  if (finalByte === CSI.SCOSC) return { type: "cursor", action: { type: "save" } };
  if (finalByte === CSI.SCORC) return { type: "cursor", action: { type: "restore" } };
  if (finalByte === CSI.DECSCUSR && intermediate === " ") {
    const styleInfo = CURSOR_STYLES[p0] ?? CURSOR_STYLES[0]!;
    return { type: "cursor", action: { type: "style", ...styleInfo } };
  }

  if (privateMode === "?" && (finalByte === CSI.SM || finalByte === CSI.RM)) {
    const enabled = finalByte === CSI.SM;
    if (p0 === DEC.CURSOR_VISIBLE) return { type: "cursor", action: enabled ? { type: "show" } : { type: "hide" } };
    if (p0 === DEC.ALT_SCREEN_CLEAR || p0 === DEC.ALT_SCREEN) return { type: "mode", action: { type: "alternateScreen", enabled } };
    if (p0 === DEC.BRACKETED_PASTE) return { type: "mode", action: { type: "bracketedPaste", enabled } };
    if (p0 === DEC.MOUSE_NORMAL) return { type: "mode", action: { type: "mouseTracking", mode: enabled ? "normal" : "off" } };
    if (p0 === DEC.MOUSE_BUTTON) return { type: "mode", action: { type: "mouseTracking", mode: enabled ? "button" : "off" } };
    if (p0 === DEC.MOUSE_ANY) return { type: "mode", action: { type: "mouseTracking", mode: enabled ? "any" : "off" } };
    if (p0 === DEC.FOCUS_EVENTS) return { type: "mode", action: { type: "focusEvents", enabled } };
  }

  return { type: "unknown", sequence: rawSequence };
}

function identifySequence(sequence: string): "csi" | "osc" | "esc" | "ss3" | "unknown" {
  if (sequence.length < 2 || sequence.charCodeAt(0) !== C0.ESC) return "unknown";
  const second = sequence.charCodeAt(1);
  if (second === ESC_TYPE.CSI) return "csi";
  if (second === ESC_TYPE.OSC) return "osc";
  if (second === 0x4f) return "ss3";
  return "esc";
}

export class Parser {
  private tokenizer: Tokenizer = createTokenizer();
  style: TextStyle = defaultStyle();

  reset(): void {
    this.tokenizer.reset();
    this.style = defaultStyle();
  }

  feed(input: string): Action[] {
    const actions: Action[] = [];
    for (const token of this.tokenizer.feed(input)) {
      actions.push(...this.processToken(token));
    }
    return actions;
  }

  flush(): Action[] {
    const actions: Action[] = [];
    for (const token of this.tokenizer.flush()) {
      actions.push(...this.processToken(token));
    }
    return actions;
  }

  private processToken(token: Token): Action[] {
    if (token.type === "text") return this.processText(token.value);
    return this.processSequence(token.value);
  }

  private processText(text: string): Action[] {
    const actions: Action[] = [];
    let current = "";

    for (const char of text) {
      if (char.charCodeAt(0) === C0.BEL) {
        if (current) {
          actions.push({ type: "text", graphemes: segmentText(current), style: { ...this.style } });
          current = "";
        }
        actions.push({ type: "bell" });
      } else {
        current += char;
      }
    }

    if (current) actions.push({ type: "text", graphemes: segmentText(current), style: { ...this.style } });
    return actions;
  }

  private processSequence(sequence: string): Action[] {
    const sequenceType = identifySequence(sequence);

    if (sequenceType === "csi") {
      const action = parseCSI(sequence);
      if (!action) return [];
      if (action.type === "sgr") {
        this.style = applySGR(action.params, this.style);
        return [];
      }
      return [action];
    }

    if (sequenceType === "osc") {
      let content = sequence.slice(2);
      if (content.endsWith("\x07")) content = content.slice(0, -1);
      else if (content.endsWith("\x1b\\")) content = content.slice(0, -2);
      const action = parseOSC(content);
      return action ? [action] : [];
    }

    if (sequenceType === "esc") {
      const action = parseEsc(sequence.slice(1));
      return action ? [action] : [];
    }

    return [{ type: "unknown", sequence }];
  }
}

export function parseAnsi(input: string): Action[] {
  const parser = new Parser();
  return [...parser.feed(input), ...parser.flush()];
}
