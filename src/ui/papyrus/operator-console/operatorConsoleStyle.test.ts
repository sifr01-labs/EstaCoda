import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  styleBackgroundRow,
  styleBgColor,
  styleColor,
} from "./operatorConsoleStyle.js";
import { createScreen } from "../screen/screen.js";
import { writeToScreen } from "../screen/output.js";

describe("Papyrus operator console style", () => {
  it("uses exact RGB color when color is enabled even if truecolor is not advertised", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: false },
    });

    expect(styleColor(style, "brand", tokens.contract.palette.brand))
      .toBe("\x1b[38;2;67;137;215mbrand\x1b[0m");
    expect(styleBgColor(style, "brand", tokens.contract.palette.brand))
      .toBe("\x1b[48;2;67;137;215mbrand\x1b[0m");
  });

  it("keeps text unstyled when color is disabled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: false, supportsTrueColor: false },
    });

    expect(styleColor(style, "brand", tokens.contract.palette.brand)).toBe("brand");
    expect(styleBgColor(style, "brand", tokens.contract.palette.brand)).toBe("brand");
    expect(styleBackgroundRow(style, "brand", 8, tokens.contract.surface.bgElevated)).toBe("brand   ");
  });

  it("keeps a tokenized background across nested foreground resets and trailing padding", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const screen = createScreen(22, 1);
    const title = styleColor(style, "Subagent 1", tokens.contract.palette.accent);

    writeToScreen(
      screen,
      0,
      0,
      styleBackgroundRow(style, `${title} working`, 22, tokens.contract.surface.bgElevated)
    );

    expect(screen.rowText(0)).toBe("Subagent 1 working    ");
    for (let x = 0; x < 22; x += 1) {
      const cell = screen.cellAt(x, 0)!;
      expect(screen.getStyle(cell.styleId).bg).toEqual({ type: "rgb", r: 37, g: 37, b: 37 });
    }
  });
});
