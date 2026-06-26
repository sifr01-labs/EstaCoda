import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import {
  createDefaultStatusRailState,
  renderContextBar,
  renderStatusRailSurface,
  type StatusRailState,
} from "./index.js";

describe("Papyrus operator console status rail surface", () => {
  it("renders full rail with model, context bar, context numbers, percent, and session timer", () => {
    expect(renderStatusRailSurface(status(), { width: 80 })).toBe(
      "kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12"
    );
  });

  it("contains no tools, approvals, workspace, trust, steer, setup, or channel fields", () => {
    const output = renderStatusRailSurface(status(), { width: 80 });

    expect(output).not.toMatch(/\b(tool|approval|workspace|trust|steer|setup|channel)\b/iu);
  });

  it("clamps context bar values below 0 and above 100", () => {
    expect(renderContextBar(-20)).toBe("[▱▱▱▱▱▱▱▱▱▱]");
    expect(renderContextBar(120)).toBe("[▰▰▰▰▰▰▰▰▰▰]");
  });

  it("degrades from full to compact, narrow, and minimal by width", () => {
    expect(renderStatusRailSurface(status(), { width: 80 })).toContain("18.4k/262k");

    const compact = renderStatusRailSurface(status(), { width: 55 });
    expect(compact).toContain("[▰▱▱▱▱▱▱▱▱▱]");
    expect(compact).not.toContain("18.4k/262k");

    const narrow = renderStatusRailSurface(status(), { width: 30 });
    expect(narrow).toBe("kimi-k2.7 ● │ ctx 7% │ 01:12");

    const minimal = renderStatusRailSurface(status(), { width: 16 });
    expect(minimal).toBe("kimi ● 7% 01:12");
  });

  it("never exceeds the terminal width", () => {
    for (const width of [0, 1, 8, 16, 30, 55, 80]) {
      expect(stringWidth(renderStatusRailSurface(status(), { width }))).toBeLessThanOrEqual(width);
    }
  });

  it("uses deterministic empty model fallback", () => {
    expect(renderStatusRailSurface(createDefaultStatusRailState(), { width: 80 })).toBe(
      "model pending ○ │ ctx [▱▱▱▱▱▱▱▱▱▱] 0 0% │ session 00:00"
    );
  });

  it("formats session timer deterministically", () => {
    expect(renderStatusRailSurface(status({
      sessionTimer: { elapsedMs: 125_900 },
    }), { width: 80 })).toContain("session 02:05");
  });

  it("emits no ANSI or cursor-control sequences", () => {
    const output = renderStatusRailSurface(status(), { width: 80 });

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\\x1b");
    expect(output).not.toContain("\\u001b");
    expect(output).not.toContain("\\033");
    expect(output).not.toMatch(/\b(moveCursor|clearLine|clearScreenDown|cursorTo|setRawMode)\b/u);
    expect(output).not.toMatch(/\[[0-9;?]*[A-Za-z]/u);
  });
});

function status(input: Partial<StatusRailState> = {}): StatusRailState {
  return {
    model: { label: "kimi-k2.7-code", state: "working" },
    context: { usedTokens: 18_400, totalTokens: 262_000, percent: 7 },
    sessionTimer: { elapsedMs: 72_000 },
    ...input,
  };
}
