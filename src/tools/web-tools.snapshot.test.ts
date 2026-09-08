import { describe, expect, it, vi } from "vitest";
import { createMockBrowserBackend } from "../browser/browser-backend.js";
import { createWebTools, type FetchLike } from "./web-tools.js";

function normalizeSnapshot(result: unknown): unknown {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if ((key === "sessionId" || key === "id") && typeof value === "string") return "<session-id>";
    if ((key === "createdAt" || key === "timestamp" || key === "observedAt") && typeof value === "string") {
      return "<timestamp>";
    }
    if ((key === "path" || key === "screenshotPath") && typeof value === "string") {
      return value.replace(/\/(?:private\/)?tmp\/[^/]+/u, "<tmp-dir>");
    }
    if (typeof value === "string") {
      return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu, "<timestamp>");
    }
    return value;
  }));
}

function getTool(name: string) {
  const tool = createWebTools({
    browserBackend: createMockBrowserBackend({ title: "Test Page", text: "Hello world." }),
    currentSessionId: () => "snapshot-runtime-session",
    resolveHostname: async () => ["93.184.216.34"]
  }).find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}

describe("web and browser golden snapshots", () => {
  it("browser.snapshot output matches golden", async () => {
    const snapshotTool = getTool("browser.snapshot");

    const result = await snapshotTool.run({});

    expect(normalizeSnapshot(result)).toMatchSnapshot("browser-snapshot-mock");
  });

  it("browser.navigate output matches golden", async () => {
    const navigateTool = getTool("browser.navigate");

    const result = await navigateTool.run({ url: "https://example.com" });

    expect(normalizeSnapshot(result)).toMatchSnapshot("browser-navigate-mock");
  });

  it("web.extract output matches golden", async () => {
    const mockFetch: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "text/html" },
      text: async () => "<html><head><title>Example</title></head><body><p>Hello world</p></body></html>"
    }));
    const tools = createWebTools({ fetch: mockFetch, enableNetwork: true, resolveHostname: async () => ["93.184.216.34"] });
    const extractTool = tools.find((candidate) => candidate.name === "web.extract");
    if (extractTool === undefined) {
      throw new Error("Missing tool web.extract");
    }

    const result = await extractTool.run({ url: "https://example.com" });

    expect(normalizeSnapshot(result)).toMatchSnapshot("web-extract-mock");
  });
});
