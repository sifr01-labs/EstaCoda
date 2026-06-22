import { describe, expect, it } from "vitest";
import type { ProviderResponse } from "../contracts/provider.js";
import type { ProviderExecutionResult, ProviderAttempt } from "../providers/provider-executor.js";
import {
  renderProviderExecutionSummary,
  summarizeProviderExecution
} from "./provider-execution-summary.js";

function response(provider: string, model: string, content = "ok"): ProviderResponse {
  return {
    ok: true,
    content,
    provider: provider as ProviderResponse["provider"],
    model
  };
}

function attempt(input: {
  provider: string;
  model: string;
  ok: boolean;
  errorClass?: string;
  credentialId?: string;
}): ProviderAttempt {
  return {
    provider: input.provider,
    model: input.model,
    ok: input.ok,
    content: input.ok ? "ok" : "failed",
    ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
    ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId })
  };
}

function execution(input: {
  ok: boolean;
  response?: ProviderResponse;
  fallbackUsed?: boolean;
  attempts?: ProviderAttempt[];
  attemptedRouteIndex?: number;
}): ProviderExecutionResult {
  return {
    ok: input.ok,
    fallbackUsed: input.fallbackUsed ?? false,
    attempts: input.attempts ?? [],
    toolCalls: [],
    ...(input.response === undefined ? {} : { response: input.response }),
    ...(input.attemptedRouteIndex === undefined ? {} : { attemptedRouteIndex: input.attemptedRouteIndex })
  };
}

