import { describe, expect, it } from "vitest";
import { clampPoint, clampRect, containsPoint, containsRect, intersectRect, normalizeRect, unionRect } from "./geometry.js";

describe("Papyrus geometry utilities", () => {
  it("normalizes rectangles with negative dimensions", () => {
    expect(normalizeRect({ x: 10, y: 8, width: -4, height: -3 })).toEqual({ x: 6, y: 5, width: 4, height: 3 });
  });

  it("intersects rectangles and returns null for empty intersections", () => {
    expect(intersectRect({ x: 0, y: 0, width: 5, height: 5 }, { x: 3, y: 2, width: 5, height: 5 })).toEqual({
      x: 3,
      y: 2,
      width: 2,
      height: 3,
    });
    expect(intersectRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 3, y: 3, width: 2, height: 2 })).toBeNull();
  });

  it("checks point and rectangle containment", () => {
    const bounds = { x: 2, y: 2, width: 4, height: 3 };
    expect(containsPoint(bounds, { x: 5, y: 4 })).toBe(true);
    expect(containsPoint(bounds, { x: 6, y: 4 })).toBe(false);
    expect(containsRect(bounds, { x: 3, y: 3, width: 2, height: 1 })).toBe(true);
    expect(containsRect(bounds, { x: 3, y: 3, width: 4, height: 1 })).toBe(false);
  });

  it("clamps points and rectangles to bounds", () => {
    expect(clampPoint({ x: -2, y: 10 }, { x: 0, y: 0, width: 8, height: 4 })).toEqual({ x: 0, y: 3 });
    expect(clampRect({ x: -2, y: 1, width: 5, height: 8 }, { x: 0, y: 0, width: 8, height: 4 })).toEqual({
      x: 0,
      y: 1,
      width: 3,
      height: 3,
    });
  });

  it("unions rectangles", () => {
    expect(unionRect({ x: 4, y: 1, width: 2, height: 3 }, { x: 0, y: 5, width: 3, height: 2 })).toEqual({
      x: 0,
      y: 1,
      width: 6,
      height: 6,
    });
  });
});
