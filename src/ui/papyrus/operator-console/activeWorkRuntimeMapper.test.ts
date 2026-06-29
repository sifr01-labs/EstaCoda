import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
} from "./activeWorkRuntimeMapper.js";
import { formatActiveWorkSummary, getActiveWorkSurfaceDesiredHeight, renderActiveWorkSurface } from "./activeWorkSurface.js";

describe("active work runtime mapper", () => {
  it("keeps the active work model and default rendering uncapped", () => {
    let state = createActiveWorkRuntimeState();
    for (let index = 0; index < 12; index += 1) {
      state = applyActiveWorkRuntimeEvent(state, {
        id: `tool-${index}`,
        toolName: "read_file",
        status: index < 2 ? "running" : "done",
        summary: "completed",
        target: `src/file-${index}.ts`,
        durationMs: index * 1000,
      });
    }

    expect(state.items).toHaveLength(12);

    const lines = renderActiveWorkSurface(state, { width: 80 });
    expect(lines).toHaveLength(getActiveWorkSurfaceDesiredHeight(state));
    expect(lines.join("\n")).toContain("Running tools");
    expect(lines.join("\n")).toContain("src/file-11.ts");
    expect(lines.join("\n")).not.toContain("more completed this turn");
    expect(lines.every((line) => stringWidth(line) <= 80)).toBe(true);
  });

  it("upserts paired start/result events and preserves file-change inspection metadata", () => {
    let state = createActiveWorkRuntimeState();

    state = applyActiveWorkRuntimeEvent(state, {
      id: "write-1",
      toolName: "write_file",
      status: "running",
      summary: "preparing",
      target: "src/app.ts",
    });
    state = applyActiveWorkRuntimeEvent(state, {
      id: "write-1",
      toolName: "write_file",
      status: "done",
      summary: "write_file",
      target: "src/app.ts",
      durationMs: 1800,
      fileChangeInspected: true,
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        id: "write-1",
        toolName: "write_file",
        status: "succeeded",
        target: "src/app.ts",
        durationMs: 1800,
        fileChangeInspected: true,
      }),
    ]);
    expect(formatActiveWorkSummary(state)).toBe(
      "1 completed · 0 active · 0 failed · Worked for 00:01"
    );
  });

  it("preserves raw tool names while carrying localized display labels", () => {
    const state = applyActiveWorkRuntimeEvent(createActiveWorkRuntimeState(), {
      id: "read-1",
      toolName: "file.read",
      displayLabel: "قراءة ملف",
      status: "running",
      target: "src/app.ts",
    });

    expect(state.items[0]).toMatchObject({
      id: "read-1",
      toolName: "file.read",
      displayLabel: "قراءة ملف",
      status: "running",
      target: "src/app.ts",
    });

    const rendered = renderActiveWorkSurface(state, { width: 80, height: 4, locale: "ar" }).join("\n");
    expect(rendered).toContain("قراءة ملف");
    expect(rendered).not.toContain("file.read");
  });

  it("formats collapsed summaries from uncapped mapped live events", () => {
    let state = createActiveWorkRuntimeState();
    state = applyActiveWorkRuntimeEvent(state, { id: "run", toolName: "read_file", status: "running" });
    state = applyActiveWorkRuntimeEvent(state, { id: "queue", toolName: "rg", status: "pending" });
    state = applyActiveWorkRuntimeEvent(state, { id: "approval", toolName: "shell", status: "gated" });
    for (let index = 0; index < 38; index += 1) {
      state = applyActiveWorkRuntimeEvent(state, {
        id: `done-${index}`,
        toolName: "read_file",
        status: "done",
        target: `src/done-${index}.ts`,
      });
    }
    state = applyActiveWorkRuntimeEvent(state, {
      id: "edit",
      toolName: "write_file",
      status: "done",
      target: "src/generated.ts",
      fileChangeInspected: true,
    });

    expect(state.items).toHaveLength(42);
    expect(formatActiveWorkSummary(state)).toBe(
      "39 completed · 3 active · 0 failed · Worked for 00:00"
    );
    const rendered = renderActiveWorkSurface(state, { width: 80 }).join("\n");
    expect(rendered).toContain("src/done-37.ts");
    expect(rendered).toContain("src/generated.ts");
    expect(rendered).not.toContain("more completed this turn");
  });

  it("maps queued, running, awaiting approval, and terminal statuses for active-work sorting", () => {
    let state = createActiveWorkRuntimeState();
    state = applyActiveWorkRuntimeEvent(state, { id: "done", toolName: "typecheck", status: "done" });
    state = applyActiveWorkRuntimeEvent(state, { id: "queued", toolName: "read_file", status: "pending" });
    state = applyActiveWorkRuntimeEvent(state, { id: "approval", toolName: "shell", status: "gated" });
    state = applyActiveWorkRuntimeEvent(state, { id: "running", toolName: "rg", status: "running" });
    state = applyActiveWorkRuntimeEvent(state, { id: "failed", toolName: "test", status: "failed" });
    state = applyActiveWorkRuntimeEvent(state, { id: "cancelled", toolName: "browser", status: "cancelled" });

    expect(state.items.map((item) => item.status)).toEqual([
      "succeeded",
      "queued",
      "awaitingApproval",
      "running",
      "failed",
      "cancelled",
    ]);

    const rendered = renderActiveWorkSurface(state, { width: 88, height: 8 }).join("\n");
    expect(rendered.indexOf("rg")).toBeLessThan(rendered.indexOf("read_file"));
    expect(rendered.indexOf("read_file")).toBeLessThan(rendered.indexOf("shell"));
    expect(rendered.indexOf("shell")).toBeLessThan(rendered.indexOf("typecheck"));
  });

  it("keeps technical tokens unchanged in Arabic renders", () => {
    const state = applyActiveWorkRuntimeEvent(createActiveWorkRuntimeState(), {
      id: "read-output",
      toolName: "read_file",
      status: "running",
      summary: "preparing",
      target: "src/ui/papyrus/screen/output.ts",
      durationMs: 3000,
    });

    const rendered = renderActiveWorkSurface(state, { width: 80, height: 5, locale: "ar" }).join("\n");
    expect(rendered).toContain("تنفيذ الأدوات");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("src/ui/papyrus/screen/output.ts");
    expect(rendered).toContain("3s");
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 80)).toBe(true);
  });
});
