import { describe, expect, it } from "vitest";
import type { ProviderAttempt, ProviderExecutionResult } from "./provider-executor.js";
import { humanProviderIssue, summarizeProviderFailure } from "./provider-diagnostics.js";

function attempt(input: Partial<ProviderAttempt> & Pick<ProviderAttempt, "provider" | "model" | "ok">): ProviderAttempt {
  const { state, ...rest } = input;
  if (state === "preflight") {
    return {
      content: "",
      ...rest,
      state: "preflight"
    } as ProviderAttempt;
  }

  return {
    content: "",
    ...rest,
    state: "dispatched",
    dispatchedAt: "2026-08-21T14:21:19.270Z"
  } as ProviderAttempt;
}

function execution(attempts: ProviderAttempt[]): ProviderExecutionResult {
  return {
    ok: false,
    fallbackUsed: false,
    attempts,
    toolCalls: []
  };
}

describe("provider diagnostics", () => {
  it("counts successful calls without presenting them as unknown failures", () => {
    const attempts = Array.from({ length: 12 }, () => attempt({
      provider: "kimi",
      model: "kimi-k3",
      ok: true,
      finishReason: "tool_calls"
    }));
    attempts.push(attempt({
      provider: "kimi",
      model: "kimi-k3",
      ok: false,
      errorClass: "rate-limit"
    }));

    const summary = summarizeProviderFailure(execution(attempts));

    expect(summary).toBe(
      "The configured model path did not complete after 12 successful provider calls. " +
      "Last issue: kimi/kimi-k3 (rate limited). " +
      "Failed attempts: kimi/kimi-k3 (rate limited; dispatched)."
    );
    expect(summary).not.toContain("unknown provider issue");
  });

  it("groups repeated failures while distinguishing preflight and dispatched attempts", () => {
    const summary = summarizeProviderFailure(execution([
      attempt({
        state: "preflight",
        provider: "primary",
        model: "model-a",
        ok: false,
        errorClass: "rate-limit"
      }),
      attempt({
        provider: "primary",
        model: "model-a",
        ok: false,
        errorClass: "rate-limit"
      }),
      attempt({
        provider: "fallback",
        model: "model-b",
        ok: false,
        errorClass: "server"
      })
    ]));

    expect(summary).toContain("Last issue: fallback/model-b (provider server issue).");
    expect(summary).toContain("primary/model-a (rate limited; 2 attempts: 1 preflight, 1 dispatched)");
    expect(summary).toContain("fallback/model-b (provider server issue; dispatched)");
  });

  it("reports an unavailable route when no attempts were recorded", () => {
    expect(summarizeProviderFailure(execution([])))
      .toBe("No configured provider route was available for this request.");
  });

  it("does not expose provider content, partial output, or credential identifiers", () => {
    const summary = summarizeProviderFailure(execution([
      attempt({
        provider: "primary",
        model: "model-a",
        ok: false,
        errorClass: "auth",
        content: "response-secret-value",
        partialContent: "partial-secret-value",
        credentialId: "PRIVATE_API_KEY"
      })
    ]));

    expect(summary).toContain("authentication needs attention");
    expect(summary).not.toContain("response-secret-value");
    expect(summary).not.toContain("partial-secret-value");
    expect(summary).not.toContain("PRIVATE_API_KEY");
  });

  it("handles an inconsistent failed execution without fabricated failed attempts", () => {
    const summary = summarizeProviderFailure(execution([
      attempt({ provider: "primary", model: "model-a", ok: true })
    ]));

    expect(summary).toBe(
      "The configured model path did not complete after 1 successful provider call. " +
      "No failed provider attempt was recorded."
    );
  });

  it("keeps provider error labels bounded to known diagnostics", () => {
    expect(humanProviderIssue("quota")).toBe("quota or billing limit");
    expect(humanProviderIssue(undefined)).toBe("unknown provider issue");
  });
});
