import { describe, expect, it, vi } from "vitest";
import type { BrowserBackend } from "../contracts/browser.js";
import type { BrowserFieldSecureInputSource } from "../contracts/secure-input.js";
import {
  createProtectedBrowserValueSource,
  ProtectedBrowserValueSourceError
} from "./protected-browser-value-source.js";

const source: BrowserFieldSecureInputSource = {
  type: "browser-field",
  sessionId: "browser-session",
  ref: "@e2",
  identity: { documentEpoch: 1, actionRevision: 2, observationId: 3 },
  expectedOrigin: "https://portal.example.com",
  tabRef: "@t1"
};

describe("protected browser value source", () => {
  it("preserves the browser rejection reason as a bounded typed preparation failure", async () => {
    const backend = browserBackend({
      verifyProtectedSource: vi.fn(async () => ({ status: "rejected" as const, reason: "source-empty" as const }))
    });
    const protectedSource = createProtectedBrowserValueSource(backend);

    const error = await protectedSource.prepare({
      source,
      kind: "client-secret",
      signal: new AbortController().signal
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProtectedBrowserValueSourceError);
    expect(error).toMatchObject({
      code: "protected-browser-source-rejected",
      phase: "before-authorization",
      reason: "source-empty",
      message: "Protected browser source rejected: source-empty."
    });
    expect(JSON.stringify(error)).not.toContain(source.expectedOrigin);
  });

  it("preserves delivery re-verification reasons without reading the source", async () => {
    const readProtectedSource = vi.fn(async () => ({ status: "read" as const, value: new Uint8Array([1]) }));
    const backend = browserBackend({
      verifyProtectedSource: vi.fn(async (input) => input.phase === "before-authorization"
        ? { status: "verified" as const, sourceLabel: "Bound browser value" }
        : { status: "rejected" as const, reason: "tab-mismatch" as const }),
      readProtectedSource
    });
    const protectedSource = createProtectedBrowserValueSource(backend);
    const verified = await protectedSource.prepare({
      source,
      kind: "client-secret",
      signal: new AbortController().signal
    });

    const error = await protectedSource.reverify({
      verified,
      kind: "client-secret",
      signal: new AbortController().signal
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "protected-browser-source-rejected",
      phase: "before-delivery",
      reason: "tab-mismatch"
    });
    expect(readProtectedSource).not.toHaveBeenCalled();
  });

  it("preserves a rejection from the final backend read check", async () => {
    const backend = browserBackend({
      readProtectedSource: vi.fn(async () => ({ status: "rejected" as const, reason: "source-replaced" as const }))
    });
    const protectedSource = createProtectedBrowserValueSource(backend);
    const verified = await protectedSource.prepare({
      source,
      kind: "client-secret",
      signal: new AbortController().signal
    });

    const error = await protectedSource.read({
      verified,
      kind: "client-secret",
      signal: new AbortController().signal
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "protected-browser-source-rejected",
      phase: "before-delivery",
      reason: "source-replaced"
    });
  });
});

function browserBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    kind: "local-cdp",
    isAvailable: async () => true,
    verifyProtectedSource: async () => ({ status: "verified", sourceLabel: "Bound browser value" }),
    readProtectedSource: async () => ({ status: "read", value: new Uint8Array([1]) }),
    releaseProtectedSource: async () => undefined,
    ...overrides
  } as BrowserBackend;
}
