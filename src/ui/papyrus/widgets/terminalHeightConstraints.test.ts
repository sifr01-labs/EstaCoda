import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  calculatePickerPreviewLayout,
  calculateTerminalHeightConstraints,
} from "./index.js";

describe("Papyrus terminal height constraints", () => {
  it("splits normal terminal height among search, list, preview, hints, and status", () => {
    expect(calculateTerminalHeightConstraints({
      availableHeight: 20,
      searchRows: 2,
      hintRows: 1,
      statusRows: 1,
      listMinRows: 4,
      previewEnabled: true,
      previewPreferredRows: 6,
    })).toEqual({
      availableHeight: 20,
      searchRows: 2,
      hintRows: 1,
      statusRows: 1,
      contentRows: 16,
      listRows: 10,
      previewRows: 6,
      usedRows: 20,
      overflowRows: 0,
    });
  });

  it("handles small terminal heights while preserving list rows before preview rows", () => {
    const result = calculateTerminalHeightConstraints({
      availableHeight: 5,
      searchRows: 1,
      hintRows: 1,
      statusRows: 1,
      listMinRows: 2,
      previewEnabled: true,
      previewMinRows: 2,
      previewPreferredRows: 4,
    });

    expect(result).toMatchObject({
      availableHeight: 5,
      searchRows: 1,
      hintRows: 1,
      statusRows: 1,
      contentRows: 2,
      listRows: 2,
      previewRows: 0,
      overflowRows: 0,
    });
  });

  it("reserves fixed rows first when they exhaust the available height", () => {
    const result = calculateTerminalHeightConstraints({
      availableHeight: 2,
      searchRows: 1,
      hintRows: 1,
      statusRows: 1,
      listMinRows: 2,
      previewEnabled: true,
      previewMinRows: 1,
    });

    expect(result).toMatchObject({
      searchRows: 1,
      hintRows: 1,
      statusRows: 0,
      contentRows: 0,
      listRows: 0,
      previewRows: 0,
      usedRows: 2,
      overflowRows: 0,
    });
  });

  it("handles zero and negative heights without producing negative rows", () => {
    for (const height of [0, -10, Number.NEGATIVE_INFINITY]) {
      const result = calculateTerminalHeightConstraints({
        availableHeight: height,
        searchRows: 1,
        hintRows: 1,
        statusRows: 1,
        listMinRows: 2,
        previewEnabled: true,
        previewMinRows: 2,
      });

      expect(Object.values(result).every((value) => value >= 0)).toBe(true);
      expect(result.usedRows).toBe(0);
      expect(result.overflowRows).toBe(0);
    }
  });

  it("honors min and max rows where configured", () => {
    const result = calculateTerminalHeightConstraints({
      availableHeight: 18,
      searchRows: 1,
      listMinRows: 3,
      listMaxRows: 5,
      previewEnabled: true,
      previewMinRows: 2,
      previewPreferredRows: 10,
      previewMaxRows: 4,
    });

    expect(result.listRows).toBe(5);
    expect(result.previewRows).toBe(4);
    expect(result.usedRows).toBe(10);
    expect(result.overflowRows).toBe(0);
  });

  it("supports list-only layout when preview is disabled", () => {
    const result = calculateTerminalHeightConstraints({
      availableHeight: 8,
      searchRows: 1,
      hintRows: 1,
      previewEnabled: false,
    });

    expect(result.listRows).toBe(6);
    expect(result.previewRows).toBe(0);
    expect(result.usedRows).toBe(8);
  });

  it("returns picker/preview composition heights as data", () => {
    const layout = calculatePickerPreviewLayout({
      availableHeight: 12,
      searchRows: 1,
      statusRows: 1,
      listMinRows: 3,
      previewEnabled: true,
      previewPreferredRows: 4,
    });

    expect(layout.pickerViewportHeight).toBe(6);
    expect(layout.previewViewportHeight).toBe(4);
    expect(layout.constraints.contentRows).toBe(10);
  });

  it("keeps implementation free of terminal APIs and external coupling", async () => {
    const source = await readFile(new URL("./terminalHeightConstraints.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bstdout\b|\bstderr\b|\bchild_process\b|\bsetRawMode\b/u);
    expect(source).not.toMatch(/\breact\b|\bink\b|\byoga\b|\bsource-app\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
  });
});
