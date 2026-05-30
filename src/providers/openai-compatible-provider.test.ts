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
