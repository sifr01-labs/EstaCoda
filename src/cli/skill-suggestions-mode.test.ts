import { describe, expect, it } from "vitest";
import {
  parseSkillSuggestionsMode,
  resolveSkillSuggestionsMode,
  SKILL_SUGGESTIONS_MODE_ENV_VAR,
} from "./skill-suggestions-mode.js";

describe("skill suggestions mode", () => {
  it("defaults unset, empty, invalid, zero, and false values to off", () => {
    expect(resolveSkillSuggestionsMode({ env: {} })).toBe("off");
    expect(parseSkillSuggestionsMode(undefined)).toBe("off");
    expect(parseSkillSuggestionsMode("")).toBe("off");
    expect(parseSkillSuggestionsMode("   ")).toBe("off");
    expect(parseSkillSuggestionsMode("0")).toBe("off");
    expect(parseSkillSuggestionsMode("false")).toBe("off");
    expect(parseSkillSuggestionsMode("skill")).toBe("off");
  });

  it("accepts explicit on values", () => {
    expect(parseSkillSuggestionsMode("1")).toBe("on");
    expect(parseSkillSuggestionsMode("true")).toBe("on");
    expect(parseSkillSuggestionsMode("on")).toBe("on");
    expect(parseSkillSuggestionsMode(" ON ")).toBe("on");
  });

  it("resolves ESTACODA_SKILL_SUGGESTIONS from injected env without mutation", () => {
    const env = { [SKILL_SUGGESTIONS_MODE_ENV_VAR]: " true " };
    const before = { ...env };

    expect(resolveSkillSuggestionsMode({ env })).toBe("on");
    expect(env).toEqual(before);
  });
});
