import { describe, expect, it } from "vitest";
import { parseKeypress } from "./parseKeypress.js";

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
