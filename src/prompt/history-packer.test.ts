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
        content: "okay i want you to go and research hermes agent"
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "I will research Hermes agent for you."
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
    expect(content).toContain("research hermes agent");
  });

  it("evicts tool messages before session summaries when trimming", () => {
    const messages = [
      {
        id: "q1",
        sessionId: "s",
        role: "user" as const,
        content: "original question about Hermes agent architecture"
      },
      {
        id: "a1",
        sessionId: "s",
        role: "agent" as const,
        content: "Initial answer about Hermes."
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
    expect(content).toContain("original question about Hermes agent architecture");
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
        content: "ACTIVE TASK: explain why the post-tool response went empty"
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
      content: "ACTIVE TASK: explain why the post-tool response went empty"
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
        content: "ACTIVE TASK: keep this exact user request"
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

    expect(content).toContain("ACTIVE TASK: keep this exact user request");
  });

  it("evicts tool messages before pinned user and adjacent assistant context", () => {
    const messages = [
      {
        id: "active-user",
        sessionId: "s",
        role: "user" as const,
        content: "ACTIVE TASK: inspect the continuation state"
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
        content: "ACTIVE TASK: inspect the continuation state"
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
        content: "ACTIVE TASK: summarize the tool results without losing the ask"
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

    expect(content).toContain("ACTIVE TASK: summarize the tool results without losing the ask");
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
        content: "ACTIVE TASK: answer the newest request instead"
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

    expect(content).toContain("ACTIVE TASK: answer the newest request instead");
    expect(content).not.toContain("Old assistant state. Old assistant state.");
  });
});
