import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { stringWidth } from "../screen/stringWidth.js";
import { formatInlineToolTrailRow } from "./inlineToolTrailSurface.js";
import { createOperatorConsoleStyle } from "./operatorConsoleStyle.js";

describe("Papyrus operator console inline tool trail surface", () => {
  it("formats running tool rows with active-work symbols and compact elapsed time", () => {
    const row = formatInlineToolTrailRow({
      id: "read-1",
      sequence: 1,
      toolName: "read_file",
      status: "running",
      summary: "src/cli/session-loop.ts",
      target: "src/cli/session-loop.ts",
      durationMs: 3_000,
    }, 72);

    expect(row).toContain("◷ read_file");
    expect(row).toContain("src/cli/session-loop.ts");
    expect(row).toContain("3s");
    expect(stringWidth(row)).toBeLessThanOrEqual(72);
  });

  it("formats terminal tool statuses with the shared active-work grammar", () => {
    const succeeded = formatInlineToolTrailRow({
      id: "read-1",
      sequence: 1,
      toolName: "read_file",
      status: "succeeded",
      summary: "src/app.ts",
      durationMs: 1_000,
    }, 56);
    const failed = formatInlineToolTrailRow({
      id: "run-1",
      sequence: 2,
      toolName: "terminal.run",
      status: "failed",
      summary: "denied",
      durationMs: 0,
    }, 56);

    expect(succeeded).toContain("✓ read_file");
    expect(succeeded).toContain("1s");
    expect(failed).toContain("✗ terminal.run");
    expect(failed).toContain("denied");
    expect(failed).toContain("0s");
  });

  it("colors status symbols with the shared active-work palette when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });

    const succeeded = formatInlineToolTrailRow({
      id: "read-1",
      sequence: 1,
      toolName: "read_file",
      status: "succeeded",
      summary: "src/app.ts",
      durationMs: 1_000,
    }, 56, { style });
    const failed = formatInlineToolTrailRow({
      id: "run-1",
      sequence: 2,
      toolName: "terminal.run",
      status: "failed",
      summary: "denied",
      durationMs: 0,
    }, 56, { style });

    expect(succeeded).toContain(`${ansiFg(tokens.contract.severity.ok)}✓\x1b[0m read_file`);
    expect(failed).toContain(`${ansiFg(tokens.contract.severity.error)}✗\x1b[0m terminal.run`);
    expect(stringWidth(succeeded)).toBeLessThanOrEqual(56);
    expect(stringWidth(failed)).toBeLessThanOrEqual(56);
  });

  it("stays within narrow terminal widths", () => {
    const row = formatInlineToolTrailRow({
      id: "long-1",
      sequence: 1,
      toolName: "very_long_tool_name",
      status: "running",
      summary: "a/very/long/path/that/should/not/overflow.ts",
      durationMs: 12_000,
    }, 18);

    expect(stringWidth(row)).toBeLessThanOrEqual(18);
  });
});

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
