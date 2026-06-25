import { describe, expect, it } from "vitest";
import {
  INPUT_KEYMAP_MODE_ENV_VAR,
  parseInputKeymapMode,
  resolveInputKeymapMode,
} from "./input-keymap-mode.js";

describe("input keymap mode", () => {
  it("defaults unset, empty, and invalid values to default", () => {
    expect(parseInputKeymapMode(undefined)).toBe("default");
    expect(parseInputKeymapMode("")).toBe("default");
    expect(parseInputKeymapMode("  ")).toBe("default");
    expect(parseInputKeymapMode("emacs")).toBe("default");
  });

  it("parses explicit default and vim modes", () => {
    expect(parseInputKeymapMode("default")).toBe("default");
    expect(parseInputKeymapMode("vim")).toBe("vim");
    expect(parseInputKeymapMode(" VIM ")).toBe("vim");
  });

  it("uses injected env without mutating global env", () => {
    expect(resolveInputKeymapMode({ env: { [INPUT_KEYMAP_MODE_ENV_VAR]: "vim" } })).toBe("vim");
    expect(resolveInputKeymapMode({ env: { [INPUT_KEYMAP_MODE_ENV_VAR]: "invalid" } })).toBe("default");
    expect(process.env[INPUT_KEYMAP_MODE_ENV_VAR]).toBeUndefined();
  });
});
