import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../contracts/session.js";
import { buildNativeHistoryMessages } from "./native-history-builder.js";

function message(
  id: string,
  role: SessionMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sessionId: "session-native-history",
    role,
    content,
    createdAt: "2026-05-31T00:00:00.000Z",
    metadata
  };
}

function providerToolTurn(
  id: string,
  content = "",
  metadata: Record<string, unknown> = {}
): SessionMessage {
  return message(id, "agent", content, {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: true,
    providerToolCalls: [
      {
        id: "call-1",
        name: "files.read",
        argumentsText: "{\"path\":\"src/index.ts\"}"
      }
    ],
    ...metadata
  });
}

function toolResult(id: string, toolCallId: string, content = "tool result"): SessionMessage {
  return message(id, "tool", content, {
    tool_call_id: toolCallId,
    tool_call_name: "files.read"
  });
}

describe("buildNativeHistoryMessages", () => {
  it("converts a valid safe provider tool turn into native assistant and tool messages", () => {
    const result = buildNativeHistoryMessages([
      message("user-1", "user", "Read the file"),
      providerToolTurn("agent-call"),
      toolResult("tool-1", "call-1", "file contents")
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          }
        ]
      },
      {
        role: "tool",
        content: "file contents",
        toolCallId: "call-1"
      }
    ]);
    expect(result.stats.nativeToolTurns).toBe(1);
    expect(result.stats.nativeToolResults).toBe(1);
  });

  it("preserves assistant content alongside native tool calls", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "I'll look that up."),
      toolResult("tool-1", "call-1", "file contents")
    ]);

    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "I'll look that up.",
      toolCalls: [
        {
          id: "call-1",
          name: "files.read",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }
      ]
    });
  });

  it("does not replay unsafe turns or their matching tool results natively", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("unsafe-agent", "", {
        nativeReplaySafe: false,
        providerToolCalls: [
          {
            id: "call-secret",
            name: "files.read",
            argumentsRedacted: true
          }
        ]
      }),
      toolResult("tool-secret", "call-secret", "secret-bearing result"),
      message("agent-final", "agent", "Done")
    ]);

    expect(result.messages).toEqual([
      { role: "assistant", content: "Done" }
    ]);
    expect(result.stats.skippedUnsafeTurns).toBe(1);
    expect(JSON.stringify(result.messages)).not.toContain("call-secret");
  });

  it("carries provider replay echo only for the same provider family and API mode", () => {
    const echo = {
      field: "reasoning_content",
      value: "private provider reasoning",
      providerFamily: "deepseek",
      apiMode: "openai_chat_completions",
      chars: "private provider reasoning".length
    };
    const sameProvider = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "deepseek",
      targetApiMode: "openai_chat_completions"
    });
    const crossProvider = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions"
    });

    expect(sameProvider.messages[0]?.providerReplayEcho).toEqual(echo);
    expect(crossProvider.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(crossProvider.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("drops orphan tool messages", () => {
    const result = buildNativeHistoryMessages([
      toolResult("orphan", "missing-call", "orphaned"),
      message("user-1", "user", "Continue")
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "Continue" }
    ]);
    expect(result.stats.droppedToolMessages).toBe(1);
  });

  it("does not produce native tool calls from non-agent provider-tool-call metadata", () => {
    const result = buildNativeHistoryMessages([
      message("user-malformed", "user", "User text", {
        kind: "provider-tool-call-turn",
        nativeReplaySafe: true,
        providerToolCalls: [
          {
            id: "call-user",
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
      }),
      toolResult("tool-user", "call-user", "user tool result")
    ], {
      targetProviderFamily: "deepseek",
      targetApiMode: "openai_chat_completions"
    });

    expect(result.messages).toEqual([
      { role: "user", content: "" }
    ]);
    expect(result.messages[0]).not.toHaveProperty("toolCalls");
    expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(JSON.stringify(result.messages)).not.toContain("call-user");
    expect(JSON.stringify(result.messages)).not.toContain("user tool result");
    expect(JSON.stringify(result.messages)).not.toContain("private provider reasoning");
    expect(result.stats.droppedToolMessages).toBe(1);
  });

  it("injects a deterministic stub for a known missing result", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          },
          {
            id: "call-2",
            name: "files.stat",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          }
        ]
      }),
      toolResult("tool-1", "call-1", "file contents"),
      message("agent-final", "agent", "Done")
    ]);

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          },
          {
            id: "call-2",
            name: "files.stat",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          }
        ]
      },
      {
        role: "tool",
        content: "file contents",
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: "[Tool result unavailable]",
        toolCallId: "call-2"
      },
      {
        role: "assistant",
        content: "Done"
      }
    ]);
    expect(result.stats.injectedMissingResults).toBe(1);
  });

  it("does not merge tool messages", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call"),
      toolResult("tool-1", "call-1", "first chunk"),
      toolResult("tool-2", "call-1", "second chunk")
    ]);

    expect(result.messages.filter((providerMessage) => providerMessage.role === "tool")).toEqual([
      {
        role: "tool",
        content: "first chunk",
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: "second chunk",
        toolCallId: "call-1"
      }
    ]);
  });

  it("merges adjacent user messages when compatibility merging is enabled", () => {
    const result = buildNativeHistoryMessages([
      message("user-1", "user", "First"),
      message("user-2", "user", "Second")
    ], {
      mergeAdjacentUsers: true
    });

    expect(result.messages).toEqual([
      { role: "user", content: "First\n\nSecond" }
    ]);
    expect(result.stats.mergedUserMessages).toBe(1);
  });

  it("keeps raw reasoning out of rendered message content", () => {
    const result = buildNativeHistoryMessages([
      message("agent-reasoning", "agent", "Visible answer", {
        reasoning: "raw hidden reasoning",
        reasoning_content: "raw hidden reasoning content",
        reasoningMetadata: {
          present: true,
          chars: 28,
          format: "reasoning_content"
        }
      }),
      providerToolTurn("agent-call", "", {
        providerReplayEcho: {
          field: "reasoning_content",
          value: "private provider reasoning",
          providerFamily: "deepseek",
          apiMode: "openai_chat_completions",
          chars: "private provider reasoning".length
        }
      }),
      toolResult("tool-1", "call-1", "file contents")
    ], {
      targetProviderFamily: "deepseek",
      targetApiMode: "openai_chat_completions"
    });

    const renderedText = result.messages.map((providerMessage) => String(providerMessage.content ?? "")).join("\n");
    expect(renderedText).toContain("Visible answer");
    expect(renderedText).not.toContain("raw hidden reasoning");
    expect(renderedText).not.toContain("private provider reasoning");
    expect(result.messages[1]?.providerReplayEcho?.value).toBe("private provider reasoning");
  });

  it("does not partially replay a multi-call turn when one call lacks faithful arguments", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          {
            id: "call-1",
            name: "files.read",
            argumentsText: "{\"path\":\"src/index.ts\"}"
          },
          {
            id: "call-2",
            name: "files.stat",
            argumentsRedacted: true
          }
        ]
      }),
      toolResult("tool-1", "call-1", "file contents"),
      toolResult("tool-2", "call-2", "stat result"),
      message("agent-final", "agent", "Done")
    ]);

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: "Done"
      }
    ]);
    expect(result.stats.skippedMalformedTurns).toBe(1);
  });
});
