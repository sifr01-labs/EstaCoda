import { describe, expect, it } from "vitest";
import {
  MCP_SUGGESTIONS_MODE_ENV_VAR,
  parseMcpSuggestionsMode,
  resolveMcpSuggestionsMode,
} from "./mcp-suggestions-mode.js";

describe("MCP suggestions mode", () => {
  it("defaults unset, empty, invalid, zero, and false values to off", () => {
    expect(resolveMcpSuggestionsMode({ env: {} })).toBe("off");
    expect(parseMcpSuggestionsMode(undefined)).toBe("off");
    expect(parseMcpSuggestionsMode("")).toBe("off");
    expect(parseMcpSuggestionsMode("   ")).toBe("off");
    expect(parseMcpSuggestionsMode("0")).toBe("off");
    expect(parseMcpSuggestionsMode("false")).toBe("off");
    expect(parseMcpSuggestionsMode("mcp")).toBe("off");
  });

  it("accepts explicit on values", () => {
    expect(parseMcpSuggestionsMode("1")).toBe("on");
    expect(parseMcpSuggestionsMode("true")).toBe("on");
    expect(parseMcpSuggestionsMode("on")).toBe("on");
    expect(parseMcpSuggestionsMode(" ON ")).toBe("on");
  });

  it("resolves ESTACODA_MCP_SUGGESTIONS from injected env without mutation", () => {
    const env = { [MCP_SUGGESTIONS_MODE_ENV_VAR]: " true " };
    const before = { ...env };

    expect(resolveMcpSuggestionsMode({ env })).toBe("on");
    expect(env).toEqual(before);
  });
});
