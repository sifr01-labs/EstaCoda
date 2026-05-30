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
    expect(sanitized).not.toHaveProperty("finishReason");
    expect(sanitized).not.toHaveProperty("finish_reason");
    expect(sanitized).not.toHaveProperty("runtimeMetadata");
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
});
