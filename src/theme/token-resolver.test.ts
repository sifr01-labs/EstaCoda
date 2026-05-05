import { describe, it, expect } from "vitest";
import { resolveTokens, getBaseTheme } from "./token-resolver.js";

describe("resolveTokens", () => {
  it("resolves standard + light + no skin", () => {
    const r = resolveTokens("standard", "light", "none");
    expect(r.mode).toBe("standard");
    expect(r.theme).toBe("light");
    expect(r.skin).toBe("none");
    expect(r.contract.palette.brand).toBe("#0057D9");
    expect(r.contract.behavior.allowAnsiColor).toBe(true);
    expect(r.contract.behavior.allowAnimation).toBe(true);
  });

  it("resolves standard + dark + no skin", () => {
    const r = resolveTokens("standard", "dark", "none");
    expect(r.theme).toBe("dark");
    expect(r.contract.palette.brand).toBe("#5AACFF");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
  });

  it("resolves plain + light + no skin", () => {
    const r = resolveTokens("plain", "light", "none");
    expect(r.mode).toBe("plain");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.glyph.spinner.waiting).toEqual(["|", "/", "-", "\\"]);
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
    expect(r.contract.behavior.allowAnimation).toBe(false);
    expect(r.contract.behavior.allowEmoji).toBe(false);
  });

  it("resolves plain + dark + no skin", () => {
    const r = resolveTokens("plain", "dark", "none");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
  });

  it("resolves standard + light + kemetBlue", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.skin).toBe("kemetBlue");
    expect(r.contract.palette.brand).toBe("#0057D9");
    expect(r.contract.branding.taglinePrimary).toBe("\u2625 Kemet Research \u2625");
    expect(r.contract.glyph.spinner.waiting).toContain("(\u2326)");
    expect(r.contract.behavior.allowAnsiColor).toBe(true);
  });

  it("resolves standard + dark + kemetBlue", () => {
    const r = resolveTokens("standard", "dark", "kemetBlue");
    expect(r.skin).toBe("kemetBlue");
    expect(r.contract.palette.brand).toBe("#5AACFF");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
    expect(r.contract.branding.taglinePrimary).toBe("\u2625 Kemet Research \u2625");
  });

  it("resolves plain + light + kemetBlue", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.mode).toBe("plain");
    expect(r.skin).toBe("kemetBlue");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.branding.taglinePrimary).toBe("\u2625 Kemet Research \u2625");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
  });

  it("resolves plain + dark + kemetBlue", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
    expect(r.contract.branding.taglinePrimary).toBe("\u2625 Kemet Research \u2625");
  });

  it("defaults skin to none when omitted", () => {
    const r = resolveTokens("standard", "light");
    expect(r.skin).toBe("none");
  });
});

describe("theme invariants", () => {
  it("light brand is #0057D9", () => {
    const t = getBaseTheme("light");
    expect(t.palette.brand).toBe("#0057D9");
  });

  it("dark brand is #5AACFF", () => {
    const t = getBaseTheme("dark");
    expect(t.palette.brand).toBe("#5AACFF");
  });

  it("light action accent is turquoise", () => {
    const t = getBaseTheme("light");
    expect(t.palette.action).toBe("#00BFA5");
  });

  it("dark action accent is turquoise", () => {
    const t = getBaseTheme("dark");
    expect(t.palette.action).toBe("#00E5C9");
  });

  it("light caution accent is amber", () => {
    const t = getBaseTheme("light");
    expect(t.palette.caution).toBe("#FFA000");
  });

  it("dark caution accent is amber", () => {
    const t = getBaseTheme("dark");
    expect(t.palette.caution).toBe("#FFB300");
  });

  it("severity colors are semantic, not brand", () => {
    const light = getBaseTheme("light");
    expect(light.severity.ok).not.toBe(light.palette.brand);
    expect(light.severity.error).not.toBe(light.palette.brand);
    expect(light.severity.warn).not.toBe(light.palette.brand);
  });

  it("surfaces are neutral in light theme", () => {
    const t = getBaseTheme("light");
    expect(t.surface.bg).toBe("#FFFFFF");
    expect(t.surface.bgElevated).toBe("#F5F5F5");
  });

  it("surfaces are neutral in dark theme", () => {
    const t = getBaseTheme("dark");
    expect(t.surface.bg).toBe("#1A1A1A");
    expect(t.surface.bgElevated).toBe("#252525");
  });
});

describe("plain mode invariants", () => {
  it("plain forces ASCII prompt", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.contract.glyph.prompt).toBe(">");
  });

  it("plain forces ASCII spinner", () => {
    const r = resolveTokens("plain", "dark", "none");
    const frames = r.contract.glyph.spinner.waiting;
    for (const f of frames) {
      expect(f.charCodeAt(0)).toBeLessThan(128);
    }
  });

  it("plain forces ASCII tool icons", () => {
    const r = resolveTokens("plain", "light", "none");
    for (const icon of Object.values(r.contract.toolIcon)) {
      expect(icon.charCodeAt(0)).toBeLessThan(128);
    }
  });

  it("plain disables ANSI color", () => {
    const r = resolveTokens("plain", "light", "none");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
  });

  it("plain disables animation", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.behavior.allowAnimation).toBe(false);
  });
});

describe("kemetBlue skin overlay", () => {
  it("preserves base theme brand color", () => {
    const light = resolveTokens("standard", "light", "kemetBlue");
    expect(light.contract.palette.brand).toBe("#0057D9");
    const dark = resolveTokens("standard", "dark", "kemetBlue");
    expect(dark.contract.palette.brand).toBe("#5AACFF");
  });

  it("overrides branding only", () => {
    const base = getBaseTheme("light");
    const skinned = resolveTokens("standard", "light", "kemetBlue");
    expect(skinned.contract.branding.taglinePrimary).not.toBe(
      base.branding.taglinePrimary
    );
  });

  it("overrides spinner glyphs", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.contract.glyph.spinner.waiting).toContain("(\u2326)");
  });

  it("overrides tool icons", () => {
    const r = resolveTokens("standard", "dark", "kemetBlue");
    expect(r.contract.toolIcon.terminal).toBe("\u2318");
  });
});

describe("skin overlay precedence", () => {
  it("plain overlay wins over skin for behavior", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
    expect(r.contract.behavior.allowAnimation).toBe(false);
  });

  it("plain overlay wins over skin for glyphs", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.contract.glyph.prompt).toBe(">");
  });

  it("skin keeps branding even in plain mode", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.branding.taglinePrimary).toBe("\u2625 Kemet Research \u2625");
  });
});
