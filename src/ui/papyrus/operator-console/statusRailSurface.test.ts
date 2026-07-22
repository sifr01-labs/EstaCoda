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
  it("renders the full rail with the timer immediately after context", () => {
    const output = renderStatusRailSurface(status(), { width: 80 });

    expect(output).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
    expect(output).not.toContain("7%");
    expect(output).not.toContain("│");
    expect(output.trimEnd().endsWith("18.4k/262k · ◷ 01:12")).toBe(true);
    expect(stringWidth(output)).toBe(80);
  });

  it("renders YOLO badge between model and context when active", () => {
    const output = renderStatusRailSurface(status({
      security: { yolo: true },
    }), { width: 80 });

    expect(output).toContain("kimi-k2.7-code ● · ↯ YOLO · ctx");
    expect(output.trimEnd().endsWith("18.4k/262k · ◷ 01:12")).toBe(true);
  });

  it("contains no tools, approvals, workspace trust, steer, setup, or channel state", () => {
    const output = renderStatusRailSurface(status(), { width: 80 });

    expect(output).not.toMatch(/\b(tool|approval|trust|steer|setup|channel)\b/iu);
  });

  it("clamps context bar values below 0 and above 100", () => {
    expect(renderContextBar(-20)).toBe("[▱▱▱▱▱▱▱▱▱▱]");
    expect(renderContextBar(120)).toBe("[▰▰▰▰▰▰▰▰▰▰]");
  });

  it("degrades from full to compact, narrow, and minimal by width", () => {
    expect(renderStatusRailSurface(status(), { width: 80 })).toContain("18.4k/262k");

    const compact = renderStatusRailSurface(status(), { width: 55 });
    expect(compact).toContain("ctx 18.4k/262k · ◷ 01:12");
    expect(compact).not.toContain("7%");

    const compactWithBadge = renderStatusRailSurface(status({
      security: { yolo: true },
    }), { width: 55 });
    expect(compactWithBadge).toContain("YOLO");
    expect(compactWithBadge).toContain("18.4k/262k");

    const narrow = renderStatusRailSurface(status(), { width: 30 });
    expect(narrow.trimEnd()).toBe("ctx 18.4k/262k · ◷ 01:12");

    const minimal = renderStatusRailSurface(status(), { width: 16 });
    expect(minimal).toBe("18.4k/262k");
  });

  it("keeps cumulative session tokens and cost together on the right", () => {
    const complete = status({
      sessionCost: {
        totalTokens: 31_400,
        usageComplete: true,
        estimatedCostUsd: 0.73,
        costComplete: true,
      },
    });
    const partial = status({
      sessionCost: {
        totalTokens: 32_100,
        usageComplete: false,
        estimatedCostUsd: 0.84,
        costComplete: false,
      },
    });

    const completeOutput = renderStatusRailSurface(complete, { width: 80 });
    expect(completeOutput).toContain("18.4k/262k · ◷ 01:12");
    expect(completeOutput.endsWith("31.4k tok · $0.73")).toBe(true);
    expect(renderStatusRailSurface(complete, { width: 30 })).toContain("$0.73");
    expect(renderStatusRailSurface(partial, { width: 30 })).toContain("≥ $0.84");
    expect(renderStatusRailSurface(partial, { width: 16 })).toContain("≥ $0.84");
  });

  it("uses workspace as the identity badge before context when YOLO is off", () => {
    const withWorkspace = status({
      workspace: {
        label: "~/Documents/…/EstaCoda",
        shortLabel: "EstaCoda",
        branch: "main",
      },
      sessionCost: {
        totalTokens: 31_400,
        usageComplete: true,
        estimatedCostUsd: 0.08,
        costComplete: true,
      },
    });

    const wide = renderStatusRailSurface(withWorkspace, { width: 140 });
    expect(wide).toContain("~/Documents/…/EstaCoda · main · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k · ◷ 01:12");
    expect(wide.endsWith("31.4k tok · $0.08")).toBe(true);

    const compact = renderStatusRailSurface(withWorkspace, { width: 95 });
    expect(compact).toContain("· EstaCoda · ctx");
    expect(compact).not.toContain("~/Documents");
    expect(compact).not.toContain("main");

    const constrained = renderStatusRailSurface(withWorkspace, { width: 80 });
    expect(constrained).toContain("EstaCoda · ctx 18.4k/262k · ◷ 01:12");
    expect(constrained).not.toContain("[▰");
    expect(constrained.endsWith("31.4k tok · $0.08")).toBe(true);

    const yolo = renderStatusRailSurface({
      ...withWorkspace,
      security: { yolo: true },
    }, { width: 140 });
    expect(yolo).toContain("↯ YOLO · ctx");
    expect(yolo).not.toContain("EstaCoda");
    expect(yolo).not.toContain("main");
  });

  it("shows the session limit and reserved capacity without breaking narrow rails", () => {
    const budgeted = status({
      sessionCost: {
        totalTokens: 31_400,
        usageComplete: true,
        estimatedCostUsd: 0.42,
        costComplete: true,
        budget: {
          spentCostUsd: 0.42,
          reservedCostUsd: 0.18,
          remainingCostUsd: 0.4,
          maxEstimatedCostUsd: 1,
          warningThresholdPercent: 80,
          state: "available"
        }
      }
    });

    expect(renderStatusRailSurface(budgeted, { width: 120 }))
      .toContain("31.4k tok · $0.42/$1.00 +$0.18 reserved");
    expect(renderStatusRailSurface(budgeted, { width: 28 })).toContain("$0.42/$1.00");
  });

  it("uses isolated Arabic cost text", () => {
    const output = renderStatusRailSurface(status({
      sessionCost: {
        totalTokens: 32_100,
        usageComplete: false,
        estimatedCostUsd: 0.84,
        costComplete: false,
      },
    }), { width: 80, locale: "ar" });

    expect(output).toContain("\u2066≥ 32.1k tok\u2069");
    expect(output).toContain("\u2066≥ $0.84\u2069");
  });

  it("isolates workspace paths and branch names in Arabic mode", () => {
    const output = renderStatusRailSurface(status({
      workspace: {
        label: "~/Documents/…/EstaCoda",
        shortLabel: "EstaCoda",
        branch: "feature/prompt-rail",
      },
    }), { width: 140, locale: "ar" });

    expect(output).toContain("\u2066~/Documents/…/EstaCoda\u2069");
    expect(output).toContain("\u2066feature/prompt-rail\u2069");
  });

  it("never exceeds the terminal width", () => {
    for (const width of [0, 1, 8, 16, 30, 55, 80]) {
      expect(stringWidth(renderStatusRailSurface(status(), { width }))).toBeLessThanOrEqual(width);
    }
  });

  it("uses deterministic empty model fallback", () => {
    const output = renderStatusRailSurface(createDefaultStatusRailState(), { width: 80 });

    expect(output).toContain("model pending ● · ctx [··········] --");
    expect(output.trimEnd().endsWith("◷ 00:00")).toBe(true);
    expect(stringWidth(output)).toBe(80);
  });

  it("renders a known context limit without fabricating usage", () => {
    expect(renderStatusRailSurface(status({
      context: { totalTokens: 262_000 },
    }), { width: 80 })).toContain("ctx [··········] --/262k");
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

  it("uses semantic hierarchy colors for context, workspace, branch, and session values", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const output = renderStatusRailSurface(status({
      workspace: {
        label: "~/Documents/…/EstaCoda",
        shortLabel: "EstaCoda",
        branch: "main",
      },
      sessionCost: {
        totalTokens: 31_400,
        usageComplete: true,
        estimatedCostUsd: 0.08,
        costComplete: true,
      },
    }), { width: 140, style });

    expect(output).toContain(`${ansiFg(tokens.contract.text.muted)}ctx\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.interactive.primary)}▰\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.interactive.primary)}~/Documents/…/EstaCoda\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.text.secondary)}main\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.text.secondary)}31.4k tok\x1b[0m`);
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
