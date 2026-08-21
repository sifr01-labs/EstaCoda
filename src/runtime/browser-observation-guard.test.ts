import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { BrowserObservationGuard } from "./browser-observation-guard.js";

function execution(input: {
  tool?: string;
  toolInput?: Record<string, unknown>;
  ok?: boolean;
  content?: string;
  metadata?: Record<string, unknown>;
} = {}): ToolExecutionRecord {
  const tool = input.tool ?? "browser.snapshot";
  return {
    tool: {
      name: tool,
      description: "test",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["browser"],
      progressLabel: "test",
      maxResultSizeChars: 8_000
    },
    input: input.toolInput,
    decision: "allow",
    riskClass: "read-only-network",
    result: {
      ok: input.ok ?? true,
      content: input.content ?? "browser result",
      metadata: input.metadata
    }
  };
}

function snapshot(observationId = 1, elements: unknown[] = [{ ref: "@e1", role: "button", name: "Open" }]) {
  return {
    sessionId: "session-1",
    url: "https://example.com/apps",
    title: "Apps",
    identity: { documentEpoch: 3, actionRevision: 7, observationId },
    observedAt: `2026-08-20T00:00:0${observationId}.000Z`,
    tab: { ref: "@t1", url: "https://example.com/apps", controlled: true },
    elements
  };
}

function targetFailure(locator: string): ToolExecutionRecord {
  return execution({
    tool: "browser.click",
    toolInput: { locator: { text: locator } },
    ok: false,
    content: "Browser locator did not match a current element.",
    metadata: {
      reason: "browser-target-not-found",
      currentIdentity: { documentEpoch: 3, actionRevision: 7, observationId: 4 }
    }
  });
}

function action(toolInput: Record<string, unknown>, outcome: string): ToolExecutionRecord {
  return execution({
    tool: "browser.click",
    toolInput,
    metadata: {
      snapshot: {
        ...snapshot(6),
        actionDelta: { outcome, url: { changed: outcome === "changed" } }
      }
    }
  });
}

function blockedPopup(ref: string, destination: string): ToolExecutionRecord {
  const record = action({ ref }, "popup-blocked");
  const actionDelta = (record.result!.metadata!.snapshot as Record<string, unknown>).actionDelta as Record<string, unknown>;
  actionDelta.popup = { destination, userGesture: true };
  return record;
}

function terminalNavigation(url: string, status: number, documentEpoch: number): ToolExecutionRecord {
  return execution({
    tool: "browser.navigate",
    toolInput: { url, disposition: "current-tab" },
    metadata: {
      snapshot: {
        ...snapshot(documentEpoch),
        url,
        identity: { documentEpoch, actionRevision: documentEpoch, observationId: documentEpoch },
        mainDocument: { status }
      }
    }
  });
}

