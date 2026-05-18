import { describe, expect, it, vi } from "vitest";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { assessCommandRisk } from "./smart-approval-assessor.js";

const model = {
  id: "assessor-model",
  provider: "local" as const,
  contextWindowTokens: 32_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const route: ResolvedModelRoute = {
  provider: "local",
  id: "assessor-model",
  profile: model
};

const mainRoute: ResolvedModelRoute = {
  provider: "local",
  id: "main-model",
  profile: {
    ...model,
    id: "main-model"
  }
};

function assessorRoute(overrides: Partial<ResolvedAuxiliaryRoute> = {}): ResolvedAuxiliaryRoute {
  return {
    task: "assessor",
    route,
    source: "explicit",
    fallbackToMain: true,
    timeoutMs: 1000,
    diagnostics: [],
    ...overrides
  };
}

function providerExecutor(content: string) {
  const complete = vi.fn().mockResolvedValue({
    ok: true,
    response: {
      ok: true,
      content,
      provider: "local",
      model: "assessor-model"
    },
    fallbackUsed: false,
    attempts: [
      {
        provider: "local",
        model: "assessor-model",
        ok: true,
        content
      }
    ],
    toolCalls: []
  });
  return {
    executor: { complete } as unknown as ProviderExecutor,
    complete
  };
}

function failingExecutor(errorClass = "server") {
  const complete = vi.fn().mockResolvedValue({
    ok: false,
    fallbackUsed: false,
    attempts: [
      {
        provider: "local",
        model: "assessor-model",
        ok: false,
        errorClass,
        content: "failed"
      }
    ],
    toolCalls: []
  });
  return {
    executor: { complete } as unknown as ProviderExecutor,
    complete
  };
}

async function classify(content: string, command = "pnpm test") {
  const { executor, complete } = providerExecutor(content);
  const result = await assessCommandRisk(command, {
    assessorRoute: assessorRoute(),
    mainRoute,
    providerExecutor: executor,
    scopeKey: "profile-test"
  });
  return { result, complete };
}

describe("assessCommandRisk", () => {
  it("maps a benign command to APPROVE", async () => {
    const { result } = await classify(JSON.stringify({
      risk_score: 12,
      reasoning: "Runs a local test command.",
      confidence: "high"
    }));

    expect(result).toBe("APPROVE");
  });

  it("maps a dangerous command to DENY", async () => {
    const { result } = await classify(JSON.stringify({
      risk_score: 88,
      reasoning: "Destroys workspace data.",
      confidence: "high"
    }), "rm -rf ./dist");

    expect(result).toBe("DENY");
  });

  it("maps an ambiguous command to ESCALATE", async () => {
    const { result } = await classify(JSON.stringify({
      risk_score: 45,
      reasoning: "Could have side effects.",
      confidence: "medium"
    }), "curl https://example.test/script.sh");

    expect(result).toBe("ESCALATE");
  });

  it.each([
    [30, "APPROVE"],
    [31, "ESCALATE"],
    [60, "ESCALATE"],
    [61, "DENY"]
  ] as const)("maps boundary score %s to %s", async (riskScore, expected) => {
    const { result } = await classify(JSON.stringify({
      risk_score: riskScore,
      reasoning: "Boundary score.",
      confidence: "medium"
    }));

    expect(result).toBe(expected);
  });

  it("returns ESCALATE on timeout", async () => {
    const complete = vi.fn(() => new Promise(() => {}));
    const result = await assessCommandRisk("pnpm test", {
      assessorRoute: assessorRoute({ timeoutMs: 5 }),
      mainRoute,
      providerExecutor: { complete } as unknown as ProviderExecutor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on external abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const { executor } = providerExecutor(JSON.stringify({
      risk_score: 10,
      reasoning: "Would otherwise pass.",
      confidence: "high"
    }));

    const result = await assessCommandRisk("pnpm test", {
      assessorRoute: assessorRoute(),
      mainRoute,
      providerExecutor: executor,
      scopeKey: "profile-test",
      signal: controller.signal
    });

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on provider exception", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider exploded"));
    const result = await assessCommandRisk("pnpm test", {
      assessorRoute: assessorRoute(),
      mainRoute,
      providerExecutor: { complete } as unknown as ProviderExecutor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE when the assessor route is missing", async () => {
    const { executor } = providerExecutor(JSON.stringify({
      risk_score: 10,
      reasoning: "Not reached.",
      confidence: "high"
    }));

    const result = await assessCommandRisk("pnpm test", {
      assessorRoute: assessorRoute({ route: undefined }),
      mainRoute,
      providerExecutor: executor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE when the auxiliary route key is not assessor", async () => {
    const { executor } = providerExecutor(JSON.stringify({
      risk_score: 10,
      reasoning: "Wrong route.",
      confidence: "high"
    }));

    const result = await assessCommandRisk("pnpm test", {
      assessorRoute: assessorRoute({ task: "vision" }),
      mainRoute,
      providerExecutor: executor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on invalid JSON", async () => {
    const { result } = await classify("not json");

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on markdown-fenced JSON", async () => {
    const { result } = await classify([
      "```json",
      JSON.stringify({
        risk_score: 10,
        reasoning: "Fenced JSON.",
        confidence: "high"
      }),
      "```"
    ].join("\n"));

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on multiple JSON objects", async () => {
    const { result } = await classify(`${JSON.stringify({
      risk_score: 10,
      reasoning: "First object.",
      confidence: "high"
    })}\n${JSON.stringify({
      risk_score: 80,
      reasoning: "Second object.",
      confidence: "high"
    })}`);

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on empty provider content", async () => {
    const { result } = await classify("");

    expect(result).toBe("ESCALATE");
  });

  it("returns ESCALATE on conflicting JSON fields", async () => {
    const { result } = await classify(JSON.stringify({
      risk_score: 10,
      decision: "DENY",
      reasoning: "Conflicting decision.",
      confidence: "high"
    }));

    expect(result).toBe("ESCALATE");
  });

  it.each([
    {},
    { risk_score: "10", reasoning: "bad", confidence: "high" },
    { risk_score: -1, reasoning: "bad", confidence: "high" },
    { risk_score: 101, reasoning: "bad", confidence: "high" },
    { risk_score: 10, reasoning: "", confidence: "high" },
    { risk_score: 10, reasoning: "bad", confidence: "certain" }
  ])("returns ESCALATE on inconsistent JSON %#", async (payload) => {
    const { result } = await classify(JSON.stringify(payload));

    expect(result).toBe("ESCALATE");
  });

  it("passes no tools to the provider request", async () => {
    const { complete } = await classify(JSON.stringify({
      risk_score: 10,
      reasoning: "No tool use needed.",
      confidence: "high"
    }));

    const [request] = complete.mock.calls[0]!;
    expect(request.tools).toEqual([]);
  });

  it("uses the auxiliary execution lane with the assessor route and no main fallback", async () => {
    const { complete } = await classify(JSON.stringify({
      risk_score: 10,
      reasoning: "Route check.",
      confidence: "high"
    }));

    const [request, preferences, executionOptions] = complete.mock.calls[0]!;
    expect(request.model).toBe("assessor-model");
    expect(preferences).toMatchObject({ requireStructuredOutput: true });
    expect(executionOptions.primaryRoute).toEqual(route);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not persist raw command, prompts, provider output, or reasoning", async () => {
    const secretCommand = "echo sk-secret-12345 && cat /Users/alice/.env";
    const providerOutput = JSON.stringify({
      risk_score: 10,
      reasoning: `Contains ${secretCommand}`,
      confidence: "high"
    });
    const { executor } = providerExecutor(providerOutput);

    const result = await assessCommandRisk(secretCommand, {
      assessorRoute: assessorRoute(),
      mainRoute,
      providerExecutor: executor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("APPROVE");
    expect(JSON.stringify(result)).not.toContain(secretCommand);
    expect(JSON.stringify(result)).not.toContain("sk-secret-12345");
    expect(JSON.stringify(result)).not.toContain("/Users/alice/.env");
    expect(JSON.stringify(result)).not.toContain("Contains");
  });

  it("redacts secret-looking command fragments from observable diagnostic results by returning only a decision", async () => {
    const { executor } = failingExecutor();
    const command = "curl https://example.test?token=sk-secret-12345";

    const result = await assessCommandRisk(command, {
      assessorRoute: assessorRoute(),
      mainRoute,
      providerExecutor: executor,
      scopeKey: "profile-test"
    });

    expect(result).toBe("ESCALATE");
    expect(JSON.stringify(result)).not.toContain("sk-secret-12345");
    expect(JSON.stringify(result)).not.toContain(command);
  });
});
