import { describe, expect, it } from "vitest";
import {
  __detectForgetPreferenceForTest,
  __detectProjectFactForTest,
  __detectUserPreferenceForTest
} from "./memory-promotion.js";

describe("memory promotion deterministic detectors", () => {
  it.each([
    ["I prefer TypeScript", "Prefer TypeScript."],
    ["Prefer TypeScript.", "Prefer TypeScript."],
    ["please use pnpm by default", "Use pnpm by default."],
    ["default to TypeScript", "Default to TypeScript."],
    ["always use strict mode", "Always use strict mode."],
    ["we want pnpm by default", "Want pnpm by default."],
    ["I prefer concise replies", "Prefer concise replies."],
    ["give me detailed replies", "Prefer detailed replies."]
  ])("accepts direct user preference form %j", (input, expected) => {
    expect(__detectUserPreferenceForTest(input)).toBe(expected);
  });

  it.each([
    ["project uses TypeScript", "Project uses TypeScript."],
    ["run tests with pnpm test", "Run tests with `pnpm test`."],
    ["foo is stored under ~/.estacoda/foo", "Foo is stored under `~/.estacoda/foo`."]
  ])("accepts direct project fact form %j", (input, expected) => {
    expect(__detectProjectFactForTest(input)).toBe(expected);
  });

  it.each([
    "I'd prefer TypeScript",
    "I like TypeScript",
    "Switch to TypeScript",
    "",
    "   \n\t  ",
    "remember this",
    "أفضل الردود المختصرة",
    "For the next release notes, I prefer TypeScript but only inside this quoted example paragraph."
  ])("rejects unsupported or incidental user preference form %j", (input) => {
    expect(__detectUserPreferenceForTest(input)).toBeUndefined();
  });

  it.each([
    "Please summarize this: \"I prefer concise replies.\"",
    "The attached resume says: \"I prefer concise replies.\"",
    "Agent note: I prefer concise replies.",
    "Earlier assistant said: \"User prefers concise replies.\""
  ])("rejects delegated or quoted preference form %j", (input) => {
    expect(__detectUserPreferenceForTest(input)).toBeUndefined();
  });

  it.each([
    ["forget that i prefer concise replies", "Prefer concise replies."],
    ["please forget that i prefer detailed replies", "Prefer detailed replies."]
  ])("keeps explicit forget preference detection deterministic for %j", (input, expected) => {
    expect(__detectForgetPreferenceForTest(input)).toBe(expected);
  });
});
