import { describe, expect, it } from "vitest";
import {
  findProtectedArgumentEnvelopes,
  getAtProtectedArgumentPointer,
  isProtectedArgumentPattern,
  matchesProtectedArgumentPattern,
  matchesProtectedArgumentPointer,
  setAtProtectedArgumentPointer,
} from "./protected-argument-path.js";

describe("protected argument JSON Pointer patterns", () => {
  it("matches wildcards only to actual array entries", () => {
    const input = {
      values: [
        { value: { protectedInput: { kind: "api-key" } } },
        { value: { protectedInput: { kind: "client-secret" } } },
      ],
    };
    expect(matchesProtectedArgumentPattern("/values/*/value", "/values/0/value", input)).toBe(true);
    expect(matchesProtectedArgumentPattern("/values/*/value", "/values/1/value", input)).toBe(true);
    expect(matchesProtectedArgumentPattern("/values/*/value", "/values/2/value", input)).toBe(false);
    expect(matchesProtectedArgumentPattern("/values/*/value", "/values/name/value", { values: { name: { value: 1 } } })).toBe(false);
    expect(matchesProtectedArgumentPointer("/values/*/value", "/values/12/value")).toBe(true);
  });

  it("rejects unsafe, ambiguous, and non-pointer declarations", () => {
    expect(isProtectedArgumentPattern("/values/*/value")).toBe(true);
    expect(isProtectedArgumentPattern("values.*.value")).toBe(false);
    expect(isProtectedArgumentPattern("/__proto__/value")).toBe(false);
    expect(isProtectedArgumentPattern("/values/0/value")).toBe(false);
    expect(isProtectedArgumentPattern("/values/~2/value")).toBe(false);
  });

  it("discovers concrete envelopes and replaces only an existing leaf", () => {
    const input = {
      values: [
        { key: "first", value: { protectedInput: { kind: "api-key" } } },
        { key: "second", value: "plain" },
      ],
    };
    expect(findProtectedArgumentEnvelopes(input).map((entry) => entry.pointer)).toEqual(["/values/0/value"]);
    expect(getAtProtectedArgumentPointer(input, "/values/0/value")).toEqual({ protectedInput: { kind: "api-key" } });
    setAtProtectedArgumentPointer(input, "/values/0/value", "injected");
    expect(input.values[0]?.value).toBe("injected");
    expect(() => setAtProtectedArgumentPointer(input, "/values/2/value", "blocked")).toThrow();
  });
});
