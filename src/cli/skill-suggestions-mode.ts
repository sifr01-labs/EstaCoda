export const SKILL_SUGGESTIONS_MODE_ENV_VAR = "ESTACODA_SKILL_SUGGESTIONS";

export type SkillSuggestionsMode = "off" | "on";

export type ResolveSkillSuggestionsModeOptions = {
  readonly env?: Record<string, string | undefined>;
};

export function parseSkillSuggestionsMode(value: string | undefined): SkillSuggestionsMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on") return "on";
  return "off";
}

export function resolveSkillSuggestionsMode(options?: ResolveSkillSuggestionsModeOptions): SkillSuggestionsMode {
  const env = options?.env ?? process.env;
  return parseSkillSuggestionsMode(env[SKILL_SUGGESTIONS_MODE_ENV_VAR]);
}
