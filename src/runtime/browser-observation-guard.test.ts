import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { BrowserObservationGuard } from "./browser-observation-guard.js";

function execution(input: {
  tool?: string;
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
    decision: "allow",
    riskClass: "read-only-network",
    result: {
      ok: input.ok ?? true,
      content: input.content ?? "rendered snapshot",
      metadata: input.metadata
    }
  };
}

describe("BrowserObservationGuard", () => {
  it("nudges once before stopping an unchanged observation loop", () => {
    const guard = new BrowserObservationGuard(3);
    const observation = execution({
      metadata: {
        snapshot: {
          sessionId: "session-1",
          url: "https://example.com",
          text: "account content"
        }
      }
    });

    expect(guard.observe([observation])).toMatchObject({ count: 1, shouldNudge: false, shouldStop: false });
    expect(guard.observe([observation])).toMatchObject({ count: 2, shouldNudge: true, shouldStop: false });
    expect(guard.observe([observation])).toEqual({
      tool: "browser.snapshot",
      count: 3,
      shouldNudge: false,
      shouldStop: true
    });
  });

  it("treats changed browser state as progress", () => {
    const guard = new BrowserObservationGuard(3);
    const first = execution({ metadata: { snapshot: { url: "https://example.com", text: "first" } } });
    const changed = execution({ metadata: { snapshot: { url: "https://example.com", text: "second" } } });

    guard.observe([first]);
    expect(guard.observe([first])?.shouldNudge).toBe(true);
    expect(guard.observe([changed])).toMatchObject({ count: 1, shouldNudge: false, shouldStop: false });
  });

  it("resets after a browser action or failed observation", () => {
    const guard = new BrowserObservationGuard(3);
    const observation = execution();

    guard.observe([observation]);
    expect(guard.observe([execution({ tool: "browser.switch_tab" })])).toBeUndefined();
    expect(guard.observe([observation])).toMatchObject({ count: 1 });
    expect(guard.observe([execution({ ok: false })])).toBeUndefined();
    expect(guard.observe([observation])).toMatchObject({ count: 1 });
  });

  it("does not treat concurrent observation ordering as a state change", () => {
    const guard = new BrowserObservationGuard(3);
    const snapshot = execution({ metadata: { snapshot: { url: "https://example.com" } } });
    const tabs = execution({
      tool: "browser.tabs",
      metadata: {
        sessionId: "session-1",
        tabs: [{ ref: "@t1", url: "https://example.com", controlled: true }],
        blockedCount: 0
      }
    });

    guard.observe([snapshot, tabs]);
    expect(guard.observe([tabs, snapshot])).toMatchObject({ count: 2, shouldNudge: true });
  });

  it("does not expose page content or fingerprints in assessments", () => {
    const guard = new BrowserObservationGuard(3);
    const observation = execution({
      content: "secret-visible-content",
      metadata: { snapshot: { text: "secret-metadata-content" } }
    });

    const assessment = guard.observe([observation]);
    expect(JSON.stringify(assessment)).not.toContain("secret");
    expect(assessment).toEqual({
      tool: "browser.snapshot",
      count: 1,
      shouldNudge: false,
      shouldStop: false
    });
  });
});
