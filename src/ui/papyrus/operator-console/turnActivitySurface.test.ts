import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { createOperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { renderTurnActivitySurface } from "./turnActivitySurface.js";

describe("turn activity semantic motion", () => {
  const style = createOperatorConsoleStyle({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    capabilities: { supportsColor: true, supportsTrueColor: true },
  });

  it.each([
    ["thinking", "◜", "38;2;184;153;255"],
    ["routing", "›", "38;2;94;208;230"],
    ["provider", "⠋", "38;2;90;172;255"],
    ["finalizing", "◇", "38;2;215;167;255"],
    ["background", "⠁", "38;2;136;136;136"],
  ] as const)("renders %s with its own frame and color", (phase, frame, color) => {
    const text = renderTurnActivitySurface({ phase }, {
      width: 80,
      style,
      motionElapsedMs: 0,
    }).join("\n");

    expect(stripAnsi(text)).toContain(frame);
    expect(text).toContain(color);
  });

  it("uses provider waiting cadence rather than refresh count", () => {
    const before = stripAnsi(renderTurnActivitySurface({ phase: "provider" }, {
      width: 80,
      style,
      motionElapsedMs: 84,
    }).join("\n"));
    const after = stripAnsi(renderTurnActivitySurface({ phase: "provider" }, {
      width: 80,
      style,
      motionElapsedMs: 85,
    }).join("\n"));

    expect(before).toContain("⠋");
    expect(after).toContain("⠙");
  });

  it("keeps plain output ASCII, static, and color-free", () => {
    const plainStyle = createOperatorConsoleStyle({
      tokens: resolveTokens("plain", "dark", "kemetBlue"),
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const text = renderTurnActivitySurface({ phase: "finalizing" }, {
      width: 80,
      style: plainStyle,
      motionElapsedMs: 10_000,
    }).join("\n");

    expect(text).toContain("o");
    expect(text).not.toContain("\x1b");
    for (const character of text) expect(character.charCodeAt(0)).toBeLessThan(128);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}
