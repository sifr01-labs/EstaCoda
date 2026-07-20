import { describe, expect, it } from "vitest";
import { taskActivityFromDelegationProgress } from "./task-safe-activity.js";

describe("safe durable Task activity", () => {
  it("keeps child tool progress categorical and drops previews, arguments, and result bodies", () => {
    const activity = taskActivityFromDelegationProgress({
      kind: "delegation-progress",
      subagentId: "attempt-1",
      childSessionId: "worker-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      childEvent: {
        kind: "tool-start",
        tool: "browser.navigate",
        displayPreview: "https://user:secret@example.com/private",
      },
    });

    expect(activity).toEqual({ kind: "tool", label: "Using browser.navigate", toolCategory: "browser" });
    expect(JSON.stringify(activity)).not.toContain("secret");
  });

  it("records fallback transitions without buffering or accepting abandoned provider text", () => {
    const activity = taskActivityFromDelegationProgress({
      kind: "delegation-progress",
      subagentId: "attempt-1",
      childSessionId: "worker-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      childEvent: {
        kind: "provider-result",
        provider: "primary",
        model: "model",
        ok: false,
        fallback: false,
        willFallback: true,
      },
    });

    expect(activity).toEqual({ kind: "provider", label: "Provider route failed; switching fallback" });
    expect(activity).not.toHaveProperty("text");
  });
});
