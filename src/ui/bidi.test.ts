import { describe, it, expect } from "vitest";
import { closeOpenBidiIsolates, isolateLtr, LRI, PDI, RLI } from "./bidi.js";

describe("isolateLtr", () => {
  it("wraps a slash command in LRI/PDI", () => {
    const out = isolateLtr("/help");
    expect(out).toBe(`${LRI}/help${PDI}`);
  });

  it("wraps a path in LRI/PDI", () => {
    const out = isolateLtr("/workspace/src/main.ts");
    expect(out).toBe(`${LRI}/workspace/src/main.ts${PDI}`);
  });

  it("wraps a model ID in LRI/PDI", () => {
    const out = isolateLtr("deepseek-reasoner");
    expect(out).toBe(`${LRI}deepseek-reasoner${PDI}`);
  });

  it("wraps a provider ID in LRI/PDI", () => {
    const out = isolateLtr("openrouter");
    expect(out).toBe(`${LRI}openrouter${PDI}`);
  });

  it("wraps an env var in LRI/PDI", () => {
    const out = isolateLtr("ESTACODA_API_KEY");
    expect(out).toBe(`${LRI}ESTACODA_API_KEY${PDI}`);
  });

  it("wraps a version in LRI/PDI", () => {
    const out = isolateLtr("v0.0.5");
    expect(out).toBe(`${LRI}v0.0.5${PDI}`);
  });

  it("wraps a session ID in LRI/PDI", () => {
    const out = isolateLtr("sess-9f7a2c1b");
    expect(out).toBe(`${LRI}sess-9f7a2c1b${PDI}`);
  });

  it("wraps a numeric value in LRI/PDI", () => {
    const out = isolateLtr("32.7k");
    expect(out).toBe(`${LRI}32.7k${PDI}`);
  });

  it("wraps a key chord in LRI/PDI", () => {
    const out = isolateLtr("Ctrl+C");
    expect(out).toBe(`${LRI}Ctrl+C${PDI}`);
  });

  it("produces stable output for identical input", () => {
    const a = isolateLtr("/model");
    const b = isolateLtr("/model");
    expect(a).toBe(b);
  });
});

describe("closeOpenBidiIsolates", () => {
  it("leaves balanced isolates unchanged", () => {
    const value = `${RLI}مرحبا ${LRI}EstaCoda${PDI}${PDI}`;
    expect(closeOpenBidiIsolates(value)).toBe(value);
  });

  it("closes unbalanced isolates at the end of a wrapped segment", () => {
    expect(closeOpenBidiIsolates(`${RLI}مرحبا ${LRI}EstaCoda`)).toBe(`${RLI}مرحبا ${LRI}EstaCoda${PDI}${PDI}`);
  });
});
