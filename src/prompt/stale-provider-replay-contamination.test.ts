import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import type { ModelProfile, ProviderMessage, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionMessage } from "../contracts/session.js";
import { assembleProviderContinuationPrompt, assembleProviderPrompt } from "./prompt-assembly.js";

const staleBaiObjective = "The user wants me to send the BAI integration plan file as an attachment";
const staleTtsPath = "/home/whodis/workspace/plan-tts-implementation.md";
const currentUserText = "Okay, let's try to do that.";
const currentToolResult = "OK: function";
const activeEcho = "Current same-turn provider reasoning needed for protocol echo";

const model: ModelProfile = {
  id: "kimi-k2-thinking",
  provider: "kimi",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const echoRequiredNativeRoute = {
  provider: "kimi",
  id: "kimi-k2-thinking",
  profile: model,
  apiMode: "openai_chat_completions",
  supportsNativeToolHistory: true,
  requiresReasoningEcho: true,
  reasoningEchoField: "reasoning_content",
  reasoningEchoRequiredForToolCalls: true,
  reasoningEchoProviderFamily: "kimi"
} as ResolvedModelRoute & {
  supportsNativeToolHistory: true;
  requiresReasoningEcho: true;
  reasoningEchoField: "reasoning_content";
  reasoningEchoRequiredForToolCalls: true;
  reasoningEchoProviderFamily: "kimi";
};

const generalIntent: IntentRoute = {
  nativeIntent: "general",
  labels: ["general"],
  confidence: 1,
  suggestedSkills: [],
  suggestedToolsets: [],
  confirmationRequired: false,
  evidence: [],
  rationale: "No specialized route matched."
};

describe("stale provider replay contamination regression", () => {
  it("does not replay stale provider reasoning into normal historical native prompts", () => {
    const prompt = assembleProviderPrompt(basePromptInput({
      rawSessionHistory: staleHistoricalReplayFixture()
    }));

    assertNoStaleReasoning(prompt.messages);
    expect(textContent(prompt.messages)).toContain(currentUserText);

    const toolCalls = collectToolCalls(prompt.messages);
    expect(toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "call_old_bai_artifact", name: "artifact_record" }),
      expect.objectContaining({ id: "call_old_tts_copy", name: "files.copy" }),
      expect.objectContaining({ id: "call_old_tts_artifact", name: "artifact_record" })
    ]));

    for (const message of assistantToolMessages(prompt.messages)) {
      if (message.providerReplayEcho !== undefined) {
        expect(message.providerReplayEcho).toEqual(expect.objectContaining({
          value: " ",
          provenance: "protocol-placeholder"
        }));
      }
      expect(message.providerReplayEcho?.provenance).not.toBe("provider");
      expect(message.providerReplayEcho?.value).not.toBe(staleBaiObjective);
      expect(message.providerReplayEcho?.value).not.toBe(staleTtsPath);
    }
  });

  it("does not preserve stale echo for unrelated continuation active ids", () => {
    const prompt = assembleProviderContinuationPrompt(baseContinuationInput({
      rawSessionHistory: staleHistoricalReplayFixture(),
      providerExecution: providerExecution("", [
        { id: "call_current_unrelated", name: "files.stat", argumentsText: "{\"path\":\"tts-output.wav\"}" }
      ]),
      toolPlans: [{
        id: "call_current_unrelated",
        tool: "files.stat",
        input: { path: "tts-output.wav" },
        source: "provider-tool-call",
        status: "executed",
        result: {
          ok: true,
          content: currentToolResult
        }
      }]
    }));

    assertNoStaleReasoning(prompt.messages);
    expect(textContent(prompt.messages)).toContain(currentUserText);
    expect(textContent(prompt.messages)).toContain(currentToolResult);

    const echoedMessages = assistantToolMessages(prompt.messages).filter((message) => message.providerReplayEcho !== undefined);
    expect(echoedMessages.length).toBeGreaterThan(0);
    for (const message of echoedMessages) {
      expect(message.providerReplayEcho).toEqual(expect.objectContaining({
        value: " ",
        provenance: "protocol-placeholder"
      }));
    }
  });

  it("preserves only the exact active same-turn provider echo as structured protocol material", () => {
    const prompt = assembleProviderContinuationPrompt(baseContinuationInput({
      rawSessionHistory: [
        ...staleHistoricalReplayFixture(),
        providerToolTurn("active-current-tts", [{
          id: "call_current_tts",
          name: "tts.synthesize",
          argumentsText: "{\"text\":\"current request\"}"
        }], activeEcho),
        toolResult("active-current-tts-result", "call_current_tts", currentToolResult, "tts.synthesize")
      ],
      providerExecution: providerExecution("", [
        { id: "call_current_tts", name: "tts.synthesize", argumentsText: "{\"text\":\"current request\"}" }
      ]),
      toolPlans: [{
        id: "call_current_tts",
        tool: "tts.synthesize",
        input: { text: "current request" },
        source: "provider-tool-call",
        status: "executed",
        result: {
          ok: true,
          content: currentToolResult
        }
      }]
    }));

    assertNoStaleReasoning(prompt.messages);
    expect(textContent(prompt.messages)).not.toContain(activeEcho);

    const currentEchoMessages = assistantToolMessages(prompt.messages).filter((message) =>
      message.toolCalls?.some((toolCall) => toolCall.id === "call_current_tts")
    );
    expect(currentEchoMessages).toHaveLength(1);
    expect(currentEchoMessages[0]?.providerReplayEcho).toEqual({
      field: "reasoning_content",
      value: activeEcho,
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: activeEcho.length
    });

    const staleEchoMessages = assistantToolMessages(prompt.messages).filter((message) =>
      message.toolCalls?.some((toolCall) => toolCall.id !== "call_current_tts") &&
      message.providerReplayEcho !== undefined
    );
    expect(staleEchoMessages.length).toBeGreaterThan(0);
    expect(staleEchoMessages.every((message) =>
      message.providerReplayEcho?.provenance === "protocol-placeholder"
    )).toBe(true);
  });
});

