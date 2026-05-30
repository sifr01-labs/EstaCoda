import { describe, expect, it } from "vitest";
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
});

describe("createOpenAICompatibleProvider streaming", () => {
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

  it("surfaces transport done when DONE is the only terminal signal after visible text", async () => {
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
      expect.objectContaining({ kind: "transport-done" })
    ]));
    expect(events.some((event) => event.kind === "done")).toBe(false);
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
