import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STALE_TIMEOUT_MS
} from "../contracts/provider.js";
import {
  buildOpenAICompatibleRequest,
  createOpenAICompatibleProvider,
  parseOpenAICompatibleResponse
} from "./openai-compatible-provider.js";
import type { ProviderEndpoint, ProviderStreamEvent } from "../contracts/provider.js";

const DEFAULT_ENDPOINT: ProviderEndpoint = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: { kind: "env", name: "OPENAI_API_KEY" }
};

describe("createOpenAICompatibleProvider health", () => {
  it("checks the adapter default endpoint when no override is passed", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { kind: "env", name: "MISSING_KEY" }
      }
    });

    const health = await provider.health();
    expect(health.available).toBe(false);
    expect(health.reason).toContain("MISSING_KEY");
  });

  it("checks the effective endpoint when an override is passed", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { kind: "env", name: "MISSING_KEY" }
      }
    });

    const overrideEndpoint: ProviderEndpoint = {
      baseUrl: "https://custom.example.com/v1",
      apiKey: { kind: "env", name: "CUSTOM_KEY" }
    };

    const health = await provider.health(overrideEndpoint);
    expect(health.available).toBe(false);
    expect(health.reason).toContain("CUSTOM_KEY");
    expect(health.reason).not.toContain("MISSING_KEY");
  });

  it("returns available when the override endpoint has no env key requirement", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { kind: "env", name: "MISSING_KEY" }
      }
    });

    const overrideEndpoint: ProviderEndpoint = {
      baseUrl: "https://custom.example.com/v1",
      apiKey: { kind: "none" }
    };

    const health = await provider.health(overrideEndpoint);
    expect(health.available).toBe(true);
  });
});

describe("createOpenAICompatibleProvider timeout classification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies local request timeout as timeout", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 10,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    });
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
  });

  it("keeps real fetch rejection classified as network", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        throw new Error("Connection refused");
      }
    });

    const response = await provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    });

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("network");
  });

  it("uses the default stale timeout before response headers", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_STALE_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("No response from provider for 2 minutes.");
  });

  it("uses the default total timeout when stale timeout is longer", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }, { staleTimeoutMs: DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS + 1_000 });
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("Provider request timed out after 30 minutes.");
  });

  it("lets completion timeout options override adapter defaults", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 1_000,
      staleTimeoutMs: 1_000,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }, { timeoutMs: 10, staleTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("Provider request timed out after 10ms.");
  });

  it("lets completion stale timeout options override adapter defaults", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 1_000,
      staleTimeoutMs: 1_000,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }, { staleTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("No response from provider for 10ms.");
  });

  it("honors adapter-level stale timeout", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 1_000,
      staleTimeoutMs: 10,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    });
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("No response from provider for 10ms.");
  });

  it("disables non-streaming stale timeout after response headers", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 30,
      staleTimeoutMs: 5,
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
        text: async () => "",
        body: null
      })
    });

    const responsePromise = provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    });
    await vi.advanceTimersByTimeAsync(6);
    await vi.advanceTimersByTimeAsync(24);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.errorClass).toBe("timeout");
    expect(response.content).toBe("Provider request timed out after 30ms.");
  });
});

