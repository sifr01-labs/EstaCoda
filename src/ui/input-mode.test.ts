import { describe, expect, it } from "vitest";
import {
  parseUiInputMode,
  resolveCoreSessionUiInputMode,
  resolveUiInputMode,
  UI_INPUT_MODE_ENV_VAR,
  UI_INPUT_MODES,
  type UiInputMode,
} from "./input-mode.js";

describe("UI input mode", () => {
  it("covers the full-migration matrix for core TTY, removed readline flag, and non-TTY sessions", () => {
    expect(resolveCoreSessionUiInputMode({
      env: {},
      isInteractiveTty: true,
    })).toBe("raw");
    expect(resolveCoreSessionUiInputMode({
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      isInteractiveTty: true,
    })).toBe("raw");
    expect(resolveCoreSessionUiInputMode({
      env: {},
      isInteractiveTty: false,
    })).toBe("raw");
  });

  it("defaults unset values to raw", () => {
    expect(resolveUiInputMode({ env: {} })).toBe("raw");
    expect(parseUiInputMode(undefined)).toBe("raw");
  });

  it("defaults empty values to raw", () => {
    expect(parseUiInputMode("")).toBe("raw");
    expect(parseUiInputMode("   ")).toBe("raw");
  });

  it("ignores removed explicit readline values", () => {
    expect(parseUiInputMode("readline")).toBe("raw");
  });

  it("accepts raw", () => {
    expect(parseUiInputMode("raw")).toBe("raw");
  });

  it("trims whitespace", () => {
    expect(parseUiInputMode("  raw  ")).toBe("raw");
    expect(parseUiInputMode("\nreadline\t")).toBe("raw");
  });

  it("accepts modes case-insensitively", () => {
    expect(parseUiInputMode("RAW")).toBe("raw");
    expect(parseUiInputMode("Readline")).toBe("raw");
  });

  it("falls back to raw for invalid values", () => {
    expect(parseUiInputMode("papyrus")).toBe("raw");
    expect(parseUiInputMode("raw-beta")).toBe("raw");
  });

  it("can use raw as an injected default for TTY core sessions", () => {
    expect(resolveUiInputMode({ env: {}, defaultMode: "raw" })).toBe("raw");
    expect(parseUiInputMode(undefined, "raw")).toBe("raw");
    expect(parseUiInputMode("", "raw")).toBe("raw");
    expect(parseUiInputMode("invalid", "raw")).toBe("raw");
  });

  it("does not let explicit readline override raw defaults", () => {
    expect(resolveUiInputMode({
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      defaultMode: "raw",
    })).toBe("raw");
  });

  it("defaults core TTY sessions to raw", () => {
    expect(resolveCoreSessionUiInputMode({
      env: {},
      isInteractiveTty: true,
    })).toBe("raw");
  });

  it("keeps non-TTY core sessions on the only supported mode value", () => {
    expect(resolveCoreSessionUiInputMode({
      env: {},
      isInteractiveTty: false,
    })).toBe("raw");
  });

  it("ignores explicit readline for core sessions", () => {
    expect(resolveCoreSessionUiInputMode({
      env: { [UI_INPUT_MODE_ENV_VAR]: "readline" },
      isInteractiveTty: true,
    })).toBe("raw");
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
    expect(modes).toEqual(["raw"]);
  });
});
