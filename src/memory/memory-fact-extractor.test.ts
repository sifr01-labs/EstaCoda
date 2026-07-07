import { describe, expect, it, vi } from "vitest";
import type {
  ModelProfile,
  ProviderResponse,
  ResolvedAuxiliaryRoute,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { SessionMessage } from "../contracts/session.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { extractMemoryFacts } from "./memory-fact-extractor.js";

describe("extractMemoryFacts", () => {
  it("extracts normalized facts through the compression auxiliary route", async () => {
    const complete = vi.fn(async (
      _request: Parameters<ProviderExecutor["complete"]>[0],
      _preferences: Parameters<ProviderExecutor["complete"]>[1],
      _options: Parameters<ProviderExecutor["complete"]>[2]
    ) => ({
      ok: true,
      fallbackUsed: false,
      attempts: [],
      toolCalls: [],
      response: providerResponse(JSON.stringify({
        facts: [
          {
            statement: "User prefers pnpm",
            category: "technical-default",
            evidence: [{ messageId: "m1", exactSpan: "prefer pnpm" }],
            explicitness: "explicit",
            sensitivity: "none",
            confidence: 0.7
          },
          {
            statement: "Unsupported fact",
            category: "preference",
            evidence: [{ messageId: "missing", exactSpan: "not present" }],
            explicitness: "explicit",
            sensitivity: "none",
            confidence: 0.7
          }
        ]
      }))
    }));

    const result = await extractMemoryFacts({
      messages: [message("m1", "I prefer pnpm for this repo.")],
      profileId: "default",
      sessionId: "session-1",
      options: {
        route: auxiliaryRoute(),
        mainRoute: modelRoute("main-model"),
        providerExecutor: { complete: complete as ProviderExecutor["complete"] },
        id: () => "fact-1"
      }
    });

    expect(result.diagnostics).toMatchObject({
      ok: true,
      routeSource: "semantic-compression",
      rawFactCount: 2,
      acceptedFactCount: 1,
      rejectedFactCount: 1
    });
    expect(result.facts).toEqual([
      {
        id: "fact-1",
        statement: "User prefers pnpm",
        category: "technical-default",
        evidence: [{ messageId: "m1", exactSpan: "prefer pnpm" }],
        explicitness: "explicit",
        sensitivity: "none",
        confidence: 0.7
      }
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      primaryRoute: modelRoute("compression-model")
    });
  });

  it("returns structured diagnostics when extraction dependencies are unavailable", async () => {
    const result = await extractMemoryFacts({
      messages: [message("m1", "Please remember I use pnpm.")],
      profileId: "default",
      sessionId: "session-1",
      options: {}
    });

    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      ok: false,
      routeSource: "unavailable",
      acceptedFactCount: 0
    });
  });
});

function message(id: string, content: string): SessionMessage {
  return {
    id,
    sessionId: "session-1",
    role: "user",
    content,
    createdAt: "2026-05-20T00:00:00.000Z"
  };
}

function providerResponse(content: string): ProviderResponse {
  return {
    ok: true,
    content,
    model: "compression-model",
    provider: "test"
  };
}

function auxiliaryRoute(): ResolvedAuxiliaryRoute {
  return {
    task: "compression",
    route: modelRoute("compression-model"),
    source: "explicit",
    fallbackToMain: false,
    diagnostics: []
  };
}

function modelRoute(id: string): ResolvedModelRoute {
  return {
    provider: "test",
    id,
    profile: modelProfile(id)
  };
}

function modelProfile(id: string): ModelProfile {
  return {
    id,
    provider: "test",
    contextWindowTokens: 128_000,
    supportsTools: false,
    supportsVision: false,
    supportsStructuredOutput: true
  };
}
