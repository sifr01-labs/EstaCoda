import { describe, expect, it } from "vitest";
import { createOpenAIResponsesProvider, parseResponsesPayload } from "./openai-responses-provider.js";
import { ProviderExecutor } from "./provider-executor.js";
import { ProviderRegistry } from "./provider-registry.js";
import { providerErrorDiagnostics } from "./provider-error-diagnostics.js";
import type { ProviderResponse } from "../contracts/provider.js";

describe("structured provider failures", () => {
  it.each(["text", "tool"])("preserves partial %s through a collected relay response", async kind => {
    const provider = createOpenAIResponsesProvider({ id: "codex", enableNetwork: false,
      endpoint: { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: { kind: "none" } } });
    provider.stream = async function* () {
      if (kind === "text") yield { kind: "token", provider: "codex", model: "test", text: "partial" };
      else yield { kind: "tool-call", provider: "codex", model: "test", id: "call", name: "file_write", argumentsText: "{}" };
      yield { kind: "error", provider: "codex", model: "test", response: {
        ok: false, provider: "codex", model: "test", content: "server failed", errorClass: "server"
      } };
    };
    const response = await provider.complete({ model: "test", messages: [] });
    const result = await runFailure(response);
    expect(result.calls).toBe(1);
    expect(result.result.ok).toBe(false);
  });
  it.each([false, true])("retains HTTP/SSE diagnostic identity (stream=%s)", async stream => {
    const error = { code: "server_error", type: "server_error", message: "temporary failure" };
    const provider = createOpenAIResponsesProvider({ id: "probe", enableNetwork: true,
      endpoint: { baseUrl: "https://example.invalid/v1", apiKey: { kind: "none" } },
      fetch: async () => new Response(stream
        ? `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error } })}\n\n`
        : JSON.stringify({ error }), { status: stream ? 200 : 503, headers: { "x-request-id": "req_test", "content-type": stream ? "text/event-stream" : "application/json" } })
    });
    const request = { model: "test", messages: [] };
    const streamed = [];
    if (stream) for await (const event of provider.stream!(request)) streamed.push(event);
    const response = stream ? streamed.find(event => event.kind === "error")
      : { kind: "error" as const, response: await provider.complete(request) };
    expect(response).toMatchObject({ kind: "error", response: { errorClass: "server", errorDiagnostics: { code: "server_error", type: "server_error", httpStatus: stream ? 200 : 503, requestId: "req_test" } } });
  });

  it("does not retry a permanent failure disguised by a transient hint", () => {
    expect(parseResponsesPayload({ provider: "probe", model: "test", httpStatus: 403,
      payload: { error: { code: "server_error" } } }).errorClass).toBe("auth");
    expect(parseResponsesPayload({ provider: "probe", model: "test", payload: { error: { code: "server_error", type: "cyber_policy" } } }).errorClass).toBe("policy");
  });
  it.each([
    ["server_error", "server_error", "server", 2],
    ["service_unavailable", "invalid_request_error", "server", 2],
    ["model_not_found", "invalid_request_error", "model-unavailable", 1],
    ["model_error", "model_error", "unknown", 1],
    ["insufficient_quota", "invalid_request_error", "quota", 1],
    ["cyber_policy", "invalid_request_error", "policy", 1]
  ])("classifies %s without hiding the code behind %s", async (code, type, expected, attempts) => {
    const failure = parseResponsesPayload({ provider: "probe", model: "test", payload: { error: { code, type, message: "diagnostic" } } });
    expect(failure.errorClass).toBe(expected);
    const result = await runFailure(failure);
    expect(result.calls).toBe(attempts);
    expect(result.result.ok).toBe(attempts === 2);
    expect(result.result.attempts[0]?.errorDiagnostics).toEqual({ code, type });
  });

  it.each(["server", "rate-limit"] as const)("never replays %s after partial output", async errorClass => {
    for (const partial of [
      { partialContent: "already visible" },
      { raw: { output: [{ type: "function_call", call_id: "call", name: "file_write", arguments: "{}" }] } }
    ]) {
      const result = await runFailure({ ok: false, provider: "probe", model: "test", content: "failed", errorClass, ...partial });
      expect(result.calls).toBe(1);
      expect(result.result.ok).toBe(false);
    }
  });

  it("retains only bounded diagnostic fields, never arbitrary error messages or credentials", () => {
    expect(providerErrorDiagnostics({ code: "server_error", type: "server_error", httpStatus: 503, requestId: "req_test-123", message: "Bearer private", authorization: "secret" }))
      .toEqual({ code: "server_error", type: "server_error", httpStatus: 503, requestId: "req_test-123" });
    expect(providerErrorDiagnostics({ code: "sk_private_secret", type: "Bearer private", requestId: "Bearer private", httpStatus: 999, raw: { secret: true } })).toBeUndefined();
  });
});

async function runFailure(failure: ProviderResponse) {
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register({ id: "probe", name: "Offline probe", executable: true, health: () => ({ available: true }), listModels: () => [],
    complete: async () => ++calls === 1 ? failure : { ok: true, provider: "probe", model: "test", content: "Recovered" } });
  const result = await new ProviderExecutor({ registry, readOnlyCredentials: true, retrySleep: async () => true }).complete({ messages: [] }, {}, {
    primaryRoute: { provider: "probe", id: "test", authMethod: "none", profile: { provider: "probe", id: "test", contextWindowTokens: 128000, supportsTools: true, supportsVision: false, supportsStructuredOutput: true } },
    retryTransientFailures: true, retryRateLimits: true
  });
  return { calls, result };
}
