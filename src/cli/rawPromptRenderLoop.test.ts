import { describe, expect, it, vi } from "vitest";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  buildRawPromptFrame,
  RawPromptOverlayHost,
  RawPromptRenderLoop,
  type RawPromptRenderOutput,
} from "./rawPromptRenderLoop.js";

const forbiddenManagedRegionOutput = /\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u;

describe("raw prompt render loop", () => {
  it("renders prompt line from editor state and positions the cursor deterministically", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("abc", 1),
    });

    expect(rows).toBe(1);
    expect(output.text()).toContain("> abc");
    expect(output.text()).toContain("\x1b[3C");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("redraws after edits without full-screen or scrollback clear sequences", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    loop.render({ prompt: "> ", state: createLineEditorState("a") });
    loop.render({ prompt: "> ", state: createLineEditorState("ab") });

    expect(output.text()).toContain("> a");
    expect(output.text()).toContain("> ab");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders multiline pasted content as managed prompt rows", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("line one\nline two"),
    });

    expect(rows).toBe(2);
    expect(output.text()).toContain("> line one");
    expect(output.text()).toContain("line two");
    expect(output.text()).toContain("\x1b[8C");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders inert overlay rows and clears them later", () => {
    const output = fakeOutput();
    const host = new RawPromptOverlayHost();
    const loop = new RawPromptRenderLoop(output);

    host.setRows([
      { id: "one", text: "first suggestion" },
      { id: "two", text: "second suggestion" },
    ]);
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState(""),
      overlayRows: host.getRows(),
    })).toBe(3);

    host.clear();
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState(""),
      overlayRows: host.getRows(),
    })).toBe(1);

    expect(output.text()).toContain("first suggestion");
    expect(output.text()).toContain("second suggestion");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("recalculates overlay rows after prompt-region size changes while keeping focus visible", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      overlayRows: [
        { id: "help", text: "> /help - Show help" },
        { id: "status", text: "  /status - Show status" },
        { id: "model", text: "  /model - Show model" },
      ],
    })).toBe(4);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/s"),
      overlayRows: [
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(2);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      overlayRows: [
        { id: "help", text: "  /help - Show help" },
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(3);

    expect(output.text()).toContain("> /status - Show status");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("coexists with surrounding bottom-chrome writes without destructive terminal sequences", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    output.write("bottom chrome before\n");
    loop.render({
      prompt: "> ",
      state: createLineEditorState("/h"),
      overlayRows: [{ id: "help", text: "> /help - Show help" }],
    });
    output.write("\nbottom chrome after");

    expect(output.text()).toContain("bottom chrome before");
    expect(output.text()).toContain("> /help - Show help");
    expect(output.text()).toContain("bottom chrome after");
    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("clears previously rendered prompt and overlay rows safely", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    loop.render({
      prompt: "> ",
      state: createLineEditorState("draft"),
      overlayRows: [{ text: "overlay" }],
    });
    loop.clear();

    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("builds cursor metadata for prompt and continuation rows", () => {
    expect(buildRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("abc", 2),
    })).toMatchObject({
      rows: ["> abc"],
      cursorRow: 0,
      cursorColumn: 4,
    });

    expect(buildRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("one\ntwo", 5),
    })).toMatchObject({
      rows: ["> one", "two"],
      cursorRow: 1,
      cursorColumn: 1,
    });
  });
});

function fakeOutput(): RawPromptRenderOutput & { text(): string } {
  const writes: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
    }),
    text: () => writes.join(""),
  };
}
