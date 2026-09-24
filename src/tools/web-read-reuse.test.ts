import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnWebReadCache } from "./turn-web-read-cache.js";
import { createWebTools, type WebToolOptions } from "./web-tools.js";
import { registerWebResearchProvider, resetWebResearchProvidersForTest } from "./web-research-registry.js";

const url = "https://93.184.216.34/research?q=one";
afterEach(resetWebResearchProvidersForTest);
function fixture(options: WebToolOptions = {}, headers: Record<string, string | undefined> = {}) {
  const fetch = vi.fn(async (requested: string) => ({ ok: true, status: 200, statusText: "OK",
    headers: { get: (name: string) => headers[name] ?? null }, text: async () => `Observation for ${requested}` }));
  const tool = createWebTools({ enableNetwork: true, webConfig: { extractBackend: "fetch" }, fetch, ...options }).find((tool) => tool.name === "web.extract")!;
  const cache = new TurnWebReadCache();
  let call = 0;
  return { fetch, cache, run: (args: Record<string, unknown> = { url }) => tool.run(args, { webReadReuse: cache.bind("profile/session/turn/target/authority", `call-${++call}`) }) };
}

describe("turn-local public extract reuse", () => {
  it("preserves observation time, content, truncation and owned provenance without another fetch", async () => {
    const h = fixture();
    const first = await h.run({ url, maxContentChars: 15 });
    const hit = await h.run({ url, maxContentChars: 15 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(hit.content).toContain("Prior observation reused from call-1");
    expect(hit.content).toContain(first.content);
    expect(hit.metadata).toMatchObject({ retrievedAt: first.metadata?.retrievedAt, originUrl: url, truncated: true, sourceToolCallId: "call-1" });
    expect(h.cache.provenance(hit)).toBe("call-1");
    expect(h.cache.provenance({ ...hit })).toBeUndefined();
    await h.run({ url, maxContentChars: 15, refresh: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.cache.clear();
    expect(h.cache.provenance(hit)).toBe("call-1");
    await h.run({ url, maxContentChars: 15 });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps meaningful queries and extraction limits distinct", async () => {
    const h = fixture();
    await h.run(); await h.run({ url: url.replace("one", "two") }); await h.run({ url, maxContentChars: 10 });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([{ "cache-control": "private" }, { "cache-control": "no-store" }, { "cache-control": "max-age=1" }, { "set-cookie": "session=value" }, { vary: "Cookie" }])("excludes protected or uncertain-freshness responses %j", async (headers) => {
    const h = fixture({}, headers);
    await h.run(); await h.run(); expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("revalidates changed website policy and public URL eligibility before reuse", async () => {
    const securityConfig = { allowPrivateUrls: true, websiteBlocklist: { domains: [] as string[] } };
    const h = fixture({ securityConfig });
    await h.run(); securityConfig.websiteBlocklist.domains.push("93.184.216.34");
    expect((await h.run()).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const privateRead = fixture({ securityConfig: { allowPrivateUrls: true, websiteBlocklist: { domains: [] } } });
    await privateRead.run({ url: "http://127.0.0.1/doc" }); await privateRead.run({ url: "http://127.0.0.1/doc" });
    expect(privateRead.fetch).toHaveBeenCalledTimes(2);
    expect((await privateRead.run({ url: `${url}&token=secret` })).ok).toBe(false);
  });

  it("rechecks DNS and shared blocklist files rather than trusting the cached observation", async () => {
    let address = "93.184.216.34";
    const dns = fixture({ resolveHostname: () => [address] });
    const args = { url: "https://example.org/research" };
    await dns.run(args); address = "127.0.0.1";
    expect((await dns.run(args)).ok).toBe(false);
    expect(dns.fetch).toHaveBeenCalledTimes(1);
    const dir = await mkdtemp(join(tmpdir(), "extract-policy-"));
    try {
      const path = join(dir, "blocked.txt");
      await writeFile(path, "");
      const h = fixture({ securityConfig: { allowPrivateUrls: false, websiteBlocklist: { sharedFiles: [path] } } });
      await h.run(); await writeFile(path, "93.184.216.34\n");
      expect((await h.run()).ok).toBe(false);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not reuse redirected responses or failed refresh observations", async () => {
    let fail = false;
    const fetch = vi.fn(async (requested: string) => ({ ok: !fail && requested.endsWith("/final"), status: fail ? 503 : requested.endsWith("/final") ? 200 : 302,
      statusText: "fixture", headers: { get: (name: string) => name === "location" && !requested.endsWith("/final") ? "/final" : null }, text: async () => "body" }));
    const h = fixture({ fetch });
    await h.run(); await h.run(); expect(fetch).toHaveBeenCalledTimes(4);
    const direct = { url: "https://93.184.216.34/final" };
    await h.run(direct); fail = true; expect((await h.run({ ...direct, refresh: true })).ok).toBe(false);
    fail = false; await h.run(direct); expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("requires provider opt-in and invalidates replacement providers/configuration", async () => {
    const extract = vi.fn(async (url: string) => ({ url, content: "provider observation", status: 200 }));
    const provider = { name: "fixture", displayName: "Fixture", capabilities: { extract: true as const }, getAvailability: () => ({ available: true }), extract };
    registerWebResearchProvider(provider);
    const config = { extractBackend: "fixture", maxResults: 5 };
    const h = fixture({ webConfig: config });
    await h.run(); await h.run(); expect(extract).toHaveBeenCalledTimes(2);
    registerWebResearchProvider({ ...provider, publicExtractReuse: true });
    await h.run(); await h.run(); expect(extract).toHaveBeenCalledTimes(3);
    config.maxResults = 6;
    await h.run(); expect(extract).toHaveBeenCalledTimes(4);
    registerWebResearchProvider({ ...provider, publicExtractReuse: true });
    await h.run(); expect(extract).toHaveBeenCalledTimes(5);
  });
});

describe("bounded owned observation store", () => {
  it("bounds entries, bytes and age, isolates scope and rejects stale asynchronous views", () => {
    let now = 0;
    const cache = new TurnWebReadCache(() => now);
    const view = cache.bind("session-a", "original").configure("config-a");
    for (let i = 0; i < 17; i++) view.put(String(i), { ok: true, content: String(i) });
    expect(view.get("0")).toBeUndefined(); expect(view.get("16")).toBeDefined();
    view.put("large", { ok: true, content: "a".repeat(256001) }); expect(view.get("large")).toBeUndefined();
    view.put("error", { ok: false, content: "error" }); expect(view.get("error")).toBeUndefined();
    now = 60001; expect(view.get("16")).toBeUndefined();
    cache.bind("session-b", "b").configure("config-a");
    const returned = cache.bind("session-a", "a").configure("config-a");
    view.put("stale", { ok: true, content: "stale" }); expect(returned.get("stale")).toBeUndefined();
    cache.clear(); returned.put("late", { ok: true, content: "late" });
    expect(cache.bind("session-a", "a").configure("config-a").get("late")).toBeUndefined();
  });
});
