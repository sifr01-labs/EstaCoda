import { afterEach, describe, expect, it } from "vitest";
import { createWebTools } from "./web-tools.js";
import { webReadableText } from "./web-readable-text.js";
import { ToolRegistry } from "./tool-registry.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { SessionCapabilityRecovery } from "./capability-tools.js";
import { buildProviderToolSchemaCatalog } from "./tool-schema.js";
import { resetWebResearchProvidersForTest } from "./web-research-registry.js";
import { TurnWebReadCache } from "./turn-web-read-cache.js";

afterEach(resetWebResearchProvidersForTest);
describe("research source recovery", () => {
  it("keeps unavailable search discoverable with the actual setup reason and no callable schema", async () => {
    const registry = new ToolRegistry();
    registry.register(createWebTools({ webConfig: { searchBackend: "fetch" } }).find(tool => tool.name === "web.search")!);
    const snapshot = await registry.snapshot();
    const catalog = buildProviderToolSchemaCatalog({ tools: snapshot.available, unavailableTools: snapshot.unavailable });
    const recovery = new SessionCapabilityRecovery({ registry, skills: new SkillRegistry() });
    recovery.bindCatalog(catalog);
    const scope = { sessionId: "s", profileId: "p", visibleTurnId: "t", toolCallId: "call" };
    recovery.beginTurn({ ...scope, tools: [] });
    expect(recovery.discover({ ids: ["tool:web.search"] }, scope).metadata?.matches).toEqual([
      expect.objectContaining({ name: "web.search", state: "temporarily_unavailable", setup_note: "Provider fetch does not support web search." })
    ]);
    expect(catalog.entries).toEqual([]);
    expect(recovery.request({ ids: ["tool:web.search"], reason: "research" }, scope).metadata?.requests).toEqual([
      { id: "tool:web.search", status: "temporarily_unavailable" }
    ]);
  });

  it("extracts lifecycle evidence beyond long site navigation and retains a readable fallback", () => {
    const html = `<html><head><title>Models</title></head><body><nav>${"Model catalog ".repeat(6000)}</nav><main><h1>Kimi</h1><p>Managed endpoints are retired.</p><script>secret script</script></main><footer>Other models</footer></body></html>`;
    expect(webReadableText(html, "text/html")).toEqual({ text: "Kimi Managed endpoints are retired.", contentKind: "main" });
    expect(webReadableText(html, "TEXT/HTML; charset=UTF-8").contentKind).toBe("main");
    expect(webReadableText("<nav>Models</nav><p>GLM endpoint status</p>", "text/html")).toEqual({ text: "GLM endpoint status", contentKind: "body" });
    expect(webReadableText("<nav>Models Pricing</nav>", "text/html")).toEqual({ text: "Models Pricing", contentKind: "navigation-only" });
    expect(webReadableText("x < y and y > z", "text/plain").text).toBe("x < y and y > z");
    expect(webReadableText('<article>الحالة &#x627; &amp; active</article>', "text/html").text).toBe("الحالة ا & active");
  });

  it("preserves actual documentation destinations without treating links as authorization or exposing URL credentials", () => {
    const result = webReadableText('<main>Moved to <a href="./model-cards.html">models at a glance</a>. <a href="javascript:alert(1)">script</a> <a href="https://user:password@example.org/">credentials</a><a href="/doc?token=secret">private link</a></main>', "text/html", "https://docs.example.org/guide/old.html");
    expect(result.text).toContain("[models at a glance](https://docs.example.org/guide/model-cards.html)");
    expect(result.text).not.toContain("javascript:");
    expect(result.text).not.toContain("password");
    expect(result.text).not.toContain("token=secret");
  });

  it("recovers an offset query miss from cached source text without treating it as a failed fetch", async () => {
    let calls = 0;
    const body = "Managed endpoints are retired. " + "Background ".repeat(1000);
    const tool = createWebTools({ enableNetwork: true, webConfig: { extractBackend: "fetch" },
      fetch: async () => { calls++; return { ok: true, status: 200, statusText: "OK", headers: { get: name => name === "content-type" ? "text/plain" : null }, text: async () => body }; }
    }).find(tool => tool.name === "web.extract")!;
    const cache = new TurnWebReadCache();
    const run = (input: Record<string, unknown>, id: string) => tool.run({ url: "https://93.184.216.34/model", maxContentChars: 100, ...input }, { webReadReuse: cache.bind("p/s/t", id) });
    const miss = await run({ query: "retired", startChar: 500 }, "first");
    expect(miss.ok).toBe(true);
    expect(miss.metadata).toMatchObject({ reason: "query-not-found", content: "" });
    const found = await run({ query: "retired", startChar: 0 }, "second");
    expect(found.ok).toBe(true);
    expect(found.content).toContain("Managed endpoints are retired.");
    expect(found.content.length).toBeLessThan(1000);
    expect(JSON.stringify(found.metadata)).not.toContain("Background ".repeat(100));
    expect(cache.provenance(found)).toBe("first");
    expect(calls).toBe(1);
  });
});