describe("BrowserObservationGuard", () => {
  it("treats a focused find and a structural snapshot as distinct new evidence on an unchanged page", () => {
    const guard = new BrowserObservationGuard(3);
    const find = execution({
      tool: "browser.find",
      toolInput: { locator: { text: "TikTok Connect" } },
      metadata: {
        status: "not-found",
        identity: { documentEpoch: 3, actionRevision: 7, observationId: 2 },
        tabRef: "@t1",
        candidates: [],
        nearbyCandidates: [{ ref: "@e4", role: "link", name: "apps", withinText: "TikTok Connect notification" }]
      }
    });
    const structural = execution({ metadata: { snapshot: snapshot(3, [
      { ref: "@e62", role: "link", name: "Callback", regionText: "TikTok Connect Callback Edit Delete" },
      { ref: "@e65", role: "link", name: "Edit", regionText: "TikTok Connect Callback Edit Delete" }
    ]) } });

    expect(guard.observe([find])).toMatchObject({ evidenceAdvanced: true, count: 0, shouldStop: false });
    expect(guard.observe([structural])).toMatchObject({ evidenceAdvanced: true, count: 0, shouldStop: false });
  });

  it("nudges an identical observation, suppresses only that whole-state tool, and then stops a repeat", () => {
    const guard = new BrowserObservationGuard(3);
    const first = execution({ metadata: { snapshot: snapshot(1) } });
    const later = execution({ metadata: { snapshot: snapshot(2) } });

    expect(guard.observe([first])).toMatchObject({ evidenceAdvanced: true, count: 0 });
    expect(guard.observe([later])).toEqual({
      tool: "browser.snapshot",
      count: 1,
      evidenceAdvanced: false,
      actionDispatched: false,
      shouldNudge: true,
      shouldRetarget: false,
      shouldStop: false,
      suppressedTools: ["browser.snapshot"]
    });
    expect(guard.observe([later])).toMatchObject({ count: 2, shouldNudge: false, shouldStop: true });
  });

  it("does not treat ref renumbering, element order, timestamps, or observation IDs as new evidence", () => {
    const guard = new BrowserObservationGuard(3);
    const first = execution({ metadata: { snapshot: snapshot(1, [
      { ref: "@e1", role: "button", name: "Open" },
      { ref: "@e2", role: "link", name: "Edit" }
    ]) } });
    const churned = execution({ metadata: { snapshot: snapshot(9, [
      { ref: "@e9", role: "link", name: "Edit" },
      { ref: "@e8", role: "button", name: "Open" }
    ]) } });

    guard.observe([first]);
    expect(guard.observe([churned])).toMatchObject({ evidenceAdvanced: false, shouldNudge: true });
  });

  it("does not count different locator wording with the same candidate set as new evidence", () => {
    const guard = new BrowserObservationGuard(3);
    const result = {
      status: "not-found",
      identity: { documentEpoch: 3, actionRevision: 7, observationId: 2 },
      tabRef: "@t1",
      candidates: [],
      nearbyCandidates: [{ ref: "@e4", role: "link", name: "Edit", regionText: "TikTok Connect" }]
    };

    guard.observe([execution({ tool: "browser.find", toolInput: { locator: { text: "TikTok Connect" } }, metadata: result })]);
    expect(guard.observe([execution({
      tool: "browser.find",
      toolInput: { locator: { text: "tiktok   connect" } },
      metadata: { ...result, identity: { ...result.identity, observationId: 3 } }
    })])).toMatchObject({ evidenceAdvanced: false, shouldNudge: true, suppressedTools: [] });
  });

  it("bounds alternating empty or failed observation tools once their evidence has already been seen", () => {
    const guard = new BrowserObservationGuard(3);
    const find = execution({ tool: "browser.find", content: "No element matched." });
    const screenshot = execution({ tool: "browser.screenshot", ok: false, content: "Blocked.", metadata: { reason: "protected-input" } });
    const extract = execution({ tool: "browser.extract", content: "No text." });

    expect(guard.observe([find])?.evidenceAdvanced).toBe(true);
    expect(guard.observe([screenshot])?.evidenceAdvanced).toBe(true);
    expect(guard.observe([extract])?.evidenceAdvanced).toBe(true);
    expect(guard.observe([find])).toMatchObject({ count: 1, shouldNudge: true });
    expect(guard.observe([screenshot])).toMatchObject({ count: 2, shouldStop: true });
  });

  it("permits one bounded retarget when no action was dispatched", () => {
    const guard = new BrowserObservationGuard(3);

    expect(guard.observe([targetFailure("TikTok Connect")])).toMatchObject({
      actionDispatched: false,
      shouldRetarget: true,
      shouldStop: false
    });
    expect(guard.observe([action({ ref: "@e65" }, "changed")])).toBeUndefined();
    expect(guard.observe([targetFailure("Another app")])).toMatchObject({ shouldRetarget: true, shouldStop: false });
  });

  it("stops the same failed target or a second failed retarget", () => {
    const repeated = new BrowserObservationGuard(3);
    repeated.observe([targetFailure("TikTok Connect")]);
    expect(repeated.observe([targetFailure("TikTok Connect")])).toMatchObject({ shouldStop: true });

    const different = new BrowserObservationGuard(3);
    different.observe([targetFailure("TikTok Connect")]);
    expect(different.observe([targetFailure("TikTok Connect app card")])).toMatchObject({
      shouldRetarget: false,
      shouldStop: true
    });
  });

  it("allows a targeting repair after one dispatched no-change action", () => {
    const guard = new BrowserObservationGuard(3);
    expect(guard.observe([action({ ref: "@e62" }, "no-change")])).toMatchObject({
      actionDispatched: true,
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([targetFailure("TikTok Connect")])).toMatchObject({
      actionDispatched: false,
      shouldRetarget: true,
      shouldStop: false
    });
    expect(guard.observe([action({ ref: "@e65" }, "changed")])).toBeUndefined();
  });

  it("stops a repeated ineffective action while allowing bounded distinct strategies", () => {
    const repeated = new BrowserObservationGuard(3);
    repeated.observe([action({ ref: "@e62" }, "no-change")]);
    expect(repeated.observe([action({ ref: "@e62" }, "no-change")])).toMatchObject({ shouldStop: true });

    const different = new BrowserObservationGuard(3);
    different.observe([action({ ref: "@e62" }, "no-change")]);
    expect(different.observe([action({ ref: "@e65" }, "no-change")])).toMatchObject({
      shouldNudge: true,
      shouldStop: false
    });
    expect(different.observe([action({ ref: "@e66" }, "no-change")])).toMatchObject({ shouldStop: true });
  });

  it("allows one blocked-popup strategy change and stops the same destination across different targets", () => {
    const guard = new BrowserObservationGuard(3);
    guard.observe([targetFailure("TikTok Connect")]);
    expect(guard.observe([blockedPopup("@e62", "https://example.com/connect")])).toMatchObject({
      actionDispatched: true,
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([blockedPopup("@e65", "https://example.com/connect")])).toMatchObject({
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("fingerprints terminal navigation semantically across document revisions", () => {
    const guard = new BrowserObservationGuard(3);

    expect(guard.observe([terminalNavigation("https://example.com/connect", 405, 3)])).toMatchObject({
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([terminalNavigation("https://example.com/connect#retry", 405, 9)])).toMatchObject({
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("allows a different terminal navigation strategy but still bounds endless variations", () => {
    const guard = new BrowserObservationGuard(3);

    guard.observe([terminalNavigation("https://example.com/connect", 405, 3)]);
    expect(guard.observe([terminalNavigation("https://example.com/apps/edit", 404, 4)])).toMatchObject({
      shouldNudge: true,
      shouldStop: false
    });
    expect(guard.observe([terminalNavigation("https://example.com/apps/settings", 404, 5)])).toMatchObject({
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("treats controlled new-tab and same-tab navigation as progress", () => {
    const guard = new BrowserObservationGuard(3);
    expect(guard.observe([action({ disposition: "new-tab" }, "new-tab-opened")])).toBeUndefined();
    expect(guard.observe([action({ ref: "@e1" }, "same-tab-navigation")])).toBeUndefined();
  });

  it("does not expose page content, inputs, or fingerprints in assessments", () => {
    const guard = new BrowserObservationGuard(3);
    const sensitive = execution({
      toolInput: { locator: { text: "secret-query" } },
      content: "secret-visible-content",
      metadata: { snapshot: { ...snapshot(1), text: "secret-metadata-content" } }
    });

    guard.observe([sensitive]);
    const assessment = guard.observe([sensitive]);
    expect(JSON.stringify(assessment)).not.toContain("secret");
    expect(assessment).toMatchObject({ tool: "browser.snapshot", shouldNudge: true });
  });
});
