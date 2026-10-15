import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EXTRACT_SOURCE_CHARS, webExtractWindow } from "./web-extract-window.js";
import { createWebTools } from "./web-tools.js";

import { registerWebResearchProvider, resetWebResearchProvidersForTest } from "./web-research-registry.js";

afterEach(resetWebResearchProvidersForTest);

describe("bounded source passage retrieval", () => {
  it("continues past the prefix without presenting unseen text as read", () => {
    const first = webExtractWindow("prefix..actual definition", 8, {});
    expect(first).toMatchObject({ content: "prefix..", nextStartChar: 8, truncated: true });
    const next = webExtractWindow("prefix..actual definition", 30, { startChar: first.nextStartChar });
    expect(next.content).toContain("actual definition");
    expect(next.truncated).toBe(true);
    expect(next.nextStartChar).toBeUndefined();
  });
  it("finds a late passage and bounds repeated matches with continuation", () => {
    const text = "introduction ".repeat(2500) + "401 Unauthorized means credentials are required. ".repeat(500);
    const result = webExtractWindow(text, 3000, { query: "401 Unauthorized" });
    expect(result.content).toContain("credentials are required");
    expect(result.windows[0]!.start).toBeGreaterThan(24000);
    expect(result.nextStartChar).toBeGreaterThan(24000);
    expect(result.windows.reduce((n, w) => n + w.end - w.start, 0)).toBeLessThanOrEqual(3000);
    expect(webExtractWindow(text, 3000, { query: "401 Unauthorized", startChar: result.nextStartChar }).windows[0]!.start)
      .toBeGreaterThanOrEqual(result.nextStartChar!);
  });
  it("does not interpret query as regex or claim absence from an unseen source", () => {
    const result = webExtractWindow("visible prefix", 100, { query: ".*" }, true);
    expect(result.content).toBe("");
    expect(result.notice).toContain("not evidence");
    expect(result.sourceTruncated).toBe(true);
    expect(webExtractWindow("x".repeat(MAX_EXTRACT_SOURCE_CHARS + 1), 10, {}).sourceTruncated).toBe(true);
  });
  it("preserves Unicode offsets and includes the match in a small window", () => {
    const text = "İ".repeat(300) + "Target";
    const result = webExtractWindow(text, 6, { query: "target" });
    expect(result.windows).toEqual([{ start: 300, end: 306 }]);
    expect(result.content).toContain("Target");
  });
  it("applies the same window and upstream truncation contract to configured extraction providers", async () => {
    const extract = vi.fn(async (url: string) => ({ url, content: "hidden prefix ".repeat(3000) + "Observed finding", truncated: true }));
    registerWebResearchProvider({ name: "window-fixture", displayName: "Window fixture", capabilities: { extract: true },
      getAvailability: () => ({ available: true }), extract });
    const tool = createWebTools({ enableNetwork: true, webConfig: { extractBackend: "window-fixture" },
      resolveHostname: async () => ["93.184.216.34"] }).find(tool => tool.name === "web.extract")!;
    const result = await tool.run({ url: "https://example.com/spec", query: "Observed finding", maxContentChars: 20 });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Observed finding");
    expect(result.metadata).toMatchObject({ sourceTruncated: true, retrievedTextChars: 42016 });
    expect(String(result.metadata?.content).length).toBeLessThan(100);
    expect(extract).toHaveBeenCalledWith("https://example.com/spec", expect.objectContaining({ maxContentChars: MAX_EXTRACT_SOURCE_CHARS }));
    const missing = await tool.run({ url: "https://example.com/spec", query: "unobserved fact" });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("not evidence");
  });
  it("preserves URL guards, validates window inputs and fetches actual late text", async () => {
    let calls = 0;
    const extract = createWebTools({ enableNetwork: true, resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => { calls++; return { ok: true, status: 200, statusText: "OK", headers: { get: () => "text/plain" },
        text: async () => "Preface ".repeat(6000) + "15.5.2. 401 Unauthorized: missing valid credentials." }; }
    }).find(t => t.name === "web.extract")!;
    const found = await extract.run({ url: "https://example.com/spec", query: "15.5.2.", maxContentChars: 2000 });
    expect(found.ok).toBe(true);
    expect(found.content).toContain("missing valid credentials");
    expect(found.metadata).toMatchObject({ truncated: true, source: "fetch" });
    expect((await extract.run({ url: "https://example.com/spec", startChar: -1 })).ok).toBe(false);
    expect((await extract.run({ url: "http://169.254.169.254/latest/meta-data", query: "password" })).ok).toBe(false);
    expect(calls).toBe(1);
  });
});
