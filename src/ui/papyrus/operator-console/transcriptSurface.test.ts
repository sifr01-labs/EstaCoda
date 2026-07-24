import { describe, expect, it } from "vitest";
import { isolateAuto, isolateLtr } from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  getTranscriptSurfaceDesiredHeight,
  renderTranscriptSurface,
  type TranscriptBlock,
} from "./index.js";

describe("Papyrus operator console transcript surface", () => {
  it("renders assistant transcript blocks in the EstaCoda frame", () => {
    const rows = renderTranscriptSurface([
      { id: "user-1", role: "user", text: "Please inspect the stream path." },
      { id: "assistant-1", role: "assistant", text: "I found the controller and renderer." },
    ], { width: 72 });

    expect(rows[0]).toBe("User │ Please inspect the stream path.");
    expect(rows).toContainEqual(expect.stringContaining("EstaCoda"));
    expect(rows).toContainEqual(expect.stringContaining("I found the controller and renderer."));
    expect(rows.join("\n")).not.toContain("Assistant │");
    expect(rows.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders assistant transcript tool trails inside the EstaCoda frame", () => {
    const rows = renderTranscriptSurface([
      {
        id: "assistant-1",
        role: "assistant",
        text: "I inspected the runtime path.",
        toolTrail: [{
          id: "read-1",
          sequence: 1,
          toolName: "read_file",
          status: "succeeded",
          summary: "src/cli/session-loop.ts",
          target: "src/cli/session-loop.ts",
          durationMs: 1_000,
        }],
      },
    ], { width: 80 });
    const rendered = rows.join("\n");

    expect(rendered).toContain("EstaCoda");
    expect(rendered).toContain("I inspected the runtime path.");
    expect(rendered).toContain("✓ read_file");
    expect(rendered).toContain("src/cli/session-loop.ts");
    expect(rendered).toContain("1s");
    expect(rendered).not.toContain("Tool │");
    expect(rows.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("isolates technical tokens in settled Arabic assistant prose", () => {
    const rows = renderTranscriptSurface([
      { id: "assistant-1", role: "assistant", text: "شغّل /model ثم استخدم GPT-5.5" },
    ], { width: 72 });
    const rendered = rows.join("\n");

    expect(rendered).toContain(isolateAuto(
      `شغّل ${isolateLtr("/model")} ثم استخدم ${isolateLtr("GPT-5.5")}`
    ));
    expect(rows.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("wraps and truncates to the visible height cap", () => {
    const transcript: TranscriptBlock[] = [
      {
        id: "assistant-1",
        role: "assistant",
        text: "This is a deliberately long assistant response that should wrap across several terminal rows without exceeding the requested width.",
      },
      { id: "tool-1", role: "tool", text: "read_file completed" },
      { id: "assistant-2", role: "assistant", text: "Final visible row." },
    ];

    const rows = renderTranscriptSurface(transcript, { width: 44, height: 3 });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("EstaCoda");
    expect(rows).toContainEqual(expect.stringContaining("Final visible row."));
    expect(rows.join("\n")).not.toContain("Tool │ read_file completed");
    expect(getTranscriptSurfaceDesiredHeight(transcript, 44)).toBeGreaterThanOrEqual(rows.length);
    expect(rows.every((line) => stringWidth(line) <= 44)).toBe(true);
  });

  it("does not cap settled transcript desired height to eight rows", () => {
    const transcript: TranscriptBlock[] = [{
      id: "assistant-1",
      role: "assistant",
      text: numberedLines(12),
    }];

    const desiredHeight = getTranscriptSurfaceDesiredHeight(transcript, 72);
    const rows = renderTranscriptSurface(transcript, { width: 72 });

    expect(desiredHeight).toBeGreaterThan(8);
    expect(rows).toHaveLength(desiredHeight);
    expect(rows.join("\n")).toContain("line 1");
    expect(rows.join("\n")).toContain("line 12");
  });

  it("returns no rows for empty transcript state", () => {
    expect(renderTranscriptSurface([], { width: 80 })).toEqual([]);
    expect(getTranscriptSurfaceDesiredHeight([], 80)).toBe(0);
  });
});

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}