function basePromptInput(
  overrides: Partial<Parameters<typeof assembleProviderPrompt>[0]> = {}
): Parameters<typeof assembleProviderPrompt>[0] {
  return {
    model,
    userText: currentUserText,
    routedText: currentUserText,
    selectedSkill: undefined,
    selectedSkillInstructions: undefined,
    selectedSkillResources: undefined,
    selectedSkillSetup: undefined,
    intent: generalIntent,
    securityDecision: "allow",
    toolExecutions: [],
    context: undefined,
    projectContext: undefined,
    memoryPromptContext: undefined,
    providerTools: [],
    fallbackText: "fallback",
    nativeHistoryRoute: echoRequiredNativeRoute,
    ...overrides
  };
}

function baseContinuationInput(
  overrides: Partial<Parameters<typeof assembleProviderContinuationPrompt>[0]> = {}
): Parameters<typeof assembleProviderContinuationPrompt>[0] {
  return {
    ...basePromptInput(),
    providerExecution: providerExecution(""),
    toolPlans: [],
    ...overrides
  };
}

function providerExecution(
  content: string,
  toolCalls: NonNullable<Parameters<typeof assembleProviderContinuationPrompt>[0]["providerExecution"]>["toolCalls"] = []
): Parameters<typeof assembleProviderContinuationPrompt>[0]["providerExecution"] {
  return {
    ok: true,
    response: {
      ok: true,
      content,
      model: model.id,
      provider: model.provider
    },
    fallbackUsed: false,
    attempts: [{
      provider: model.provider,
      model: model.id,
      state: "dispatched",
      dispatchedAt: "2030-01-01T00:00:00.000Z",
      ok: true,
      content
    }],
    toolCalls
  };
}

function staleHistoricalReplayFixture(): SessionMessage[] {
  return [
    sessionMessage("old-bai-user", "user", "Please send the BAI integration plan."),
    providerToolTurn("old-bai-artifact", [{
      id: "call_old_bai_artifact",
      name: "artifact_record",
      argumentsText: "{\"path\":\"bai-integration-plan.md\"}"
    }], staleBaiObjective),
    toolResult("old-bai-result", "call_old_bai_artifact", "Recorded artifact bai-integration-plan.md.", "artifact_record"),
    sessionMessage("old-tts-user", "user", "Now prepare the TTS implementation plan."),
    providerToolTurn("old-tts-plan", [
      {
        id: "call_old_tts_copy",
        name: "files.copy",
        argumentsText: "{\"from\":\"draft.md\",\"to\":\"plan-tts-implementation.md\"}"
      },
      {
        id: "call_old_tts_artifact",
        name: "artifact_record",
        argumentsText: "{\"path\":\"plan-tts-implementation.md\"}"
      }
    ], `Need to copy and attach ${staleTtsPath}`),
    toolResult("old-tts-copy-result", "call_old_tts_copy", "Copied draft to plan-tts-implementation.md.", "files.copy"),
    toolResult("old-tts-artifact-result", "call_old_tts_artifact", "Recorded artifact plan-tts-implementation.md.", "artifact_record")
  ];
}

function providerToolTurn(
  id: string,
  providerToolCalls: Array<{ id: string; name: string; argumentsText: string }>,
  echoValue: string
): SessionMessage {
  return sessionMessage(id, "agent", "Visible provider tool-call content.", {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: true,
    providerToolCalls,
    providerReplayEcho: {
      field: "reasoning_content",
      value: echoValue,
      providerFamily: "kimi",
      apiMode: "openai_chat_completions",
      chars: echoValue.length
    }
  });
}

function toolResult(id: string, toolCallId: string, content: string, toolName: string): SessionMessage {
  return sessionMessage(id, "tool", content, {
    tool_call_id: toolCallId,
    tool_call_name: toolName
  });
}

function sessionMessage(
  id: string,
  role: SessionMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sessionId: "stale-provider-replay-regression",
    role,
    content,
    createdAt: `2026-06-23T00:${String(id.length).padStart(2, "0")}:00.000Z`,
    ...(metadata === undefined ? {} : { metadata })
  };
}

function textContent(messages: ProviderMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content.map((part) =>
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
          ? part.text
          : ""
      ).join("\n");
    }
    return "";
  }).join("\n\n");
}

function assistantToolMessages(
  messages: ProviderMessage[]
): Array<ProviderMessage & { role: "assistant"; toolCalls: NonNullable<ProviderMessage["toolCalls"]> }> {
  return messages.filter((message): message is ProviderMessage & {
    role: "assistant";
    toolCalls: NonNullable<ProviderMessage["toolCalls"]>;
  } =>
    message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0
  );
}

function collectToolCalls(messages: ProviderMessage[]): Array<{ id: string; name: string }> {
  return assistantToolMessages(messages).flatMap((message) =>
    message.toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name }))
  );
}

function assertNoStaleReasoning(messages: ProviderMessage[]): void {
  expect(textContent(messages)).not.toContain(staleBaiObjective);
  expect(textContent(messages)).not.toContain(staleTtsPath);
  expect(JSON.stringify(messages)).not.toContain(staleBaiObjective);
  expect(JSON.stringify(messages)).not.toContain(staleTtsPath);
}
