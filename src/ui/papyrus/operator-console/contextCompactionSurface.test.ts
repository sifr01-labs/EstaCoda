import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { stringWidth, stripAnsi } from "../screen/stringWidth.js";
import {
  createOperatorConsoleStyle,
  getContextCompactionSurfaceDesiredHeight,
  renderContextCompactionSurface,
  renderContextCompactionStatusSurface,
  type ContextCompactionSurfaceState,
} from "./index.js";

describe("Papyrus operator console context compaction surface", () => {
  it("renders a compact completion card with aligned session statistics", () => {
    const rows = renderContextCompactionSurface(compactedState(), { width: 120 });
    const text = rows.join("\n");

    expect(rows[0]).toContain("╭─ 𓂀  Context Compacted ");
    expect(text).toContain("│ Messages   39 → 29");
    expect(text).toContain("│ Tokens     8,248 → 6,923");
    expect(text).toContain("│ Saved      ~1,325 tokens · 16%");
    expect(text).toContain("│ Note       2 older tool results were omitted.");
    expect(rows.at(-1)).toMatch(/^╰─+╯$/u);
    expect(stringWidth(rows[0] ?? "")).toBe(49);
    expect(rows.every((line) => stringWidth(line) <= 120)).toBe(true);
    expect(getContextCompactionSurfaceDesiredHeight(compactedState())).toBe(rows.length);
  });

  it("uses the brand token for the completion title only", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const rows = renderContextCompactionSurface(compactedState(), { width: 80, style });

    expect(rows[0]).toContain(`${ansiFg(tokens.contract.palette.brand)}\x1b[1m𓂀  Context Compacted\x1b[0m\x1b[0m`);
    expect(rows[1]).not.toContain(ansiFg(tokens.contract.palette.brand));
  });

  it("renders skipped compaction as an unchanged context card", () => {
    const rows = renderContextCompactionSurface({
      ...compactedState(),
      didCompress: false,
      messagesAfter: 39,
      tokensAfter: 8_248,
      savedTokens: 0,
      savingsPercent: 0,
      omittedToolResults: 0,
      skippedReason: "below-threshold",
    }, { width: 52 });
    const text = rows.join("\n");

    expect(rows[0]).toContain("𓂀  Context Unchanged");
    expect(text).toContain("│ Saved      ~0 tokens · 0%");
    expect(text).toContain("│ Note       Compaction skipped: below-threshold.");
    expect(rows.every((line) => stringWidth(line) <= 52)).toBe(true);
  });

  it("keeps singular omitted tool-result notes grammatical", () => {
    const rows = renderContextCompactionSurface({
      ...compactedState(),
      omittedToolResults: 1,
    }, { width: 80 });

    expect(rows.join("\n")).toContain("1 older tool result was omitted.");
  });

  it("summarizes non-tool compaction warnings without dumping raw diagnostics", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const rows = renderContextCompactionSurface({
      ...compactedState(),
      omittedToolResults: 0,
      warningCount: 3,
    }, { width: 80, style });

    const text = rows.join("\n");

    expect(stripAnsi(text)).toContain("│ Warning    3 compaction warnings were recorded.");
    expect(text).toContain(`${ansiFg(tokens.contract.palette.caution)}Warning`);
    expect(text).not.toContain("Warning:");
  });

  it("uses the caution token for deterministic fallback compaction cards", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const rows = renderContextCompactionSurface({
      ...compactedState(),
      tone: "warning",
      warningCount: 1,
    }, { width: 80, style });

    expect(rows[0]).toContain(`${ansiFg(tokens.contract.palette.caution)}\x1b[1m𓂀  Context Compacted\x1b[0m\x1b[0m`);
    expect(rows[0]).not.toContain(ansiFg(tokens.contract.palette.brand));
  });

  it("renders failed and unavailable status cards through the same Papyrus frame with outcome colors", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const failed = renderContextCompactionStatusSurface({
      kind: "failed",
      detail: "provider timed out",
    }, { width: 80, style }).join("\n");
    const unavailable = renderContextCompactionStatusSurface({
      kind: "unavailable",
    }, { width: 80, style }).join("\n");
    const cancelled = renderContextCompactionStatusSurface({
      kind: "cancelled",
    }, { width: 80, style }).join("\n");

    expect(failed).toContain("𓂀  Context Compaction Failed");
    expect(failed).toContain(`${ansiFg(tokens.contract.severity.error)}\x1b[1m𓂀  Context Compaction Failed\x1b[0m\x1b[0m`);
    expect(failed).toContain("│ Status     Compaction failed.");
    expect(failed).toContain("│ Detail     provider timed out");
    expect(unavailable).toContain("𓂀  Context Compaction Unavailable");
    expect(unavailable).toContain(`${ansiFg(tokens.contract.palette.caution)}\x1b[1m𓂀  Context Compaction Unavailable\x1b[0m\x1b[0m`);
    expect(unavailable).toContain("│ Status     Compaction is unavailable in this runtime.");
    expect(cancelled).toContain("𓂀  Context Compaction Cancelled");
    expect(cancelled).toContain(`${ansiFg(tokens.contract.palette.caution)}\x1b[1m𓂀  Context Compaction Cancelled\x1b[0m\x1b[0m`);
    expect(cancelled).toContain("│ Status     Compaction was cancelled.");
  });
});

function compactedState(): ContextCompactionSurfaceState {
  return {
    didCompress: true,
    messagesBefore: 39,
    messagesAfter: 29,
    tokensBefore: 8_248,
    tokensAfter: 6_923,
    savedTokens: 1_325,
    savingsPercent: 16,
    omittedToolResults: 2,
  };
}

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
