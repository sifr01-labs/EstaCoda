import { describe, expect, it } from "vitest";
import type { BrowserBackend } from "../contracts/browser.js";
import { createMockBrowserBackend, createUnconfiguredBrowserBackend } from "./browser-backend.js";
import { browserCapabilities, validateBrowserBackendCapabilities } from "./browser-capabilities.js";

describe("browser backend capabilities", () => {
  it("reports explicit truthful capabilities for configured and unconfigured backends", async () => {
    const mock = createMockBrowserBackend();
    const unconfigured = createUnconfiguredBrowserBackend();

    expect(mock.capabilities).toMatchObject({ snapshots: true, semanticActions: true, downloads: false });
    expect((await mock.status()).capabilities).toEqual(mock.capabilities);
    expect(unconfigured.capabilities).toEqual(browserCapabilities());
    expect((await unconfigured.status()).capabilities).toEqual(unconfigured.capabilities);
  });

  it("rejects a capability declaration without its required implementation", () => {
    const backend = {
      kind: "mock",
      capabilities: browserCapabilities({ downloads: true }),
      isAvailable: () => true,
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => { throw new Error("unused"); }
    } satisfies BrowserBackend;

    expect(() => validateBrowserBackendCapabilities(backend)).toThrow(
      "declares downloads without implementing download"
    );
  });
});
