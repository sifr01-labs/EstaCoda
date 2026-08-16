import { describe, expect, it } from "vitest";
import type { BrowserBackend, BrowserSnapshot, BrowserTab } from "../contracts/browser.js";
import { BrowserSessionStateError } from "./session-state.js";
import {
  BROWSER_STATE_MAX_TABS,
  projectBrowserStateFromExecutions,
  refreshBrowserStateProjection
} from "./browser-state-projection.js";

function activeBackend(input: {
  snapshot: BrowserSnapshot;
  tabs?: BrowserTab[];
}): BrowserBackend {
  return {
    kind: "mock",
    isAvailable: () => true,
    status: () => ({ backend: "mock", available: true }),
    navigate: async () => ({
      session: { id: input.snapshot.sessionId, backend: "mock", createdAt: input.snapshot.observedAt },
      snapshot: input.snapshot
    }),
    snapshot: async () => input.snapshot,
    tabs: async () => ({
      sessionId: input.snapshot.sessionId,
      tabs: input.tabs ?? (input.snapshot.tab === undefined ? [] : [input.snapshot.tab]),
      blockedCount: 0
    })
  };
}

function snapshot(input: {
  actionRevision: number;
  tabRef?: string;
  url?: string;
  title?: string;
}): BrowserSnapshot {
  const url = input.url ?? "https://example.com/current";
  return {
    sessionId: "browser-session",
    url,
    identity: { documentEpoch: 1, actionRevision: input.actionRevision, observationId: input.actionRevision },
    observedAt: "2026-08-13T00:00:00.000Z",
    readiness: "complete",
    tab: {
      ref: input.tabRef ?? "@t1",
      url,
      title: input.title ?? "Current page",
      controlled: true
    }
  };
}

describe("browser state projection", () => {
  it("detects manual changes while refreshing authoritative state", async () => {
    const previous = await refreshBrowserStateProjection({
      backend: activeBackend({ snapshot: snapshot({ actionRevision: 2, tabRef: "@t1" }) }),
      sessionId: "browser-session"
    });
    const refreshed = await refreshBrowserStateProjection({
      backend: activeBackend({
        snapshot: snapshot({ actionRevision: 3, tabRef: "@t2", url: "https://example.com/manual" }),
        tabs: [
          { ref: "@t1", url: "https://example.com/current", controlled: false },
          { ref: "@t2", url: "https://example.com/manual", controlled: true }
        ]
      }),
      sessionId: "browser-session",
      previous
    });

    expect(refreshed).toMatchObject({
      sessionStatus: "active",
      freshness: "current",
      externalChangeDetected: true,
      identity: { documentEpoch: 1, actionRevision: 3, observationId: 3 },
      controlledTab: { ref: "@t2", url: "https://example.com/manual" }
    });
  });

  it("represents a missing session explicitly", async () => {
    const backend: BrowserBackend = {
      kind: "mock",
      isAvailable: () => true,
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => { throw new Error("unused"); },
      tabs: async () => { throw new BrowserSessionStateError("session_missing", "Browser session not found: browser-session"); }
    };

    await expect(refreshBrowserStateProjection({ backend, sessionId: "browser-session" })).resolves.toMatchObject({
      sessionStatus: "missing",
      sessionId: "browser-session",
      freshness: "current"
    });
  });

  it("does not claim an active session when an available backend cannot inspect session state", async () => {
    const backend: BrowserBackend = {
      kind: "firecrawl",
      isAvailable: () => true,
      status: () => ({ backend: "firecrawl", available: true }),
      navigate: async () => { throw new Error("unused"); }
    };

    await expect(refreshBrowserStateProjection({ backend, sessionId: "browser-session" })).resolves.toMatchObject({
      sessionStatus: "missing",
      freshness: "stale"
    });
  });

  it("returns stale prior state when browser refresh is aborted", async () => {
    const controller = new AbortController();
    const previous = await refreshBrowserStateProjection({
      backend: activeBackend({ snapshot: snapshot({ actionRevision: 2 }) }),
      sessionId: "browser-session"
    });
    const backend: BrowserBackend = {
      kind: "mock",
      isAvailable: () => new Promise<boolean>(() => undefined),
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => { throw new Error("unused"); }
    };

    const refresh = refreshBrowserStateProjection({
      backend,
      sessionId: "browser-session",
      previous,
      signal: controller.signal
    });
    controller.abort("cancelled turn");

    await expect(refresh).resolves.toMatchObject({
      sessionStatus: "active",
      freshness: "stale",
      controlledTab: { url: "https://example.com/current" }
    });
  });

  it("bounds a silent browser refresh with one deadline", async () => {
    const backend: BrowserBackend = {
      kind: "mock",
      isAvailable: () => new Promise<boolean>(() => undefined),
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => { throw new Error("unused"); }
    };

    await expect(refreshBrowserStateProjection({
      backend,
      sessionId: "browser-session",
      timeoutMs: 5
    })).resolves.toMatchObject({
      sessionStatus: "missing",
      freshness: "stale"
    });
  });

  it("bounds tabs and redacts secrets before state reaches a prompt", async () => {
    const secret = "secretsecretsecretsecret";
    const tabs = Array.from({ length: BROWSER_STATE_MAX_TABS + 4 }, (_, index) => ({
      ref: `@t${index + 1}`,
      url: `https://example.com/${index}?token=${secret}`,
      title: `Bearer ${secret}`,
      controlled: index === 0
    }));
    const projection = await refreshBrowserStateProjection({
      backend: activeBackend({
        snapshot: snapshot({ actionRevision: 4, url: `https://example.com/0?token=${secret}`, title: `Bearer ${secret}` }),
        tabs
      }),
      sessionId: "browser-session"
    });
    const serialized = JSON.stringify(projection);

    expect(projection.tabs).toHaveLength(BROWSER_STATE_MAX_TABS);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("derives current state and last action from trusted browser tool metadata", () => {
    const current = snapshot({ actionRevision: 9, tabRef: "@t3" });
    current.actionDelta = {
      outcome: "changed",
      beforeIdentity: { documentEpoch: 1, actionRevision: 8, observationId: 8 },
      afterIdentity: current.identity,
      waitCondition: "dom-stable",
      conditionMet: true,
      url: { changed: false, after: current.url }
    };
    const projection = projectBrowserStateFromExecutions({
      sessionId: "browser-session",
      executions: [{
        tool: {
          name: "browser.click",
          description: "click",
          inputSchema: {},
          riskClass: "read-only-network",
          toolsets: ["browser"],
          progressLabel: "clicking",
          maxResultSizeChars: 1000
        },
        decision: "allow",
        riskClass: "read-only-network",
        result: { ok: true, content: "clicked", metadata: { snapshot: current } }
      }]
    });

    expect(projection).toMatchObject({
      sessionStatus: "active",
      controlledTab: { ref: "@t3" },
      identity: current.identity,
      lastAction: { tool: "browser.click", status: "succeeded", changed: true }
    });
  });
});
