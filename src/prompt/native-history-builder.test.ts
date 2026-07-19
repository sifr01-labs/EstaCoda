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

function replayEcho(
  value: string,
  providerFamily: "deepseek" | "kimi" | "mimo" = "kimi",
  provenance?: "provider" | "protocol-placeholder"
): Record<string, unknown> {
  return {
    field: "reasoning_content",
    value,
    providerFamily,
    apiMode: "openai_chat_completions",
    chars: value.length,
    ...(provenance === undefined ? {} : { provenance })
  };
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

  it("caps labeled native delegation results with an explicit truncation marker", () => {
    const delegationContent = `${"d".repeat(8_500)}delegation-beyond-limit`;
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          {
            id: "call-delegate",
            name: "delegate_task",
            argumentsText: "{\"task\":\"inspect\"}"
          }
        ]
      }),
      message("tool-delegate", "tool", delegationContent, {
        tool_call_id: "call-delegate",
        tool_call_name: "delegate_task"
      })
    ]);
    const rendered = String(result.messages.find((entry) => entry.role === "tool")?.content);

    expect(rendered.length).toBe(8_000);
    expect(rendered).toContain("via delegate_task; reference only.");
    expect(rendered).toContain("chars total, truncated)");
    expect(rendered).not.toContain("delegation-beyond-limit");
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

  it("strips raw provider replay echo by default while preserving native tool calls", () => {
    const echo = replayEcho("private provider reasoning", "deepseek");
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "deepseek",
      targetApiMode: "openai_chat_completions"
    });

    expect(result.messages[0]).toEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: [
        {
          id: "call-1",
          name: "files.read",
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }
      ]
    }));
    expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
  });

  it("uses historical placeholder for echo-required routes", () => {
    const echo = replayEcho("old private provider reasoning", "kimi");
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: { kind: "historical", requiresReasoningEcho: true }
    });

    expect(result.messages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    });
    expect(JSON.stringify(result.messages)).not.toContain("old private provider reasoning");
    expect(result.stats.placeholderProviderReplayEcho).toBe(1);
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("strips historical echo when reasoning echo is not required", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: replayEcho("old private provider reasoning") }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: { kind: "historical", requiresReasoningEcho: false }
    });

    expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
  });

  it("strip context always strips provider replay echo", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", { providerReplayEcho: replayEcho("private provider reasoning") }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: { kind: "strip" }
    });

    expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
  });

  it("active continuation preserves provider echo for the exact active group", () => {
    const echo = replayEcho("current provider reasoning", "kimi", "provider");
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          { id: "call_active_1", name: "files.read", argumentsText: "{\"path\":\"a\"}" },
          { id: "call_active_2", name: "files.stat", argumentsText: "{\"path\":\"a\"}" }
        ],
        providerReplayEcho: echo
      }),
      toolResult("tool-1", "call_active_1"),
      toolResult("tool-2", "call_active_2")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call_active_1", "call_active_2"]),
        requiresReasoningEcho: true
      }
    });

    expect(result.messages[0]?.providerReplayEcho).toEqual(echo);
    expect(result.stats.preservedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
    expect(result.stats.strippedProviderReplayEcho).toBe(0);
  });

  it("active continuation requires exact active id set instead of loose intersection", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          { id: "call_active_1", name: "files.read", argumentsText: "{\"path\":\"a\"}" },
          { id: "call_other_2", name: "files.stat", argumentsText: "{\"path\":\"a\"}" }
        ],
        providerReplayEcho: replayEcho("intersecting provider reasoning", "kimi")
      }),
      toolResult("tool-1", "call_active_1"),
      toolResult("tool-2", "call_other_2")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call_active_1", "call_active_2"]),
        requiresReasoningEcho: true
      }
    });

    expect(result.messages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    });
    expect(JSON.stringify(result.messages)).not.toContain("intersecting provider reasoning");
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
    expect(result.stats.placeholderProviderReplayEcho).toBe(1);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("active continuation strips partial id matches when echo is not required", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerToolCalls: [
          { id: "call_active_1", name: "files.read", argumentsText: "{\"path\":\"a\"}" },
          { id: "call_other_2", name: "files.stat", argumentsText: "{\"path\":\"a\"}" }
        ],
        providerReplayEcho: replayEcho("intersecting provider reasoning", "kimi")
      }),
      toolResult("tool-1", "call_active_1"),
      toolResult("tool-2", "call_other_2")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call_active_1", "call_active_2"]),
        requiresReasoningEcho: false
      }
    });

    expect(result.messages[0]).not.toHaveProperty("providerReplayEcho");
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("active continuation preserves only the active group and placeholders older groups", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("older-call", "", {
        providerReplayEcho: replayEcho("older provider reasoning", "kimi")
      }),
      toolResult("older-tool", "call-1"),
      providerToolTurn("active-call", "", {
        providerToolCalls: [
          { id: "call_active_1", name: "files.read", argumentsText: "{\"path\":\"a\"}" }
        ],
        providerReplayEcho: replayEcho("current provider reasoning", "kimi", "provider")
      }),
      toolResult("active-tool", "call_active_1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call_active_1"]),
        requiresReasoningEcho: true
      }
    });

    const assistantMessages = result.messages.filter((providerMessage) => providerMessage.role === "assistant");
    expect(assistantMessages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    });
    expect(assistantMessages[1]?.providerReplayEcho?.value).toBe("current provider reasoning");
    expect(JSON.stringify(result.messages)).not.toContain("older provider reasoning");
    expect(result.stats.preservedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(1);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("requires matching route identity before preserving active provider echo for colliding ids", () => {
    const oldEcho = "old colliding provider reasoning";
    const currentEcho = "current colliding provider reasoning";
    const result = buildNativeHistoryMessages([
      providerToolTurn("older-call", "", {
        provider: "kimi",
        model: "kimi-old-model",
        routeRole: "primary",
        attemptedRouteIndex: 0,
        providerToolCalls: [
          { id: "call_collision_1", name: "files.read", argumentsText: "{\"path\":\"old\"}" }
        ],
        providerReplayEcho: replayEcho(oldEcho, "kimi", "provider")
      }),
      toolResult("older-tool", "call_collision_1"),
      providerToolTurn("active-call", "", {
        provider: "kimi",
        model: "kimi-current-model",
        routeRole: "primary",
        attemptedRouteIndex: 0,
        providerToolCalls: [
          { id: "call_collision_1", name: "files.read", argumentsText: "{\"path\":\"current\"}" }
        ],
        providerReplayEcho: replayEcho(currentEcho, "kimi", "provider")
      }),
      toolResult("active-tool", "call_collision_1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      activeRouteIdentity: {
        provider: "kimi",
        model: "kimi-current-model",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call_collision_1"]),
        requiresReasoningEcho: true
      }
    });

    const assistantMessages = result.messages.filter((providerMessage) => providerMessage.role === "assistant");
    expect(assistantMessages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    });
    expect(assistantMessages[1]?.providerReplayEcho?.value).toBe(currentEcho);
    expect(result.messages.map((providerMessage) => providerMessage.content).join("\n")).not.toContain(currentEcho);
    expect(JSON.stringify(result.messages)).not.toContain(oldEcho);
    expect(result.stats.preservedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(1);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("preserves active provider echo for legacy records without route identity", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerReplayEcho: replayEcho("legacy active provider reasoning", "kimi", "provider")
      }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      activeRouteIdentity: {
        provider: "kimi",
        model: "kimi-current-model",
        routeRole: "primary",
        attemptedRouteIndex: 0
      },
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call-1"]),
        requiresReasoningEcho: true
      }
    });

    expect(result.messages[0]?.providerReplayEcho?.value).toBe("legacy active provider reasoning");
    expect(result.stats.preservedProviderReplayEcho).toBe(1);
    expect(result.stats.placeholderProviderReplayEcho).toBe(0);
    expect(result.stats.strippedProviderReplayEcho).toBe(0);
  });

  it("does not treat stored placeholder echo as preserved active provider echo", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-call", "", {
        providerReplayEcho: replayEcho(" ", "kimi", "protocol-placeholder")
      }),
      toolResult("tool-1", "call-1")
    ], {
      targetProviderFamily: "kimi",
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call-1"]),
        requiresReasoningEcho: true
      }
    });

    expect(result.messages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: " ",
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: 1,
      provenance: "protocol-placeholder"
    });
    expect(result.stats.preservedProviderReplayEcho).toBe(0);
    expect(result.stats.placeholderProviderReplayEcho).toBe(1);
    expect(result.stats.strippedProviderReplayEcho).toBe(1);
  });

  it("preserves valid provider replay echo provenance for active provider echo", () => {
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
      }
    ];

    for (const echo of echoes) {
      const result = buildNativeHistoryMessages([
        providerToolTurn("agent-call", "", { providerReplayEcho: echo }),
        toolResult("tool-1", "call-1")
      ], {
        targetProviderFamily: "kimi",
        targetApiMode: "openai_chat_completions",
        replayEchoContext: {
          kind: "active-continuation",
          activeToolCallIds: new Set(["call-1"]),
          requiresReasoningEcho: true
        }
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
      targetApiMode: "openai_chat_completions",
      replayEchoContext: {
        kind: "active-continuation",
        activeToolCallIds: new Set(["call-1"]),
        requiresReasoningEcho: true
      }
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
