import { C0, ESC_TYPE, isEscFinal } from "./ansi.js";
import { isCSIFinal, isCSIIntermediate, isCSIParam } from "./csi.js";

export type Token = { type: "text"; value: string } | { type: "sequence"; value: string };

type State = "ground" | "escape" | "escapeIntermediate" | "csi" | "ss3" | "osc" | "dcs" | "apc";

export type Tokenizer = {
  feed(input: string): Token[];
  flush(): Token[];
  reset(): void;
  buffer(): string;
};

export type TokenizerOptions = {
  x10Mouse?: boolean;
};

export function createTokenizer(options?: TokenizerOptions): Tokenizer {
  let currentState: State = "ground";
  let currentBuffer = "";
  const x10Mouse = options?.x10Mouse ?? false;

  return {
    feed(input: string): Token[] {
      const result = tokenize(input, currentState, currentBuffer, false, x10Mouse);
      currentState = result.state.state;
      currentBuffer = result.state.buffer;
      return result.tokens;
    },
    flush(): Token[] {
      const result = tokenize("", currentState, currentBuffer, true, x10Mouse);
      currentState = result.state.state;
      currentBuffer = result.state.buffer;
      return result.tokens;
    },
    reset(): void {
      currentState = "ground";
      currentBuffer = "";
    },
    buffer(): string {
      return currentBuffer;
    },
  };
}

type InternalState = {
  state: State;
  buffer: string;
};

function tokenize(
  input: string,
  initialState: State,
  initialBuffer: string,
  flush: boolean,
  x10Mouse: boolean,
): { tokens: Token[]; state: InternalState } {
  const tokens: Token[] = [];
  const state: InternalState = { state: initialState, buffer: "" };
  const data = initialBuffer + input;
  let i = 0;
  let textStart = 0;
  let sequenceStart = 0;

  const flushText = (): void => {
    if (i > textStart) {
      const text = data.slice(textStart, i);
      if (text) tokens.push({ type: "text", value: text });
    }
    textStart = i;
  };

  const emitSequence = (sequence: string): void => {
    if (sequence) tokens.push({ type: "sequence", value: sequence });
    state.state = "ground";
    textStart = i;
  };

  while (i < data.length) {
    const code = data.charCodeAt(i);

    switch (state.state) {
      case "ground":
        if (code === C0.ESC) {
          flushText();
          sequenceStart = i;
          state.state = "escape";
          i += 1;
        } else {
          i += 1;
        }
        break;

      case "escape":
        if (code === ESC_TYPE.CSI) {
          state.state = "csi";
          i += 1;
        } else if (code === ESC_TYPE.OSC) {
          state.state = "osc";
          i += 1;
        } else if (code === ESC_TYPE.DCS) {
          state.state = "dcs";
          i += 1;
        } else if (code === ESC_TYPE.APC) {
          state.state = "apc";
          i += 1;
        } else if (code === 0x4f) {
          state.state = "ss3";
          i += 1;
        } else if (isCSIIntermediate(code)) {
          state.state = "escapeIntermediate";
          i += 1;
        } else if (isEscFinal(code)) {
          i += 1;
          emitSequence(data.slice(sequenceStart, i));
        } else if (code === C0.ESC) {
          emitSequence(data.slice(sequenceStart, i));
          sequenceStart = i;
          state.state = "escape";
          i += 1;
        } else {
          state.state = "ground";
          textStart = sequenceStart;
        }
        break;

      case "escapeIntermediate":
        if (isCSIIntermediate(code)) {
          i += 1;
        } else if (isEscFinal(code)) {
          i += 1;
          emitSequence(data.slice(sequenceStart, i));
        } else {
          state.state = "ground";
          textStart = sequenceStart;
        }
        break;

      case "csi":
        if (
          x10Mouse &&
          code === 0x4d &&
          i - sequenceStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4;
            emitSequence(data.slice(sequenceStart, i));
          } else {
            i = data.length;
          }
        } else if (isCSIFinal(code)) {
          i += 1;
          emitSequence(data.slice(sequenceStart, i));
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i += 1;
        } else {
          state.state = "ground";
          textStart = sequenceStart;
        }
        break;

      case "ss3":
        if (code >= 0x40 && code <= 0x7e) {
          i += 1;
          emitSequence(data.slice(sequenceStart, i));
        } else {
          state.state = "ground";
          textStart = sequenceStart;
        }
        break;

      case "osc":
      case "dcs":
      case "apc":
        if (code === C0.BEL) {
          i += 1;
          emitSequence(data.slice(sequenceStart, i));
        } else if (code === C0.ESC && i + 1 < data.length && data.charCodeAt(i + 1) === ESC_TYPE.ST) {
          i += 2;
          emitSequence(data.slice(sequenceStart, i));
        } else {
          i += 1;
        }
        break;
    }
  }

  if (state.state === "ground") {
    flushText();
  } else if (flush) {
    const remaining = data.slice(sequenceStart);
    if (remaining) tokens.push({ type: "sequence", value: remaining });
    state.state = "ground";
  } else {
    state.buffer = data.slice(sequenceStart);
  }

  return { tokens, state };
}
