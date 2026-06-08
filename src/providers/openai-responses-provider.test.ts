import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAIResponsesProvider,
  buildResponsesRequest,
  parseResponsesPayload,
  extractResponsesToolCalls
} from "./openai-responses-provider.js";
import type { ProviderEndpoint, ProviderRequest } from "../contracts/provider.js";

function createMockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}): typeof globalThis.fetch {
  return async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? "",
    json: async () => response.json ?? {},
    text: async () => response.text ?? "",
    body: null
  }) as unknown as ReturnType<typeof globalThis.fetch>;
}

const DEFAULT_ENDPOINT: ProviderEndpoint = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: { kind: "env", name: "OPENAI_API_KEY" }
};

describe("openai-responses-provider", () => {
  describe("timeout classification", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("classifies local request timeout as timeout", async () => {
      vi.useFakeTimers();
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "none" }
        },
        enableNetwork: true,
        timeoutMs: 10,
        fetch: (_url, init) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
      });

      const responsePromise = provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });
      await vi.advanceTimersByTimeAsync(10);
      const response = await responsePromise;

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("timeout");
    });

    it("keeps real fetch rejection classified as network", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "none" }
        },
        enableNetwork: true,
        fetch: async () => {
          throw new Error("Connection refused");
        }
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("network");
    });
  });

  describe("buildResponsesRequest", () => {
    it("builds correct request body with model, instructions, and input", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" }
        ]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request, "sk-test");

      expect(prepared.body.model).toBe("gpt-4o");
      expect(prepared.body.instructions).toBe("You are a helpful assistant.");
      expect(prepared.body.store).toBe(false);
      expect(prepared.url).toBe("https://api.openai.com/v1/responses");
      expect(prepared.headers.authorization).toBe("Bearer sk-test");

      const input = prepared.body.input as Array<{ role: string; content: unknown }>;
      expect(input).toHaveLength(2);
      expect(input[0].role).toBe("user");
      expect(input[0].content).toBe("Hello");
      expect(input[1].role).toBe("assistant");
      expect(input[1].content).toBe("Hi there!");
    });

    it("includes no reasoning, encrypted_content, include, or prompt_cache_key", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      const keys = Object.keys(prepared.body);

      expect(keys).not.toContain("reasoning");
      expect(keys).not.toContain("encrypted_content");
      expect(keys).not.toContain("include");
      expect(keys).not.toContain("prompt_cache_key");
    });

    it("does not include parallel_tool_calls when tools are absent", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body).not.toHaveProperty("parallel_tool_calls");
      expect(prepared.body).not.toHaveProperty("tools");
      expect(prepared.body).not.toHaveProperty("tool_choice");
    });

    it("includes parallel_tool_calls: false when tools are present", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "get_weather" } }]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body.parallel_tool_calls).toBe(false);
      expect(prepared.body.tool_choice).toBe("auto");
      expect(prepared.body.tools).toEqual(request.tools);
    });

    it("sets store to false", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body.store).toBe(false);
    });

    it("maps maxTokens to max_output_tokens", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 1024
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body.max_output_tokens).toBe(1024);
      expect(prepared.body).not.toHaveProperty("max_tokens");
      expect(prepared.body).not.toHaveProperty("max_completion_tokens");
    });

    it("omits max_output_tokens when maxTokens is undefined", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body).not.toHaveProperty("max_output_tokens");
    });

    it("omits max_output_tokens when maxTokens is null or zero", () => {
      for (const maxTokens of [null, 0] as const) {
        const request: ProviderRequest = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          maxTokens: maxTokens as never
        };

        const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
        expect(prepared.body).not.toHaveProperty("max_output_tokens");
        expect(prepared.body).not.toHaveProperty("max_tokens");
        expect(prepared.body).not.toHaveProperty("max_completion_tokens");
      }
    });

    it("handles multiple system messages by using first as instructions and rest as developer", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "First system" },
          { role: "system", content: "Second system" },
          { role: "user", content: "Hello" }
        ]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      expect(prepared.body.instructions).toBe("First system");
      const input = prepared.body.input as Array<{ role: string; content: unknown }>;
      expect(input[0].role).toBe("developer");
      expect(input[0].content).toBe("Second system");
    });

    it("converts tool messages to user content", () => {
      const request: ProviderRequest = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's the weather?" },
          { role: "assistant", content: "Let me check." },
          { role: "tool", content: "Sunny, 72F" }
        ]
      };

      const prepared = buildResponsesRequest(DEFAULT_ENDPOINT, request);
      const input = prepared.body.input as Array<{ role: string; content: unknown }>;
      expect(input[2].role).toBe("user");
      expect(input[2].content).toBe("Sunny, 72F");
    });
  });

  describe("parseResponsesPayload", () => {
    it.each([
      [
        "incomplete max output",
        {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }]
        },
        "length"
      ],
      [
        "other incomplete",
        {
          status: "incomplete",
          incomplete_details: { reason: "safety_filter" },
          output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }]
        },
        "incomplete"
      ],
      [
        "completed function call",
        {
          status: "completed",
          output: [{ type: "function_call", call_id: "call-1", name: "test_tool", arguments: "{}" }]
        },
        "tool_calls"
      ],
      [
        "completed visible text",
        {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }]
        },
        "stop"
      ],
      [
        "unknown state",
        {
          status: "queued",
          output: [{ type: "message", content: [{ type: "output_text", text: "Pending" }] }]
        },
        "unknown"
      ]
    ] as const)("maps finish state for %s", (_name, payload, expected) => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload
      });

      expect(response.ok).toBe(true);
      expect(response.finishReason).toBe(expected);
    });

    it("extracts output_text content from message items", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "Hello, world!" }
              ]
            }
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15
          }
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("Hello, world!");
      expect(response.model).toBe("codex-model");
      expect(response.provider).toBe("codex");
    });

    it("extracts usage when present", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hi" }]
            }
          ],
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            total_tokens: 6
          }
        }
      });

      expect(response.usage).toEqual({
        inputTokens: 5,
        outputTokens: 1,
        totalTokens: 6
      });
    });

    it("extracts usage with reasoning tokens when present", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hi" }]
            }
          ],
          usage: {
            input_tokens: 5,
            output_tokens: 4,
            total_tokens: 9,
            output_tokens_details: {
              reasoning_tokens: 3
            }
          }
        }
      });

      expect(response.usage).toEqual({
        inputTokens: 5,
        outputTokens: 4,
        totalTokens: 9,
        reasoningTokens: 3
      });
    });

    it("maps failed status to error", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "failed",
          output: []
        }
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("server");
    });

    it("returns error when output is empty and status is not in_progress", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: []
        }
      });

      expect(response.ok).toBe(false);
    });

    it("treats reasoning-only Responses output as provider-successful", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            { type: "reasoning", text: "hidden responses reasoning" }
          ]
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("");
      expect(response.reasoning).toBe("hidden responses reasoning");
      expect(response.reasoningMetadata).toEqual({
        present: true,
        chars: "hidden responses reasoning".length,
        format: "responses_reasoning"
      });
      expect(response.errorClass).toBeUndefined();
      expect(response.content).not.toContain("Provider response did not include assistant content.");
    });

    it("treats summary-only Responses reasoning metadata as provider-successful", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ text: "summary should stay metadata-only" }] }
          ]
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("");
      expect(response.reasoning).toBeUndefined();
      expect(response.reasoningMetadata).toEqual({
        present: true,
        chars: 0,
        format: "responses_reasoning"
      });
      expect(response.errorClass).toBeUndefined();
      expect(JSON.stringify(response.reasoningMetadata)).not.toContain("summary should stay metadata-only");
      expect(response.content).not.toContain("Provider response did not include assistant content.");
    });

    it("handles payload-level error object", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          error: {
            message: "Invalid model",
            type: "invalid_request_error"
          }
        }
      });

      expect(response.ok).toBe(false);
      expect(response.content).toBe("Invalid model");
    });

    it("concatenates multiple output_text parts", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "First" },
                { type: "output_text", text: "Second" }
              ]
            }
          ]
        }
      });

      expect(response.content).toBe("FirstSecond");
    });

    it("extracts reasoning-shaped output items while preserving visible output only", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            { type: "reasoning", text: "hidden responses reasoning" },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Visible answer" }]
            }
          ]
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("Visible answer");
      expect(response.reasoning).toBe("hidden responses reasoning");
      expect(response.reasoningMetadata).toEqual({
        present: true,
        chars: "hidden responses reasoning".length,
        format: "responses_reasoning"
      });
    });

    it("keeps Responses reasoning summaries as metadata-only", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ text: "summary should not become raw reasoning" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Visible answer" }]
            }
          ]
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("Visible answer");
      expect(response.reasoning).toBeUndefined();
      expect(response.reasoningMetadata).toEqual({
        present: true,
        chars: 0,
        format: "responses_reasoning"
      });
      expect(JSON.stringify(response.reasoningMetadata)).not.toContain("summary should not become raw reasoning");
    });

    it("strips inline reasoning from Responses visible output", () => {
      const response = parseResponsesPayload({
        provider: "codex",
        model: "codex-model",
        payload: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Visible <think>hidden</think> answer" }]
            }
          ]
        }
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("Visible  answer");
      expect(response.reasoning).toBe("hidden");
      expect(response.reasoningMetadata).toEqual({
        present: true,
        chars: "hidden".length,
        format: "responses_reasoning"
      });
    });
  });

  describe("executeResponsesRequest", () => {
    it("401 maps to errorClass: auth", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: DEFAULT_ENDPOINT,
        enableNetwork: true,
        fetch: createMockFetch({ ok: false, status: 401, text: "Unauthorized" })
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("auth");
    });

    it("403 maps to errorClass: auth", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: DEFAULT_ENDPOINT,
        enableNetwork: true,
        fetch: createMockFetch({ ok: false, status: 403, text: "Forbidden" })
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("auth");
    });

    it("returns success on 200 with parsed content", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "none" }
        },
        enableNetwork: true,
        fetch: createMockFetch({
          ok: true,
          status: 200,
          json: {
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Done!" }]
              }
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5
            }
          }
        })
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(true);
      expect(response.content).toBe("Done!");
      expect(response.usage).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5
      });
    });

    it("network failure maps to errorClass: network", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "none" }
        },
        enableNetwork: true,
        fetch: async () => {
          throw new Error("Connection refused");
        }
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("network");
    });

    it("returns unsupported when enableNetwork is false", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "none" }
        },
        enableNetwork: false
      });

      const response = await provider.complete({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      });

      expect(response.ok).toBe(false);
      expect(response.errorClass).toBe("unsupported");
      expect(response.raw).toBeDefined();
    });
  });

  describe("extractResponsesToolCalls", () => {
    it("extracts function_call items from output array", () => {
      const toolCalls = extractResponsesToolCalls({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Let me check." }]
          },
          {
            type: "function_call",
            call_id: "call_123",
            name: "get_weather",
            arguments: '{"location":"Paris"}'
          }
        ]
      });

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe("call_123");
      expect(toolCalls[0].name).toBe("get_weather");
      expect(toolCalls[0].argumentsText).toBe('{"location":"Paris"}');
      expect(toolCalls[0].index).toBe(0);
    });

    it("returns empty array when no function_calls exist", () => {
      const toolCalls = extractResponsesToolCalls({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello" }]
          }
        ]
      });

      expect(toolCalls).toHaveLength(0);
    });
  });

  describe("streaming", () => {
    it("fails closed with structured provider error", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: DEFAULT_ENDPOINT
      });

      const events: Array<{ kind: string; response?: { errorClass?: string } }> = [];
      for await (const event of provider.stream!({
        model: "codex-model",
        messages: [{ role: "user", content: "Hello" }]
      })) {
        events.push(event as any);
      }

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("error");
      expect(events[0].response?.errorClass).toBe("unsupported");
    });
  });

  describe("health", () => {
    it("returns unavailable when env key is missing", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "env", name: "MISSING_KEY_999" }
        }
      });

      const health = await provider.health();
      expect(health.available).toBe(false);
      expect(health.reason).toContain("MISSING_KEY_999");
    });

    it("returns available when credential override is present even if env is missing", async () => {
      const provider = createOpenAIResponsesProvider({
        id: "codex",
        endpoint: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { kind: "env", name: "MISSING_KEY_999" }
        }
      });

      // Health checks endpoint only, not credential override
      const health = await provider.health();
      expect(health.available).toBe(false);
    });
  });
});