describe("buildOpenAICompatibleRequest", () => {
  it("uses max_completion_tokens for direct OpenAI Chat Completions", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-5",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 1024
    }, undefined, "openai");

    expect(prepared.body.max_completion_tokens).toBe(1024);
    expect(prepared.body).not.toHaveProperty("max_tokens");
  });

  it("uses max_tokens for third-party OpenAI-compatible providers by default", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 1024
    }, undefined, "deepseek");

    expect(prepared.body.max_tokens).toBe(1024);
    expect(prepared.body).not.toHaveProperty("max_completion_tokens");
  });

  it("omits chat token parameters when maxTokens is unset, null, or zero", () => {
    for (const maxTokens of [undefined, null, 0] as const) {
      const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: maxTokens as never
      }, undefined, "openai");

      expect(prepared.body).not.toHaveProperty("max_tokens");
      expect(prepared.body).not.toHaveProperty("max_completion_tokens");
    }
  });

  it("requests usage chunks for streaming OpenAI-compatible chat providers", () => {
    for (const provider of ["openai", "deepseek", "kimi", "google", "openrouter"] as const) {
      const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
        model: "chat-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: true
      }, undefined, provider);

      expect(prepared.body.stream_options).toEqual({ include_usage: true });
    }
  });

  it("does not request streaming usage for non-streaming chat requests", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }]
    }, undefined, "openai");

    expect(prepared.body).not.toHaveProperty("stream_options");
  });

  it("does not request streaming usage for local or custom OpenAI-compatible backends", () => {
    for (const provider of ["local", "custom-corp"] as const) {
      const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
        model: "chat-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: true
      }, undefined, provider as any);

      expect(prepared.body).not.toHaveProperty("stream_options");
    }
  });

  it("serializes assistant native tool calls for tested Chat Completions providers", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "read_file",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }]
      }, {
        role: "tool",
        content: "file contents",
        toolCallId: "call_1"
      }]
    }, undefined, "openai");

    expect(bodyMessages(prepared)[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"src/index.ts\"}"
        }
      }]
    });
  });

  it("serializes matching native tool results", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            name: "read_file",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          }]
        },
        {
          role: "tool",
          content: "file contents",
          toolCallId: "call_1"
        }
      ]
    }, undefined, "openai");

    expect(bodyMessages(prepared)[1]).toEqual({
      role: "tool",
      content: "file contents",
      tool_call_id: "call_1"
    });
  });

  it("serializes assistant content plus native tool calls", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "I'll inspect that.",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }]
      }, {
        role: "tool",
        content: "search result",
        toolCallId: "call_1"
      }]
    }, undefined, "openai");

    expect(bodyMessages(prepared)[0]).toMatchObject({
      role: "assistant",
      content: "I'll inspect that.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "search",
          arguments: "{\"query\":\"native history\"}"
        }
      }]
    });
  });

  it("serializes provider replay echo for matching echo-required providers", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "deepseek-reasoner",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }],
        providerReplayEcho: {
          field: "reasoning_content",
          value: "private replay echo",
          providerFamily: "deepseek",
          apiMode: "openai_chat_completions",
          chars: "private replay echo".length
        }
      }, {
        role: "tool",
        content: "search result",
        toolCallId: "call_1"
      }]
    }, undefined, "deepseek");

    expect(bodyMessages(prepared)[0]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "private replay echo",
      tool_calls: [expect.objectContaining({ id: "call_1" })]
    });
  });

  it("serializes Kimi provider replay echo for matching echo-required routes", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "kimi-k2-thinking",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }],
        providerReplayEcho: {
          field: "reasoning_content",
          value: "kimi private replay echo",
          providerFamily: "kimi",
          apiMode: "openai_chat_completions",
          chars: "kimi private replay echo".length
        }
      }, {
        role: "tool",
        content: "search result",
        toolCallId: "call_1"
      }]
    }, undefined, "kimi");

    expect(bodyMessages(prepared)[0]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "kimi private replay echo",
      tool_calls: [expect.objectContaining({ id: "call_1" })]
    });
  });

  it("fails closed for echo-required providers when replay echo is missing", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "deepseek-reasoner",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            name: "search",
            argumentsText: "{\"query\":\"native history\"}"
          }]
        },
        {
          role: "tool",
          content: "search result",
          toolCallId: "call_1"
        }
      ]
    }, undefined, "deepseek");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("tool_call_id");
    expect(serialized).not.toContain("reasoning_content");
    expect(serialized).not.toContain("\"reasoning_content\":\" \"");
    expect(bodyMessages(prepared)[0]).toEqual({
      role: "assistant",
      content: "[Native tool-call history unavailable]"
    });
    expect(bodyMessages(prepared)[1]).toEqual({
      role: "user",
      content: "Tool result received without serialized assistant tool call:\nsearch result"
    });
  });

  it("fails closed for cross-provider echo on echo-required providers", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "deepseek-reasoner",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }],
        providerReplayEcho: {
          field: "reasoning_content",
          value: "kimi private replay echo",
          providerFamily: "kimi",
          apiMode: "openai_chat_completions",
          chars: "kimi private replay echo".length
        }
      }]
    }, undefined, "deepseek");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("reasoning_content");
    expect(serialized).not.toContain("kimi private replay echo");
  });

  it("strips cross-provider echo for providers that do not require echo", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }],
        providerReplayEcho: {
          field: "reasoning_content",
          value: "private replay echo",
          providerFamily: "kimi",
          apiMode: "openai_chat_completions",
          chars: "private replay echo".length
        }
      }, {
        role: "tool",
        content: "search result",
        toolCallId: "call_1"
      }]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(bodyMessages(prepared)[0]).toHaveProperty("tool_calls");
    expect(serialized).not.toContain("reasoning_content");
    expect(serialized).not.toContain("private replay echo");
  });

  it("serializes complete multi-call native tool groups atomically", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_a",
              name: "search",
              argumentsText: "{\"query\":\"a\"}"
            },
            {
              id: "call_b",
              name: "read_file",
              argumentsText: "{\"path\":\"b.ts\"}"
            }
          ]
        },
        {
          role: "tool",
          content: "result a",
          toolCallId: "call_a"
        },
        {
          role: "tool",
          content: "result b",
          toolCallId: "call_b"
        }
      ]
    }, undefined, "openai");

    expect(bodyMessages(prepared)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: null,
        tool_calls: [
          expect.objectContaining({ id: "call_a" }),
          expect.objectContaining({ id: "call_b" })
        ]
      }),
      {
        role: "tool",
        content: "result a",
        tool_call_id: "call_a"
      },
      {
        role: "tool",
        content: "result b",
        tool_call_id: "call_b"
      }
    ]);
  });

  it("fails closed for multi-call native tool groups with a missing result", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_a",
              name: "search",
              argumentsText: "{\"query\":\"a\"}"
            },
            {
              id: "call_b",
              name: "read_file",
              argumentsText: "{\"path\":\"b.ts\"}"
            }
          ]
        },
        {
          role: "tool",
          content: "result a",
          toolCallId: "call_a"
        },
        {
          role: "user",
          content: "next turn"
        }
      ]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("tool_call_id");
    expect(bodyMessages(prepared)).toEqual([
      {
        role: "assistant",
        content: "[Native tool-call history unavailable]"
      },
      {
        role: "user",
        content: "Tool result received without serialized assistant tool call:\nresult a"
      },
      {
        role: "user",
        content: "next turn"
      }
    ]);
  });

  it("fails closed for single-call native tool groups with a missing result", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "search",
          argumentsText: "{\"query\":\"native history\"}"
        }]
      }]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(bodyMessages(prepared)[0]).toEqual({
      role: "assistant",
      content: "[Native tool-call history unavailable]"
    });
  });

  it("fails closed for malformed matching tool results", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            name: "search",
            argumentsText: "{\"query\":\"native history\"}"
          }]
        },
        {
          role: "tool",
          content: "search result",
          toolCallId: ""
        } as any
      ]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("tool_call_id");
  });

  it("fails closed without leaking echo when echo-required multi-call groups are incomplete", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "deepseek-reasoner",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_a",
              name: "search",
              argumentsText: "{\"query\":\"a\"}"
            },
            {
              id: "call_b",
              name: "read_file",
              argumentsText: "{\"path\":\"b.ts\"}"
            }
          ],
          providerReplayEcho: {
            field: "reasoning_content",
            value: "private replay echo",
            providerFamily: "deepseek",
            apiMode: "openai_chat_completions",
            chars: "private replay echo".length
          }
        },
        {
          role: "tool",
          content: "result a",
          toolCallId: "call_a"
        }
      ]
    }, undefined, "deepseek");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("tool_call_id");
    expect(serialized).not.toContain("reasoning_content");
    expect(serialized).not.toContain("private replay echo");
  });

  it("fails closed for malformed native tool call messages", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "I will call a tool.",
        toolCalls: [{
          id: "call_1",
          name: "search"
        }]
      } as any]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(bodyMessages(prepared)[0]).toEqual({
      role: "assistant",
      content: "I will call a tool."
    });
  });

  it("does not leak raw reasoning fields into Chat Completions request messages", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: "Visible answer",
        reasoning: "raw hidden reasoning",
        reasoning_content: "raw reasoning content",
        reasoningMetadata: {
          present: true,
          chars: 20,
          format: "reasoning_content"
        },
        raw: {
          providerPayload: "raw provider payload"
        },
        usage: {
          inputTokens: 1
        }
      } as any]
    }, undefined, "openai");

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).toContain("Visible answer");
    expect(serialized).not.toContain("raw hidden reasoning");
    expect(serialized).not.toContain("raw reasoning content");
    expect(serialized).not.toContain("raw provider payload");
    expect(serialized).not.toContain("reasoningMetadata");
    expect(serialized).not.toContain("usage");
  });

  it("keeps Responses-mode providers on non-native fallback", () => {
    const prepared = buildOpenAICompatibleRequest(DEFAULT_ENDPOINT, {
      model: "codex-test",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            name: "search",
            argumentsText: "{\"query\":\"native history\"}"
          }]
        },
        {
          role: "tool",
          content: "search result",
          toolCallId: "call_1"
        }
      ]
    }, undefined, "codex" as any);

    const serialized = JSON.stringify(prepared.body);
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("tool_call_id");
    expect(bodyMessages(prepared).map((message) => message.role)).toEqual(["assistant", "user"]);
  });
});

