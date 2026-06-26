import { describe, expect, it } from "vitest";
import {
  parseUiRendererMode,
  resolveUiRendererMode,
  UI_RENDERER_ENV_VAR,
  UI_RENDERER_MODES,
  type UiRendererMode,
} from "./renderer-mode.js";

describe("UI renderer mode", () => {
  it("covers the full-migration matrix default and removed legacy flag", () => {
    expect(resolveUiRendererMode({ env: {} })).toBe("papyrus");
    expect(resolveUiRendererMode({ env: { [UI_RENDERER_ENV_VAR]: "legacy" } })).toBe("papyrus");
  });

  it("defaults unset values to papyrus", () => {
    expect(resolveUiRendererMode({ env: {} })).toBe("papyrus");
    expect(parseUiRendererMode(undefined)).toBe("papyrus");
  });

  it("defaults empty values to papyrus", () => {
    expect(parseUiRendererMode("")).toBe("papyrus");
    expect(parseUiRendererMode("   ")).toBe("papyrus");
  });

  it("ignores removed explicit legacy values", () => {
    expect(parseUiRendererMode("legacy")).toBe("papyrus");
  });

  it("accepts papyrus", () => {
    expect(parseUiRendererMode("papyrus")).toBe("papyrus");
  });

  it("trims whitespace", () => {
    expect(parseUiRendererMode("  papyrus  ")).toBe("papyrus");
    expect(parseUiRendererMode("\nlegacy\t")).toBe("papyrus");
  });

  it("accepts modes case-insensitively", () => {
    expect(parseUiRendererMode("PAPYRUS")).toBe("papyrus");
    expect(parseUiRendererMode("Legacy")).toBe("papyrus");
  });

  it("falls back to papyrus for invalid values", () => {
    expect(parseUiRendererMode("screen")).toBe("papyrus");
    expect(parseUiRendererMode("papyrus-beta")).toBe("papyrus");
  });

  it("resolves ESTACODA_UI_RENDERER from a passed env object", () => {
    expect(resolveUiRendererMode({ env: { [UI_RENDERER_ENV_VAR]: "papyrus" } })).toBe("papyrus");
    expect(resolveUiRendererMode({ env: { [UI_RENDERER_ENV_VAR]: "legacy" } })).toBe("papyrus");
  });

  it("does not mutate env objects", () => {
    const env = { [UI_RENDERER_ENV_VAR]: " papyrus " };
    const before = { ...env };
    expect(resolveUiRendererMode({ env })).toBe("papyrus");
    expect(env).toEqual(before);
  });

  it("exports only the narrow supported modes", () => {
    const modes = [...UI_RENDERER_MODES] satisfies UiRendererMode[];
    expect(modes).toEqual(["papyrus"]);
  });
});
