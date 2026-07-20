import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { resolveTokens } from "../../../theme/token-resolver.js";
import {
  createOperatorConsoleStyle,
  createDefaultStatusRailState,
  renderContextBar,
  renderStatusRailSurface,
  type StatusRailState,
} from "./index.js";

describe("Papyrus operator console status rail surface", () => {
  it("renders full rail with model, context bar, context numbers, percent, and session timer", () => {
    expect(renderStatusRailSurface(status(), { width: 80 })).toBe(
      "kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ ◷ 01:12"
    );
  });

  it("renders YOLO badge between model and context when active", () => {
    expect(renderStatusRailSurface(status({
      security: { yolo: true },
    }), { width: 80 })).toBe(
      "kimi-k2.7-code ● │ ↯ YOLO │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ ◷ 01:12"
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

    const compactWithoutBadge = renderStatusRailSurface(status({
      security: { yolo: true },
    }), { width: 55 });
    expect(compactWithoutBadge).not.toContain("YOLO");
    expect(compactWithoutBadge).toContain("[▰▱▱▱▱▱▱▱▱▱]");

    const narrow = renderStatusRailSurface(status(), { width: 30 });
    expect(narrow).toBe("kimi-k2.7 ● │ ctx 7% │ 01:12");

    const minimal = renderStatusRailSurface(status(), { width: 16 });
    expect(minimal).toBe("kimi ● 7% 01:12");
  });

  it("keeps complete and partial session cost visible in narrow layouts", () => {
    const complete = status({
      sessionCost: { estimatedCostUsd: 0.73, costComplete: true },
    });
    const partial = status({
      sessionCost: { estimatedCostUsd: 0.84, costComplete: false },
    });

    expect(renderStatusRailSurface(complete, { width: 80 })).toContain("session ≈ $0.73");
    expect(renderStatusRailSurface(complete, { width: 30 })).toContain("≈ $0.73");
    expect(renderStatusRailSurface(partial, { width: 30 })).toContain("≥ $0.84");
    expect(renderStatusRailSurface(partial, { width: 16 })).toContain("≥ $0.84");
  });

  it("uses isolated Arabic cost text", () => {
    const output = renderStatusRailSurface(status({
      sessionCost: { estimatedCostUsd: 0.84, costComplete: false },
    }), { width: 80, locale: "ar" });

    expect(output).toContain("الجلسة");
    expect(output).toContain("\u2066≥ $0.84\u2069");
  });

  it("never exceeds the terminal width", () => {
    for (const width of [0, 1, 8, 16, 30, 55, 80]) {
      expect(stringWidth(renderStatusRailSurface(status(), { width }))).toBeLessThanOrEqual(width);
    }
  });

  it("uses deterministic empty model fallback", () => {
    expect(renderStatusRailSurface(createDefaultStatusRailState(), { width: 80 })).toBe(
      "model pending ● │ ctx [··········] -- --% │ ◷ 00:00"
    );
  });

  it("renders a known context limit without fabricating usage", () => {
    expect(renderStatusRailSurface(status({
      context: { totalTokens: 262_000 },
    }), { width: 80 })).toContain("ctx [··········] --/262k --%");
  });

  it("formats session timer deterministically", () => {
    expect(renderStatusRailSurface(status({
      sessionTimer: { elapsedMs: 125_900 },
    }), { width: 80 })).toContain("◷ 02:05");
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

  it("colors primary and fallback model status dots from semantic tokens when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });

    expect(renderStatusRailSurface(status({
      model: { label: "kimi-k2.7-code", state: "idle", route: "primary" },
    }), { width: 80, style })).toContain(`${ansiFg(tokens.contract.severity.ok)}●\x1b[0m`);
    expect(renderStatusRailSurface(status({
      model: { label: "kimi-k2.7-code", state: "idle", route: "fallback" },
    }), { width: 80, style })).toContain(`${ansiFg(tokens.contract.palette.caution)}●\x1b[0m`);
  });

  it("colors the YOLO badge with the caution token when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });

    expect(renderStatusRailSurface(status({
      security: { yolo: true },
    }), { width: 80, style })).toContain(`${ansiFg(tokens.contract.palette.caution)}↯ YOLO\x1b[0m`);
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

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}
