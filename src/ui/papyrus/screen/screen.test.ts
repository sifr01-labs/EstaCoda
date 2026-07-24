import { describe, expect, it } from "vitest";
import { LRI, PDI, RLI } from "../../bidi.js";
import { defaultStyle } from "../termio/types.js";
import { createScreen, CellWidth } from "./screen.js";
import { Output, styleIdFor, writeToScreen } from "./output.js";
import { stringWidth } from "./stringWidth.js";

describe("Papyrus Screen", () => {
  it("creates a fixed-size blank screen", () => {
    const screen = createScreen(4, 2);
    expect(screen.width).toBe(4);
    expect(screen.height).toBe(2);
    expect(screen.rowText(0)).toBe("    ");
  });

  it("writes plain ASCII to cells", () => {
    const screen = createScreen(5, 1);
    writeToScreen(screen, 0, 0, "abc");
    expect(screen.rowText(0)).toBe("abc  ");
  });

  it("packs zero-width bidi controls into adjacent visible cells", () => {
    const screen = createScreen(4, 1);
    const cursor = writeToScreen(screen, 0, 0, `${LRI}a${PDI}b`);

    expect(screen.cellAt(0, 0)).toMatchObject({
      char: `${LRI}a${PDI}`,
      width: CellWidth.Narrow,
    });
    expect(screen.cellAt(1, 0)).toMatchObject({ char: "b", width: CellWidth.Narrow });
    expect(screen.rowText(0)).toBe(`${LRI}a${PDI}b  `);
    expect(stringWidth(screen.rowText(0))).toBe(4);
    expect(cursor).toEqual({ x: 2, y: 0 });
  });

  it("does not allocate a cell or advance for zero-width-only input", () => {
    const screen = createScreen(2, 1);
    const cursor = writeToScreen(screen, 0, 0, `${LRI}${PDI}`);

    expect(screen.rowText(0)).toBe("  ");
    expect(cursor).toEqual({ x: 0, y: 0 });
  });

  it("keeps packed controls with the visible cell across style boundaries", () => {
    const screen = createScreen(3, 1);
    const cursor = writeToScreen(screen, 0, 0, `${LRI}\x1b[31ma\x1b[0m${PDI}b`);

    expect(screen.cellAt(0, 0)?.char).toBe(`${LRI}a${PDI}`);
    expect(screen.cellAt(0, 0)?.styleId).not.toBe(styleIdFor(screen, defaultStyle()));
    expect(screen.cellAt(1, 0)).toMatchObject({
      char: "b",
      styleId: styleIdFor(screen, defaultStyle()),
    });
    expect(cursor).toEqual({ x: 2, y: 0 });
  });

  it("preserves hyperlink metadata on a packed visible cell", () => {
    const screen = createScreen(3, 1);
    writeToScreen(
      screen,
      0,
      0,
      `${LRI}\x1b]8;;https://example.com\x07a${PDI}\x1b]8;;\x07b`,
    );

    expect(screen.cellAt(0, 0)?.char).toBe(`${LRI}a${PDI}`);
    expect(screen.getHyperlink(screen.cellAt(0, 0)?.hyperlinkId ?? 0)).toBe("https://example.com");
    expect(screen.getHyperlink(screen.cellAt(1, 0)?.hyperlinkId ?? 0)).toBeUndefined();
  });

  it("packs controls around wide cells without replacing spacer cells", () => {
    const screen = createScreen(3, 1);
    const cursor = writeToScreen(screen, 0, 0, `${RLI}表${PDI}a`);

    expect(screen.cellAt(0, 0)).toMatchObject({ char: `${RLI}表${PDI}`, width: CellWidth.Wide });
    expect(screen.cellAt(1, 0)).toMatchObject({ char: "", width: CellWidth.Spacer });
    expect(screen.cellAt(2, 0)).toMatchObject({ char: "a", width: CellWidth.Narrow });
    expect(cursor).toEqual({ x: 3, y: 0 });
  });

  it("clips by visible width rather than zero-width control count", () => {
    const screen = createScreen(2, 1);
    const cursor = writeToScreen(screen, 0, 0, `${LRI}a${PDI}bc`);

    expect(screen.rowText(0)).toBe(`${LRI}a${PDI}b`);
    expect(stringWidth(screen.rowText(0))).toBe(2);
    expect(cursor).toEqual({ x: 2, y: 0 });
  });

  it("does not carry packed controls across a newline", () => {
    const screen = createScreen(2, 2);
    const cursor = writeToScreen(screen, 0, 0, `a\n${LRI}b${PDI}`);

    expect(screen.rowText(0)).toBe("a ");
    expect(screen.rowText(1)).toBe(`${LRI}b${PDI} `);
    expect(cursor).toEqual({ x: 1, y: 1 });
  });

  it("reorders a complete mixed-direction line across ANSI style boundaries", () => {
    const screen = createScreen(10, 1);
    const cursor = writeToScreen(
      screen,
      0,
      0,
      `ID: \x1b[31mمر\x1b[32mحبا\x1b[0m`,
      { bidi: "software" },
    );

    expect(screen.rowText(0)).toBe("ID: ابحرم ");
    expect(screen.getStyle(screen.cellAt(4, 0)?.styleId ?? 0).fg).toEqual({ type: "named", name: "green" });
    expect(screen.getStyle(screen.cellAt(6, 0)?.styleId ?? 0).fg).toEqual({ type: "named", name: "green" });
    expect(screen.getStyle(screen.cellAt(7, 0)?.styleId ?? 0).fg).toEqual({ type: "named", name: "red" });
    expect(screen.getStyle(screen.cellAt(8, 0)?.styleId ?? 0).fg).toEqual({ type: "named", name: "red" });
    expect(cursor).toEqual({ x: 9, y: 0 });
  });

  it("preserves hyperlink ownership while reordering a complete logical line", () => {
    const screen = createScreen(9, 1);
    writeToScreen(
      screen,
      0,
      0,
      `go م\x1b]8;;https://example.com\x07رح\x1b]8;;\x07با`,
      { bidi: "software" },
    );

    expect(screen.rowText(0)).toBe("go ابحرم ");
    expect(screen.getHyperlink(screen.cellAt(3, 0)?.hyperlinkId ?? 0)).toBeUndefined();
    expect(screen.getHyperlink(screen.cellAt(4, 0)?.hyperlinkId ?? 0)).toBeUndefined();
    expect(screen.getHyperlink(screen.cellAt(5, 0)?.hyperlinkId ?? 0)).toBe("https://example.com");
    expect(screen.getHyperlink(screen.cellAt(6, 0)?.hyperlinkId ?? 0)).toBe("https://example.com");
    expect(screen.getHyperlink(screen.cellAt(7, 0)?.hyperlinkId ?? 0)).toBeUndefined();
  });

  it("flushes software bidi independently at newlines and at end of input", () => {
    const screen = createScreen(6, 2);
    const cursor = writeToScreen(
      screen,
      0,
      0,
      `\x1b[31mمر\x1b[0mحبا\n\x1b[32mسل\x1b[0mام`,
      { bidi: "software" },
    );

    expect(screen.rowText(0)).toBe("ابحرم ");
    expect(screen.rowText(1)).toBe("مالس  ");
    expect(screen.getStyle(screen.cellAt(3, 0)?.styleId ?? 0).fg).toEqual({ type: "named", name: "red" });
    expect(screen.getStyle(screen.cellAt(2, 1)?.styleId ?? 0).fg).toEqual({ type: "named", name: "green" });
    expect(cursor).toEqual({ x: 4, y: 1 });
  });

  it("writes wide text with spacer cells and clips at bounds", () => {
    const screen = createScreen(4, 1);
    writeToScreen(screen, 0, 0, "表a😀");
    expect(screen.cellAt(0, 0)).toMatchObject({ char: "表", width: CellWidth.Wide });
    expect(screen.cellAt(1, 0)).toMatchObject({ char: "", width: CellWidth.Spacer });
    expect(screen.cellAt(2, 0)).toMatchObject({ char: "a", width: CellWidth.Narrow });
    expect(screen.cellAt(3, 0)).toMatchObject({ char: " ", width: CellWidth.Narrow });
  });

  it("stores styled text without escape sequences", () => {
    const screen = createScreen(4, 1);
    writeToScreen(screen, 0, 0, "\x1b[31mr\x1b[0mx");
    expect(screen.rowText(0)).toBe("rx  ");
    expect(screen.cellAt(0, 0)?.styleId).not.toBe(styleIdFor(screen, defaultStyle()));
    expect(screen.cellAt(1, 0)?.styleId).toBe(styleIdFor(screen, defaultStyle()));
  });

  it("compares styled cells by resolved style instead of per-screen ids", () => {
    const left = createScreen(4, 1);
    const right = createScreen(4, 1);
    writeToScreen(left, 0, 0, "\x1b[31ma");
    writeToScreen(right, 1, 0, "\x1b[32mz");
    writeToScreen(right, 0, 0, "\x1b[31ma");
    expect(left.equalsCell(right, 0, 0)).toBe(true);

    const changed = createScreen(4, 1);
    writeToScreen(changed, 0, 0, "\x1b[32ma");
    expect(left.equalsCell(changed, 0, 0)).toBe(false);
  });

  it("stores OSC 8 hyperlinks only inside the active span", () => {
    const screen = createScreen(8, 1);
    writeToScreen(screen, 0, 0, "\x1b]8;id=one;https://example.com\x07ab\x1b]8;;\x07c");
    expect(screen.rowText(0)).toBe("abc     ");
    expect(screen.getHyperlink(screen.cellAt(0, 0)?.hyperlinkId ?? 0)).toBe("https://example.com");
    expect(screen.getHyperlink(screen.cellAt(1, 0)?.hyperlinkId ?? 0)).toBe("https://example.com");
    expect(screen.getHyperlink(screen.cellAt(2, 0)?.hyperlinkId ?? 0)).toBeUndefined();
  });

  it("compares hyperlink cells by resolved link instead of per-screen ids", () => {
    const left = createScreen(4, 1);
    const right = createScreen(4, 1);
    writeToScreen(left, 0, 0, "\x1b]8;;https://a.test\x07a\x1b]8;;\x07");
    writeToScreen(right, 1, 0, "\x1b]8;;https://b.test\x07b\x1b]8;;\x07");
    writeToScreen(right, 0, 0, "\x1b]8;;https://a.test\x07a\x1b]8;;\x07");
    expect(left.equalsCell(right, 0, 0)).toBe(true);
  });

  it("advances rows on newline", () => {
    const screen = createScreen(4, 2);
    const cursor = writeToScreen(screen, 1, 0, "a\nb");
    expect(screen.rowText(0)).toBe(" a  ");
    expect(screen.rowText(1)).toBe(" b  ");
    expect(cursor).toEqual({ x: 2, y: 1 });
  });

  it("clears a region", () => {
    const screen = createScreen(5, 1);
    const output = new Output(screen);
    output.write(0, 0, "abcde");
    output.clearRegion({ x: 1, y: 0, width: 3, height: 1 });
    expect(screen.rowText(0)).toBe("a   e");
  });
});
