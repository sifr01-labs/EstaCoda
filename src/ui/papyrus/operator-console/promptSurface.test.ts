import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  createDefaultPromptSurfaceState,
  getPromptSurfaceDesiredHeight,
  getPromptSurfaceMetrics,
  renderPromptSurface,
  type PromptSurfaceState,
} from "./index.js";

describe("Papyrus operator console prompt surface", () => {
  it("renders a borderless prompt as a single content row when constrained", () => {
    const output = renderPromptSurface(prompt({ value: "review the Papyrus rollout plan" }), {
      width: 72,
      height: 1,
    });

    expect(output[0]).toContain("› review the Papyrus rollout plan");
    expect(output).toHaveLength(1);
  });

  it("centers one input row between two half-cell bands at rest", () => {
    const output = renderPromptSurface(prompt({ value: "review the Papyrus rollout plan" }), {
      width: 72,
      terminalHeight: 24,
    });

    expect(output[0]?.trim()).toBe("");
    expect(output[1]).toContain("› review the Papyrus rollout plan");
    expect(output[2]?.trim()).toBe("");
    expect(output).toHaveLength(3);
  });

  it("falls back to the content row plus full padding when only two rows fit", () => {
    const state = prompt({ value: "review the Papyrus rollout plan" });
    const output = renderPromptSurface(state, { width: 72, height: 2 });
    const metrics = getPromptSurfaceMetrics(state, { width: 72, height: 2 });

    expect(output[0]).toContain("› review the Papyrus rollout plan");
    expect(output[1]?.trim()).toBe("");
    expect(metrics.contentStartRow).toBe(0);
  });

  it("renders an empty prompt marker", () => {
    const output = renderPromptSurface(prompt({ value: "" }), { width: 40, height: 1 });

    expect(output[0]).toContain("›");
  });

  it("renders slash input as normal prompt content", () => {
    const output = renderPromptSurface(prompt({ value: "/mo" }), { width: 40, height: 1 });

    expect(output[0]).toContain("› /mo");
  });

  it("renders multiline content without a title", () => {
    const output = renderPromptSurface(prompt({
      multiline: true,
      value: "write a migration plan for:\n- approval cards",
    }), { width: 72, height: 4 });

    expect(output[1]).toContain("› write a migration plan for:");
    expect(output[2]).toContain("  - approval cards");
  });

  it("soft-wraps long typed lines and keeps the cursor on the wrapped row", () => {
    const value = "review our src code and explain memory compaction";
    const state = prompt({
      value,
      cursorOffset: value.length,
    });
    const output = renderPromptSurface(state, { width: 24, height: 5 });
    const metrics = getPromptSurfaceMetrics(state, { width: 24, height: 5 });

    expect(output).toHaveLength(5);
    expect(output.join("\n")).toContain("› review our src code");
    expect(output.join("\n")).toContain("  and explain memory");
    expect(metrics.cursorRow).toBeGreaterThan(0);
    expect(metrics.cursorColumn).toBeGreaterThan(2);
    expect(output.every((line) => stringWidth(line) <= 24)).toBe(true);
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
    expect(output[4]?.trim()).toBe("");
  });

  it("caps prompt expansion at the preferred maximum of 8 input rows", () => {
    const state = prompt({
      multiline: true,
      value: numberedLines(12),
      cursorOffset: numberedLines(12).length,
    });

    expect(getPromptSurfaceDesiredHeight(state, { height: 80 })).toBe(10);
    expect(renderPromptSurface(state, { width: 72, terminalHeight: 80 })).toHaveLength(10);
  });

  it("caps prompt expansion at 30 percent of terminal height when smaller than the preferred maximum", () => {
    const state = prompt({
      multiline: true,
      value: numberedLines(12),
      cursorOffset: numberedLines(12).length,
    });

    expect(getPromptSurfaceDesiredHeight(state, { height: 20 })).toBe(6);
    expect(renderPromptSurface(state, { width: 72, terminalHeight: 20 })).toHaveLength(6);
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
    }), { width: 72, terminalHeight: 80 });

    expect(output).toHaveLength(10);
    expect(output.at(-2)).toContain("12 lines · ↑↓ scroll within prompt");
    expect(output.at(-1)?.trim()).toBe("");
  });

  it("keeps the cursor row visible when newline insertion pushes content beyond visible rows", () => {
    const value = numberedLines(9);
    const output = renderPromptSurface(prompt({
      multiline: true,
      value,
      cursorOffset: value.length,
      scrollOffset: 0,
    }), { width: 72, height: 6 });

    expect(output.join("\n")).not.toContain("› line 1");
    expect(output.join("\n")).toContain("line 7");
    expect(output.join("\n")).toContain("line 9");
    expect(output.at(-2)).toContain("9 lines · ↑↓ scroll within prompt");
  });

  it("keeps the cursor row visible after resize to a shorter terminal height", () => {
    const value = numberedLines(8);
    const state = prompt({
      multiline: true,
      value,
      cursorOffset: value.length,
      scrollOffset: 0,
    });
    const output = renderPromptSurface(state, { width: 72, height: 5 });
    const metrics = getPromptSurfaceMetrics(state, { width: 72, height: 5 });

    expect(metrics.scrollOffset).toBe(6);
    expect(metrics.cursorRow).toBe(7);
    expect(output.join("\n")).toContain("line 7");
    expect(output.join("\n")).toContain("line 8");
  });

  it("keeps the cursor row visible after resize to a narrower terminal width", () => {
    const value = numberedLines(8);
    const output = renderPromptSurface(prompt({
      multiline: true,
      value,
      cursorOffset: value.length,
      scrollOffset: 0,
    }), { width: 24, height: 5 });

    expect(output.every((line) => stringWidth(line) <= 24)).toBe(true);
    expect(output.join("\n")).toContain("line 8");
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

  it("uses an elevated background, focused glyph, and dedicated placeholder color", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const emptyLines = renderPromptSurface(prompt({
      value: "",
      placeholder: "/help · /tools · /model · /status · /compact · Ctrl+C exit",
    }), { width: 72, height: 3, style });
    const empty = emptyLines.join("\n");
    const typed = renderPromptSurface(prompt({
      value: "hello",
      placeholder: "/help · /tools",
    }), { width: 72, height: 1, style }).join("\n");

    expect(emptyLines[0]).toContain(`${ansiFg(tokens.contract.surface.bgElevated)}${"▄".repeat(72)}`);
    expect(emptyLines[1]).toContain(ansiBg(tokens.contract.surface.bgElevated));
    expect(emptyLines[2]).toContain(`${ansiFg(tokens.contract.surface.bgElevated)}${"▀".repeat(72)}`);
    expect(empty).toContain(`${ansiFg(tokens.contract.palette.action)}› `);
    expect(empty).toContain(`${ansiFg(tokens.contract.text.placeholder)}/help`);
    expect(typed).not.toContain("/tools");
    expect(typed).toContain(`${ansiFg(tokens.contract.text.primary)}hello`);
    expect(typed).not.toContain(ansiFg(tokens.contract.text.placeholder));
  });

  it("uses blank cap rows instead of block glyphs without color support", () => {
    const style = createOperatorConsoleStyle({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      capabilities: { supportsColor: false, supportsTrueColor: false },
    });
    const output = renderPromptSurface(prompt({ value: "hello" }), { width: 40, height: 3, style });

    expect(output[0]?.trim()).toBe("");
    expect(output[1]).toContain("› hello");
    expect(output[2]?.trim()).toBe("");
    expect(output.join("\n")).not.toMatch(/[▄▀]/u);
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

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}

function ansiBg(hex: string): string {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `\x1b[48;2;${r};${g};${b}m`;
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}
