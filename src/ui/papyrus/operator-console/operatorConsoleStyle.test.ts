import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  styleBgColor,
  styleColor,
} from "./operatorConsoleStyle.js";

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
  });
});
