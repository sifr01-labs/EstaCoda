import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_MODE_ENV_VAR,
  parseClipboardMode,
  resolveClipboardMode,
} from "./clipboard-mode.js";

describe("clipboard mode", () => {
  it("defaults unset, empty, invalid, zero, and false values to off", () => {
    expect(resolveClipboardMode({ env: {} })).toBe("off");
    expect(parseClipboardMode(undefined)).toBe("off");
    expect(parseClipboardMode("")).toBe("off");
    expect(parseClipboardMode("   ")).toBe("off");
    expect(parseClipboardMode("0")).toBe("off");
    expect(parseClipboardMode("false")).toBe("off");
    expect(parseClipboardMode("clipboard")).toBe("off");
  });

  it("accepts explicit on values", () => {
    expect(parseClipboardMode("1")).toBe("on");
    expect(parseClipboardMode("true")).toBe("on");
    expect(parseClipboardMode("on")).toBe("on");
    expect(parseClipboardMode(" ON ")).toBe("on");
  });

  it("resolves ESTACODA_CLIPBOARD from injected env without mutation", () => {
    const env = { [CLIPBOARD_MODE_ENV_VAR]: " true " };
    const before = { ...env };

    expect(resolveClipboardMode({ env })).toBe("on");
    expect(env).toEqual(before);
  });
});
