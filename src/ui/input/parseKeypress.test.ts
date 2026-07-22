import { describe, expect, it } from "vitest";
import { createInitialKeypressParseState, parseKeypress, parseKeypressStream } from "./parseKeypress.js";

describe("parseKeypress", () => {
  it("parses printable ASCII text", () => {
    expect(parseKeypress("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("parses Arabic printable text", () => {
    expect(parseKeypress("مرحبا")).toEqual([{ type: "text", text: "مرحبا" }]);
  });

  it("parses emoji input without splitting the grapheme", () => {
    expect(parseKeypress("👩🏽‍💻")).toEqual([{ type: "text", text: "👩🏽‍💻" }]);
  });

  it("parses Enter, Tab, Backspace, and Escape", () => {
    expect(parseKeypress("\r\n")).toEqual([{ type: "key", key: "enter" }]);
    expect(parseKeypress("\t")).toEqual([{ type: "key", key: "tab" }]);
    expect(parseKeypress("\x7f\b")).toEqual([
      { type: "key", key: "backspace" },
      { type: "key", key: "backspace" },
    ]);
    expect(parseKeypress("\x1b")).toEqual([{ type: "key", key: "escape" }]);
  });

  it("distinguishes normal Enter from Alt+Enter", () => {
    expect(parseKeypress("\r")).toEqual([{ type: "key", key: "enter" }]);
    expect(parseKeypress("\x1b\r")).toEqual([{ type: "key", key: "enter", alt: true }]);
    expect(parseKeypress("\x1b\r\n")).toEqual([{ type: "key", key: "enter", alt: true }]);
  });

  it("parses Ctrl-C, Ctrl-D, and Ctrl-A", () => {
    expect(parseKeypress("\x03\x04\x01")).toEqual([
      { type: "key", key: "c", ctrl: true },
      { type: "key", key: "d", ctrl: true },
      { type: "key", key: "a", ctrl: true },
    ]);
  });

  it("parses arrow keys", () => {
    expect(parseKeypress("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([
      { type: "key", key: "up" },
      { type: "key", key: "down" },
      { type: "key", key: "right" },
      { type: "key", key: "left" },
    ]);
  });

  it("parses Home and End variants", () => {
    expect(parseKeypress("\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH\x1bOF")).toEqual([
      { type: "key", key: "home" },
      { type: "key", key: "end" },
      { type: "key", key: "home" },
      { type: "key", key: "end" },
      { type: "key", key: "home" },
      { type: "key", key: "end" },
    ]);
  });

  it("parses Delete, Insert, PageUp, and PageDown", () => {
    expect(parseKeypress("\x1b[3~\x1b[2~\x1b[5~\x1b[6~")).toEqual([
      { type: "key", key: "delete" },
      { type: "key", key: "insert" },
      { type: "key", key: "pageup" },
      { type: "key", key: "pagedown" },
    ]);
  });

  it("parses Alt/meta-prefixed printable characters", () => {
    expect(parseKeypress("\x1bb\x1bش")).toEqual([
      { type: "text", text: "b", alt: true },
      { type: "text", text: "ش", alt: true },
    ]);
  });

  it("parses modified CSI key sequences", () => {
    expect(parseKeypress("\x1b[1;2A\x1b[1;3C\x1b[1;5D\x1b[3;5~")).toEqual([
      { type: "key", key: "up", shift: true },
      { type: "key", key: "right", alt: true },
      { type: "key", key: "left", ctrl: true },
      { type: "key", key: "delete", ctrl: true },
    ]);
  });

  it("parses SGR primary press/release and wheel events with zero-based coordinates", () => {
    expect(parseKeypress("\x1b[<0;12;7M\x1b[<0;12;7m\x1b[<64;3;4M\x1b[<65;3;4M")).toEqual([
      { type: "mouse", action: "press", button: "primary", x: 11, y: 6 },
      { type: "mouse", action: "release", button: "primary", x: 11, y: 6 },
      { type: "mouse", action: "scroll", button: "wheelUp", x: 2, y: 3 },
      { type: "mouse", action: "scroll", button: "wheelDown", x: 2, y: 3 },
    ]);
  });

  it("parses SGR mouse modifiers and rejects motion or malformed coordinates", () => {
    expect(parseKeypress("\x1b[<28;2;9M")).toEqual([{
      type: "mouse",
      action: "press",
      button: "primary",
      x: 1,
      y: 8,
      shift: true,
      alt: true,
      ctrl: true,
    }]);
    expect(parseKeypress("\x1b[<32;2;9M\x1b[<0;0;9M")).toEqual([
      { type: "unknown", sequence: "\x1b[<32;2;9M" },
      { type: "unknown", sequence: "\x1b[<0;0;9M" },
    ]);
  });

  it("parses bracketed paste as paste data without submitting it", () => {
    expect(parseKeypress("\x1b[200~hello world\x1b[201~")).toEqual([
      { type: "paste", text: "hello world" },
    ]);
  });

  it("preserves multiline bracketed paste data", () => {
    expect(parseKeypress("\x1b[200~line one\nline two\r\nline three\x1b[201~")).toEqual([
      { type: "paste", text: "line one\nline two\r\nline three" },
    ]);
  });

  it("parses text around paste regions deterministically", () => {
    expect(parseKeypress("a\x1b[200~b\nc\x1b[201~d")).toEqual([
      { type: "text", text: "a" },
      { type: "paste", text: "b\nc" },
      { type: "text", text: "d" },
    ]);
  });

  it("does not throw for incomplete escape sequences", () => {
    expect(() => parseKeypress("\x1b[")).not.toThrow();
    expect(parseKeypress("\x1b[")).toEqual([{ type: "unknown", sequence: "\x1b[" }]);
  });

  it("preserves unknown CSI sequences safely", () => {
    expect(parseKeypress("\x1b[999~")).toEqual([{ type: "unknown", sequence: "\x1b[999~" }]);
  });
});

describe("parseKeypressStream", () => {
  it("preserves an SGR mouse event split across input chunks", () => {
    let state = createInitialKeypressParseState();
    let parsed = parseKeypressStream(state, "\x1b[<0;12");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    parsed = parseKeypressStream(state, ";7M");
    expect(parsed.events).toEqual([{ type: "mouse", action: "press", button: "primary", x: 11, y: 6 }]);
  });

  it("preserves multiline bracketed paste across data chunks", () => {
    let state = createInitialKeypressParseState();

    let parsed = parseKeypressStream(state, "\x1b[200~line one\n");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    parsed = parseKeypressStream(state, "line two\r\nline three\x1b[201~");
    expect(parsed.events).toEqual([
      { type: "paste", text: "line one\nline two\r\nline three" },
    ]);
    expect(parsed.state).toEqual(createInitialKeypressParseState());
  });

  it("preserves split bracketed paste start markers", () => {
    let state = createInitialKeypressParseState();

    let parsed = parseKeypressStream(state, "\x1b[20");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    parsed = parseKeypressStream(state, "0~hello\x1b[201~");
    expect(parsed.events).toEqual([{ type: "paste", text: "hello" }]);
    expect(parsed.state).toEqual(createInitialKeypressParseState());
  });

  it("preserves bracketed paste start markers split after escape", () => {
    let state = createInitialKeypressParseState();

    let parsed = parseKeypressStream(state, "\x1b");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    parsed = parseKeypressStream(state, "[200~hello\x1b[201~");
    expect(parsed.events).toEqual([{ type: "paste", text: "hello" }]);
    expect(parsed.state).toEqual(createInitialKeypressParseState());
  });

  it("preserves split bracketed paste end markers", () => {
    let state = createInitialKeypressParseState();

    let parsed = parseKeypressStream(state, "\x1b[200~hello\x1b[20");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    parsed = parseKeypressStream(state, "1~");
    expect(parsed.events).toEqual([{ type: "paste", text: "hello" }]);
    expect(parsed.state).toEqual(createInitialKeypressParseState());
  });

  it("flushes a standalone escape key", () => {
    let state = createInitialKeypressParseState();

    const parsed = parseKeypressStream(state, "\x1b");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    expect(parseKeypressStream(state, null).events).toEqual([{ type: "key", key: "escape" }]);
  });

  it("treats buffered escape as standalone before ordinary text", () => {
    let state = createInitialKeypressParseState();

    const parsed = parseKeypressStream(state, "\x1b");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    expect(parseKeypressStream(state, "0i").events).toEqual([
      { type: "key", key: "escape" },
      { type: "text", text: "0i" },
    ]);
  });

  it("flushes incomplete paste as one paste event", () => {
    let state = createInitialKeypressParseState();

    const parsed = parseKeypressStream(state, "\x1b[200~partial\npaste");
    expect(parsed.events).toEqual([]);
    state = parsed.state;

    expect(parseKeypressStream(state, null).events).toEqual([
      { type: "paste", text: "partial\npaste" },
    ]);
  });
});
