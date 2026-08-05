import { describe, expect, it } from "vitest";
import { isolateTechnicalTokens, RLI, PDI } from "../../bidi.js";
import { isCursorAtGraphemeBoundary } from "../../input/cursor.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  layoutEditableText,
  moveEditableCursorVisual,
  renderEditableTextRow,
} from "./editableTextLayout.js";

describe("Papyrus editable bidi text layout", () => {
  it("keeps logical Arabic text unchanged while exposing visual clusters and cursor cells", () => {
    const text = "سلام";
    const layout = layoutEditableText(text, {
      maxCells: 10,
      cursorOffset: text.length,
      wrap: true,
    });

    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]?.text).toBe(text);
    expect(layout.rows[0]?.direction).toBe("rtl");
    expect(layout.rows[0]?.visualClusters.map((cluster) => cluster.text).join("")).toBe("مالس");
    expect(renderEditableTextRow(layout.rows[0]!)).toBe(`      ${RLI}${text}${PDI}`);
    expect(layout.cursorColumn).toBe(6);
    expect(text).toBe("سلام");
  });

  it("keeps Latin runs stable inside an RTL paragraph", () => {
    const text = "هلا ممكن تستخدم ٣ subagents وتبحث عن RSI";
    const layout = layoutEditableText(text, {
      maxCells: 48,
      cursorOffset: text.length,
      wrap: true,
    });
    const visual = layout.rows[0]?.visualClusters.map((cluster) => cluster.text).join("");

    expect(visual).toBe("RSI نع ثحبتو subagents ٣ مدختست نكمم اله");
    expect(visual).toContain("RSI");
    expect(visual).toContain("subagents");
    expect(layout.cursorColumn).toBe(11);
  });

  it("keeps leading path punctuation inside its isolated technical run", () => {
    const text = "استخدم /home/idris الآن";
    const layout = layoutEditableText(text, {
      maxCells: 40,
      cursorOffset: text.length,
      wrap: true,
    });
    const visual = layout.rows[0]?.visualClusters.map((cluster) => cluster.text).join("");

    expect(visual).toBe("نآلا /home/idris مدختسا");
    expect(renderEditableTextRow(layout.rows[0]!)).toContain(isolateTechnicalTokens(text));
  });

  it("maps visual arrow movement back to logical grapheme boundaries", () => {
    const text = "سلام";

    expect(moveEditableCursorVisual(text, text.length, "left", { maxCells: 10, wrap: true })).toBe(text.length);
    expect(moveEditableCursorVisual(text, text.length, "right", { maxCells: 10, wrap: true })).toBe(3);
    expect(moveEditableCursorVisual(text, 0, "left", { maxCells: 10, wrap: true })).toBe(1);
    expect(moveEditableCursorVisual(text, 0, "right", { maxCells: 10, wrap: true })).toBe(0);
  });

  it("soft-wraps mixed text without exceeding terminal cells", () => {
    const text = "مرحبا world مرحبا again";
    const layout = layoutEditableText(text, {
      maxCells: 8,
      cursorOffset: text.length,
      wrap: true,
    });

    expect(layout.rows.length).toBeGreaterThan(1);
    expect(layout.rows.every((row) => row.width <= 8)).toBe(true);
    expect(layout.cursorRow).toBe(layout.rows.length - 1);
    expect(layout.cursorColumn).toBeGreaterThanOrEqual(0);
    expect(layout.cursorColumn).toBeLessThanOrEqual(8);
  });

  it("keeps emoji and combining marks on grapheme boundaries", () => {
    const text = "مرحبا 👩🏽‍💻 Cafe\u0301";
    const layout = layoutEditableText(text, {
      maxCells: 30,
      cursorOffset: text.length,
      wrap: true,
    });

    for (const row of layout.rows) {
      for (const cluster of row.visualClusters) {
        expect(isCursorAtGraphemeBoundary(text, cluster.logicalStart)).toBe(true);
        expect(isCursorAtGraphemeBoundary(text, cluster.logicalEnd)).toBe(true);
      }
      expect(stringWidth(renderEditableTextRow(row))).toBe(30);
    }
  });

  it("leaves pure LTR rendering and navigation unchanged", () => {
    const text = "hello RSI";
    const layout = layoutEditableText(text, {
      maxCells: 20,
      cursorOffset: text.length,
      wrap: true,
    });

    expect(renderEditableTextRow(layout.rows[0]!)).toBe(text);
    expect(layout.cursorColumn).toBe(text.length);
    expect(moveEditableCursorVisual(text, text.length, "left", { maxCells: 20, wrap: true })).toBe(text.length - 1);
  });

  it("does not right-pad unbounded measurement layouts", () => {
    const layout = layoutEditableText("سلام", {
      maxCells: Number.POSITIVE_INFINITY,
      cursorOffset: 4,
      wrap: true,
    });

    expect(layout.rows[0]?.leftPadding).toBe(0);
    expect(stringWidth(renderEditableTextRow(layout.rows[0]!))).toBe(4);
  });

  it("contains unsafe bidi controls in rendering without mutating source text", () => {
    const text = "مرحبا\u202eabc";
    const layout = layoutEditableText(text, {
      maxCells: 20,
      cursorOffset: text.length,
      wrap: true,
    });
    const rendered = renderEditableTextRow(layout.rows[0]!);

    expect(layout.rows[0]?.text).toBe(text);
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("abc");
  });
});
