import { describe, expect, it, vi } from "vitest";
import type { IntentRoute, SkillRouteCandidate } from "../contracts/intent.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ProviderRequest, ResolvedModelRoute } from "../contracts/provider.js";
import type { SkillDefinition } from "../contracts/skill.js";
import { boundedRerankCandidates, LlmSkillRouteShadowReranker } from "./skill-route-reranker.js";

describe("LlmSkillRouteShadowReranker", () => {
  it("records a valid bounded model selection as shadow telemetry", async () => {
    let observedRequest: (Omit<ProviderRequest, "model"> & { model?: string }) | undefined;
    const complete = vi.fn(async (request: Omit<ProviderRequest, "model"> & { model?: string }) => {
      observedRequest = request;
      return providerResult({
        selectedSkill: "beta-skill",
        confidence: 0.74,
        rankedSkills: ["beta-skill", "alpha-skill"]
      });
    });
    const reranker = new LlmSkillRouteShadowReranker({
      providerExecutor: { complete } as never,
      route: { task: "assessor", route: modelRoute(), source: "main", fallbackToMain: false, diagnostics: [] },
      mainRoute: modelRoute()
    });

    const telemetry = await reranker.rerank({
      intent: route([
        candidate(skill("alpha-skill"), "primary"),
        candidate(skill("beta-skill"), "supporting")
      ]),
      userText: "choose the best skill"
    });

    expect(telemetry).toEqual({
      mode: "llm-rerank-shadow",
      status: "succeeded",
      wouldSelectSkill: "beta-skill",
      confidence: 0.74,
      candidates: [
        { skillName: "beta-skill", confidence: 0.74 },
        { skillName: "alpha-skill" }
      ],
      diagnostics: [],
      provider: "openai",
      model: "assessor-model"
    });
    expect(observedRequest?.responseFormat).toEqual({ type: "json_object" });
  });

  it("marks malformed model output invalid", async () => {
    const reranker = new LlmSkillRouteShadowReranker({
      providerExecutor: { complete: async () => providerResult("not json") } as never,
      route: { task: "assessor", route: modelRoute(), source: "main", fallbackToMain: false, diagnostics: [] },
      mainRoute: modelRoute()
    });

    const telemetry = await reranker.rerank({
      intent: route([
        candidate(skill("alpha-skill"), "primary"),
        candidate(skill("beta-skill"), "supporting")
      ]),
      userText: "choose the best skill"
    });

    expect(telemetry).toEqual(expect.objectContaining({
      status: "invalid",
      diagnostics: ["Reranker returned malformed JSON."]
    }));
  });

  it("rejects model selections outside the bounded candidate set", async () => {
    const reranker = new LlmSkillRouteShadowReranker({
      providerExecutor: { complete: async () => providerResult({ selectedSkill: "unknown-skill" }) } as never,
      route: { task: "assessor", route: modelRoute(), source: "main", fallbackToMain: false, diagnostics: [] },
      mainRoute: modelRoute()
    });

    const telemetry = await reranker.rerank({
      intent: route([
        candidate(skill("alpha-skill"), "primary"),
        candidate(skill("beta-skill"), "supporting")
      ]),
      userText: "choose the best skill"
    });

    expect(telemetry).toEqual(expect.objectContaining({
      status: "invalid",
      diagnostics: ["Reranker selected a skill outside the bounded candidate set."]
    }));
  });

  it("does not pass rejected or deferred candidates to the reranker", () => {
    const primary = candidate(skill("alpha-skill"), "primary");
    const supporting = candidate(skill("beta-skill"), "supporting");
    const rejected = candidate(skill("wrong-skill"), "rejected");
    const deferred = candidate(skill("blocked-skill"), "deferred");

    expect(boundedRerankCandidates(route([primary, supporting, rejected, deferred])))
      .toEqual([primary, supporting]);
  });
});

function providerResult(content: unknown): ProviderExecutionResult {
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  return {
    ok: true,
    response: {
      ok: true,
      provider: "openai",
      model: "assessor-model",
      content: serialized
    },
    fallbackUsed: false,
    attempts: [{
      provider: "openai",
      model: "assessor-model",
      state: "dispatched",
      dispatchedAt: "2030-01-01T00:00:00.000Z",
      ok: true,
      content: serialized
    }],
    toolCalls: []
  };
}

function modelRoute(): ResolvedModelRoute {
  return {
    provider: "openai",
    id: "assessor-model",
    profile: {
      provider: "openai",
      id: "assessor-model",
      contextWindowTokens: 128_000,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    }
  };
}

function route(candidates: SkillRouteCandidate[]): IntentRoute {
  const primary = candidates.find((entry) => entry.role === "primary")?.skill;
  const supporting = candidates.filter((entry) => entry.role === "supporting").map((entry) => entry.skill);
  return {
    nativeIntent: "general",
    taskClass: "general",
    labels: ["general"],
    confidence: 0.7,
    suggestedToolsets: [],
    primarySkill: primary,
    supportingSkills: supporting,
    candidates,
    rejectedCandidates: candidates.filter((entry) => entry.role === "rejected" || entry.role === "deferred"),
    suggestedSkills: primary === undefined ? supporting : [primary, ...supporting],
    confirmationRequired: false,
    evidence: [],
    rationale: "test"
  };
}

function candidate(skillDefinition: SkillDefinition, role: SkillRouteCandidate["role"]): SkillRouteCandidate {
  return {
    skill: skillDefinition,
    role,
    score: role === "primary" ? 0.9 : 0.7,
    confidence: role === "primary" ? 0.9 : 0.7,
    evidence: []
  };
}

function skill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    version: "0.1.0",
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: []
  };
}
