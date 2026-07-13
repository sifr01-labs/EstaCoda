import { describe, expect, it } from "vitest";
import {
  getStreamingSurfaceDesiredHeight,
  hasStreamingSurface,
  renderTranscriptSurface,
  renderStreamingSurface,
  type StreamingState,
} from "./index.js";

describe("Papyrus operator console streaming surface", () => {
  it("does not render whitespace-only streaming state", () => {
    const state: StreamingState = {
      segments: [{ id: "segment-1", role: "assistant", text: "   \n\t" }],
      tail: "   ",
      isStreaming: true,
    };

    expect(hasStreamingSurface(state)).toBe(false);
    expect(getStreamingSurfaceDesiredHeight(state, 80)).toBe(0);
    expect(renderStreamingSurface(state, { width: 80 })).toEqual([]);
  });

  it("renders non-empty visible streaming text", () => {
    const state: StreamingState = {
      segments: [{ id: "segment-1", role: "assistant", text: "Visible segment." }],
      tail: "Visible tail.",
      isStreaming: true,
    };
    const rendered = renderStreamingSurface(state, { width: 80 }).join("\n");

    expect(hasStreamingSurface(state)).toBe(true);
    expect(rendered).toContain("EstaCoda");
    expect(rendered).toContain("Visible segment.");
    expect(rendered).toContain("Visible tail.▍");
    expect(rendered).not.toContain("Assistant stream");
    expect(rendered).not.toContain("assistant:");
  });

  it("reports live streaming desired height from full content without a viewport cap", () => {
    const state: StreamingState = {
      segments: [],
      tail: numberedLines(80),
      isStreaming: true,
    };

    expect(getStreamingSurfaceDesiredHeight(state, 80, { terminalHeight: 24 })).toBe(82);
    expect(getStreamingSurfaceDesiredHeight(state, 80, { terminalHeight: 80 })).toBe(82);
    expect(renderStreamingSurface(state, { width: 80, terminalHeight: 80 })).toHaveLength(82);
  });

  it("leaves short-terminal bounds to the Operator Console layout allocator", () => {
    const state: StreamingState = {
      segments: [],
      tail: numberedLines(80),
      isStreaming: true,
    };

    expect(getStreamingSurfaceDesiredHeight(state, 80, { terminalHeight: 10 })).toBe(82);
  });

  it("renders anchored inline tool trails between streamed segments and tail", () => {
    const state: StreamingState = {
      segments: [{ id: "segment-1", role: "assistant", text: "I'll inspect the runtime path first." }],
      tail: "The session loop wires deltas through the console.",
      isStreaming: true,
      toolTrail: [{
        id: "read-1",
        sequence: 1,
        toolName: "read_file",
        status: "running",
        summary: "src/cli/session-loop.ts",
        target: "src/cli/session-loop.ts",
        durationMs: 3_000,
        afterSegmentId: "segment-1",
      }],
    };
    const rendered = renderStreamingSurface(state, { width: 84 }).join("\n");

    expect(rendered).toContain("I'll inspect the runtime path first.");
    expect(rendered).toContain("◷ read_file");
    expect(rendered).toContain("src/cli/session-loop.ts");
    expect(rendered).toContain("The session loop wires deltas through the console.▍");
    expect(rendered.indexOf("I'll inspect the runtime path first.")).toBeLessThan(rendered.indexOf("◷ read_file"));
    expect(rendered.indexOf("◷ read_file")).toBeLessThan(rendered.indexOf("The session loop wires"));
  });

  it("settles into the same assistant frame without the live cursor", () => {
    const state: StreamingState = {
      segments: [{ id: "segment-1", role: "assistant", text: "Visible segment." }],
      tail: "",
      isStreaming: true,
    };
    const liveRows = renderStreamingSurface(state, { width: 72 });
    const settledRows = renderTranscriptSurface([
      { id: "assistant-1", role: "assistant", text: "Visible segment." },
    ], { width: 72 });

    expect(liveRows[0]).toBe(settledRows[0]);
    expect(liveRows.at(-1)).toBe(settledRows.at(-1));
    expect(extractFrameContent(liveRows[1]?.replace("▍", "") ?? "")).toBe(
      extractFrameContent(settledRows[1] ?? "")
    );
  });
});

function extractFrameContent(line: string): string {
  return line.replace(/^│ /u, "").replace(/ │$/u, "").trim();
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}
