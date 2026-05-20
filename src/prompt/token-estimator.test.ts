import { describe, expect, it } from "vitest";
import {
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
});
