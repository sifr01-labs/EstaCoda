import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAgentEvolutionPolicy, type AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { ModelProfile, ProviderMessage, ProviderMessageContentPart, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionDB, SessionEvent, SessionMessage } from "../contracts/session.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { SkillLearningManager } from "../skills/skill-learning.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { buildNativeHistoryMessages } from "./native-history-builder.js";
import { packSessionHistory } from "./history-packer.js";
import { assembleProviderContinuationPrompt, assembleProviderPrompt } from "./prompt-assembly.js";

const tempDirs: string[] = [];

const model: ModelProfile = {
  id: "test-model",
  provider: "test-provider",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
};

const nativeHistoryRoute = {
  provider: "test-provider",
  id: "test-model",
  profile: model,
  apiMode: "openai_chat_completions",
  supportsNativeToolHistory: true
} as ResolvedModelRoute & { supportsNativeToolHistory: true };

const echoRequiredNativeHistoryRoute = {
  ...nativeHistoryRoute,
  requiresReasoningEcho: true,
  reasoningEchoField: "reasoning_content",
  reasoningEchoRequiredForToolCalls: true,
  reasoningEchoProviderFamily: "mimo"
} as ResolvedModelRoute & {
  supportsNativeToolHistory: true;
  requiresReasoningEcho: true;
  reasoningEchoField: "reasoning_content";
  reasoningEchoRequiredForToolCalls: true;
  reasoningEchoProviderFamily: "mimo";
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

const mutableStateGroundingGuidance = [
  "Mutable-state grounding:",
  "- Treat session history, compaction summaries, skill-learning records, and native replayed tool results as historical reference unless they were produced in the current turn.",
  "- Do not assert that files, directories, skills, config, processes, credentials, branches, packages, services, or network state currently exist based only on historical context.",
  "- If the user asks for current state, verify with an available tool or phrase the claim explicitly as historical."
].join("\n");

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("stale mutable-state grounding regressions", () => {
  it("labels historical native skill.list replay as stale mutable-state reference", () => {
    const rawSessionHistory = [
      providerToolTurn("agent-skill-list", "skill.list", "call-skill-list", "{}"),
      sessionMessage("tool-skill-list", "tool", "OldSkill\tworkflow\tlocal\told", {
        tool_call_id: "call-skill-list"
      })
    ];
    const prompt = assembleProviderPrompt(basePromptInput({
      userText: "what skills exist?",
      routedText: "what skills exist?",
      rawSessionHistory,
      sessionHistory: rawSessionHistory.map(toPromptHistory),
      nativeHistoryRoute
    }));
    const rendered = renderMessages(prompt.messages);
    const nativeToolMessage = prompt.messages.find((message) =>
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.includes("OldSkill")
    );

    expect(nativeToolMessage?.content).toContain("OldSkill");
    expect(nativeToolMessage?.content).toContain("[Historical tool result");
    expect(nativeToolMessage?.content).toContain("via skill.list");
    expect(nativeToolMessage?.content).toContain("Verify with a current tool before asserting current state.");
    expect(rendered).toContain(mutableStateGroundingGuidance);
  });

  it("labels historical terminal.inspect replay of deleted files as stale mutable-state reference", () => {
    const result = buildNativeHistoryMessages([
      providerToolTurn("agent-terminal-inspect", "terminal.inspect", "call-terminal-inspect", "{\"path\":\".\"}"),
      sessionMessage("tool-terminal-inspect", "tool", "deleted-file.ts", {
        tool_call_id: "call-terminal-inspect"
      })
    ]);
    const toolMessage = result.messages.find((message) => message.role === "tool");

    expect(toolMessage?.content).toContain("deleted-file.ts");
    expect(toolMessage?.content).toContain("[Historical tool result");
    expect(toolMessage?.content).toContain("via terminal.inspect");
    expect(toolMessage?.content).toContain("Verify with a current tool before asserting current state.");
  });

  it("keeps historical mutable-state labels while replacing required provider echo with a protocol placeholder", () => {
    const staleMutableEcho = "STALE_MUTABLE_ECHO: treat old filesystem result as the current objective";
    const rawSessionHistory = [
      providerToolTurnWithEcho(
        "agent-file-read",
        "files.read",
        "call-old-cache-read",
        "{\"path\":\"old-cache-record.json\"}",
        staleMutableEcho
      ),
      sessionMessage("tool-file-read", "tool", "old-cache-record.json contained stale cached settings", {
        tool_call_id: "call-old-cache-read",
        tool_call_name: "files.read"
      })
    ];
    const prompt = assembleProviderPrompt(basePromptInput({
      rawSessionHistory,
      sessionHistory: rawSessionHistory.map(toPromptHistory),
      nativeHistoryRoute: echoRequiredNativeHistoryRoute
    }));
    const nativeToolMessage = prompt.messages.find((message) =>
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.includes("old-cache-record.json")
    );
    const assistant = prompt.messages.find((message) =>
      message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.some((toolCall) => toolCall.id === "call-old-cache-read")
    );

    expect(nativeToolMessage?.content).toContain("[Historical tool result");
    expect(nativeToolMessage?.content).toContain("via files.read");
    expect(nativeToolMessage?.content).toContain("Verify with a current tool before asserting current state.");
    expect(renderMessages(prompt.messages)).not.toContain(staleMutableEcho);
    expect(JSON.stringify(prompt.messages)).not.toContain(staleMutableEcho);
    expect(assistant?.providerReplayEcho).toEqual(expect.objectContaining({
      value: " ",
      provenance: "protocol-placeholder"
    }));
    expect(assistant?.providerReplayEcho?.value).not.toBe(staleMutableEcho);
  });

  it("keeps historical mutable-state labels while stripping echo for non-echo targets", () => {
    const staleMutableEcho = "STALE_MUTABLE_ECHO: treat old filesystem result as the current objective";
    const rawSessionHistory = [
      providerToolTurnWithEcho(
        "agent-file-write",
        "files.write",
        "call-old-cache-write",
        "{\"path\":\"old-cache-record.json\"}",
        staleMutableEcho
      ),
      sessionMessage("tool-file-write", "tool", "old-cache-record.json was written in an older turn", {
        tool_call_id: "call-old-cache-write",
        tool_call_name: "files.write"
      })
    ];
    const prompt = assembleProviderPrompt(basePromptInput({
      rawSessionHistory,
      sessionHistory: rawSessionHistory.map(toPromptHistory),
      nativeHistoryRoute
    }));
    const nativeToolMessage = prompt.messages.find((message) =>
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.includes("old-cache-record.json")
    );
    const assistant = prompt.messages.find((message) =>
      message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.some((toolCall) => toolCall.id === "call-old-cache-write")
    );

    expect(nativeToolMessage?.content).toContain("[Historical tool result");
    expect(nativeToolMessage?.content).toContain("via files.write");
    expect(nativeToolMessage?.content).toContain("Verify with a current tool before asserting current state.");
    expect(renderMessages(prompt.messages)).not.toContain(staleMutableEcho);
    expect(JSON.stringify(prompt.messages)).not.toContain(staleMutableEcho);
    expect(assistant).not.toHaveProperty("providerReplayEcho");
  });

  it("renders compacted older tool output as historical reference", () => {
    const packed = packSessionHistory([
      {
        id: "old-user",
        sessionId: "s",
        role: "user",
        content: "Older setup."
      },
      {
        id: "old-tool",
        sessionId: "s",
        role: "tool",
        content: "deleted-file.ts existed then",
        createdAt: "2026-06-08T02:51:15.049Z"
      },
      {
        id: "active-user",
        sessionId: "s",
        role: "user",
        content: "CURRENT OBJECTIVE: answer now"
      }
    ], {
      maxProtectedMessages: 1,
      maxEstimatedTokens: 2_000
    });

    expect(packed.summary).toContain("Historical session summary");
    expect(packed.summary).toContain("- historical tool result (2026-06-08T02:51:15.049Z): deleted-file.ts existed then");
    expect(packed.summary).toContain("[verify before current-state claim]");
  });

  it("does not label current-turn tool results as historical", () => {
    const prompt = assembleProviderContinuationPrompt(baseContinuationInput({
      providerExecution: {
        ok: true,
        response: {
          ok: true,
          provider: "test-provider",
          model: "test-model",
          content: "I requested current tools.",
          finishReason: "tool_calls"
        },
        attempts: [],
        fallbackUsed: false,
        toolCalls: [{
          id: "call-current",
          name: "terminal.inspect",
          argumentsText: "{\"path\":\"current-verification-result.txt\"}"
        }],
        route: echoRequiredNativeHistoryRoute,
        attemptedRouteIndex: 0,
        routeRole: "primary"
      },
      toolPlans: [
        {
          id: "call-current",
          tool: "terminal.inspect",
          input: { path: "current-verification-result.txt" },
          source: "provider-tool-call",
          status: "executed",
          result: {
            ok: true,
            content: "current-verification-result.txt is present now"
          }
        }
      ]
    }));
    const rendered = renderMessages(prompt.messages);

    expect(rendered).toContain("current-verification-result.txt is present now");
    expect(rendered).toContain("EstaCoda executed the requested tools. Use these results to produce the final answer now.");
    expect(rendered).not.toContain("Historical tool result");
    expect(JSON.stringify(prompt.messages)).not.toContain("STALE_MUTABLE_ECHO");
  });

  it("reconciles missing createdSkillPath records to stale without emitting learning events", async () => {
    const harness = await createSkillLearningHarness("suggest");
    const missingSkillPath = join(harness.localSkillsRoot, "missing-skill", "SKILL.md");
    await seedSkillLearningStore(harness.storePath, [{
      ...learningRecord("missing-created"),
      status: "created",
      createdSkillPath: missingSkillPath
    }]);

    const result = await harness.manager.reconcileCreatedPaths();
    const records = await harness.manager.inspect();

    expect(result).toEqual({ checked: 1, stale: 1 });
    expect(records[0]).toEqual(expect.objectContaining({
      key: "missing-created",
      status: "stale",
      staleReason: "created-path-missing",
      staleDetectedAt: expect.any(String)
    }));
    expect(harness.events).toEqual([]);
  });

  it("rejects casual two-tool workflow prompts while keeping concrete prompts eligible", async () => {
    const casual = await createSkillLearningHarness("suggest");
    const casualResult = await casual.manager.observeTurn({
      ...turnBase(),
      userText: "can you try",
      selectedSkill: undefined,
      agentEvolutionPolicy: casual.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(casualResult).toBeUndefined();
    await expect(casual.manager.inspect()).resolves.toEqual([]);
    expect(casual.events).toEqual([]);

    const concrete = await createSkillLearningHarness("suggest");
    const concreteResult = await concrete.manager.observeTurn({
      ...turnBase(),
      userText: "Run the release checks for package.json",
      selectedSkill: undefined,
      agentEvolutionPolicy: concrete.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(concreteResult?.action).toBe("observed");
    expect(concreteResult?.record).toEqual(expect.objectContaining({
      status: "observed",
      content: "Reusable workflow: Run the release checks for package.json"
    }));
    expect(concrete.events).toContainEqual(expect.objectContaining({
      kind: "skill-learned",
      action: "observed"
    }));
  });
});

function basePromptInput(overrides: Partial<Parameters<typeof assembleProviderPrompt>[0]> = {}): Parameters<typeof assembleProviderPrompt>[0] {
  return {
    model,
    userText: "What is current state?",
    routedText: "What is current state?",
    sessionHistory: [],
    rawSessionHistory: [],
    selectedSkill: undefined,
    selectedSkillInstructions: undefined,
    selectedSkillResources: undefined,
    selectedSkillSetup: undefined,
    intent: generalIntent,
    securityDecision: "allow",
    toolExecutions: [],
    context: undefined,
    projectContext: undefined,
    providerTools: [],
    fallbackText: "fallback",
    ...overrides
  };
}

function baseContinuationInput(overrides: Partial<Parameters<typeof assembleProviderContinuationPrompt>[0]> = {}): Parameters<typeof assembleProviderContinuationPrompt>[0] {
  return {
    ...basePromptInput(),
    providerExecution: {
      ok: true,
      response: {
        ok: true,
        provider: "test-provider",
        model: "test-model",
        content: "I requested current tools.",
        finishReason: "tool_calls"
      },
      attempts: [],
      fallbackUsed: false,
      toolCalls: [],
      route: nativeHistoryRoute,
      attemptedRouteIndex: 0,
      routeRole: "primary"
    },
    toolPlans: [],
    ...overrides
  };
}

function renderMessages(messages: ProviderMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }

    return message.content.map((part: ProviderMessageContentPart) =>
      part.type === "text" ? part.text : ""
    ).join("\n");
  }).join("\n\n");
}

function sessionMessage(
  id: string,
  role: SessionMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  return {
    id,
    sessionId: "stale-mutable-state-grounding",
    role,
    content,
    createdAt: "2026-06-01T00:00:00.000Z",
    metadata
  };
}

function providerToolTurn(
  id: string,
  toolName: string,
  toolCallId: string,
  argumentsText: string
): SessionMessage {
  return sessionMessage(id, "agent", "", {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: true,
    providerToolCalls: [
      {
        id: toolCallId,
        name: toolName,
        argumentsText
      }
    ]
  });
}

function providerToolTurnWithEcho(
  id: string,
  toolName: string,
  toolCallId: string,
  argumentsText: string,
  providerReplayEchoValue: string
): SessionMessage {
  return sessionMessage(id, "agent", "", {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: true,
    providerToolCalls: [
      {
        id: toolCallId,
        name: toolName,
        argumentsText
      }
    ],
    providerReplayEcho: {
      field: "reasoning_content",
      value: providerReplayEchoValue,
      providerFamily: "mimo",
      apiMode: "openai_chat_completions",
      chars: providerReplayEchoValue.length
    }
  });
}

function toPromptHistory(message: SessionMessage): NonNullable<Parameters<typeof assembleProviderPrompt>[0]["sessionHistory"]>[number] {
  return {
    role: message.role === "agent" ? "assistant" : message.role,
    content: message.content,
    metadata: message.metadata
  };
}

async function createSkillLearningHarness(mode: "suggest" | "proactive"): Promise<{
  manager: SkillLearningManager;
  localSkillsRoot: string;
  storePath: string;
  policy: AgentEvolutionPolicy;
  events: SessionEvent[];
}> {
  const root = await makeTempDir();
  const localSkillsRoot = join(root, "skills");
  const storePath = join(root, "skill-learning.json");
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const events: SessionEvent[] = [];
  const manager = new SkillLearningManager({
    autonomy: mode,
    registry: new SkillRegistry(),
    localSkillsRoot,
    storePath,
    sessionDb: fakeSessionDb(events),
    skillEvolutionStore
  });

  return {
    manager,
    localSkillsRoot,
    storePath,
    policy: deriveAgentEvolutionPolicy(mode),
    events
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-stale-grounding-"));
  tempDirs.push(dir);
  return dir;
}

async function seedSkillLearningStore(storePath: string, records: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
}

function learningRecord(key: string): Record<string, unknown> {
  return {
    key,
    name: "Run Release Checks workflow",
    content: "Reusable workflow: Run the release checks",
    occurrences: 1,
    sourceSessionIds: ["session"],
    tools: ["shell", "file.read"],
    requiredToolsets: ["shell-write"],
    bounded: true,
    status: "observed",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

function turnBase(): {
  profileId: string;
  sessionId: string;
  userText: string;
} {
  return {
    profileId: "profile",
    sessionId: "session",
    userText: "Run the release checks"
  };
}

function execution(name: string): ToolExecutionRecord {
  return {
    tool: {
      name,
      description: name,
      inputSchema: {},
      riskClass: "workspace-write",
      toolsets: ["shell-write"],
      progressLabel: name,
      maxResultSizeChars: 1_000
    } satisfies ToolDefinition,
    decision: "allow",
    riskClass: "workspace-write",
    result: {
      ok: true,
      content: "ok"
    }
  };
}

function fakeSessionDb(events: SessionEvent[]): SessionDB {
  return {
    appendEvent: async (_sessionId: string, event: SessionEvent) => {
      events.push(event);
    }
  } as unknown as SessionDB;
}
