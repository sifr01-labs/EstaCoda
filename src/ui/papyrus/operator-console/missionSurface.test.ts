import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "../../../contracts/execution-plan.js";
import { formatPlainExecutionPlan, renderMissionSurface } from "./missionSurface.js";

const plan: ExecutionPlan = {
  objective: "Build six MTN products in Postman",
  originTurnId: "turn-1",
  revision: 3,
  status: "active",
  items: [
    { id: "identify", content: "Identify products", status: "completed" },
    { id: "specs", content: "Obtain specifications", status: "in_progress" },
    { id: "build", content: "Build collection", status: "pending" }
  ]
};

describe("Mission surface", () => {
  it("renders the English Mission checklist", () => {
    expect(renderMissionSurface(plan, { width: 80, locale: "en" })).toEqual([
      "Mission · Build six MTN products in Postman",
      "✓ Identify products",
      "● Obtain specifications",
      "○ Build collection"
    ]);
  });

  it("uses the Arabic product label", () => {
    const arabic = { ...plan, objective: "إنشاء مجموعة MTN في Postman" };
    expect(renderMissionSurface(arabic, { width: 80, locale: "ar" })[0])
      .toBe("خطة التنفيذ · إنشاء مجموعة MTN في Postman");
  });

  it("stays within narrow terminal width", () => {
    const lines = renderMissionSurface(plan, { width: 18, height: 3, locale: "en" });
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => [...line].length <= 18)).toBe(true);
    expect(lines[0]).toContain("Mission");
  });

  it("has a deterministic plain rendering", () => {
    expect(formatPlainExecutionPlan(plan)).toContain("✓ Identify products\n● Obtain specifications");
  });
});
