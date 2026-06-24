import { describe, it, expect } from "vitest";
import {
  measureTextWidth,
  measureVisibleWidth,
  wrapText,
  truncateText,
  truncateVisible,
  padVisibleEnd,
  padVisibleStart,
  padVisibleAlign,
  centerVisibleBlock,
  indentLines,
  openHorizontalFrame,
  solidPromptRail,
  renderBeads,
  stripAnsi,
} from "./layout.js";

describe("stripAnsi", () => {
  it("strips color codes", () => {
    const colored = "\x1b[38;2;255;0;0mred\x1b[0m";
    expect(stripAnsi(colored)).toBe("red");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });

  it("strips bold codes", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[0m")).toBe("bold");
  });
});

describe("measureTextWidth", () => {
  it("measures ASCII text as 1 per char", () => {
    expect(measureTextWidth("hello")).toBe(5);
    expect(measureTextWidth("Hello World")).toBe(11);
  });

  it("does not count ANSI escape sequences", () => {
    expect(measureTextWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("measures empty string as 0", () => {
    expect(measureTextWidth("")).toBe(0);
  });

  it("measures full-width CJK chars as 2", () => {
    expect(measureTextWidth("中文")).toBe(4); // two CJK chars
    expect(measureTextWidth("日本語")).toBe(6);
  });

  it("measures combining chars as 0", () => {
    expect(measureTextWidth("e\u0301")).toBe(1); // e + combining acute
  });

  it("measures Egyptian hieroglyphs as 2", () => {
    expect(measureTextWidth("ገ0")).toBe(2);
  });

  it("measures emoji as 2", () => {
    expect(measureTextWidth("😀")).toBe(2);
    expect(measureTextWidth("⚠")).toBe(2);
  });

  it("measures emoji variation selector cases with grapheme width", () => {
    expect(measureTextWidth("❤️")).toBe(2);
    expect(measureTextWidth("1️")).toBe(1);
  });

  it("measures mixed-script text", () => {
    const text = "Hello العربية";
    expect(measureTextWidth(text)).toBe(13); // Hello(5) + space(1) + Arabic(7)
  });

  it("does not count bidi isolate controls", () => {
    expect(measureTextWidth("\u2067العربية\u2069")).toBe(7);
    expect(measureTextWidth("\u2066/model\u2069")).toBe(6);
  });

  it("handles surrogate pairs correctly", () => {
    expect(measureTextWidth("💎")).toBe(2); // gem emoji
    expect(measureTextWidth("🧠")).toBe(2); // brain emoji
  });
});

describe("measureVisibleWidth", () => {
  it("measures text without counting ANSI codes", () => {
    const text = "\x1b[1mbold\x1b[0m";
    expect(measureVisibleWidth(text)).toBe(4);
  });

  it("matches measureTextWidth for plain text", () => {
    expect(measureVisibleWidth("hello")).toBe(measureTextWidth("hello"));
  });

  it("handles colored Unicode", () => {
    const text = "\x1b[38;2;90;172;255m💎\x1b[0m";
    expect(measureVisibleWidth(text)).toBe(2);
  });

  it("measures Arabic text through the visible width helper", () => {
    expect(measureVisibleWidth("\x1b[32mالعربية\x1b[0m")).toBe(7);
  });
});

describe("wrapText", () => {
  it("wraps text at word boundaries", () => {
    const lines = wrapText("hello world foo bar", 10);
    expect(lines).toEqual(["hello", "world foo", "bar"]);
  });

  it("returns single line when text fits", () => {
    expect(wrapText("short", 20)).toEqual(["short"]);
  });

  it("truncates words that exceed maxWidth", () => {
    const lines = wrapText("supercalifragilistic", 8);
    expect(lines[0]).toBe("super...");
  });

  it("handles narrow width", () => {
    const lines = wrapText("hello world", 4);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(4);
    }
  });

  it("handles empty string", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("handles multiple spaces", () => {
    const lines = wrapText("a   b   c", 5);
    expect(lines).toEqual(["a b c"]);
  });

  it("wraps ANSI-styled text without corrupting escape sequences", () => {
    const lines = wrapText("\x1b[31mred\x1b[0m blue", 5);
    expect(lines).toEqual(["\x1b[31mred\x1b[0m", "blue"]);
    for (const line of lines) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(5);
    }
    expect(lines[0]).toContain("\x1b[31m");
    expect(lines[0]).toContain("\x1b[0m");
  });
});

describe("truncateText", () => {
  it("truncates long text with ellipsis", () => {
    expect(truncateText("hello world", 8)).toBe("hello...");
  });

  it("returns full text when it fits", () => {
    expect(truncateText("short", 20)).toBe("short");
  });

  it("handles exact fit", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("handles custom ellipsis", () => {
    expect(truncateText("hello world", 7, "..")).toBe("hello..");
  });

  it("handles full-width chars in truncation", () => {
    const text = "中文测试"; // 4 CJK chars = 8 width
    expect(truncateText(text, 6)).toBe("中..."); // 2 + 3 = 5, fits in 6
  });

  it("handles emoji in truncation", () => {
    const text = "😀😀😀"; // 3 emojis = 6 width
    // With maxWidth=4, even one emoji (2) + ellipsis (3) = 5 > 4,
    // so only ellipsis (3) fits.
    expect(truncateText(text, 4)).toBe("...");
    expect(measureTextWidth(truncateText(text, 4))).toBeLessThanOrEqual(4);
  });

  it("does not split emoji variation-selector clusters in truncation", () => {
    const truncated = truncateText("❤️❤️ ok", 5);
    expect(truncated).toBe("❤️...");
    expect(Array.from(truncated)).toContain("\ufe0f");
    expect(measureTextWidth(truncated)).toBeLessThanOrEqual(5);
  });

  it("does not split combining marks away from their base character", () => {
    const truncated = truncateText("e\u0301e\u0301e\u0301e\u0301e\u0301", 4);
    expect(truncated).toBe("e\u0301...");
    expect(measureTextWidth(truncated)).toBeLessThanOrEqual(4);
  });

  it("treats bidi isolate controls as zero width while truncating Arabic text", () => {
    const truncated = truncateText("\u2067العربية\u2069 token", 10);
    expect(truncated).toBe("\u2067العربية\u2069...");
    expect(measureTextWidth(truncated)).toBeLessThanOrEqual(10);
  });

  it("returns empty string for maxWidth 0", () => {
    expect(truncateText("hello", 0)).toBe("");
  });

  it("handles long paths", () => {
    const path = "/home/user/projects/my-awesome-project/src/components/ui/button.tsx";
    const truncated = truncateText(path, 40);
    expect(measureTextWidth(truncated)).toBeLessThanOrEqual(40);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("handles long model names", () => {
    const name = "anthropic/claude-3-5-sonnet-20241022-v2:0";
    const truncated = truncateText(name, 25);
    expect(measureTextWidth(truncated)).toBeLessThanOrEqual(25);
  });
});

describe("truncateVisible", () => {
  it("truncates ANSI text preserving codes", () => {
    const text = "\x1b[38;2;255;0;0mhello world\x1b[0m";
    const truncated = truncateVisible(text, 8);
    expect(truncated.startsWith("\x1b[38;2;255;0;0m")).toBe(true);
    expect(stripAnsi(truncated)).toBe("hello...");
    expect(measureVisibleWidth(truncated)).toBeLessThanOrEqual(8);
  });

  it("returns full text when it fits", () => {
    const text = "\x1b[1mshort\x1b[0m";
    expect(truncateVisible(text, 20)).toBe(text);
  });

  it("handles plain text like truncateText", () => {
    expect(truncateVisible("hello world", 8)).toBe("hello...");
  });

  it("handles multi-codepoint ANSI sequences", () => {
    const text = "\x1b[38;2;90;172;255m\x1b[1mbold blue\x1b[0m";
    const truncated = truncateVisible(text, 6);
    expect(stripAnsi(truncated)).toBe("bol...");
    expect(measureVisibleWidth(truncated)).toBeLessThanOrEqual(6);
  });

  it("does not split ANSI sequences while truncating styled CJK text", () => {
    const truncated = truncateVisible("\x1b[32m中文测试\x1b[0m", 7);
    expect(truncated).toBe("\x1b[32m中文...");
    expect(stripAnsi(truncated)).toBe("中文...");
    expect(measureVisibleWidth(truncated)).toBeLessThanOrEqual(7);
  });

  it("keeps mixed Arabic, LTR, ANSI, and emoji tokens within visible width", () => {
    const text = "\u2067مرحبا\u2069 \x1b[36m/model\x1b[0m ❤️";
    const truncated = truncateVisible(text, 14);
    expect(truncated).toContain("\x1b[36m");
    expect(stripAnsi(truncated)).not.toContain("\x1b");
    expect(measureVisibleWidth(truncated)).toBeLessThanOrEqual(14);
  });
});

describe("padVisibleEnd", () => {
  it("pads ANSI text correctly", () => {
    const text = "\x1b[1mhi\x1b[0m";
    const padded = padVisibleEnd(text, 5);
    expect(stripAnsi(padded)).toBe("hi   ");
    expect(measureVisibleWidth(padded)).toBe(5);
  });

  it("returns text unchanged if already wide enough", () => {
    expect(padVisibleEnd("hello", 3)).toBe("hello");
  });

  it("pads plain text like padEnd", () => {
    expect(padVisibleEnd("hi", 5)).toBe("hi   ");
  });
});

describe("padVisibleStart", () => {
  it("pads ANSI text to the left", () => {
    const text = "\x1b[1mhi\x1b[0m";
    const padded = padVisibleStart(text, 5);
    expect(stripAnsi(padded)).toBe("   hi");
    expect(measureVisibleWidth(padded)).toBe(5);
  });

  it("pads plain text like padStart", () => {
    expect(padVisibleStart("hi", 5)).toBe("   hi");
  });
});

describe("padVisibleAlign", () => {
  it("left-aligns ANSI text", () => {
    const text = "\x1b[1mhi\x1b[0m";
    expect(stripAnsi(padVisibleAlign(text, 5, "left"))).toBe("hi   ");
    expect(measureVisibleWidth(padVisibleAlign(text, 5, "left"))).toBe(5);
  });

  it("right-aligns ANSI text", () => {
    const text = "\x1b[1mhi\x1b[0m";
    expect(stripAnsi(padVisibleAlign(text, 5, "right"))).toBe("   hi");
    expect(measureVisibleWidth(padVisibleAlign(text, 5, "right"))).toBe(5);
  });

  it("center-aligns ANSI text", () => {
    const text = "\x1b[1mhi\x1b[0m";
    expect(stripAnsi(padVisibleAlign(text, 6, "center"))).toBe("  hi  ");
    expect(measureVisibleWidth(padVisibleAlign(text, 6, "center"))).toBe(6);
  });

  it("returns text unchanged if wider than width", () => {
    expect(padVisibleAlign("hello world", 3, "left")).toBe("hello world");
  });
});

describe("centerVisibleBlock", () => {
  it("centers a simple multi-line block based on maximum visible width", () => {
    expect(centerVisibleBlock("abc\nabcd", 10)).toBe("   abc\n   abcd");
  });

  it("uses ANSI-aware width measurement", () => {
    const text = "\x1b[31mred\x1b[0m\nblue";
    const centered = centerVisibleBlock(text, 10);
    expect(centered).toBe("   \x1b[31mred\x1b[0m\n   blue");
  });

  it("leaves text unchanged when terminal width is narrower than block width", () => {
    const text = "short\nlonger";
    expect(centerVisibleBlock(text, 5)).toBe(text);
  });

  it("leaves text unchanged when terminal width equals block width", () => {
    const text = "short\nlonger";
    expect(centerVisibleBlock(text, 6)).toBe(text);
  });

  it("preserves empty lines", () => {
    expect(centerVisibleBlock("top\n\nbottom", 12)).toBe("   top\n\n   bottom");
  });

  it("does not strip ANSI sequences", () => {
    const text = "\x1b[1mBold\x1b[0m";
    const centered = centerVisibleBlock(text, 10);
    expect(centered).toContain("\x1b[1m");
    expect(centered).toContain("\x1b[0m");
    expect(stripAnsi(centered)).toBe("   Bold");
  });

  it("centers based on whole-block width rather than each individual line", () => {
    expect(centerVisibleBlock("x\n12345678", 12)).toBe("  x\n  12345678");
  });

  it("handles a dashboard-like block with hero, blank line, and frame lines", () => {
    const block = [
      "\x1b[1mEstaCoda\x1b[0m",
      "",
      "╭────────╮",
      "  model",
      "╰────────╯",
    ].join("\n");

    expect(centerVisibleBlock(block, 20)).toBe([
      "     \x1b[1mEstaCoda\x1b[0m",
      "",
      "     ╭────────╮",
      "       model",
      "     ╰────────╯",
    ].join("\n"));
  });
});

describe("indentLines", () => {
  it("indents with number of spaces", () => {
    expect(indentLines(["a", "b"], 2)).toEqual(["  a", "  b"]);
  });

  it("indents with custom prefix", () => {
    expect(indentLines(["a"], ">> ")).toEqual([">> a"]);
  });

  it("preserves empty lines", () => {
    expect(indentLines(["a", "", "b"], 2)).toEqual(["  a", "", "  b"]);
  });
});

describe("openHorizontalFrame", () => {
  it("renders open frame with Unicode", () => {
    const result = openHorizontalFrame(["Hello", "World"], { useUnicode: true });
    expect(result).toContain("╭");
    expect(result).toContain("╮");
    expect(result).toContain("╰");
    expect(result).toContain("╯");
    expect(result).toContain("  Hello");
    expect(result).toContain("  World");
    expect(result).not.toContain("│");
  });

  it("renders open frame with ASCII fallback", () => {
    const result = openHorizontalFrame(["Hello"], { useUnicode: false });
    expect(result).toContain("+");
    expect(result).not.toContain("╭");
    expect(result).not.toContain("│");
  });

  it("renders frame with centered title", () => {
    const result = openHorizontalFrame(["content"], {
      useUnicode: true,
      title: "Title",
    });
    expect(result).toContain("─ Title ─");
    const lines = result.split("\n");
    expect(lines[0]).toContain("─ Title ─");
  });

  it("renders ASCII frame title with rule gaps", () => {
    const result = openHorizontalFrame(["content"], {
      useUnicode: false,
      title: "* EstaCoda",
    });
    const lines = result.split("\n");
    expect(lines[0]).toContain("- * EstaCoda -");
  });

  it("respects explicit width", () => {
    const result = openHorizontalFrame(["a"], { useUnicode: true, width: 20 });
    const topLine = result.split("\n")[0];
    expect(measureTextWidth(topLine)).toBe(20);
  });

  it("handles empty content", () => {
    const result = openHorizontalFrame([], { useUnicode: true });
    expect(result).toContain("╭");
    expect(result).toContain("╰");
  });
});

describe("solidPromptRail", () => {
  it("renders Unicode rail", () => {
    const rail = solidPromptRail(20, { useUnicode: true });
    expect(rail).toBe("+" + "─".repeat(18) + "+");
    expect(measureTextWidth(rail)).toBe(20);
  });

  it("renders ASCII rail", () => {
    const rail = solidPromptRail(10, { useUnicode: false });
    expect(rail).toBe("+--------+");
  });

  it("uses custom cap and fill", () => {
    const rail = solidPromptRail(6, { cap: "*", fill: "=" });
    expect(rail).toBe("*====*");
  });

  it("returns just caps for width 2", () => {
    expect(solidPromptRail(2)).toBe("++");
  });

  it("returns single cap for width 1", () => {
    expect(solidPromptRail(1)).toBe("+");
  });
});

describe("renderBeads", () => {
  it("renders filled and empty beads", () => {
    expect(renderBeads(3, 5)).toBe("◉◉◉··");
  });

  it("clamps filled to total", () => {
    expect(renderBeads(10, 5)).toBe("◉◉◉◉◉");
  });

  it("handles zero filled", () => {
    expect(renderBeads(0, 3)).toBe("···");
  });

  it("uses custom characters", () => {
    expect(renderBeads(2, 4, { filledChar: "#", emptyChar: "-" })).toBe("##--");
  });

  it("returns empty for zero total", () => {
    expect(renderBeads(0, 0)).toBe("");
  });

  it("returns empty for negative total", () => {
    expect(renderBeads(0, -1)).toBe("");
  });
});
