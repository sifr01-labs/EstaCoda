import { describe, expect, it } from "vitest";
import {
  parseUiInputMode,
  resolveUiInputMode,
  UI_INPUT_MODE_ENV_VAR,
  UI_INPUT_MODES,
  type UiInputMode,
} from "./input-mode.js";

describe("UI input mode", () => {
  it("defaults unset values to readline", () => {
    expect(resolveUiInputMode({ env: {} })).toBe("readline");
    expect(parseUiInputMode(undefined)).toBe("readline");
  });

  it("defaults empty values to readline", () => {
    expect(parseUiInputMode("")).toBe("readline");
    expect(parseUiInputMode("   ")).toBe("readline");
  });

  it("accepts readline", () => {
    expect(parseUiInputMode("readline")).toBe("readline");
  });

  it("accepts raw", () => {
    expect(parseUiInputMode("raw")).toBe("raw");
  });

  it("trims whitespace", () => {
    expect(parseUiInputMode("  raw  ")).toBe("raw");
    expect(parseUiInputMode("\nreadline\t")).toBe("readline");
  });

  it("accepts modes case-insensitively", () => {
    expect(parseUiInputMode("RAW")).toBe("raw");
    expect(parseUiInputMode("Readline")).toBe("readline");
  });

  it("falls back to readline for invalid values", () => {
    expect(parseUiInputMode("papyrus")).toBe("readline");
    expect(parseUiInputMode("raw-beta")).toBe("readline");
  });

  it("resolves ESTACODA_INPUT_MODE from a passed env object", () => {
    expect(resolveUiInputMode({ env: { [UI_INPUT_MODE_ENV_VAR]: "raw" } })).toBe("raw");
  });

  it("does not mutate env objects", () => {
    const env = { [UI_INPUT_MODE_ENV_VAR]: " raw " };
    const before = { ...env };
    expect(resolveUiInputMode({ env })).toBe("raw");
    expect(env).toEqual(before);
  });

  it("exports only the narrow supported modes", () => {
    const modes = [...UI_INPUT_MODES] satisfies UiInputMode[];
    expect(modes).toEqual(["readline", "raw"]);
  });
});
