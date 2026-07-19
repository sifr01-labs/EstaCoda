import { describe, expect, it } from "vitest";
import { IMAGE_TOKEN_ESTIMATE } from "./token-estimator.js";
import { deriveSessionHistoryBudget, packSessionHistory } from "./history-packer.js";

describe("deriveSessionHistoryBudget", () => {
  it("scales history budget with model context window", () => {
    expect(deriveSessionHistoryBudget(128_000)).toBe(15_360);
    expect(deriveSessionHistoryBudget(262_000)).toBe(24_000);
    expect(deriveSessionHistoryBudget(32_000)).toBe(6_000);
    expect(deriveSessionHistoryBudget(undefined)).toBe(15_360);
  });
});

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

  it("preserves the original user question through a high-tool turn when trimming is required", () => {
    const messages = [
      {
        id: "q1",
        sessionId: "s",
        role: "user" as const,
        content: "okay i want you to go and research agent architecture"
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "I will research agent architecture for you."
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `t${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `tool ${index + 1} output `.repeat(500)
      })),
      {
        id: "q2",
        sessionId: "s",
        role: "user" as const,
        content: "but that wasnt my question to you"
      }
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 2_000,
      maxMessageChars: 2_000,
      maxProtectedMessages: 6
    });
    const content = packed.messages.map((message) => message.content).join("\n");
    const toolCount = packed.messages.filter((message) => message.role === "tool").length;

    expect(packed.messages.some((message) => message.role === "system")).toBe(true);
    expect(toolCount).toBeLessThan(9);
    expect(content).toContain("research agent architecture");
  });

  it("evicts tool messages before session summaries when trimming", () => {
    const messages = [
      {
        id: "q1",
        sessionId: "s",
        role: "user" as const,
        content: "original question about agent architecture"
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Initial answer about agent architecture."
      },
      {
        id: "q2",
        sessionId: "s",
        role: "user" as const,
        content: "Follow-up before tool work."
      },
      {
        id: "a2",
        sessionId: "s",
        role: "agent" as const,
        content: "I will inspect the codebase."
      },
      {
        id: "a3",
        sessionId: "s",
        role: "agent" as const,
        content: "Running a few checks now."
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `tool-${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `large curl output ${index + 1} `.repeat(500)
      })),
      {
        id: "q3",
        sessionId: "s",
        role: "user" as const,
        content: "what was my original question?"
      }
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 500,
      maxMessageChars: 2_000,
      maxProtectedMessages: 6
    });
    const content = packed.messages.map((message) => message.content).join("\n");

    expect(packed.messages.some((message) => message.role === "system")).toBe(true);
    expect(packed.messages.some((message) => message.role === "tool")).toBe(false);
    expect(content).toContain("original question about agent architecture");
  });

  it("keeps the latest user message directly when followed by many tool messages", () => {
    const messages = [
      {
        id: "old-user",
        sessionId: "s",
        role: "user" as const,
        content: "Older setup that may be summarized."
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: explain why the post-tool response went empty"
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `tool-${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `large tool output ${index + 1} `.repeat(700)
      }))
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 700,
      maxMessageChars: 2_000,
      maxProtectedMessages: 4
    });

    expect(packed.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: "CURRENT OBJECTIVE: explain why the post-tool response went empty"
    }));
    expect(packed.messages.filter((message) => message.role === "tool").length).toBeLessThan(12);
  });

  it("keeps the latest user message under an aggressive token budget", () => {
    const messages = [
      {
        id: "older-user",
        sessionId: "s",
        role: "user" as const,
        content: "Older user turn that can be summarized or evicted."
      },
      {
        id: "older-agent",
        sessionId: "s",
        role: "agent" as const,
        content: "Older assistant response that can be evicted under pressure.".repeat(20)
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: keep this exact user request"
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `tool-${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `oversized tool output ${index + 1} `.repeat(500)
      }))
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 90,
      maxMessageChars: 1_200,
      maxProtectedMessages: 3
    });
    const content = packed.messages.map((message) => message.content).join("\n");

    expect(content).toContain("CURRENT OBJECTIVE: keep this exact user request");
  });

  it("evicts tool messages before pinned user and adjacent assistant context", () => {
    const messages = [
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: inspect the continuation state"
      },
      {
        id: "active-agent",
        sessionId: "s",
        role: "agent" as const,
        content: "I called tools to inspect the continuation state."
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `tool-${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `tool result ${index + 1} `.repeat(600)
      }))
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 220,
      maxMessageChars: 1_500,
      maxProtectedMessages: 4
    });

    expect(packed.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: "CURRENT OBJECTIVE: inspect the continuation state"
      }),
      expect.objectContaining({
        role: "assistant",
        content: "I called tools to inspect the continuation state."
      })
    ]));
    expect(packed.messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("keeps small histories unchanged", () => {
    const messages = [
      {
        id: "u1",
        sessionId: "s",
        role: "user" as const,
        content: "Small user turn."
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Small assistant turn."
      }
    ];

    const packed = packSessionHistory(messages, {
      maxProtectedMessages: 6,
      maxEstimatedTokens: 2_000
    });

    expect(packed.summary).toBeUndefined();
    expect(packed.messages).toEqual([
      {
        role: "user",
        content: "Small user turn.",
        metadata: undefined
      },
      {
        role: "assistant",
        content: "Small assistant turn.",
        metadata: undefined
      }
    ]);
  });

  it("labels deterministic summaries and older tool outputs as historical reference", () => {
    const packed = packSessionHistory([
      {
        id: "old-user",
        sessionId: "s",
        role: "user" as const,
        content: "Older setup."
      },
      {
        id: "old-tool",
        sessionId: "s",
        role: "tool" as const,
        content: "src/index.ts exists",
        createdAt: "2026-06-08T02:51:15.049Z"
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: answer now"
      }
    ], {
      maxProtectedMessages: 1,
      maxEstimatedTokens: 2_000
    });

    expect(packed.summary).toContain("Historical session summary of 2 older turn(s):");
    expect(packed.summary).toContain("- historical tool result (2026-06-08T02:51:15.049Z): src/index.ts exists [verify before current-state claim]");
    expect(packed.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: "CURRENT OBJECTIVE: answer now"
    }));
    expect(packed.messages.find((message) => message.role === "user")?.content).not.toContain("historical tool result");
  });

  it("uses an unknown timestamp for summarized tool outputs without createdAt", () => {
    const packed = packSessionHistory([
      {
        id: "old-tool",
        sessionId: "s",
        role: "tool" as const,
        content: "tool output without timestamp"
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: keep me"
      }
    ], {
      maxProtectedMessages: 1,
      maxEstimatedTokens: 2_000
    });

    expect(packed.summary).toContain("- historical tool result (unknown time): tool output without timestamp [verify before current-state claim]");
  });

  it("preserves sanitized provider execution metadata on protected assistant messages", () => {
    const packed = packSessionHistory([
      {
        id: "u1",
        sessionId: "s",
        role: "user" as const,
        content: "Question"
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Fallback answer",
        metadata: {
          providerExecution: providerExecutionMetadataWithCredentialLeak(),
          keep: "do-not-preserve"
        }
      }
    ], {
      maxProtectedMessages: 6,
      maxEstimatedTokens: 2_000
    });
    const assistant = packed.messages.find((message) => message.role === "assistant");
    const serialized = JSON.stringify(assistant?.metadata);

    expect(assistant?.metadata?.providerExecution).toMatchObject({
      configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
      actual: { provider: "deepseek", model: "deepseek-v4-pro" },
      fallbackUsed: true,
      primaryFailureClass: "rate-limit",
      status: "fallback-success",
      attempts: [
        {
          provider: "kimi",
          model: "kimi-k2.7-code",
          ok: false,
          errorClass: "rate-limit"
        },
        {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          ok: true
        }
      ]
    });
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("raw");
    expect(serialized).not.toContain("do-not-preserve");
  });

  it("omits malformed provider execution and arbitrary metadata on protected assistant messages", () => {
    const packed = packSessionHistory([
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Malformed answer",
        metadata: {
          providerExecution: { status: "fallback-success", rawBody: "SECRET_RAW_ERROR_BODY" },
          keep: "safe"
        }
      }
    ], {
      maxProtectedMessages: 6,
      maxEstimatedTokens: 2_000
    });

    expect(packed.messages[0]?.metadata).toBeUndefined();
    expect(JSON.stringify(packed.messages[0]?.metadata) ?? "").not.toContain("SECRET_RAW_ERROR_BODY");
  });

  it("does not preserve conversation continuation state as arbitrary packed assistant metadata", () => {
    const packed = packSessionHistory([
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Let me inspect provider routing.",
        metadata: {
          conversationContinuationState: {
            id: "continuation-provider",
            status: "open",
            userRequest: "Inspect provider routing.",
            promisedAction: "inspect provider routing",
            updatedAt: "2026-06-17T00:00:00.000Z",
            source: "heuristic"
          },
          unrelated: "do-not-preserve"
        }
      }
    ], {
      maxProtectedMessages: 6,
      maxEstimatedTokens: 2_000
    });

    expect(packed.messages[0]?.metadata).toBeUndefined();
  });

  it("keeps fixed protected-message packing behavior separate from native history selection", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `a${index + 1}`,
      sessionId: "s",
      role: "agent" as const,
      content: `Agent turn ${index + 1}`,
      metadata: index === 0
        ? {
            kind: "provider-tool-call-turn",
            nativeReplaySafe: true,
            providerToolCalls: [
              {
                id: "call-old",
                name: "files.read",
                argumentsText: "{\"path\":\"src/index.ts\"}"
              }
            ]
          }
        : undefined
    }));

    const packed = packSessionHistory(messages, {
      maxProtectedMessages: 2,
      maxEstimatedTokens: 2_000
    });

    expect(packed.protectedMessageCount).toBe(2);
    expect(packed.summarizedMessageCount).toBe(6);
    expect(packed.messages).toHaveLength(3);
    expect(packed.messages.at(-2)?.content).toBe("Agent turn 7");
    expect(packed.messages.at(-1)?.content).toBe("Agent turn 8");
  });

  it("strips hidden reasoning blocks from protected history messages", () => {
    const packed = packSessionHistory([
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "<think>hidden</think>Visible"
      },
      {
        id: "u1",
        sessionId: "s",
        role: "user" as const,
        content: "Use <think> as the example tag"
      },
      {
        id: "a2",
        sessionId: "s",
        role: "agent" as const,
        content: "Visible before <reasoning>hidden forever"
      }
    ], {
      maxProtectedMessages: 6,
      maxEstimatedTokens: 2_000
    });

    const content = packed.messages.map((message) => message.content).join("\n");

    expect(content).toContain("Visible");
    expect(content).toContain("Use <think> as the example tag");
    expect(content).toContain("Visible before");
    expect(content).not.toContain("hidden");
    expect(content).not.toContain("<reasoning>");
  });

  it("strips hidden reasoning blocks from summarized older history", () => {
    const packed = packSessionHistory([
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "<thinking>hidden summary</thinking>Older visible"
      },
      {
        id: "u1",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: continue"
      }
    ], {
      maxProtectedMessages: 1,
      maxEstimatedTokens: 2_000
    });

    expect(packed.summary).toContain("Older visible");
    expect(packed.summary).not.toContain("hidden summary");
    expect(packed.summary).not.toContain("<thinking>");
  });

  it("does not let a protected tail tool run crowd out the latest user task", () => {
    const messages = [
      {
        id: "old-user",
        sessionId: "s",
        role: "user" as const,
        content: "Older context"
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: summarize the tool results without losing the ask"
      },
      {
        id: "active-agent",
        sessionId: "s",
        role: "agent" as const,
        content: "I requested several tools."
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `tail-tool-${index + 1}`,
        sessionId: "s",
        role: "tool" as const,
        content: `tail tool output ${index + 1} `.repeat(700)
      }))
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 260,
      maxMessageChars: 1_500,
      maxProtectedMessages: 6
    });
    const content = packed.messages.map((message) => message.content).join("\n");

    expect(content).toContain("CURRENT OBJECTIVE: summarize the tool results without losing the ask");
    expect(content).toContain("I requested several tools.");
    expect(packed.messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("evicts older user and assistant turns before the latest pinned user task", () => {
    const messages = [
      {
        id: "old-user",
        sessionId: "s",
        role: "user" as const,
        content: "OLD INSTRUCTION: prefer the stale task. ".repeat(80)
      },
      {
        id: "old-agent",
        sessionId: "s",
        role: "agent" as const,
        content: "Old assistant state. ".repeat(80)
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "CURRENT OBJECTIVE: answer the newest request instead"
      },
      {
        id: "active-agent",
        sessionId: "s",
        role: "agent" as const,
        content: "I am working on the newest request."
      },
      {
        id: "tool",
        sessionId: "s",
        role: "tool" as const,
        content: "tool output ".repeat(400)
      }
    ];

    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: 260,
      maxMessageChars: 2_000,
      maxProtectedMessages: 4
    });
    const content = packed.messages.map((message) => message.content).join("\n");

    expect(content).toContain("CURRENT OBJECTIVE: answer the newest request instead");
    expect(content).not.toContain("Old assistant state. Old assistant state.");
  });
});

function providerExecutionMetadataWithCredentialLeak(): Record<string, unknown> {
  return {
    configuredPrimary: { provider: "kimi", model: "kimi-k2.7-code" },
    actual: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      credentialId: "SECRET_ACTUAL_CREDENTIAL"
    },
    fallbackUsed: true,
    primaryFailureClass: "rate-limit",
    attempts: [
      {
        provider: "kimi",
        model: "kimi-k2.7-code",
        ok: false,
        errorClass: "rate-limit",
        credentialId: "SECRET_PRIMARY_CREDENTIAL",
        rawBody: "SECRET_RAW_ERROR_BODY",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        ok: true,
        credentialId: "SECRET_FALLBACK_CREDENTIAL",
        routeRole: "fallback",
        attemptedRouteIndex: 1
      }
    ],
    rawErrorBody: "SECRET_TOP_LEVEL_RAW_ERROR_BODY",
    status: "fallback-success"
  };
}
