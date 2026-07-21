import { randomUUID } from "node:crypto";
import type { IntentRoute, SkillRouteCandidate } from "../contracts/intent.js";
import type { ProviderRequest, ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { SkillRouteLlmRerankTelemetry } from "../contracts/skill.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";

const MAX_RERANK_CANDIDATES = 5;
const MAX_PROMPT_CHARS = 1_000;
const MAX_METADATA_CHARS = 240;

export type SkillRouteShadowReranker = {
  rerank(input: {
    intent: IntentRoute;
    userText: string;
    executionSessionId?: string;
    visibleTurnId?: string;
    signal?: AbortSignal;
  }): Promise<SkillRouteLlmRerankTelemetry | undefined>;
};

export class LlmSkillRouteShadowReranker implements SkillRouteShadowReranker {
  readonly #providerExecutor: ProviderExecutor;
  readonly #route: ResolvedAuxiliaryRoute | undefined;
  readonly #mainRoute: ResolvedModelRoute;

  constructor(options: {
    providerExecutor: ProviderExecutor;
    route?: ResolvedAuxiliaryRoute;
    mainRoute: ResolvedModelRoute;
  }) {
    this.#providerExecutor = options.providerExecutor;
    this.#route = options.route;
    this.#mainRoute = options.mainRoute;
  }

  async rerank(input: {
    intent: IntentRoute;
    userText: string;
    executionSessionId?: string;
    visibleTurnId?: string;
    signal?: AbortSignal;
  }): Promise<SkillRouteLlmRerankTelemetry | undefined> {
    const candidates = boundedRerankCandidates(input.intent);
    if (candidates.length < 2) {
      return undefined;
    }

    const resolvedRoute = this.#route?.route ?? (this.#route?.fallbackToMain === true ? this.#mainRoute : undefined);
    const route = resolvedRoute === undefined || this.#route?.timeoutMs === undefined
      ? resolvedRoute
      : { ...resolvedRoute, timeoutMs: this.#route.timeoutMs };
    if (route === undefined) {
      return {
        mode: "llm-rerank-shadow",
        status: "skipped",
        candidates: candidates.map((candidate) => ({ skillName: candidate.skill.name })),
        diagnostics: ["No auxiliary assessor route is available for shadow reranking."]
      };
    }

    const request = buildRerankRequest({
      intent: input.intent,
      userText: input.userText,
      candidates
    });
    const execution = await this.#providerExecutor.complete(request, {}, {
      primaryRoute: route,
      signal: input.signal,
      usage: {
        requestKey: `auxiliary:skill-rerank:${randomUUID()}`,
        sourceKind: "auxiliary",
        auxiliaryKind: "skill_rerank",
        ...(input.executionSessionId === undefined ? {} : {
          executionSessionId: input.executionSessionId,
          sessionBudgetScopeId: input.executionSessionId
        }),
        ...(input.visibleTurnId === undefined ? {} : { visibleTurnId: input.visibleTurnId })
      }
    });

    if (!execution.ok || execution.response?.ok !== true) {
      return {
        mode: "llm-rerank-shadow",
        status: "failed",
        candidates: candidates.map((candidate) => ({ skillName: candidate.skill.name })),
        diagnostics: [`Reranker provider failed: ${execution.attempts.at(-1)?.errorClass ?? "unknown"}.`],
        provider: execution.response?.provider ?? route.provider,
        model: execution.response?.model ?? route.id
      };
    }

    return parseRerankResponse(execution.response.content, {
      candidates,
      provider: execution.response.provider,
      model: execution.response.model
    });
  }
}

export function boundedRerankCandidates(intent: IntentRoute): SkillRouteCandidate[] {
  const candidates = intent.candidates ?? [];
  return candidates
    .filter((candidate) =>
      candidate.role === "primary" ||
      candidate.role === "supporting" ||
      candidate.role === "candidate"
    )
    .slice(0, MAX_RERANK_CANDIDATES);
}

function buildRerankRequest(input: {
  intent: IntentRoute;
  userText: string;
  candidates: SkillRouteCandidate[];
}): Omit<ProviderRequest, "model"> & { model?: string } {
  return {
    messages: [
      {
        role: "system",
        content: [
          "You are a shadow-only skill route reranker.",
          "Choose at most one skillName from the provided candidate list.",
          "Do not invent skill names.",
          "Return only JSON with shape: {\"selectedSkill\":\"name-or-null\",\"confidence\":0..1,\"rankedSkills\":[\"name\"]}.",
          "This decision is advisory telemetry only and must not authorize tools or change routing."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt: truncate(input.userText, MAX_PROMPT_CHARS),
          taskClass: input.intent.taskClass,
          deterministicPrimarySkill: input.intent.primarySkill?.name ?? null,
          candidates: input.candidates.map((candidate) => ({
            skillName: candidate.skill.name,
            role: candidate.role,
            score: candidate.score,
            confidence: candidate.confidence,
            description: truncate(candidate.skill.description, MAX_METADATA_CHARS),
            routingLabels: candidate.skill.routing?.labels ?? [],
            whenToUse: candidate.skill.whenToUse.slice(0, 3).map((entry) => truncate(entry, MAX_METADATA_CHARS))
          }))
        })
      }
    ],
    temperature: 0,
    maxTokens: 240,
    responseFormat: { type: "json_object" }
  };
}

function parseRerankResponse(
  content: string,
  input: {
    candidates: SkillRouteCandidate[];
    provider: string;
    model: string;
  }
): SkillRouteLlmRerankTelemetry {
  const allowed = new Set(input.candidates.map((candidate) => candidate.skill.name));
  const base = {
    mode: "llm-rerank-shadow" as const,
    candidates: input.candidates.map((candidate) => ({ skillName: candidate.skill.name })),
    provider: input.provider,
    model: input.model
  };

  const parsed = parseJsonRecord(content);
  if (parsed === undefined) {
    return {
      ...base,
      status: "invalid",
      diagnostics: ["Reranker returned malformed JSON."]
    };
  }

  const selectedSkillRaw = parsed.selectedSkill;
  const selectedSkill = typeof selectedSkillRaw === "string" && selectedSkillRaw.length > 0
    ? selectedSkillRaw
    : undefined;
  if (selectedSkill !== undefined && !allowed.has(selectedSkill)) {
    return {
      ...base,
      status: "invalid",
      diagnostics: ["Reranker selected a skill outside the bounded candidate set."]
    };
  }

  const rankedSkills = Array.isArray(parsed.rankedSkills)
    ? parsed.rankedSkills.filter((entry): entry is string => typeof entry === "string" && allowed.has(entry))
    : [];
  const ranked = mergeOrdered(
    selectedSkill === undefined ? [] : [selectedSkill],
    rankedSkills
  );
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? clamp01(parsed.confidence)
    : undefined;

  return {
    ...base,
    status: "succeeded",
    ...(selectedSkill === undefined ? {} : { wouldSelectSkill: selectedSkill }),
    ...(confidence === undefined ? {} : { confidence }),
    candidates: ranked.length === 0
      ? base.candidates
      : ranked.map((skillName) => ({
          skillName,
          ...(skillName === selectedSkill && confidence !== undefined ? { confidence } : {})
        })),
    diagnostics: []
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function mergeOrdered<T>(first: T[], second: T[]): T[] {
  return [...new Set([...first, ...second])];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 3) + "...";
}
