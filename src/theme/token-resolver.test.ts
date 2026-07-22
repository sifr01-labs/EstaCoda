import { describe, it, expect } from "vitest";
import { resolveTokens, getBaseTheme } from "./token-resolver.js";

describe("resolveTokens", () => {
  it("resolves standard + light + kemetBlue", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.mode).toBe("standard");
    expect(r.theme).toBe("light");
    expect(r.skin).toBe("kemetBlue");
    expect(r.contract.palette.brand).toBe("#4389D7");
    expect(r.contract.palette.accent).toBe("#0057D9");
    expect(r.contract.palette.action).toBe("#008C95");
    expect(r.contract.palette.caution).toBe("#B45309");
    expect(r.contract.trace).toMatchObject({
      terminal: "#616161",
      search: "#0057D9",
      plan: "#6D28D9",
      read: "#2563EB",
      edit: "#008C95",
      answer: "#2E7D32",
      wait: "#B45309",
      finish: "#2E7D32",
      failed: "#C62828",
    });
    expect(r.contract.behavior.allowAnsiColor).toBe(true);
    expect(r.contract.behavior.allowAnimation).toBe(true);
  });

  it("resolves standard + dark + kemetBlue", () => {
    const r = resolveTokens("standard", "dark", "kemetBlue");
    expect(r.theme).toBe("dark");
    expect(r.contract.palette.brand).toBe("#4389D7");
    expect(r.contract.palette.accent).toBe("#4EA1FF");
    expect(r.contract.palette.action).toBe("#40E0D0");
    expect(r.contract.palette.caution).toBe("#FFB454");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
    expect(r.contract.trace.search).toBe("#5AACFF");
    expect(r.contract.trace.edit).toBe("#40E0D0");
  });

  it("resolves plain + light + kemetBlue", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.mode).toBe("plain");
    expect(r.skin).toBe("kemetBlue");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.motion.waiting.frames).toEqual(["|", "/", "-", "\\"]);
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
    expect(r.contract.behavior.allowAnimation).toBe(false);
    expect(r.contract.behavior.allowEmoji).toBe(false);
    expect(r.contract.glyph.trace).toEqual({ event: ".", selected: "o", live: ">", earlier: "<" });
  });

  it("resolves plain + dark + kemetBlue", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.surface.bg).toBe("#1A1A1A");
    expect(r.contract.glyph.prompt).toBe(">");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
  });

  it("defaults skin to kemetBlue when omitted", () => {
    const r = resolveTokens("standard", "light");
    expect(r.skin).toBe("kemetBlue");
  });
});

describe("theme invariants", () => {
  it("light base palette is neutral", () => {
    const t = getBaseTheme("light");
    expect(t.palette.brand).toBe("#666666");
    expect(t.palette.accent).toBe("#666666");
    expect(t.palette.action).toBe("#666666");
    expect(t.palette.caution).toBe("#666666");
  });

  it("dark base palette is neutral", () => {
    const t = getBaseTheme("dark");
    expect(t.palette.brand).toBe("#B0B0B0");
    expect(t.palette.accent).toBe("#B0B0B0");
    expect(t.palette.action).toBe("#B0B0B0");
    expect(t.palette.caution).toBe("#B0B0B0");
  });

  it("light severity colors are semantic", () => {
    const t = getBaseTheme("light");
    expect(t.severity.ok).toBe("#2E7D32");
    expect(t.severity.error).toBe("#C62828");
    expect(t.severity.warn).toBe("#EF6C00");
  });

  it("dark severity colors are semantic", () => {
    const t = getBaseTheme("dark");
    expect(t.severity.ok).toBe("#4CAF50");
    expect(t.severity.error).toBe("#EF5350");
    expect(t.severity.warn).toBe("#FFA726");
  });

  it("severity colors are semantic, not brand", () => {
    const light = getBaseTheme("light");
    expect(light.severity.ok).not.toBe(light.palette.brand);
    expect(light.severity.error).not.toBe(light.palette.brand);
    expect(light.severity.warn).not.toBe(light.palette.brand);
  });

  it("trace colors are complete semantic theme tokens", () => {
    for (const theme of ["light", "dark"] as const) {
      const trace = getBaseTheme(theme).trace;
      expect(Object.keys(trace).sort()).toEqual([
        "answer", "edit", "failed", "finish", "plan", "read", "search", "terminal", "wait"
      ]);
      for (const color of Object.values(trace)) expect(color).toMatch(/^#[0-9A-F]{6}$/u);
    }
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
    const r = resolveTokens("plain", "dark", "kemetBlue");
    const frames = [
      ...r.contract.motion.waiting.frames,
      ...r.contract.motion.thinking.frames,
      ...r.contract.motion.routing.frames,
      ...r.contract.motion.tool.frames,
      ...r.contract.motion.worker.frames,
      ...r.contract.motion.finalizing.frames,
      ...r.contract.motion.background.frames,
    ];
    for (const f of frames) {
      expect(f.charCodeAt(0)).toBeLessThan(128);
    }
    expect(r.contract.motion.worker.frames).toEqual(["."]);
  });

  it("plain forces ASCII tool icons", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    for (const icon of Object.values(r.contract.toolIcon)) {
      expect(icon.charCodeAt(0)).toBeLessThan(128);
    }
  });

  it("plain forces ASCII trace glyphs", () => {
    const traceGlyphs = resolveTokens("plain", "dark", "kemetBlue").contract.glyph.trace;
    for (const glyph of Object.values(traceGlyphs)) expect(glyph.charCodeAt(0)).toBeLessThan(128);
  });

  it("plain disables ANSI color", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    expect(r.contract.behavior.allowAnsiColor).toBe(false);
  });

  it("plain disables animation", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.behavior.allowAnimation).toBe(false);
  });

  it("plain strips Unicode branding symbols", () => {
    const r = resolveTokens("plain", "light", "kemetBlue");
    // No Egyptian eye, no ankh, no Unicode frames in branding
    expect(r.contract.branding.responseLabel).toBe("EstaCoda");
    expect(r.contract.branding.taglinePrimary).toBe("⟡ SIFR01 ⟡");
    expect(r.contract.branding.taglineSecondary).toBe("");
    expect(r.contract.branding.helpHeader).toBe("Available Commands");
  });

  it("plain keeps operational branding text labels ASCII-safe", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.branding.responseLabel).toBe("EstaCoda");
    expect(r.contract.branding.taglinePrimary).toBe("⟡ SIFR01 ⟡");
    const { taglinePrimary: _companyMark, ...operationalBranding } = r.contract.branding;
    for (const value of Object.values(operationalBranding)) {
      if (typeof value === "string" && value.length > 0) {
        for (const ch of value) {
          expect(ch.charCodeAt(0)).toBeLessThan(128);
        }
      }
    }
  });
});

