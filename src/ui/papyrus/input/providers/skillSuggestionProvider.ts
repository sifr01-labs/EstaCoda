import {
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
  type SuggestionProviderError,
  type SuggestionTokenContext,
} from "../suggestionTypes.js";

export const SKILL_SUGGESTION_PROVIDER_ID = "skill";
export const DEFAULT_SKILL_SUGGESTION_MAX_SKILLS = 200;
export const DEFAULT_SKILL_SUGGESTION_MAX_SUGGESTIONS = 20;

export type SkillSuggestionListOptions = {
  readonly limit: number;
  readonly signal?: AbortSignal;
};

export type SkillSuggestionSource = {
  readonly listSkills: (
    options: SkillSuggestionListOptions
  ) => readonly SkillSuggestionSkill[] | Promise<readonly SkillSuggestionSkill[]>;
};

export type SkillSuggestionSkill = {
  readonly label: string;
  readonly id?: string;
  readonly description?: string;
  readonly detail?: string;
  readonly keywords?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type SkillSuggestionMetadata = {
  readonly label: string;
  readonly id?: string;
  readonly description?: string;
  readonly detail?: string;
  readonly keywords?: readonly string[];
  readonly skillIndex: number;
  readonly matchKind: SkillSuggestionMatchKind;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
};

export type SkillSuggestionProviderOptions = {
  readonly source: SkillSuggestionSource;
  readonly enabled?: boolean;
  readonly isAuthorized?: () => boolean | Promise<boolean>;
  readonly maxSkillsToScan?: number;
  readonly maxSuggestions?: number;
};

type SkillSuggestionMatchKind = "exact" | "prefix" | "contains" | "subsequence";

type RankedSkillSuggestion = {
  readonly skill: SkillSuggestionSkill;
  readonly skillIndex: number;
  readonly score: number;
  readonly matchKind: SkillSuggestionMatchKind;
};

export function createSkillSuggestionProvider(
  options: SkillSuggestionProviderOptions
): SuggestionProvider<SkillSuggestionMetadata> {
  const maxSkillsToScan = positiveIntegerOrDefault(
    options.maxSkillsToScan,
    DEFAULT_SKILL_SUGGESTION_MAX_SKILLS
  );
  const maxSuggestions = positiveIntegerOrDefault(
    options.maxSuggestions,
    DEFAULT_SKILL_SUGGESTION_MAX_SUGGESTIONS
  );

  return {
    id: SKILL_SUGGESTION_PROVIDER_ID,
    name: "Skills",
    capabilityTags: ["skill"],
    getSuggestions: async (context, signal) => {
      if (isSignalAborted(signal)) {
        return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID, { canceled: true });
      }
      if (options.enabled !== true) {
        return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID);
      }

      try {
        const authorized = await options.isAuthorized?.();
        if (authorized !== true) {
          return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID);
        }
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const skills = await options.source.listSkills({ limit: maxSkillsToScan, signal });
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const suggestions = rankSkills({
          skills: skills.slice(0, maxSkillsToScan),
          context,
        })
          .slice(0, maxSuggestions)
          .map((skill) => toSkillSuggestion(skill, context));

        return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID, { suggestions });
      } catch (error) {
        return normalizeSuggestionProviderResult(SKILL_SUGGESTION_PROVIDER_ID, {
          error: providerError(error),
        });
      }
    },
  };
}

function rankSkills(input: {
  readonly skills: readonly SkillSuggestionSkill[];
  readonly context: SuggestionTokenContext;
}): readonly RankedSkillSuggestion[] {
  const seenLabels = new Set<string>();
  const query = normalizeSearchText(input.context.token);
  const ranked: RankedSkillSuggestion[] = [];

  for (const [skillIndex, rawSkill] of input.skills.entries()) {
    const label = rawSkill.label.trim();
    const duplicateKey = normalizeSearchText(label);
    if (label.length === 0 || seenLabels.has(duplicateKey)) continue;
    seenLabels.add(duplicateKey);

    const skill = {
      ...rawSkill,
      label,
    };
    const match = scoreSkill(skill, query);
    if (match === undefined) continue;
    ranked.push({
      skill,
      skillIndex,
      score: match.score,
      matchKind: match.kind,
    });
  }

  return ranked.sort((left, right) => left.score - right.score || left.skillIndex - right.skillIndex);
}

function toSkillSuggestion(
  ranked: RankedSkillSuggestion,
  context: SuggestionTokenContext
): SuggestionItem<SkillSuggestionMetadata> {
  const { skill } = ranked;
  return {
    id: `${SKILL_SUGGESTION_PROVIDER_ID}:${skill.id ?? ranked.skillIndex}`,
    label: skill.label,
    detail: skill.detail ?? skill.id,
    description: skill.description,
    replacementText: skill.label,
    replacementRange: context.tokenRange,
    providerId: SKILL_SUGGESTION_PROVIDER_ID,
    kind: "skill",
    rank: {
      score: ranked.score,
    },
    metadata: {
      label: skill.label,
      id: skill.id,
      description: skill.description,
      detail: skill.detail,
      keywords: skill.keywords,
      skillIndex: ranked.skillIndex,
      matchKind: ranked.matchKind,
      sourceMetadata: skill.metadata,
    },
  };
}

function scoreSkill(
  skill: SkillSuggestionSkill,
  query: string
): { readonly kind: SkillSuggestionMatchKind; readonly score: number } | undefined {
  if (query.length === 0) return { kind: "prefix", score: 1 };

  const fields = [
    skill.label,
    skill.id,
    skill.description,
    skill.detail,
    ...(skill.keywords ?? []),
  ].flatMap((field) => field === undefined ? [] : [normalizeSearchText(field)]);

  if (fields.some((field) => field === query)) return { kind: "exact", score: 0 };
  if (fields.some((field) => field.startsWith(query))) return { kind: "prefix", score: 1 };
  if (fields.some((field) => field.includes(query))) return { kind: "contains", score: 2 };
  if (fields.some((field) => isSubsequence(field, query))) return { kind: "subsequence", score: 3 };
  return undefined;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSubsequence(text: string, query: string): boolean {
  let queryIndex = 0;
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function providerError(error: unknown): SuggestionProviderError {
  if (error instanceof Error) return { message: error.message, recoverable: true };
  return { message: String(error), recoverable: true };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
