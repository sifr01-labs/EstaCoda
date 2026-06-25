import { describe, expect, it } from "vitest";
import {
  parseShellHistoryMode,
  resolveShellHistoryMode,
  SHELL_HISTORY_MODE_ENV_VAR,
} from "./shell-history-mode.js";

describe("shell history mode", () => {
  it("defaults unset, empty, invalid, zero, and false values to off", () => {
    expect(resolveShellHistoryMode({ env: {} })).toBe("off");
    expect(parseShellHistoryMode(undefined)).toBe("off");
    expect(parseShellHistoryMode("")).toBe("off");
    expect(parseShellHistoryMode("   ")).toBe("off");
    expect(parseShellHistoryMode("0")).toBe("off");
    expect(parseShellHistoryMode("false")).toBe("off");
    expect(parseShellHistoryMode("history")).toBe("off");
  });

  it("accepts explicit on values", () => {
    expect(parseShellHistoryMode("1")).toBe("on");
    expect(parseShellHistoryMode("true")).toBe("on");
    expect(parseShellHistoryMode("on")).toBe("on");
    expect(parseShellHistoryMode(" ON ")).toBe("on");
  });

  it("resolves ESTACODA_SHELL_HISTORY from injected env without mutation", () => {
    const env = { [SHELL_HISTORY_MODE_ENV_VAR]: " true " };
    const before = { ...env };

    expect(resolveShellHistoryMode({ env })).toBe("on");
    expect(env).toEqual(before);
  });
});