function bodyMessages(prepared: ReturnType<typeof buildOpenAICompatibleRequest>): any[] {
  return prepared.body.messages as any[];
}

describe("createOpenAICompatibleProvider streaming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends stream options that request final usage chunks", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
          ])
        };
      }
    });

    await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.stream_options).toEqual({ include_usage: true });
  });

  it("classifies streaming stale timeout before the first byte", async () => {
    vi.useFakeTimers();
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 100,
      staleTimeoutMs: 10,
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: abortAwareStream(init.signal)
      })
    });

    const eventsPromise = collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);
    await vi.advanceTimersByTimeAsync(10);
    const events = await eventsPromise;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "start" }),
      expect.objectContaining({
        kind: "error",
        response: expect.objectContaining({
          errorClass: "timeout",
          content: "No response from provider for 10ms."
        })
      })
    ]));
  });

  it("resets streaming stale timeout after received bytes", async () => {
    vi.useFakeTimers();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      timeoutMs: 100,
      staleTimeoutMs: 10,
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
          }
        })
      })
    });
    const encoder = new TextEncoder();

    const eventsPromise = collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);
    await vi.advanceTimersByTimeAsync(0);
    streamController?.enqueue(encoder.encode(sseData({ choices: [{ delta: { content: "A" }, finish_reason: null }] })));
    await vi.advanceTimersByTimeAsync(8);
    streamController?.enqueue(encoder.encode(sseData({ choices: [{ delta: { content: "B" }, finish_reason: null }] })));
    await vi.advanceTimersByTimeAsync(8);
    await vi.advanceTimersByTimeAsync(2);
    const events = await eventsPromise;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "A" }),
      expect.objectContaining({ kind: "token", text: "B" }),
      expect.objectContaining({
        kind: "error",
        response: expect.objectContaining({
          errorClass: "timeout",
          content: "No response from provider for 10ms."
        })
      })
    ]));
  });

  it("finalizes on finish_reason without usage", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          sseData({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "done")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "Hello" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "Hello",
          finishReason: "stop",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6
          }
        })
      })
    ]));
  });

  it("usage-only chunk with transport-done triggers non-streaming fallback", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({}),
            text: async () => "",
            body: sseStream([
              sseData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
              "data: [DONE]\n\n"
            ])
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fallback ok" }
              }
            ]
          }),
          text: async () => "",
          body: null
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.stream).toBe(true);
    expect(requestBodies[1]?.stream).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "fallback ok" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "fallback ok",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        })
      })
    ]));
  });

  it("usage-only chunk without transport-done leaves stream incomplete", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toEqual([
      expect.objectContaining({ kind: "start" })
    ]);
  });

  it("visible tokens followed by usage-only chunk returns content with usage", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
            sseData({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "Hello" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "Hello",
          usage: {
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5
          }
        })
      })
    ]));
  });

  it("finalizes transport-only visible text with unknown finish reason", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { content: "Partial" }, finish_reason: null }] }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "Partial" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "Partial",
          finishReason: "unknown"
        })
      })
    ]));
    expect(events.some((event) => event.kind === "transport-done")).toBe(false);
  });

  it("skips null DeepSeek-style stream delta fields without dropping chunks", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "deepseek" as any,
      endpoint: { baseUrl: "https://api.deepseek.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: null, reasoning_content: null, content: null }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: null }, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "deepseek" as any,
      model: "deepseek-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "Visible" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "Visible",
          finishReason: "stop"
        })
      })
    ]));
  });

  it("visible tokens followed by finish_reason and usage preserves usage", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { content: "Done" }, finish_reason: null }] }),
          sseData({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
          }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "Done" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "Done",
          finishReason: "stop",
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            totalTokens: 7
          }
        })
      })
    ]));
  });

  it("tool-call stream followed by usage and terminal tool_calls finish preserves tool call", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
          text: async () => "",
          body: sseStream([
            sseData({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "test.tool",
                      arguments: "{\"path\":\"README.md\"}"
                    }
                  }]
                },
                finish_reason: null
              }]
            }),
            sseData({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }),
            sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool-call",
        id: "call-1",
        name: "test.tool",
        argumentsText: "{\"path\":\"README.md\"}"
      }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "",
          finishReason: "tool_calls",
          usage: {
            inputTokens: 9,
            outputTokens: 3,
            totalTokens: 12
          }
        })
      })
    ]));
  });

  it("reasoning-only stream followed by usage-only chunk preserves reasoning and usage", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] }),
            sseData({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "",
          reasoning: "hidden",
          reasoningMetadata: {
            present: true,
            chars: "hidden".length,
            format: "reasoning_content"
          },
          usage: {
            inputTokens: 7,
            outputTokens: 4,
            totalTokens: 11
          }
        })
      })
    ]));
  });

  it("finish-reason-only empty stream triggers fallback", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({}),
            text: async () => "",
            body: sseStream([
              sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
              "data: [DONE]\n\n"
            ])
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fallback after empty finish" }
              }
            ]
          }),
          text: async () => "",
          body: null
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.stream).toBe(true);
    expect(requestBodies[1]?.stream).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", text: "fallback after empty finish" }),
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "fallback after empty finish"
        })
      })
    ]));
  });

  it("empty content_filter finish does not fallback", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fallback should not run" }
              }
            ]
          }),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: {}, finish_reason: "content_filter" }] }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "",
          finishReason: "content_filter"
        })
      })
    ]));
  });

  it("empty length finish does not fallback", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fallback should not run" }
              }
            ]
          }),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: {}, finish_reason: "length" }] }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "done",
        response: expect.objectContaining({
          content: "",
          finishReason: "length"
        })
      })
    ]));
  });

  it("does not fallback or finalize empty abrupt streams", async () => {
    let fallbackJsonCalled = false;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          fallbackJsonCalled = true;
          return {
            choices: [
              {
                finish_reason: "stop",
                message: { content: "fallback should not run" }
              }
            ]
          };
        },
        text: async () => "",
        body: sseStream([])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fallbackJsonCalled).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ kind: "start" })
    ]);
  });

  it("extracts reasoning deltas without emitting them as visible tokens", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning_content: "hidden chain" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "token")).toEqual([
      expect.objectContaining({ text: "Visible" })
    ]);
    expect(JSON.stringify(events.filter((event) => event.kind === "token"))).not.toContain("hidden chain");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible",
        reasoning: "hidden chain",
        reasoningMetadata: {
          present: true,
          chars: "hidden chain".length,
          format: "reasoning_content"
        }
      })
    }));
  });

  it("extracts streamed reasoning fields and inline hidden blocks from visible deltas", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: "delta hidden" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "A <thi" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "nk>inline hidden</think>B" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "token")).toEqual([
      expect.objectContaining({ text: "A " }),
      expect.objectContaining({ text: "B" })
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "A B",
        reasoning: "delta hidden\n\ninline hidden",
        reasoningMetadata: {
          present: true,
          chars: "delta hidden\n\ninline hidden".length,
          format: "mixed"
        }
      })
    }));
  });

  it("preserves streamed reasoning source format in safe metadata", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: "hidden reasoning" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        reasoning: "hidden reasoning",
        reasoningMetadata: {
          present: true,
          chars: "hidden reasoning".length,
          format: "reasoning"
        }
      })
    }));
  });

  it("preserves transport-only streamed reasoning fields through unknown finalization", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: "transport hidden" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "token")).toEqual([
      expect.objectContaining({ text: "Visible" })
    ]);
    expect(JSON.stringify(events.filter((event) => event.kind === "token"))).not.toContain("transport hidden");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible",
        finishReason: "unknown",
        reasoning: "transport hidden",
        reasoningMetadata: {
          present: true,
          chars: "transport hidden".length,
          format: "reasoning"
        }
      })
    }));
  });

  it("preserves transport-only hidden-reasoning-only streams without non-stream fallback", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            choices: [
              {
                message: {
                  content: "fallback should not run"
                }
              }
            ]
          }),
          text: async () => "",
          body: sseStream([
            sseData({ choices: [{ delta: { reasoning: "transport hidden only" }, finish_reason: null }] }),
            "data: [DONE]\n\n"
          ])
        };
      }
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(fetchCalls).toBe(1);
    expect(events.filter((event) => event.kind === "token")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "",
        finishReason: "unknown",
        reasoning: "transport hidden only",
        reasoningMetadata: {
          present: true,
          chars: "transport hidden only".length,
          format: "reasoning"
        }
      })
    }));
    expect(JSON.stringify(events)).not.toContain("fallback should not run");
  });

  it("preserves transport-only streamed reasoning_content through unknown finalization", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning_content: "transport hidden" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible",
        finishReason: "unknown",
        reasoning: "transport hidden",
        reasoningMetadata: {
          present: true,
          chars: "transport hidden".length,
          format: "reasoning_content"
        }
      })
    }));
  });

  it("preserves transport-only inline hidden reasoning through unknown finalization", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { content: "Visible <think>transport hidden</think>" }, finish_reason: null }] }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "token")).toEqual([
      expect.objectContaining({ text: "Visible " })
    ]);
    expect(JSON.stringify(events.filter((event) => event.kind === "token"))).not.toContain("transport hidden");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible ",
        finishReason: "unknown",
        reasoning: "transport hidden",
        reasoningMetadata: {
          present: true,
          chars: "transport hidden".length,
          format: "think_block"
        }
      })
    }));
  });

  it("marks transport-only mixed reasoning sources as mixed", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: "delta hidden" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible <think>inline hidden</think>" }, finish_reason: null }] }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible ",
        finishReason: "unknown",
        reasoning: "delta hidden\n\ninline hidden",
        reasoningMetadata: {
          present: true,
          chars: "delta hidden\n\ninline hidden".length,
          format: "mixed"
        }
      })
    }));
  });

  it("keeps transport-only tool fragments unsafe without explicit finish metadata", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-1",
                  function: { name: "test.tool", arguments: "{\"x\":" }
                }]
              },
              finish_reason: null
            }]
          }),
          "data: [DONE]\n\n"
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.some((event) => event.kind === "done")).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool-call", id: "call-1" }),
      expect.objectContaining({ kind: "transport-done" })
    ]));
  });

  it("marks streamed reasoning metadata as mixed when delta formats differ", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { reasoning: "first" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { reasoning_content: "second" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: { content: "Visible" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        reasoning: "first\n\nsecond",
        reasoningMetadata: {
          present: true,
          chars: "first\n\nsecond".length,
          format: "mixed"
        }
      })
    }));
  });

  it("does not flush unclosed streamed hidden blocks into visible output", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai" as any,
      endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: { kind: "none" } },
      enableNetwork: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
        text: async () => "",
        body: sseStream([
          sseData({ choices: [{ delta: { content: "Visible <reasoning>hidden forever" }, finish_reason: null }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "stop" }] })
        ])
      })
    });

    const events = await collectStreamEvents(provider.stream?.({
      provider: "openai" as any,
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }]
    }) ?? []);

    expect(events.filter((event) => event.kind === "token")).toEqual([
      expect.objectContaining({ text: "Visible " })
    ]);
    expect(JSON.stringify(events.filter((event) => event.kind === "token"))).not.toContain("hidden forever");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "done",
      response: expect.objectContaining({
        content: "Visible ",
        reasoning: "hidden forever"
      })
    }));
  });
});

