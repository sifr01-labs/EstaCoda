import { describe, expect, it } from "vitest";
import { clearLineWidthCache, lineWidth, lineWidthCacheSize } from "./lineWidthCache.js";
import { reorderBidi, type ClusteredChar } from "./bidi.js";
import { stringWidth } from "./stringWidth.js";
import { widestLine } from "./widestLine.js";

function clusters(value: string): ClusteredChar[] {
  return Array.from(value, (char) => ({ value: char, width: 1, styleId: 0, hyperlink: undefined }));
}

describe("Papyrus screen string width utilities", () => {
  it("measures ASCII via the fast path", () => {
    expect(stringWidth("abc")).toBe(3);
  });

  it("ignores ANSI style sequences", () => {
    expect(stringWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("measures CJK text as wide", () => {
    expect(stringWidth("表")).toBe(2);
    expect(stringWidth("表a")).toBe(3);
  });

  it("measures emoji and variation-selector cases", () => {
    expect(stringWidth("😀")).toBe(2);
    expect(stringWidth("❤️")).toBe(2);
    expect(stringWidth("1️")).toBe(1);
  });

  it("does not add width for combining marks", () => {
    expect(stringWidth("e\u0301")).toBe(1);
  });
});

describe("Papyrus line width cache", () => {
  it("returns stable widths and caches repeated inputs", () => {
    clearLineWidthCache();
    expect(lineWidth("abc")).toBe(3);
    expect(lineWidthCacheSize()).toBe(1);
    expect(lineWidth("abc")).toBe(3);
    expect(lineWidthCacheSize()).toBe(1);
  });
});

describe("Papyrus widestLine", () => {
  it("handles multiline ANSI and Unicode text", () => {
    expect(widestLine("a\n\x1b[32m表😀\x1b[0m\nabc")).toBe(4);
  });
});

describe("Papyrus screen-local bidi", () => {
  it("reorders RTL runs when software bidi is forced", () => {
    const reordered = reorderBidi(clusters("abc مرحبا"), { mode: "software" });
    expect(reordered.map((cluster) => cluster.value).join("")).toBe("abc ابحرم");
  });

  it("no-ops for empty and pure LTR input", () => {
    const empty: ClusteredChar[] = [];
    expect(reorderBidi(empty, { mode: "software" })).toBe(empty);

    const ltr = clusters("abc");
    expect(reorderBidi(ltr, { mode: "software" })).toBe(ltr);
  });

  it("can be explicitly disabled independent of terminal environment", () => {
    const input = clusters("abc مرحبا");
    expect(reorderBidi(input, { mode: "native" })).toBe(input);
  });
});
