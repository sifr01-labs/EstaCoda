import { describe, expect, it } from "vitest";
import {
  DBP,
  EBP,
  HIDE_CURSOR,
  LINK_END,
  Parser,
  SHOW_CURSOR,
  applySGR,
  csi,
  cursorMove,
  defaultStyle,
  eraseLine,
  link,
  osc,
  parseAnsi,
  tabStatus,
} from "./index.js";

describe("Papyrus termio CSI primitives", () => {
  it("generates deterministic CSI cursor and erase sequences", () => {
    expect(csi(2, "A")).toBe("\x1b[2A");
    expect(cursorMove(3, -2)).toBe("\x1b[3C\x1b[2A");
    expect(eraseLine()).toBe("\x1b[2K");
  });
});

describe("Papyrus termio DEC primitives", () => {
  it("exports inert mode enable and disable sequences", () => {
    expect(HIDE_CURSOR).toBe("\x1b[?25l");
    expect(SHOW_CURSOR).toBe("\x1b[?25h");
    expect(EBP).toBe("\x1b[?2004h");
    expect(DBP).toBe("\x1b[?2004l");
  });
});

describe("Papyrus termio OSC primitives", () => {
  it("generates OSC sequences without subprocess behavior", () => {
    expect(osc(2, "EstaCoda")).toBe("\x1b]2;EstaCoda\x07");
    expect(tabStatus({ status: "ready;steady" })).toBe("\x1b]21337;status=ready\\;steady\x07");
  });

  it("generates OSC 8 hyperlink boundaries", () => {
    expect(link("https://example.com")).toMatch(/^\x1b\]8;id=[a-z0-9]+;https:\/\/example\.com\x07$/u);
    expect(LINK_END).toBe("\x1b]8;;\x07");
  });
});

describe("Papyrus termio SGR primitives", () => {
  it("applies common styles and reset", () => {
    const styled = applySGR("1;31;48;5;12", defaultStyle());
    expect(styled.bold).toBe(true);
    expect(styled.fg).toEqual({ type: "named", name: "red" });
    expect(styled.bg).toEqual({ type: "indexed", index: 12 });

    expect(applySGR("0", styled)).toEqual(defaultStyle());
  });
});

describe("Papyrus termio parser", () => {
  it("parses plain text into text actions", () => {
    expect(parseAnsi("hello")).toEqual([
      {
        type: "text",
        graphemes: [
          { value: "h", width: 1 },
          { value: "e", width: 1 },
          { value: "l", width: 1 },
          { value: "l", width: 1 },
          { value: "o", width: 1 },
        ],
        style: defaultStyle(),
      },
    ]);
  });

  it("parses styled ANSI text into stable semantic text actions", () => {
    const actions = parseAnsi("a\x1b[31mb\x1b[0mc");
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ type: "text", graphemes: [{ value: "a", width: 1 }] });
    expect(actions[1]).toMatchObject({
      type: "text",
      graphemes: [{ value: "b", width: 1 }],
      style: { fg: { type: "named", name: "red" } },
    });
    expect(actions[2]).toMatchObject({
      type: "text",
      graphemes: [{ value: "c", width: 1 }],
      style: { fg: { type: "default" } },
    });
  });

  it("parses OSC 8 hyperlink sequences", () => {
    expect(parseAnsi("\x1b]8;id=abc;https://example.com\x07link\x1b]8;;\x07")).toMatchObject([
      { type: "link", action: { type: "start", url: "https://example.com", params: { id: "abc" } } },
      { type: "text", graphemes: [{ value: "l" }, { value: "i" }, { value: "n" }, { value: "k" }] },
      { type: "link", action: { type: "end" } },
    ]);
  });

  it("does not throw on incomplete or malformed escape sequences", () => {
    const parser = new Parser();
    expect(() => parser.feed("plain\x1b[")).not.toThrow();
    expect(() => parser.flush()).not.toThrow();
    expect(parseAnsi("\x1b[?9999h")).toEqual([{ type: "unknown", sequence: "\x1b[?9999h" }]);
  });
});