describe("parseOpenAICompatibleResponse", () => {
  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["tool_calls", "tool_calls"],
    ["function_call", "tool_calls"],
    ["content_filter", "content_filter"],
    ["unexpected", "unknown"],
    [undefined, "unknown"]
  ] as const)("maps finish_reason %s to %s", (finishReason, expected) => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: finishReason,
            message: {
              content: "Done"
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.finishReason).toBe(expected);
  });

  it("maps token usage including reasoning tokens", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Done"
            }
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          completion_tokens_details: {
            reasoning_tokens: 3
          }
        }
      }
    });

    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 3
    });
  });

  it("extracts reasoning_content into turn-local response reasoning", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Visible",
              reasoning_content: "hidden chain"
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.content).toBe("Visible");
    expect(response.reasoning).toBe("hidden chain");
    expect(response.reasoningMetadata).toEqual({
      present: true,
      chars: "hidden chain".length,
      format: "reasoning_content"
    });
  });

  it("treats reasoning-only non-stream responses as provider-successful", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              reasoning_content: "hidden chain"
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.content).toBe("");
    expect(response.reasoning).toBe("hidden chain");
    expect(response.reasoningMetadata).toEqual({
      present: true,
      chars: "hidden chain".length,
      format: "reasoning_content"
    });
  });

  it("extracts reasoning fields into turn-local response reasoning", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Visible",
              reasoning: "hidden reasoning"
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.reasoning).toBe("hidden reasoning");
    expect(response.reasoningMetadata?.format).toBe("reasoning");
  });

  it("keeps reasoning_details metadata-only", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Visible",
              reasoning_details: { provider_specific: "opaque hidden detail" }
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.reasoning).toBeUndefined();
    expect(response.reasoningMetadata).toEqual({
      present: true,
      chars: JSON.stringify({ provider_specific: "opaque hidden detail" }).length,
      format: "reasoning_details"
    });
  });

  it("treats reasoning_details-only responses as provider-successful metadata-only reasoning", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              reasoning_details: { provider_specific: "opaque hidden detail" }
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.content).toBe("");
    expect(response.reasoning).toBeUndefined();
    expect(response.reasoningMetadata?.present).toBe(true);
    expect(response.reasoningMetadata?.format).toBe("reasoning_details");
    expect(response.errorClass).toBeUndefined();
    expect(response.content).not.toContain("Provider response did not include assistant content.");
  });

  it("strips inline think blocks from visible content and extracts reasoning", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Before <think>hidden</think> after"
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.content).toBe("Before  after");
    expect(response.reasoning).toBe("hidden");
    expect(response.reasoningMetadata?.format).toBe("think_block");
  });

  it("extracts content-list reasoning and preserves visible output", () => {
    const response = parseOpenAICompatibleResponse({
      provider: "openai",
      model: "gpt-test",
      payload: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: [
                { type: "thinking", thinking: "hidden thought" },
                { type: "output", text: "Visible" },
                { type: "reasoning", reasoning: "hidden reason" },
                { type: "unknown", reasoning: "do not stringify", text: "do not show" }
              ]
            }
          }
        ]
      }
    });

    expect(response.ok).toBe(true);
    expect(response.content).toBe("Visible");
    expect(response.reasoning).toBe("hidden thought\n\nhidden reason");
    expect(response.reasoningMetadata?.format).toBe("mixed");
    expect(response.content).not.toContain("do not show");
    expect(response.reasoning).not.toContain("do not stringify");
  });
});

async function collectStreamEvents(events: AsyncIterable<ProviderStreamEvent> | Iterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const collected: ProviderStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

function abortAwareStream(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    }
  });
}
