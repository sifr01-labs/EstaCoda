import { describe, expect, it } from "vitest";
import { calculateMemoryBudgetPressure } from "./memory-pressure.js";

describe("memory budget pressure", () => {
  it("classifies ok, warning, critical, and overflow ratios", () => {
    expect(calculateMemoryBudgetPressure({
      kind: "USER.md",
      chars: 0,
      maxChars: 100
    }).state).toBe("ok");
    expect(calculateMemoryBudgetPressure({
      kind: "USER.md",
      chars: 79,
      maxChars: 100
    }).state).toBe("ok");
    expect(calculateMemoryBudgetPressure({
      kind: "USER.md",
      chars: 80,
      maxChars: 100
    }).state).toBe("warning");
    expect(calculateMemoryBudgetPressure({
      kind: "MEMORY.md",
      chars: 95,
      maxChars: 100
    }).state).toBe("critical");
    expect(calculateMemoryBudgetPressure({
      kind: "MEMORY.md",
      chars: 100,
      maxChars: 100
    }).state).toBe("critical");
    expect(calculateMemoryBudgetPressure({
      kind: "MEMORY.md",
      chars: 101,
      maxChars: 100
    }).state).toBe("overflow");
  });
});
