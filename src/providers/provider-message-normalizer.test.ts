import { describe, expect, it } from "vitest";
import type { ProviderMessage } from "../contracts/provider.js";
import { normalizeProviderMessagesStrict, sanitizeProviderBoundMessage } from "./provider-message-normalizer.js";

describe("sanitizeProviderBoundMessage", () => {
  it("strips raw reasoning and internal provider-loop fields", () => {
    const sanitized = sanitizeProviderBoundMessage({
      role: "assistant",
      content: "<think>hidden</think>Visible",
      reasoning: "raw reasoning",
      reasoning_content: "raw reasoning content",
      reasoning_details: [{ text: "raw reasoning details" }],
      reasoningMetadata: { present: true, chars: 12, format: "reasoning_content" },
      metadata: { session: "internal" },
      finishReason: "stop",
      finish_reason: "stop",
      runtimeMetadata: { reasoning: { present: true, chars: 12, format: "reasoning" } },
      safeProviderField: "keep"
    } as ProviderMessage & Record<string, unknown>) as ProviderMessage & Record<string, unknown>;

    expect(sanitized).toMatchObject({
      role: "assistant",
      content: "Visible",
      safeProviderField: "keep"
    });
    expect(sanitized).not.toHaveProperty("reasoning");
    expect(sanitized).not.toHaveProperty("reasoning_content");
    expect(sanitized).not.toHaveProperty("reasoning_details");
    expect(sanitized).not.toHaveProperty("reasoningMetadata");
    expect(sanitized).not.toHaveProperty("metadata");
    expect(sanitized).not.toHaveProperty("finishReason");
    expect(sanitized).not.toHaveProperty("finish_reason");
    expect(sanitized).not.toHaveProperty("runtimeMetadata");
  });

  it("preserves structured tool fields and strips unsafe runtime metadata", () => {
    const sanitized = sanitizeProviderBoundMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "files.read",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }
      ],
      providerReplayEcho: {
        field: "reasoning_content",
        value: "private provider reasoning",
        providerFamily: "deepseek",
        apiMode: "openai_chat_completions",
        chars: "private provider reasoning".length
      },
      reasoning: "raw reasoning",
      reasoning_content: "raw reasoning content",
      reasoningMetadata: { present: true, chars: 12, format: "reasoning_content" },
      usage: { inputTokens: 1 },
      finishReason: "tool_calls",
      runtimeMetadata: { unsafe: true },
      raw: { provider: "payload" }
    } as ProviderMessage & Record<string, unknown>) as ProviderMessage & Record<string, unknown>;

    expect(sanitized).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call-1",
          name: "files.read",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }
      ],
      providerReplayEcho: {
        field: "reasoning_content",
        value: "private provider reasoning",
        providerFamily: "deepseek",
        apiMode: "openai_chat_completions",
        chars: "private provider reasoning".length
      }
    });
    expect(sanitized).not.toHaveProperty("reasoning");
    expect(sanitized).not.toHaveProperty("reasoning_content");
    expect(sanitized).not.toHaveProperty("reasoningMetadata");
    expect(sanitized).not.toHaveProperty("usage");
    expect(sanitized).not.toHaveProperty("finishReason");
    expect(sanitized).not.toHaveProperty("runtimeMetadata");
    expect(sanitized).not.toHaveProperty("raw");
  });

  it("preserves valid provider replay echo provenance", () => {
    const oldEcho = {
      field: "reasoning_content",
      value: "old provider reasoning",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: "old provider reasoning".length
    };
    const providerEcho = {
      ...oldEcho,
      value: "new provider reasoning",
      chars: "new provider reasoning".length,
      provenance: "provider"
    };
    const placeholderEcho = {
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    };

    for (const providerReplayEcho of [oldEcho, providerEcho, placeholderEcho]) {
      const sanitized = sanitizeProviderBoundMessage({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "files.read", argumentsText: "{}" }],
        providerReplayEcho
      } as ProviderMessage) as ProviderMessage;

      expect(sanitized.providerReplayEcho).toEqual(providerReplayEcho);
    }
  });

  it("drops invalid provider replay echo provenance", () => {
    const invalidEchoes = [
      {
        field: "reasoning_content",
        value: "not blank",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: "not blank".length,
        provenance: "protocol-placeholder"
      },
      {
        field: "reasoning_content",
        value: " ",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: 2,
        provenance: "protocol-placeholder"
      },
      {
        field: "reasoning_content",
        value: "old provider reasoning",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: "old provider reasoning".length,
        provenance: "historical"
      }
    ];

    for (const providerReplayEcho of invalidEchoes) {
      const sanitized = sanitizeProviderBoundMessage({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "files.read", argumentsText: "{}" }],
        providerReplayEcho
      } as ProviderMessage) as ProviderMessage;

      expect(sanitized).not.toHaveProperty("providerReplayEcho");
    }
  });

  it("strips provider replay echo outside assistant messages with tool calls", () => {
    const providerReplayEcho = {
      field: "reasoning_content",
      value: "private provider reasoning",
      providerFamily: "deepseek",
      apiMode: "openai_chat_completions",
      chars: "private provider reasoning".length
    };
    const messages = [
      { role: "system", content: "system", providerReplayEcho },
      { role: "user", content: "user", providerReplayEcho },
      { role: "assistant", content: "assistant", providerReplayEcho },
      { role: "tool", content: "tool", toolCallId: "call-1", providerReplayEcho }
    ] as Array<ProviderMessage & Record<string, unknown>>;

    for (const message of messages) {
      expect(sanitizeProviderBoundMessage(message)).not.toHaveProperty("providerReplayEcho");
    }
  });

  it("preserves toolCallId only on tool messages", () => {
    expect(sanitizeProviderBoundMessage({
      role: "tool",
      content: "tool result",
      toolCallId: "call-1"
    })).toMatchObject({
      role: "tool",
      content: "tool result",
      toolCallId: "call-1"
    });
    expect(sanitizeProviderBoundMessage({
      role: "assistant",
      content: "not a tool",
      toolCallId: "call-1"
    } as ProviderMessage)).not.toHaveProperty("toolCallId");
  });

  it("strips unsafe fields from structured content without dropping unknown safe fields", () => {
    const sanitized = sanitizeProviderBoundMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "A <thinking>hidden</thinking>B",
          reasoning_content: "raw part reasoning",
          providerNative: true
        },
        {
          type: "reasoning",
          text: "raw reasoning part"
        },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
          reasoningMetadata: { present: true, chars: 1, format: "reasoning" },
          providerNative: "image"
        }
      ]
    } as ProviderMessage) as ProviderMessage;

    expect(sanitized.content).toEqual([
      {
        type: "text",
        text: "A B",
        providerNative: true
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
        providerNative: "image"
      }
    ]);
  });

  it("strips unclosed hidden reasoning blocks while preserving visible text", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "assistant",
        content: "Visible <reasoning>hidden forever"
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: "Visible"
      }
    ]);
  });

  it("does not over-strip ordinary prose mentioning reasoning tags", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "user",
        content: "Use <think> as the example tag"
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "user",
        content: "Use <think> as the example tag"
      }
    ]);
  });

  it("allows empty assistant content when tool calls exist", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      }
    ]);
  });

  it("does not merge assistant messages with tool calls", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      },
      {
        role: "assistant",
        content: "Visible follow-up"
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      },
      {
        role: "assistant",
        content: "Visible follow-up"
      }
    ]);
    expect(normalized.repairs).not.toContain("merged-adjacent-assistant-messages");
  });

  it("preserves native tool messages without merging them", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      },
      {
        role: "tool",
        content: "first result",
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: "second result",
        toolCallId: "call-1"
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{}"
          }
        ]
      },
      {
        role: "tool",
        content: "first result",
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: "second result",
        toolCallId: "call-1"
      }
    ]);
    expect(normalized.repairs).not.toContain("merged-adjacent-tool-messages");
  });

  it("converts orphan tool messages safely instead of making them native results", () => {
    const normalized = normalizeProviderMessagesStrict([
      {
        role: "assistant",
        content: "Plain assistant"
      },
      {
        role: "tool",
        content: "orphan result",
        toolCallId: "call-orphan"
      }
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: "Plain assistant"
      },
      {
        role: "user",
        content: "Tool result received without a preceding assistant tool call:\norphan result"
      }
    ]);
    expect(normalized.repairs).toContain("converted-invalid-tool-to-user-message");
  });
});
