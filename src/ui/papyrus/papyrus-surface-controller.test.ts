import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPapyrusSurfaceController,
  createPapyrusSurfaceControllerForMode,
} from "./papyrus-surface-controller.js";

describe("Papyrus surface controller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes a compositor-backed frame", () => {
    const controller = createPapyrusSurfaceController({ width: 6, height: 2 });

    expect(controller.getSize()).toEqual({ width: 6, height: 2 });
    expect(controller.snapshot().viewport).toEqual({ width: 6, height: 2 });
    expect(controller.snapshot().screen.rowText(0)).toBe("      ");
  });

  it("can be initialized after construction", () => {
    const controller = createPapyrusSurfaceController({ width: 1, height: 1 });
    const result = controller.initialize(4, 2);

    expect(result.diff).toEqual([]);
    expect(result.output).toBe("");
    expect(result.frame.viewport).toEqual({ width: 4, height: 2 });
    expect(controller.getSize()).toEqual({ width: 4, height: 2 });
  });

  it("creates the adapter for the only supported renderer mode", () => {
    expect(createPapyrusSurfaceControllerForMode("papyrus", { width: 4, height: 1 })).toBeDefined();
  });

  it("renders a text surface into a frame and diff output", () => {
    const controller = createPapyrusSurfaceController({ width: 5, height: 1 });
    const result = controller.render({ surfaces: [{ x: 1, y: 0, text: "hey" }] });

    expect(result.frame.screen.rowText(0)).toBe(" hey ");
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.output).toContain("hey");
  });

  it("returns an empty diff for an identical frame", () => {
    const controller = createPapyrusSurfaceController({ width: 5, height: 1 });

    controller.render({ surfaces: [{ x: 0, y: 0, text: "same" }] });
    const result = controller.render({ surfaces: [{ x: 0, y: 0, text: "same" }] });

    expect(result.diff).toEqual([]);
    expect(result.output).toBe("");
  });

  it("resizes and resets frame state predictably", () => {
    const controller = createPapyrusSurfaceController({ width: 5, height: 1 });

    controller.render({ surfaces: [{ x: 0, y: 0, text: "abc" }] });
    const resize = controller.resize(3, 2);

    expect(resize.frame.viewport).toEqual({ width: 3, height: 2 });
    expect(resize.frame.screen.rowText(0)).toBe("   ");
    expect(resize.diff).toEqual([
      { type: "clearTerminal", reason: "resize" },
      { type: "stdout", content: "\n" },
    ]);

    const render = controller.render({ surfaces: [{ x: 0, y: 0, text: "xy" }] });
    expect(render.output).toContain("xy");
    expect(render.diff.some((patch) => patch.type === "clearTerminal")).toBe(false);
  });

  it("reset clears rendered state", () => {
    const controller = createPapyrusSurfaceController({ width: 4, height: 1 });

    controller.render({ surfaces: [{ x: 0, y: 0, text: "gone" }] });
    const reset = controller.reset();

    expect(reset.frame.screen.rowText(0)).toBe("    ");
    expect(controller.render({ surfaces: [] }).diff).toEqual([]);
  });

  it("composes multiple surfaces in order", () => {
    const controller = createPapyrusSurfaceController({ width: 5, height: 2 });
    const result = controller.render({
      surfaces: [
        { x: 0, y: 0, text: "abcd" },
        { x: 2, y: 0, text: "XY" },
        { x: 1, y: 1, text: "z" },
      ],
    });

    expect(result.frame.screen.rowText(0)).toBe("abXY ");
    expect(result.frame.screen.rowText(1)).toBe(" z   ");
  });

  it("renders managed rows without absolute cursor patches", () => {
    const controller = createPapyrusSurfaceController({ width: 6, height: 2 });
    const result = controller.renderRows({
      surfaces: [
        { x: 0, y: 0, text: "row" },
        { x: 1, y: 1, text: "two" },
      ],
    });

    expect(result.rows).toEqual(["row", " two"]);
    expect(result.rows.join("\n")).not.toMatch(/\x1b\[\d+;\d+H/u);
    expect(result.output).toMatch(/\x1b\[\d+;\d+H/u);
  });

  it("preserves ANSI style behavior through Output", () => {
    const controller = createPapyrusSurfaceController({ width: 3, height: 1 });
    const result = controller.render({ surfaces: [{ x: 0, y: 0, text: "\x1b[31mr\x1b[0mx" }] });

    expect(result.frame.screen.rowText(0)).toBe("rx ");
    expect(result.frame.screen.cellAt(0, 0)?.styleId).not.toBe(result.frame.screen.cellAt(1, 0)?.styleId);
    expect(result.output).toContain("\x1b[31m");
  });

  it("does not write patches to stdout or stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const controller = createPapyrusSurfaceController({ width: 4, height: 1 });

    const result = controller.render({ surfaces: [{ x: 0, y: 0, text: "text" }] });
    controller.reset();

    expect(result.output).toContain("text");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
