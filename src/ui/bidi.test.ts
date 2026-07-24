import { describe, expect, it } from "vitest";
import {
  balanceBidiIsolatesAcrossSegments,
  closeOpenBidiIsolates,
  FSI,
  isolateAuto,
  isolateLtr,
  isolateTechnicalTokens,
  LRI,
  PDI,
  prepareBidiTextForWrapping,
  RLI,
  sanitizeBidiControls,
} from "./bidi.js";

describe("bidi isolation", () => {
  it.each([
    ["slash command", "/help"],
    ["path", "/workspace/src/main.ts"],
    ["model ID", "deepseek-reasoner"],
    ["provider ID", "openrouter"],
    ["env var", "ESTACODA_API_KEY"],
    ["version", "v0.0.5"],
    ["session ID", "sess-9f7a2c1b"],
    ["numeric value", "32.7k"],
    ["key chord", "Ctrl+C"],
  ])("wraps a %s in LRI/PDI", (_label, value) => {
    expect(isolateLtr(value)).toBe(`${LRI}${value}${PDI}`);
  });

  it("uses FSI/PDI when the direction should come from the content", () => {
    expect(isolateAuto("مرحبا EstaCoda")).toBe(`${FSI}مرحبا EstaCoda${PDI}`);
  });

  it("produces stable output for identical input", () => {
    expect(isolateLtr("/model")).toBe(isolateLtr("/model"));
  });
});

describe("sanitizeBidiControls", () => {
  it("preserves balanced nested isolates in untrusted text", () => {
    const value = `${RLI}مرحبا ${LRI}EstaCoda${PDI}${PDI}`;
    expect(sanitizeBidiControls(value)).toBe(value);
  });

  it("removes legacy overrides and unmatched PDI from untrusted text", () => {
    const value = `قبل \u202eabc\u202c${PDI} بعد`;
    expect(sanitizeBidiControls(value)).toBe("قبل abc بعد");
  });

  it("contains malformed open isolates to their logical line", () => {
    const value = `${LRI}GPT-5.5\n${PDI}مرحبا`;
    expect(sanitizeBidiControls(value)).toBe(`${LRI}GPT-5.5${PDI}\nمرحبا`);
  });

  it("preserves app-authored controls for trusted text", () => {
    const value = `قبل \u202eabc\u202c${PDI} بعد`;
    expect(sanitizeBidiControls(value, "trusted")).toBe(value);
  });

  it("does not inspect control-like bytes inside ANSI sequences", () => {
    const value = "مرحبا \x1b[31mGPT-5.5\x1b[0m";
    expect(sanitizeBidiControls(value)).toBe(value);
  });
});

describe("isolateTechnicalTokens", () => {
  it("leaves pure English text unchanged", () => {
    const value = "Run pnpm and open the project.";
    expect(isolateTechnicalTokens(value)).toBe(value);
  });

  it("isolates common technical tokens in mixed Arabic text", () => {
    const value = "استخدم KIMI_API_KEY مع kimi-k2.6 في /workspace/src/main.ts";
    expect(isolateTechnicalTokens(value)).toBe(
      `استخدم ${isolateLtr("KIMI_API_KEY")} مع ${isolateLtr("kimi-k2.6")} في ${isolateLtr("/workspace/src/main.ts")}`
    );
  });

  it("isolates single and multi-word Latin runs in Arabic prose", () => {
    const value = "استخدم OpenAI مع Agent Evolution الآن";
    expect(isolateTechnicalTokens(value)).toBe(
      `استخدم ${isolateLtr("OpenAI")} مع ${isolateLtr("Agent Evolution")} الآن`
    );
  });

  it("isolates explicit multi-word commands without translating them", () => {
    const command = "pnpm run smoke";
    expect(isolateTechnicalTokens(`شغّل ${command} الآن`, {
      tokens: [command],
      detectCommonTokens: false,
    })).toBe(`شغّل ${isolateLtr(command)} الآن`);
  });

  it("isolates an explicit technical label even when it is the whole value", () => {
    expect(isolateTechnicalTokens("Telegram", {
      tokens: ["Telegram"],
      detectCommonTokens: false,
    })).toBe(isolateLtr("Telegram"));
  });

  it("does not wrap a token that is already inside a nested isolate", () => {
    const value = `${RLI}استخدم ${LRI}GPT-5.5${PDI} الآن${PDI}`;
    expect(isolateTechnicalTokens(value)).toBe(value);
  });

  it("preserves ANSI sequences while isolating their visible token", () => {
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    expect(isolateTechnicalTokens(`استخدم ${red}GPT-5.5${reset} الآن`)).toBe(
      `استخدم ${red}${isolateLtr("GPT-5.5")}${reset} الآن`
    );
  });

  it("does not alter an OSC hyperlink while isolating its visible label", () => {
    const openLink = "\x1b]8;;https://example.com\x07";
    const closeLink = "\x1b]8;;\x07";
    expect(isolateTechnicalTokens(`افتح ${openLink}GPT-5.5${closeLink} الآن`)).toBe(
      `افتح ${openLink}${isolateLtr("GPT-5.5")}${closeLink} الآن`
    );
  });
});

describe("prepareBidiTextForWrapping", () => {
  it("prepares each logical line without removing its newline style", () => {
    const value = "استخدم GPT-5.5\r\nثم KIMI_API_KEY\nDone";
    expect(prepareBidiTextForWrapping(value)).toBe(
      `استخدم ${isolateLtr("GPT-5.5")}\r\nثم ${isolateLtr("KIMI_API_KEY")}\nDone`
    );
  });

  it("sanitizes untrusted controls before isolating technical tokens", () => {
    const value = `استخدم \u202eGPT-5.5\u202c الآن`;
    expect(prepareBidiTextForWrapping(value)).toBe(`استخدم ${isolateLtr("GPT-5.5")} الآن`);
  });

  it("can preserve trusted directional controls", () => {
    const value = `${RLI}مرحبا ${LRI}GPT-5.5${PDI}${PDI}`;
    expect(prepareBidiTextForWrapping(value, { source: "trusted" })).toBe(value);
  });

  it("is idempotent for already prepared mixed-direction text", () => {
    const prepared = prepareBidiTextForWrapping("استخدم GPT-5.5 مع KIMI_API_KEY");
    expect(prepareBidiTextForWrapping(prepared)).toBe(prepared);
  });
});

describe("balanceBidiIsolatesAcrossSegments", () => {
  it("closes and reopens nested isolates split by visual wrapping", () => {
    const segments = [
      `${RLI}مرحبا ${LRI}GPT-`,
      `5.5${PDI} الآن${PDI}`,
    ];

    expect(balanceBidiIsolatesAcrossSegments(segments)).toEqual([
      `${RLI}مرحبا ${LRI}GPT-${PDI}${PDI}`,
      `${RLI}${LRI}5.5${PDI} الآن${PDI}`,
    ]);
  });
});

describe("closeOpenBidiIsolates", () => {
  it("leaves balanced isolates unchanged", () => {
    const value = `${RLI}مرحبا ${LRI}EstaCoda${PDI}${PDI}`;
    expect(closeOpenBidiIsolates(value)).toBe(value);
  });

  it("closes unbalanced LRI, RLI, and FSI isolates", () => {
    expect(closeOpenBidiIsolates(`${FSI}${RLI}مرحبا ${LRI}EstaCoda`)).toBe(
      `${FSI}${RLI}مرحبا ${LRI}EstaCoda${PDI}${PDI}${PDI}`
    );
  });
});