describe("provider execution summary", () => {
  it("summarizes missing execution as not-run", () => {
    const summary = summarizeProviderExecution({
      configuredModel: { provider: "kimi", id: "kimi-k2.7-code" }
    });

    expect(summary).toEqual({
      configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
      fallbackUsed: false,
      attempts: [],
      status: "not-run"
    });
    expect(renderProviderExecutionSummary(summary)).toEqual([]);
  });

  it("summarizes primary success", () => {
    const summary = summarizeProviderExecution({
      configuredModel: { provider: "kimi", id: "kimi-k2.7-code" },
      execution: execution({
        ok: true,
        response: response("kimi", "kimi-k2.7-code"),
        attempts: [
          attempt({ provider: "kimi", model: "kimi-k2.7-code", ok: true })
        ]
      })
    });

    expect(summary.status).toBe("primary-success");
    expect(summary.fallbackUsed).toBe(false);
    expect(summary.actual).toEqual({ provider: "kimi", model: "kimi-k2.7-code" });
    expect(renderProviderExecutionSummary(summary)).toEqual([
      "provider: kimi/kimi-k2.7-code",
      "provider primary used"
    ]);
  });

  it("summarizes fallback success after primary rate-limit", () => {
    const summary = summarizeProviderExecution({
      configuredModel: { provider: "kimi", id: "kimi-k2.7-code" },
      execution: execution({
        ok: true,
        response: response("deepseek", "deepseek-v4-pro"),
        fallbackUsed: true,
        attempts: [
          attempt({
            provider: "kimi",
            model: "kimi-k2.7-code",
            ok: false,
            errorClass: "rate-limit",
            credentialId: "KIMI_API_KEY"
          }),
          attempt({
            provider: "deepseek",
            model: "deepseek-v4-pro",
            ok: true,
            credentialId: "DEEPSEEK_API_KEY"
          })
        ]
      })
    });

    expect(summary.status).toBe("fallback-success");
    expect(summary.fallbackUsed).toBe(true);
    expect(summary.primaryFailureClass).toBe("rate-limit");
    expect(summary.actual).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(renderProviderExecutionSummary(summary)).toEqual([
      "provider: deepseek/deepseek-v4-pro",
      "provider fallback used: kimi/kimi-k2.7-code failed with rate-limit"
    ]);
  });

  it("summarizes fallback success after empty-response", () => {
    const summary = summarizeProviderExecution({
      execution: execution({
        ok: true,
        response: response("deepseek", "deepseek-v4-pro"),
        fallbackUsed: true,
        attempts: [
          attempt({
            provider: "kimi",
            model: "kimi-k2.7-code",
            ok: false,
            errorClass: "empty-response"
          }),
          attempt({ provider: "deepseek", model: "deepseek-v4-pro", ok: true })
        ]
      })
    });

    expect(summary.status).toBe("fallback-success");
    expect(summary.primaryFailureClass).toBe("empty-response");
    expect(renderProviderExecutionSummary(summary)[1]).toContain("empty-response");
  });

  it("summarizes failed executions and preserves attempts", () => {
    const attempts = [
      attempt({ provider: "kimi", model: "kimi-k2.7-code", ok: false, errorClass: "rate-limit" }),
      attempt({ provider: "deepseek", model: "deepseek-v4-pro", ok: false, errorClass: "auth" })
    ];
    const summary = summarizeProviderExecution({
      execution: execution({
        ok: false,
        fallbackUsed: true,
        attempts
      })
    });

    expect(summary.status).toBe("failed");
    expect(summary.actual).toBeUndefined();
    expect(summary.attempts).toEqual([
      {
        provider: "kimi",
        model: "kimi-k2.7-code",
        ok: false,
        errorClass: "rate-limit",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: false,
        errorClass: "auth",
        routeRole: "fallback",
        attemptedRouteIndex: 1
      }
    ]);
    expect(renderProviderExecutionSummary(summary)).toEqual([
      "provider failed: kimi/kimi-k2.7-code:rate-limit, deepseek/deepseek-v4-pro:auth"
    ]);
  });

  it("renders missing errorClass as unknown", () => {
    const summary = summarizeProviderExecution({
      execution: execution({
        ok: false,
        attempts: [
          attempt({ provider: "kimi", model: "kimi-k2.7-code", ok: false })
        ]
      })
    });

    expect(renderProviderExecutionSummary(summary)).toEqual([
      "provider failed: kimi/kimi-k2.7-code:unknown"
    ]);
  });

  it("keeps configured primary separate from the first attempt", () => {
    const summary = summarizeProviderExecution({
      configuredModel: { provider: "kimi", id: "kimi-k2.7-code" },
      execution: execution({
        ok: true,
        response: response("openrouter", "kimi-k2.7-code"),
        attempts: [
          attempt({ provider: "openrouter", model: "kimi-k2.7-code", ok: true })
        ]
      })
    });

    expect(summary.configuredPrimary).toEqual({ provider: "kimi", model: "kimi-k2.7-code" });
    expect(summary.attempts[0]).toEqual({
      provider: "openrouter",
      model: "kimi-k2.7-code",
      ok: true,
      routeRole: "primary",
      attemptedRouteIndex: 0
    });
  });

  it("does not leak credential IDs in rendered output", () => {
    const summary = summarizeProviderExecution({
      execution: execution({
        ok: true,
        response: response("deepseek", "deepseek-v4-pro"),
        fallbackUsed: true,
        attempts: [
          attempt({
            provider: "kimi",
            model: "kimi-k2.7-code",
            ok: false,
            errorClass: "quota",
            credentialId: "KIMI_API_KEY"
          }),
          attempt({
            provider: "deepseek",
            model: "deepseek-v4-pro",
            ok: true,
            credentialId: "DEEPSEEK_API_KEY"
          })
        ]
      })
    });
    const rendered = renderProviderExecutionSummary(summary).join("\n");

    expect(summary.attempts.map((summaryAttempt) => summaryAttempt.credentialId)).toEqual([
      undefined,
      undefined
    ]);
    expect(JSON.stringify(summary)).not.toContain("KIMI_API_KEY");
    expect(JSON.stringify(summary)).not.toContain("DEEPSEEK_API_KEY");
    expect(rendered).not.toContain("KIMI_API_KEY");
    expect(rendered).not.toContain("DEEPSEEK_API_KEY");
  });
});
