import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../contracts/session.js";
import { selectNativeHistoryWindow } from "./native-history-selector.js";

function message(
  id: string,
  role: SessionMessage["role"],
  content = id,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sessionId: "native-history-selector-test",
    role,
    content,
    createdAt: "2026-05-31T00:00:00.000Z",
    metadata
  };
}

function providerToolTurn(
  id: string,
  calls: Array<{ id: string; name?: string; argumentsText?: string }> = [
    { id: "call-1", name: "files.read", argumentsText: "{\"path\":\"src/index.ts\"}" }
  ],
  metadata: Record<string, unknown> = {}
): SessionMessage {
  return message(id, "agent", "tool turn", {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: true,
    providerToolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name ?? "files.read",
      argumentsText: call.argumentsText ?? "{\"path\":\"src/index.ts\"}"
    })),
    provider: "deepseek",
    model: "deepseek-chat",
    providerReplayEcho: {
      field: "reasoning_content",
      value: "private provider reasoning",
      providerFamily: "deepseek",
      apiMode: "openai_chat_completions",
      chars: "private provider reasoning".length
    },
    ...metadata
  });
}

function toolResult(id: string, toolCallId: string, content = "tool result"): SessionMessage {
  return message(id, "tool", content, {
    tool_call_id: toolCallId,
    tool_call_name: "files.read"
  });
}

function ids(units: ReturnType<typeof selectNativeHistoryWindow>["selectedUnits"]): string[] {
  return units.flatMap((unit) => unit.kind === "message"
    ? [unit.message.id]
    : unit.messages.map((message) => message.id));
}

