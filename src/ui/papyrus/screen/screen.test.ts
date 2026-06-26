import { describe, expect, it } from "vitest";
import { defaultStyle } from "../termio/types.js";
import { createScreen, CellWidth } from "./screen.js";
import { Output, styleIdFor, writeToScreen } from "./output.js";

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
