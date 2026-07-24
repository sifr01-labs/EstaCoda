import { describe, expect, it } from "vitest";
import { formatSpendingThresholdWarning } from "./spending-warning-format.js";

const warning = {
  scopeKind: "root_task" as const,
  warningThresholdPercent: 80,
  maxEstimatedCostUsd: 5,
  committedCostUsd: 4
};

describe("formatSpendingThresholdWarning", () => {
  it("uses explicit plain English copy without relying on color", () => {
    const rendered = formatSpendingThresholdWarning(warning, "en");
    expect(rendered).toBe(
      "Estimated spending warning: Task has used or reserved $4.00 of $5.00 in provider spending (80% warning threshold)."
    );
    expect(rendered).not.toMatch(/\x1b/u);
  });

  it("keeps Arabic copy and monetary values directionally isolated", () => {
    const rendered = formatSpendingThresholdWarning({ ...warning, scopeKind: "session" }, "ar");
    expect(rendered).toContain("تنبيه بشأن الإنفاق التقديري");
    expect(rendered).toContain("الجلسة");
    expect(rendered).toContain("$4.00");
    expect(rendered).toContain("$5.00");
    expect(rendered).not.toMatch(/\x1b/u);
    expect(rendered.startsWith("\u2067")).toBe(true);
    expect(rendered.endsWith("\u2069")).toBe(true);
  });
});