describe("selectNativeHistoryWindow", () => {
  it("can select more than the old fixed recent-message window when budget allows", () => {
    const messages = Array.from({ length: 9 }, (_, index) => message(`m${index + 1}`, "user", `message ${index + 1}`));

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });

    expect(selection.selectedUnits).toHaveLength(9);
    expect(selection.unselectedUnits).toHaveLength(0);
    expect(selection.stats.selectedMessages).toBe(9);
  });

  it("selects a chronological suffix instead of arbitrary middle units", () => {
    const messages = [
      message("old-cheap", "user", "old"),
      message("middle-large", "agent", "middle ".repeat(400)),
      message("new-cheap", "user", "new")
    ];
    const full = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const newestCost = full.selectedUnits.at(-1)?.estimatedTokens ?? 0;

    const selection = selectNativeHistoryWindow(messages, { maxTokens: newestCost });

    expect(ids(selection.selectedUnits)).toEqual(["new-cheap"]);
    expect(ids(selection.unselectedUnits)).toEqual(["old-cheap", "middle-large"]);
  });

  it("uses explicit reservations before selecting native history", () => {
    const messages = [
      message("old", "user", "old"),
      message("middle", "agent", "middle"),
      message("new", "user", "new")
    ];
    const full = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const total = full.stats.estimatedTokens;
    const newestCost = full.selectedUnits.at(-1)?.estimatedTokens ?? 0;

    const selection = selectNativeHistoryWindow(messages, {
      maxTokens: total,
      reservedTokens: total - newestCost
    });

    expect(ids(selection.selectedUnits)).toEqual(["new"]);
    expect(ids(selection.unselectedUnits)).toEqual(["old", "middle"]);
  });

  it("keeps a complete tool group atomic", () => {
    const messages = [
      message("user", "user", "read"),
      providerToolTurn("tool-turn"),
      toolResult("tool-result", "call-1"),
      message("final", "agent", "done")
    ];
    const full = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const finalCost = full.selectedUnits.at(-1)?.estimatedTokens ?? 0;
    const toolGroup = full.selectedUnits.find((unit) => unit.kind === "tool-group");
    expect(toolGroup?.kind).toBe("tool-group");
    const toolGroupCost = toolGroup?.estimatedTokens ?? 0;

    const withoutToolGroupBudget = selectNativeHistoryWindow(messages, {
      maxTokens: finalCost + toolGroupCost - 1
    });
    expect(ids(withoutToolGroupBudget.selectedUnits)).toEqual(["final"]);

    const withToolGroupBudget = selectNativeHistoryWindow(messages, {
      maxTokens: finalCost + toolGroupCost
    });
    expect(ids(withToolGroupBudget.selectedUnits)).toEqual(["tool-turn", "tool-result", "final"]);
  });

  it("keeps multi-call tool groups atomic", () => {
    const messages = [
      providerToolTurn("multi-turn", [
        { id: "call-a", name: "files.read", argumentsText: "{\"path\":\"a\"}" },
        { id: "call-b", name: "files.stat", argumentsText: "{\"path\":\"b\"}" }
      ]),
      toolResult("tool-a", "call-a", "a"),
      toolResult("tool-b", "call-b", "b")
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });

    expect(selection.selectedUnits).toHaveLength(1);
    expect(selection.selectedUnits[0]).toMatchObject({ kind: "tool-group" });
    expect(ids(selection.selectedUnits)).toEqual(["multi-turn", "tool-a", "tool-b"]);
  });

  it("returns selected and unselected units separately for later compression", () => {
    const messages = [
      message("older", "user", "older"),
      message("recent", "user", "recent")
    ];
    const full = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const newestCost = full.selectedUnits.at(-1)?.estimatedTokens ?? 0;

    const selection = selectNativeHistoryWindow(messages, { maxTokens: newestCost });

    expect(ids(selection.selectedUnits)).toEqual(["recent"]);
    expect(ids(selection.unselectedUnits)).toEqual(["older"]);
  });

  it("preserves metadata on selected and unselected units", () => {
    const toolTurn = providerToolTurn("tool-turn");
    const messages = [
      message("old", "user", "old", { custom: "metadata" }),
      toolTurn,
      toolResult("tool-result", "call-1")
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });

    expect(selection.selectedUnits[0]).toMatchObject({
      kind: "message",
      message: messages[0]
    });
    expect(selection.selectedUnits[1]).toMatchObject({
      kind: "tool-group",
      messages: [toolTurn, messages[2]]
    });
    expect(selection.selectedUnits[1]?.kind === "tool-group"
      ? selection.selectedUnits[1].messages[0]?.metadata
      : undefined).toBe(toolTurn.metadata);
  });

  it("keeps older unselected units available for summary or compression", () => {
    const messages = [
      message("old-1", "user", "old 1"),
      message("old-2", "agent", "old 2"),
      message("new", "user", "new")
    ];
    const full = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const newestCost = full.selectedUnits.at(-1)?.estimatedTokens ?? 0;

    const selection = selectNativeHistoryWindow(messages, { maxTokens: newestCost });

    expect(ids(selection.unselectedUnits)).toEqual(["old-1", "old-2"]);
  });

  it("selects nothing when the newest unit exceeds the available budget", () => {
    const messages = [
      message("old", "user", "old"),
      message("huge-new", "agent", "huge ".repeat(300))
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 1 });

    expect(selection.selectedUnits).toEqual([]);
    expect(ids(selection.unselectedUnits)).toEqual(["old", "huge-new"]);
  });

  it("preserves an incomplete tool group atomically without inventing results", () => {
    const messages = [
      message("user", "user", "read"),
      providerToolTurn("incomplete-turn")
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });

    expect(selection.selectedUnits[1]).toMatchObject({
      kind: "tool-group",
      messages: [messages[1]]
    });
    expect(ids(selection.selectedUnits)).toEqual(["user", "incomplete-turn"]);
  });

  it("does not include nonmatching tool results in a provider tool group", () => {
    const messages = [
      providerToolTurn("tool-turn"),
      toolResult("matching-tool", "call-1"),
      toolResult("orphan-tool", "call-other")
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });

    expect(selection.selectedUnits).toHaveLength(2);
    expect(selection.selectedUnits[0]).toMatchObject({
      kind: "tool-group",
      messages: [messages[0], messages[1]]
    });
    expect(selection.selectedUnits[1]).toMatchObject({
      kind: "message",
      message: messages[2]
    });
  });

  it("keeps stats count-only and excludes raw echo or reasoning values", () => {
    const messages = [
      providerToolTurn("tool-turn", undefined, {
        reasoningMetadata: { present: true, chars: 24 },
        raw: { payload: "raw provider payload" }
      }),
      toolResult("tool-result", "call-1", "sensitive tool result")
    ];

    const selection = selectNativeHistoryWindow(messages, { maxTokens: 10_000 });
    const statsJson = JSON.stringify(selection.stats);

    expect(Object.values(selection.stats).every((value) => typeof value === "number")).toBe(true);
    expect(statsJson).not.toContain("private provider reasoning");
    expect(statsJson).not.toContain("raw provider payload");
    expect(statsJson).not.toContain("sensitive tool result");
    expect(statsJson).not.toContain("src/index.ts");
  });

  it("does not count invalid protocol placeholder replay echo when budgeting tool groups", () => {
    const noEchoTurn = providerToolTurn("tool-turn", undefined, {
      providerReplayEcho: undefined
    });
    const noEchoSelection = selectNativeHistoryWindow([
      noEchoTurn,
      toolResult("tool-result", "call-1")
    ], { maxTokens: 10_000 });
    const noEchoCost = noEchoSelection.stats.estimatedTokens;
    const invalidPlaceholderValue = "not blank ".repeat(1000);
    const invalidPlaceholderTurn = providerToolTurn("tool-turn", undefined, {
      providerReplayEcho: {
        field: "reasoning_content",
        value: invalidPlaceholderValue,
        providerFamily: "deepseek",
        apiMode: "openai_chat_completions",
        chars: invalidPlaceholderValue.length,
        provenance: "protocol-placeholder"
      }
    });

    const selection = selectNativeHistoryWindow([
      invalidPlaceholderTurn,
      toolResult("tool-result", "call-1")
    ], { maxTokens: noEchoCost });

    expect(ids(selection.selectedUnits)).toEqual(["tool-turn", "tool-result"]);
  });
});
