import { describe, expect, it } from "vitest";
import { resolveTokens } from "../../../theme/token-resolver.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  getAssistantMessageFrameDesiredHeight,
  renderAssistantMessageFrame,
} from "./assistantMessageFrame.js";
import { createOperatorConsoleStyle } from "./operatorConsoleStyle.js";

describe("Papyrus operator console assistant message frame", () => {
  it("renders assistant text in the EstaCoda frame", () => {
    const rows = renderAssistantMessageFrame({
      lines: ["The stream should look like the settled assistant response."],
    }, { width: 72 });

    expect(rows[0]).toContain("𓂀  EstaCoda");
    expect(rows).toContainEqual(expect.stringContaining("The stream should look like the settled assistant response."));
    expect(rows.at(-1)).toMatch(/^╰─+╯$/u);
    expect(rows.every((line) => stringWidth(line) <= 72)).toBe(true);
  });

  it("renders assistant content in the open response frame without side rails", () => {
    const rows = renderAssistantMessageFrame({
      lines: ["Open frame content"],
    }, { width: 48 });

    expect(rows[0]).toMatch(/^╭─+/u);
    expect(rows[1]).toBe("  Open frame content");
    expect(rows[1]).not.toContain("│");
    expect(rows.at(-1)).toMatch(/^╰─+╯$/u);
  });

  it("uses the bold brand palette token for the assistant title when styled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true },
    });
    const rows = renderAssistantMessageFrame({
      lines: ["Branded frame."],
    }, { width: 72, style });

    expect(rows[0]).toContain(ansiFg(tokens.contract.palette.brand));
    expect(rows[0]).toContain(`${ansiFg(tokens.contract.palette.brand)}\x1b[1m𓂀  EstaCoda\x1b[0m\x1b[0m`);
  });

  it("adds the live cursor only when requested", () => {
    const live = renderAssistantMessageFrame({
      lines: ["Still composing"],
      cursor: true,
    }, { width: 48 }).join("\n");
    const settled = renderAssistantMessageFrame({
      lines: ["Still composing"],
    }, { width: 48 }).join("\n");

    expect(live).toContain("Still composing▍");
    expect(settled).toContain("Still composing");
    expect(settled).not.toContain("▍");
  });

  it("renders inline tool trail rows between assistant text blocks", () => {
    const rows = renderAssistantMessageFrame({
      lines: [],
      blocks: [
        { kind: "text", lines: ["I'll inspect the runtime path first."] },
        {
          kind: "toolTrail",
          entries: [{
            id: "read-1",
            sequence: 1,
            toolName: "read_file",
            status: "running",
            summary: "src/cli/session-loop.ts",
            target: "src/cli/session-loop.ts",
            durationMs: 3_000,
          }],
        },
        { kind: "text", lines: ["The session loop wires deltas through the console."], cursor: true },
      ],
    }, { width: 84 });
    const rendered = rows.join("\n");

    expect(rendered).toContain("I'll inspect the runtime path first.");
    expect(rendered).toContain("◷ read_file");
    expect(rendered).toContain("src/cli/session-loop.ts");
    expect(rendered).toContain("3s");
    expect(rendered).toContain("The session loop wires deltas through the console.▍");
    expect(rows.every((line) => stringWidth(line) <= 84)).toBe(true);
  });

  it("summarizes without implementation chrome when height is constrained below a frame", () => {
    const rows = renderAssistantMessageFrame({
      lines: ["Constrained assistant output"],
      cursor: true,
    }, { width: 32, height: 1 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("EstaCoda: Constrained");
    expect(stringWidth(rows[0] ?? "")).toBeLessThanOrEqual(32);
    expect(rows.join("\n")).not.toContain("Assistant stream");
    expect(rows.join("\n")).not.toContain("assistant:");
  });

  it("reports frame desired height from wrapped content", () => {
    expect(getAssistantMessageFrameDesiredHeight({
      lines: ["short"],
    }, 80)).toBe(3);
    expect(getAssistantMessageFrameDesiredHeight({
      lines: ["This sentence wraps into multiple content rows at narrow width."],
    }, 24)).toBeGreaterThan(3);
  });
});

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
