import { describe, expect, it } from "vitest";
import { taskActivityFromDelegationProgress, taskTraceCategoryFromTool } from "./task-safe-activity.js";

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

    expect(activity).toEqual({
      kind: "tool",
      label: "Reviewing sources",
      traceCategory: "plan",
      toolCategory: "browser"
    });
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

    expect(activity).toEqual({
      kind: "provider",
      label: "Provider route failed; switching fallback",
      traceCategory: "plan"
    });
    expect(activity).not.toHaveProperty("text");
  });

  it("presents implementation-specific search and visible answer events with stable categories", () => {
    expect(taskTraceCategoryFromTool("rg.search")).toBe("search");
    expect(taskTraceCategoryFromTool("file.read")).toBe("read");
    expect(taskTraceCategoryFromTool("file.patch")).toBe("edit");
    expect(taskTraceCategoryFromTool("terminal.run")).toBe("terminal");
    expect(taskActivityFromDelegationProgress({
      kind: "delegation-progress",
      subagentId: "attempt-1",
      childSessionId: "worker-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      childEvent: { kind: "assistant-preview", preview: "A bounded safe answer" }
    })).toEqual({
      kind: "assistant",
      label: "Assistant answer",
      traceCategory: "answer",
      assistantPreview: "A bounded safe answer"
    });
    expect(taskActivityFromDelegationProgress({
      kind: "delegation-progress",
      subagentId: "attempt-1",
      childSessionId: "worker-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      childEvent: { kind: "agent-final" }
    })).toEqual({
      kind: "worker",
      label: "Result ready",
      traceCategory: "finish"
    });
  });

  it("uses semantic categorical labels without retaining tool arguments", () => {
    const activity = (tool: string) => taskActivityFromDelegationProgress({
      kind: "delegation-progress",
      subagentId: "attempt-1",
      childSessionId: "worker-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      childEvent: { kind: "tool-start", tool, displayPreview: "must-not-persist" }
    });

    expect(activity("file.read")).toMatchObject({ label: "Reading files", traceCategory: "read" });
    expect(activity("file.patch")).toMatchObject({ label: "Writing changes", traceCategory: "edit" });
    expect(activity("terminal.run")).toMatchObject({ label: "Running command", traceCategory: "terminal" });
    expect(activity("memory.read")).toMatchObject({ label: "Inspecting memory", traceCategory: "read" });
    expect(JSON.stringify([
      activity("file.read"),
      activity("file.patch"),
      activity("terminal.run"),
      activity("memory.read")
    ])).not.toContain("must-not-persist");
  });
});
