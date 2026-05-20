import { describe, expect, it } from "vitest";
import { IMAGE_TOKEN_ESTIMATE } from "./token-estimator.js";
import { packSessionHistory } from "./history-packer.js";

describe("packSessionHistory", () => {
  it("includes image attachment metadata in estimated history tokens", () => {
    const textOnly = packSessionHistory([
      {
        id: "text",
        sessionId: "session",
        role: "user",
        content: "Please inspect this."
      }
    ], { maxProtectedMessages: 1 });
    const withImage = packSessionHistory([
      {
        id: "image",
        sessionId: "session",
        role: "user",
        content: "Please inspect this.",
        metadata: {
          attachments: [
            { kind: "image", status: "ready" }
          ]
        }
      }
    ], { maxProtectedMessages: 1 });

    expect(withImage.estimatedTokens).toBeGreaterThanOrEqual(textOnly.estimatedTokens + IMAGE_TOKEN_ESTIMATE);
  });

  it("keeps text-only history estimates stable when no image metadata is present", () => {
    const first = packSessionHistory([
      {
        id: "text",
        sessionId: "session",
        role: "user",
        content: "A text-only turn."
      }
    ], { maxProtectedMessages: 1 });
    const second = packSessionHistory([
      {
        id: "text",
        sessionId: "session",
        role: "user",
        content: "A text-only turn."
      }
    ], { maxProtectedMessages: 1 });

    expect(second.estimatedTokens).toBe(first.estimatedTokens);
  });
});