describe("kemetBlue skin overlay", () => {
  it("overrides neutral base brand color in light", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.contract.palette.brand).toBe("#4389D7");
    expect(r.contract.palette.accent).toBe("#0057D9");
  });

  it("overrides neutral base brand color in dark", () => {
    const r = resolveTokens("standard", "dark", "kemetBlue");
    expect(r.contract.palette.brand).toBe("#4389D7");
    expect(r.contract.palette.accent).toBe("#4EA1FF");
  });

  it("overrides branding", () => {
    const base = getBaseTheme("light");
    const skinned = resolveTokens("standard", "light", "kemetBlue");
    expect(skinned.contract.branding.taglinePrimary).not.toBe(
      base.branding.taglinePrimary
    );
  });

  it("resolves the semantic motion language", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.contract.motion.waiting.frames[0]).toBe("⠋");
    expect(r.contract.motion.thinking.frames).toEqual(["◜", "◠", "◝", "◞", "◡", "◟"]);
    expect(r.contract.motion.routing.frames).toEqual(["›", "»", "›", "·"]);
    expect(r.contract.motion.tool.frames).toEqual(["◴", "◷", "◶", "◵"]);
    expect(r.contract.motion.worker.frames).toEqual(["·", "∙", "•", "●", "•", "∙"]);
    expect(r.contract.motion.finalizing.frames).toEqual(["◇", "◈", "◆", "◈"]);
    expect(r.contract.motion.background.frames[0]).toBe("⠁");
  });

  it("gives every motion token its own cadence and themeable color", () => {
    const light = resolveTokens("standard", "light", "kemetBlue").contract.motion;
    const dark = resolveTokens("standard", "dark", "kemetBlue").contract.motion;
    for (const token of Object.values(dark)) {
      expect(token.cadenceMs).toBeGreaterThan(0);
      expect(token.color).toMatch(/^#[0-9A-F]{6}$/u);
    }
    expect(new Set(Object.values(dark).map((token) => token.color)).size).toBe(7);
    expect(new Set(Object.values(light).map((token) => token.color)).size).toBe(7);
    expect(light.thinking.color).not.toBe(dark.thinking.color);
  });

  it("overrides tool icons", () => {
    const r = resolveTokens("standard", "dark", "kemetBlue");
    expect(r.contract.toolIcon.terminal).toBe("\u2318");
  });

  it("uses approved Arabic tagline", () => {
    const r = resolveTokens("standard", "light", "kemetBlue");
    expect(r.contract.branding.taglineSecondary).toBe(
      "\u0627\u0644\u0633\u064a\u0627\u062f\u0629 \u0627\u0644\u062a\u0643\u0646\u0648\u0644\u0648\u062c\u064a\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629"
    );
  });

  it("applies shared overlays across themes", () => {
    const light = resolveTokens("standard", "light", "kemetBlue");
    const dark = resolveTokens("standard", "dark", "kemetBlue");
    expect(light.contract.glyph.prompt).toBe(dark.contract.glyph.prompt);
    expect(light.contract.toolIcon.terminal).toBe(dark.contract.toolIcon.terminal);
    expect(light.contract.branding.agentName).toBe(dark.contract.branding.agentName);
  });

  it("applies theme-specific palette overrides", () => {
    const light = resolveTokens("standard", "light", "kemetBlue");
    const dark = resolveTokens("standard", "dark", "kemetBlue");
    expect(light.contract.palette.brand).toBe("#4389D7");
    expect(dark.contract.palette.brand).toBe("#4389D7");
    expect(light.contract.palette.accent).toBe("#0057D9");
    expect(dark.contract.palette.accent).toBe("#4EA1FF");
    expect(light.contract.palette.accent).not.toBe(dark.contract.palette.accent);
  });

  it("resolves trace glyphs independently from progress glyphs", () => {
    const glyph = resolveTokens("standard", "dark", "kemetBlue").contract.glyph;
    expect(glyph.trace).toEqual({ event: "■", selected: "□", live: "◆", earlier: "‹" });
    expect(glyph.trace.event).not.toBe(glyph.progress.filled);
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

  it("plain strips skin Unicode branding even with kemetBlue", () => {
    const r = resolveTokens("plain", "dark", "kemetBlue");
    expect(r.contract.branding.taglinePrimary).toBe("⟡ SIFR01 ⟡");
    expect(r.contract.branding.taglineSecondary).toBe("");
  });
});
