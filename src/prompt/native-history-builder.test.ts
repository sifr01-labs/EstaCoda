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
        content: expect.stringContaining("file contents"),
        toolCallId: "call-1"
      }
    ]);
    expect(String(result.messages[2]?.content)).toContain("[Historical tool result from 2026-05-31T00:00:00.000Z via files.read.");
    expect(String(result.messages[2]?.content)).toContain("Verify with a current tool before asserting current state.");
    expect(result.stats.nativeToolTurns).toBe(1);
    expect(result.stats.nativeToolResults).toBe(1);
    expect(result.stats.historicalToolResultsLabeled).toBe(1);
    expect(result.stats.mutableStateToolResultsLabeled).toBe(1);
  });

  it("labels non-mutable historical tool results as reference-only with timestamp and tool name", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          {
            id: "call-calc",
            name: "calculator.sum",
            argumentsText: "{\"values\":[1,2]}"
          }
        ]
      }),
      message("tool-calc", "tool", "sum=3", {
        tool_call_id: "call-calc",
        tool_call_name: "calculator.sum"
      })
    ]);

    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-calc",
        content: "[Historical tool result from 2026-05-31T00:00:00.000Z via calculator.sum; reference only.]\nsum=3"
      })
    ]));
    expect(result.stats.historicalToolResultsLabeled).toBe(1);
    expect(result.stats.mutableStateToolResultsLabeled).toBe(0);
  });

  it("derives historical tool result names from assistant metadata when result metadata only has an id", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          {
            id: "call-skill-list",
            name: "skill.list",
            argumentsText: "{}"
          }
        ]
      }),
      message("tool-skill-list", "tool", "OldSkill\tworkflow\tlocal\told", {
        tool_call_id: "call-skill-list"
      })
    ]);

    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-skill-list",
        content: expect.stringContaining("via skill.list. This may describe stale mutable filesystem/config/skill/process state.")
      })
    ]));
    expect(String(result.messages.at(-1)?.content)).toContain("OldSkill");
    expect(result.stats.historicalToolResultsLabeled).toBe(1);
    expect(result.stats.mutableStateToolResultsLabeled).toBe(1);
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

  it("preserves valid provider replay echo provenance when carrying echo", () => {
    const echoes = [
      {
        field: "reasoning_content",
        value: "old provider reasoning",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: "old provider reasoning".length
      },
      {
        field: "reasoning_content",
        value: "provider reasoning",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: "provider reasoning".length,
        provenance: "provider"
      },
      {
        field: "reasoning_content",
        value: " ",
        providerFamily: "kimi",
        apiMode: "openai_chat_completions",
        chars: 1,
        provenance: "protocol-placeholder"
      }
    ];

    for (const echo of echoes) {
      const result = buildNativeHistoryMessages([
        providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
        toolResult("tool-1", "call-1")
      ], {
        targetProviderFamily: "kimi",
        targetApiMode: "openai_chat_completions"
      });

      expect(result.messages[0]?.providerReplayEcho).toEqual(echo);
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
      const result = buildNativeHistoryMessages([
        providerToolTurn("agent-call", "", { providerReplayEcho }),
        toolResult("tool-1", "call-1")
      ], {
        targetProviderFamily: "kimi",
        targetApiMode: "openai_chat_completions"
      });

      expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    }
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
        content: expect.stringContaining("file contents"),
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: expect.stringContaining("[Tool result unavailable]"),
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
        content: expect.stringContaining("first chunk"),
        toolCallId: "call-1"
      },
      {
        role: "tool",
        content: expect.stringContaining("second chunk"),
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
