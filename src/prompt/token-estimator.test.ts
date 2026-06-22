import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  estimateMessageTokensRough,
  estimateMessagesTokensRough,
  estimateTextTokensRough,
  IMAGE_TOKEN_ESTIMATE,
  MESSAGE_FRAMING_TOKEN_ESTIMATE
} from "./token-estimator.js";

describe("rough token estimator", () => {
  it("estimates plain text by chars per token", () => {
    expect(estimateTextTokensRough("abcd")).toBe(1);
    expect(estimateTextTokensRough("abcde")).toBe(2);
  });

  it("adds framing overhead per message", () => {
    expect(estimateMessageTokensRough({ role: "user", content: "abcd" })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + 1);
  });

  it("sums multiple messages deterministically", () => {
    const messages = [
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" }
    ];
    expect(estimateMessagesTokensRough(messages)).toBe(estimateMessagesTokensRough(messages));
    expect(estimateMessagesTokensRough(messages)).toBe(
      estimateMessageTokensRough(messages[0]!) + estimateMessageTokensRough(messages[1]!)
    );
  });

  it("counts text parts in addition to string content", () => {
    expect(estimateMessageTokensRough({
      role: "user",
      content: "abcd",
      parts: [{ type: "text", text: "abcdefgh" }]
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + 3);
  });

  it("counts image parts with a fixed estimate", () => {
    expect(estimateMessageTokensRough({
      role: "user",
      content: "",
      parts: [{ type: "image_url" }, { type: "input_image" }, { type: "image" }]
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + IMAGE_TOKEN_ESTIMATE * 3);
  });

  it("counts image-like metadata", () => {
    expect(estimateMessageTokensRough({
      role: "user",
      content: "",
      metadata: {
        imageCount: 2,
        nested: {
          image_urls: ["one", "two"]
        }
      }
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + IMAGE_TOKEN_ESTIMATE * 4);
  });

  it("counts ready image attachments in persisted metadata", () => {
    expect(estimateMessageTokensRough({
      role: "user",
      content: "",
      metadata: {
        attachments: [
          { kind: "image", status: "ready" },
          { kind: "image" },
          { kind: "file", status: "ready", mimeType: "image/png" }
        ]
      }
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + IMAGE_TOKEN_ESTIMATE * 3);
  });

  it("does not count failed, unsupported, or non-image attachment metadata", () => {
    expect(estimateMessageTokensRough({
      role: "user",
      content: "",
      metadata: {
        attachments: [
          { kind: "image", status: "download-failed" },
          { kind: "image", status: "unsupported" },
          { kind: "document", status: "ready", mimeType: "application/pdf" },
          { kind: "file", url: "https://example.test/image.png" }
        ]
      }
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE);
  });

  it("handles empty messages with framing overhead only", () => {
    expect(estimateMessageTokensRough({ role: "assistant", content: "" })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE);
  });

  it("counts assistant tool call IDs, names, and arguments", () => {
    const content = "Calling tool";
    const id = "call-1";
    const name = "files.read";
    const argumentsText = "{\"path\":\"src/index.ts\"}";
    expect(estimateMessageTokensRough({
      role: "assistant",
      content,
      toolCalls: [
        {
          id,
          name,
          argumentsText
        }
      ]
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(content.length + id.length + name.length + argumentsText.length));
  });

  it("counts empty assistant messages with structured tool calls", () => {
    const id = "call-empty";
    const name = "files.read";
    const argumentsText = "{}";
    expect(estimateMessageTokensRough({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          name,
          argumentsText
        }
      ]
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(id.length + name.length + argumentsText.length));
  });

  it("counts tool result content and toolCallId", () => {
    const content = "tool result";
    const toolCallId = "call-1";
    expect(estimateMessageTokensRough({
      role: "tool",
      content,
      toolCallId
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(content.length + toolCallId.length));
  });

  it("counts provider replay echo only in the valid assistant tool-call location", () => {
    const echo = {
      field: "reasoning_content" as const,
      value: "private provider reasoning",
      providerFamily: "deepseek" as const,
      apiMode: "openai_chat_completions" as const,
      chars: "private provider reasoning".length
    };
    const toolCall = {
      id: "call-1",
      name: "files.read",
      argumentsText: "{}"
    };
    const baseChars = toolCall.id.length + toolCall.name.length + toolCall.argumentsText.length;

    expect(estimateMessageTokensRough({
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      providerReplayEcho: echo
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(baseChars + echo.value.length));
    expect(estimateMessageTokensRough({
      role: "assistant",
      content: "",
      providerReplayEcho: echo
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE);
    expect(estimateMessageTokensRough({
      role: "user",
      content: "",
      toolCalls: [toolCall],
      providerReplayEcho: echo
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE);
  });

  it("counts protocol placeholder replay echo as one character", () => {
    const placeholderEcho = {
      field: "reasoning_content" as const,
      value: " ",
      providerFamily: "kimi" as const,
      apiMode: "openai_chat_completions" as const,
      chars: 1,
      provenance: "protocol-placeholder" as const
    };
    const invalidPlaceholderEcho = {
      ...placeholderEcho,
      value: "not blank",
      chars: "not blank".length
    };
    const toolCall = {
      id: "call-1",
      name: "files.read",
      argumentsText: "{}"
    };
    const baseChars = toolCall.id.length + toolCall.name.length + toolCall.argumentsText.length;

    expect(estimateMessageTokensRough({
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      providerReplayEcho: placeholderEcho
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(baseChars + 1));
    expect(estimateMessageTokensRough({
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      providerReplayEcho: invalidPlaceholderEcho
    })).toBe(MESSAGE_FRAMING_TOKEN_ESTIMATE + estimateChars(baseChars));
  });

  it("ignores raw reasoning and runtime-only provider fields", () => {
    const unsafeMessage = {
      role: "assistant",
      content: "Visible",
      reasoning: "raw reasoning should not count",
      reasoning_content: "raw reasoning_content should not count",
      reasoningMetadata: { present: true, chars: 1_000, format: "reasoning_content" },
      metadata: { nested: "metadata should not count" },
      usage: { totalTokens: 10_000 },
      finishReason: "length",
      raw: { payload: "raw provider payload should not count" },
      runtimeMetadata: { note: "runtime metadata should not count" }
    };

    expect(estimateMessageTokensRough(unsafeMessage)).toBe(estimateMessageTokensRough({
      role: "assistant",
      content: "Visible"
    }));
  });
});

function estimateChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
