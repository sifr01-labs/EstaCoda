import { describe, expect, it } from "vitest";
import { activeWorkEventFromToolRail } from "./operator-console-tool-display.js";

describe("operator console tool display", () => {
  it("maps Papyrus active work to localized presentation labels", () => {
    const event = activeWorkEventFromToolRail({
      railEvent: {
        tool: "file.read",
        status: "running",
        label: "preparing",
        target: "src/main.ts",
        activityId: "read-1",
      },
      runtimeEvent: {
        kind: "tool-start",
        tool: "file.read",
        targetSummary: "src/main.ts",
        activityId: "read-1",
      },
      locale: "en",
    });

    expect(event).toMatchObject({
      id: "read-1",
      toolName: "file.read",
      displayLabel: "Read File",
      status: "running",
      summary: "preparing",
      target: "src/main.ts",
      detailsRef: "read-1",
    });
  });

  it("uses Arabic labels without translating technical targets", () => {
    const event = activeWorkEventFromToolRail({
      railEvent: {
        tool: "terminal.run",
        status: "done",
        label: "run_command",
        target: "pnpm run test",
        elapsedMs: 1200,
      },
      runtimeEvent: {
        kind: "tool-result",
        tool: "terminal.run",
        ok: true,
        targetSummary: "pnpm run test",
      },
      locale: "ar",
    });

    expect(event).toMatchObject({
      toolName: "terminal.run",
      displayLabel: "تشغيل أمر",
      status: "done",
      target: "pnpm run test",
      durationMs: 1200,
    });
  });

  it("prefers presentation previews over security target summaries", () => {
    const event = activeWorkEventFromToolRail({
      railEvent: {
        tool: "terminal.run",
        status: "running",
        label: "preparing",
        target: "cd app && export CI=true && pnpm test && echo done",
      },
      runtimeEvent: {
        kind: "tool-start",
        tool: "terminal.run",
        targetSummary: "cd app && export CI=true && pnpm test && echo done",
        displayPreview: "pnpm test",
      },
      locale: "en",
    });

    expect(event).toMatchObject({
      toolName: "terminal.run",
      displayLabel: "Run Command",
      target: "pnpm test",
    });
  });

  it("preserves result metadata needed by the Papyrus active work surface", () => {
    const event = activeWorkEventFromToolRail({
      railEvent: {
        tool: "file.write",
        status: "gated",
        label: "gated",
        target: "src/app.ts",
        riskClass: "workspace-write",
        activityId: "write-1",
      },
      runtimeEvent: {
        kind: "tool-result",
        tool: "file.write",
        decision: "ask",
        riskClass: "workspace-write",
        targetSummary: "src/app.ts",
        fileChangePreview: {
          kind: "fileChangePreview",
          path: "src/app.ts",
          changeType: "modified",
          hunks: [],
        },
      },
      locale: "en",
    });

    expect(event).toMatchObject({
      id: "write-1",
      toolName: "file.write",
      displayLabel: "Write File",
      status: "gated",
      target: "src/app.ts",
      riskClass: "workspace-write",
      fileChangeInspected: true,
    });
  });
});
