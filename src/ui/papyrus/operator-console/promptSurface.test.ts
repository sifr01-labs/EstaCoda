import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import {
  createDefaultPromptSurfaceState,
  renderPromptSurface,
  type PromptSurfaceState,
} from "./index.js";

describe("Papyrus operator console prompt surface", () => {
  it("renders a boxed single-line prompt", () => {
    const output = renderPromptSurface(prompt({ value: "review the Papyrus rollout plan" }), {
      width: 72,
      height: 3,
    });

    expect(output[0]).toMatch(/^╭─ Prompt ─+╮$/u);
    expect(output[1]).toContain("│ › review the Papyrus rollout plan");
    expect(output[2]).toMatch(/^╰─+╯$/u);
    expect(output).toHaveLength(3);
  });

  it("renders an empty prompt marker", () => {
    const output = renderPromptSurface(prompt({ value: "" }), { width: 40, height: 3 });

    expect(output[1]).toContain("│ ›");
  });

  it("renders slash input as normal prompt content", () => {
    const output = renderPromptSurface(prompt({ value: "/mo" }), { width: 40, height: 3 });

    expect(output[1]).toContain("│ › /mo");
  });

  it("uses multiline title for multiline prompt state", () => {
    const output = renderPromptSurface(prompt({
      multiline: true,
      value: "write a migration plan for:\n- approval cards",
    }), { width: 72, height: 4 });

    expect(output[0]).toContain("Prompt · multiline");
  });

  it("expands multiline prompts by visible rows", () => {
    const output = renderPromptSurface(prompt({
      multiline: true,
      value: "write a migration plan for:\n- approval cards\n- pasted attachments",
    }), { width: 72, height: 5 });

    expect(output).toHaveLength(5);
    expect(output[1]).toContain("› write a migration plan for:");
    expect(output[2]).toContain("  - approval cards");
    expect(output[3]).toContain("  - pasted attachments");
  });

  it("renders an internal scroll indicator for long multiline prompts", () => {
    const output = renderPromptSurface(prompt({
      multiline: true,
      value: [
        "write a migration plan for the Papyrus console redesign",
        "focusing on:",
        "- startup dashboard",
        "- prompt expansion",
        "- active work",
        "- approvals",
        "- steering",
        "- setup panels",
        "- slash menu",
        "- attachments",
        "- status rail",
        "- transcript",
      ].join("\n"),
    }), { width: 72, height: 10 });

    expect(output).toHaveLength(10);
    expect(output.at(-2)).toContain("12 lines · ↑↓ scroll within prompt");
  });

  it("keeps prompt render widths within the terminal width", () => {
    const output = renderPromptSurface(prompt({
      value: "a very long prompt that should be clipped inside the prompt box without overflowing the terminal",
    }), { width: 32, height: 3 });

    expect(output.every((line) => stringWidth(line) <= 32)).toBe(true);
  });

  it("emits no ANSI escape sequences", () => {
    const output = renderPromptSurface(prompt({ value: "hello" }), { width: 40, height: 3 }).join("\n");

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
  });

  it("emits no terminal cursor control sequences", () => {
    const output = renderPromptSurface(prompt({ value: "hello" }), { width: 40, height: 3 }).join("\n");

    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(output).not.toMatch(/\[[0-9;?]*[A-Za-z]/u);
  });

  it("is deterministic and does not mutate state", () => {
    const state = prompt({ value: "review plan" });
    const snapshot = JSON.stringify(state);

    expect(renderPromptSurface(state, { width: 40, height: 3 })).toEqual(renderPromptSurface(state, { width: 40, height: 3 }));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

function prompt(input: Partial<PromptSurfaceState>): PromptSurfaceState {
  return {
    ...createDefaultPromptSurfaceState(),
    ...input,
  };
}
