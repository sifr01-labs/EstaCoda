import { describe, expect, it } from "vitest";
import {
  coerceFiniteNumber,
  coerceNonNegativeInteger,
  coercePositiveInteger
} from "./numeric-coercion.js";

describe("numeric config coercion", () => {
  it("coerces finite numbers and clamps boundaries", () => {
    expect(coerceFiniteNumber("2.5", { default: 1, min: 0, max: 4 })).toBe(2.5);
    expect(coerceFiniteNumber("-1", { default: 1, min: 0, max: 4 })).toBe(0);
    expect(coerceFiniteNumber("9", { default: 1, min: 0, max: 4 })).toBe(4);
    expect(coerceFiniteNumber(3, { default: 1, min: 0, max: 4 })).toBe(3);
  });

  it("falls back for non-finite or non-scalar finite numbers", () => {
    const invalidValues = [
      true,
      false,
      null,
      [],
      [1],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      {}
    ];

    for (const value of invalidValues) {
      expect(coerceFiniteNumber(value, { default: 7, min: 0, max: 10 })).toBe(7);
    }
  });

  it("coerces non-negative integers", () => {
    expect(coerceNonNegativeInteger("3.9", { default: 1 })).toBe(3);
    expect(coerceNonNegativeInteger("-3", { default: 1 })).toBe(0);
    expect(coerceNonNegativeInteger("9", { default: 1, max: 5 })).toBe(5);
    expect(coerceNonNegativeInteger(null, { default: 2, min: 1, max: 5 })).toBe(2);
    expect(coerceNonNegativeInteger(Number.NaN, { default: -4 })).toBe(0);
  });

  it("coerces positive integers", () => {
    expect(coercePositiveInteger("3.9")).toBe(3);
    expect(coercePositiveInteger("0")).toBe(1);
    expect(coercePositiveInteger("-3")).toBe(1);
    expect(coercePositiveInteger("9", { max: 5 })).toBe(5);
    expect(coercePositiveInteger([], { default: 4, max: 5 })).toBe(4);
    expect(coercePositiveInteger(Number.POSITIVE_INFINITY, { default: 0 })).toBe(1);
  });
});
