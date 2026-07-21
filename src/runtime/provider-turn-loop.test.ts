import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { ModelProfile, ResolvedModelRoute, ProviderRequest, ProviderResponse, ProviderStreamDiagnostics } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ReplacementSessionMessage, SessionDB, SessionEvent } from "../contracts/session.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { SessionCompressionService, type CompactResult } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { stableToolCallId, ToolCallPlanner } from "../tools/tool-call-planner.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { RunRecorder } from "./run-recorder.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
import { ProviderTurnLoop, type ProviderTurnLoopOptions } from "./provider-turn-loop.js";

function createMockAdapter() {
  return {
    id: "test-provider" as const,
    name: "Test Provider",
    executable: true,
    health() {
      return { available: true };
    },
    listModels() {
      return [];
    },
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        ok: true,
        content: "mock-response",
        model: request.model,
        provider: "test-provider"
      };
    }
  };
}

const mockModel: ModelProfile = {
  id: "test-model",
  provider: "test-provider",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const primaryRoute: ResolvedModelRoute = {
  provider: "test-provider",
  id: "test-model",
  profile: mockModel,
  baseUrl: "https://primary.example.com/v1",
  apiKeyEnv: "PRIMARY_KEY"
};
const DISPATCHED_AT = "2030-01-01T00:00:00.000Z";

const nativeHistoryRoute = {
  ...primaryRoute,
  apiMode: "openai_chat_completions",
  supportsNativeToolHistory: true
} as ResolvedModelRoute & { supportsNativeToolHistory: true };

function echoRequiredRoute(): ResolvedModelRoute {
  return {
    provider: "deepseek",
    id: "deepseek-reasoner",
    profile: {
      ...mockModel,
      id: "deepseek-reasoner",
      provider: "deepseek"
    },
    baseUrl: "https://api.deepseek.example/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiMode: "openai_chat_completions",
    supportsNativeToolHistory: true,
    requiresReasoningEcho: true,
    reasoningEchoField: "reasoning_content",
    reasoningEchoRequiredForToolCalls: true,
    reasoningEchoProviderFamily: "deepseek"
  } as ResolvedModelRoute & {
    supportsNativeToolHistory: boolean;
    requiresReasoningEcho: boolean;
    reasoningEchoField: "reasoning_content";
    reasoningEchoRequiredForToolCalls: boolean;
    reasoningEchoProviderFamily: "deepseek";
  };
}

const fallbackRoute: ResolvedModelRoute = {
  provider: "test-provider",
  id: "test-model-fallback",
  profile: {
    id: "test-model-fallback",
    provider: "test-provider",
    contextWindowTokens: 64_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  },
  baseUrl: "https://fallback.example.com/v1",
  apiKeyEnv: "FALLBACK_KEY"
};

const secondFallbackRoute: ResolvedModelRoute = {
  provider: "test-provider",
  id: "test-model-second-fallback",
  profile: {
    id: "test-model-second-fallback",
    provider: "test-provider",
    contextWindowTokens: 64_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  },
  baseUrl: "https://second-fallback.example.com/v1",
  apiKeyEnv: "SECOND_FALLBACK_KEY"
};

const testTool: ToolDefinition = {
  name: "test.tool",
  description: "Test tool",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["test"],
  progressLabel: "testing",
  maxResultSizeChars: 1000
};

async function createProviderTurnLoopForTest(
  overrides: Partial<Pick<ProviderTurnLoopOptions, "providerExecutor" | "model">> = {}
): Promise<ProviderTurnLoop> {
  const registry = new ProviderRegistry();
  registry.register(createMockAdapter());
  const providerExecutor = new ProviderExecutor({ registry });
  const sessionDb = new InMemorySessionDB();
  const sessionId = `test-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner: undefined,
    toolExecutor: {} as any,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });

  return new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: 2,
      maxProviderToolCalls: 4,
      maxRepeatedToolFailures: 2,
      maxProviderWallClockMs: 10_000
    },
    ...overrides
  });
}

async function createCompressionHarness() {
  const registry = new ProviderRegistry();
  registry.register(createMockAdapter());
  const providerExecutor = new ProviderExecutor({ registry });
  const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
    ok: true,
    response: {
      ok: true,
      content: "mock-response",
      model: "test-model",
      provider: "test-provider",
      usage: {
        inputTokens: 123,
        outputTokens: 12,
        totalTokens: 135
      }
    },
    fallbackUsed: false,
    attempts: [
      {
        provider: "test-provider",
        model: "test-model",
        state: "dispatched",
        dispatchedAt: DISPATCHED_AT,
        ok: true,
        content: "mock-response"
      }
    ],
    toolCalls: []
  });
  const sessionDb = new InMemorySessionDB();
  const sessionId = `compression-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "compression" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner: undefined,
    toolExecutor: {} as any,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });
  const loop = (overrides: Partial<ProviderTurnLoopOptions> = {}) => new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: 2,
      maxProviderToolCalls: 4,
      maxRepeatedToolFailures: 2,
      maxProviderWallClockMs: 10_000
    },
    ...overrides
  });

  return {
    sessionDb,
    sessionId,
    providerExecutor,
    completeSpy,
    loop
  };
}

async function appendHistory(db: InMemorySessionDB, sessionId: string, content: string): Promise<void> {
  await db.appendMessage({
    id: `${sessionId}-history`,
    sessionId,
    role: "user",
    content
  });
  await db.appendMessage({
    id: `${sessionId}-latest`,
    sessionId,
    role: "user",
    content: "current user request"
  });
}

async function appendProviderToolHistory(db: InMemorySessionDB, sessionId: string): Promise<void> {
  await db.appendMessage({
    id: `${sessionId}-provider-tool-turn`,
    sessionId,
    role: "agent",
    content: "provider tool call",
    metadata: {
      kind: "provider-tool-call-turn",
      nativeReplaySafe: true,
      providerToolCalls: [
        {
          id: "call-native-history",
          name: testTool.name,
          argumentsText: "{\"path\":\"src/index.ts\"}"
        }
      ],
      provider: "test-provider",
      model: "test-model"
    }
  });
  await db.appendMessage({
    id: `${sessionId}-provider-tool-result`,
    sessionId,
    role: "tool",
    content: "native replay tool result",
    metadata: {
      tool_call_id: "call-native-history",
      tool_call_name: testTool.name
    }
  });
}

async function runBasicProviderTurn(
  loop: ProviderTurnLoop,
  callbacks: {
    onEvent?: (event: RuntimeEvent) => void;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
    attachments?: ChannelAttachment[];
    visibleTurnId?: string;
  } = {}
): Promise<Awaited<ReturnType<ProviderTurnLoop["run"]>>> {
  return await loop.run({
    visibleTurnId: callbacks.visibleTurnId,
    userText: "current user request",
    routedText: "current user request",
    selectedSkill: undefined,
    selectedSkillInstructions: undefined,
    selectedSkillResources: undefined,
    selectedSkillSetup: undefined,
    intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
    securityDecision: "allow",
    toolExecutions: [],
    context: undefined,
    projectContext: undefined,
    attachments: callbacks.attachments,
    memoryPromptContext: undefined,
    providerTools: [],
    fallbackText: "",
    toolPlans: [],
    trustedWorkspace: false,
    initialRiskClass: "read-only-local",
    onEvent: callbacks.onEvent,
    onDelta: callbacks.onDelta,
    onSegmentBreak: callbacks.onSegmentBreak
  });
}

function providerExecution(
  content: string,
  toolCalls: ProviderExecutionResult["toolCalls"] = [],
  overrides: Partial<ProviderExecutionResult> = {}
): ProviderExecutionResult {
  const response = {
    ok: true,
    content,
    model: "test-model",
    provider: "test-provider",
    ...overrides.response
  } satisfies ProviderResponse;
  const attempts = overrides.attempts ?? [
    {
      provider: "test-provider",
      model: "test-model",
      state: "dispatched" as const,
      dispatchedAt: DISPATCHED_AT,
      ok: true,
      content,
      ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
      ...(response.incompleteReason === undefined ? {} : { incompleteReason: response.incompleteReason }),
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      ...(response.reasoningMetadata === undefined ? {} : { reasoningMetadata: response.reasoningMetadata })
    }
  ];

  return {
    ok: true,
    response,
    fallbackUsed: false,
    attempts,
    toolCalls,
    runtimeMetadata: response.reasoningMetadata === undefined
      ? undefined
      : { reasoning: response.reasoningMetadata },
    ...overrides
  };
}

function incompleteStreamExecution(partialContent: string | undefined): ProviderExecutionResult {
  return {
    ok: false,
    partialContent,
    fallbackUsed: false,
    attempts: [
      {
        provider: "test-provider",
        model: "test-model",
        state: "dispatched",
        dispatchedAt: DISPATCHED_AT,
        ok: false,
        errorClass: "incomplete-stream",
        content: "Provider stream ended before completion after partial output.",
        ...(partialContent === undefined ? {} : { partialContent })
      }
    ],
    toolCalls: []
  };
}

function providerToolCall(id: string, argumentsText = "{}"): ProviderExecutionResult["toolCalls"][number] {
  return {
    id,
    name: testTool.name,
    argumentsText
  };
}

function truncatedToolCallExecution(input: {
  id: string;
  argumentsText?: string;
  route?: ResolvedModelRoute;
  attemptedRouteIndex?: number;
  fallbackUsed?: boolean;
  attempts?: ProviderExecutionResult["attempts"];
}): ProviderExecutionResult {
  const route = input.route ?? primaryRoute;
  const attemptedRouteIndex = input.attemptedRouteIndex ?? 0;
  const overrides: Partial<ProviderExecutionResult> = {
    response: {
      ok: true,
      content: "",
      finishReason: "length",
      model: route.id,
      provider: route.provider
    },
    route,
    attemptedRouteIndex,
    routeRole: attemptedRouteIndex === 0 ? "primary" : "fallback",
    fallbackUsed: input.fallbackUsed ?? attemptedRouteIndex > 0
  };
  if (input.attempts !== undefined) {
    overrides.attempts = input.attempts;
  }
  return providerExecution("", [providerToolCall(input.id, input.argumentsText)], overrides);
}

function lengthTruncatedTextExecution(input: {
  content: string;
  route?: ResolvedModelRoute;
  attemptedRouteIndex?: number;
  fallbackUsed?: boolean;
  attempts?: ProviderExecutionResult["attempts"];
}): ProviderExecutionResult {
  const route = input.route ?? primaryRoute;
  const attemptedRouteIndex = input.attemptedRouteIndex ?? 0;
  const overrides: Partial<ProviderExecutionResult> = {
    response: {
      ok: true,
      content: input.content,
      finishReason: "length",
      model: route.id,
      provider: route.provider
    },
    route,
    attemptedRouteIndex,
    routeRole: attemptedRouteIndex === 0 ? "primary" : "fallback",
    fallbackUsed: input.fallbackUsed ?? attemptedRouteIndex > 0
  };
  if (input.attempts !== undefined) {
    overrides.attempts = input.attempts;
  }
  return providerExecution(input.content, [], overrides);
}

function reasoningOnlyExecution(input: {
  reasoning: string;
  finishReason?: ProviderResponse["finishReason"];
}): ProviderExecutionResult {
  const reasoningMetadata = {
    present: true,
    chars: input.reasoning.length,
    format: "reasoning_content" as const
  };
  return providerExecution("", [], {
    response: {
      ok: true,
      content: "",
      model: "test-model",
      provider: "test-provider",
      reasoning: input.reasoning,
      reasoningMetadata,
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason })
    },
    runtimeMetadata: {
      reasoning: reasoningMetadata
    }
  });
}

function metadataOnlyReasoningExecution(input: {
  chars: number;
  finishReason?: ProviderResponse["finishReason"];
}): ProviderExecutionResult {
  const reasoningMetadata = {
    present: true,
    chars: input.chars,
    format: "reasoning_details" as const
  };
  return providerExecution("", [], {
    response: {
      ok: true,
      content: "",
      model: "test-model",
      provider: "test-provider",
      reasoningMetadata,
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason })
    },
    runtimeMetadata: {
      reasoning: reasoningMetadata
    }
  });
}

function toolExecution(id: string, content = `tool result ${id}`): ToolExecutionRecord {
  return toolExecutionForTool(id, testTool.name, content);
}

function toolExecutionForTool(id: string, toolName: string, content = `tool result ${id}`): ToolExecutionRecord {
  const tool = {
    ...testTool,
    name: toolName
  };

  return {
    tool,
    input: {},
    decision: "allow",
    riskClass: "read-only-local",
    toolCallId: id,
    toolCallName: toolName,
    result: {
      ok: true,
      content
    }
  };
}

function toolPlan(id: string, status: ToolCallPlan["status"] = "executed"): ToolCallPlan {
  return {
    id,
    tool: testTool.name,
    input: {},
    source: "provider-tool-call",
    status,
    result: status === "executed"
      ? {
          ok: true,
          content: `tool result ${id}`
        }
      : undefined
  };
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

async function createPostToolNudgeHarness(input: {
  responses: ProviderExecutionResult[];
  toolSteps: Array<{
    executions?: ToolExecutionRecord[];
    plans?: ToolCallPlan[];
  }>;
  model?: ModelProfile;
  primaryModelRoute?: ResolvedModelRoute;
  modelFallbackRoutes?: ResolvedModelRoute[];
  maxProviderIterations?: number;
  maxProviderWallClockMs?: number;
  onExecutePlans?: (input: {
    sessionDb: InMemorySessionDB;
    sessionId: string;
    stepInput: Parameters<ToolPlanRunner["executePlans"]>[0];
  }) => Promise<void> | void;
}) {
  let responseIndex = 0;
  const completeSpy = vi.fn<ProviderExecutor["complete"]>(async (_request, _preferences, options) => {
    const response = input.responses[Math.min(responseIndex, input.responses.length - 1)] ?? providerExecution("");
    responseIndex += 1;
    for (const toolCall of response.toolCalls) {
      await options?.onEvent?.({
        kind: "provider-tool-call",
        provider: response.response?.provider ?? "test-provider",
        model: response.response?.model ?? "test-model",
        index: toolCall.index,
        id: toolCall.id,
        name: toolCall.name,
        argumentsText: toolCall.argumentsText,
        raw: toolCall.raw
      });
    }
    return response;
  });
  const providerExecutor = {
    complete: completeSpy
  } as unknown as ProviderExecutor;
  const sessionDb = new InMemorySessionDB();
  const sessionId = `nudge-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "nudge" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  let toolStepIndex = 0;
  const executePlans = vi.fn(async (stepInput: Parameters<ToolPlanRunner["executePlans"]>[0]) => {
    await input.onExecutePlans?.({ sessionDb, sessionId, stepInput });
    const step = input.toolSteps[toolStepIndex] ?? {};
    toolStepIndex += 1;
    for (const plan of step.plans ?? []) {
      stepInput.toolPlans.push(plan);
    }
    for (const execution of step.executions ?? []) {
      stepInput.toolPlans.push(toolPlan(execution.toolCallId ?? execution.tool.name));
    }
    return {
      executions: step.executions ?? [],
      maxObservedRisk: stepInput.riskBaseline
    };
  });
  const toolPlanRunner = {
    executePlans
  } as unknown as ToolPlanRunner;
  const loop = new ProviderTurnLoop({
    providerExecutor,
    model: input.model ?? mockModel,
    primaryModelRoute: input.primaryModelRoute ?? primaryRoute,
    modelFallbackRoutes: input.modelFallbackRoutes ?? [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: input.maxProviderIterations ?? 3,
      maxProviderToolCalls: 8,
      maxRepeatedToolFailures: 3,
      maxProviderWallClockMs: input.maxProviderWallClockMs ?? 10_000
    }
  });

  return {
    loop,
    completeSpy,
    executePlans,
    sessionDb,
    sessionId
  };
}

async function createRealToolPlanningHarness(input: {
  response: ProviderExecutionResult;
}) {
  const completeSpy = vi.fn<ProviderExecutor["complete"]>(async (_request, _preferences, options) => {
    for (const toolCall of input.response.toolCalls) {
      await options?.onEvent?.({
        kind: "provider-tool-call",
        provider: input.response.response?.provider ?? "test-provider",
        model: input.response.response?.model ?? "test-model",
        index: toolCall.index,
        id: toolCall.id,
        name: toolCall.name,
        argumentsText: toolCall.argumentsText,
        raw: toolCall.raw
      });
    }
    return input.response;
  });
  const providerExecutor = {
    complete: completeSpy
  } as unknown as ProviderExecutor;
  const sessionDb = new InMemorySessionDB();
  const sessionId = `real-planning-session-${Date.now()}-${Math.random()}`;
  await sessionDb.createSession({ id: sessionId, profileId: "default", title: "real-planning" });
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "default",
    sessionId,
    modelId: "test-model"
  });
  const runRecorder = new RunRecorder({
    sessionDb,
    sessionId,
    trajectoryRecorder,
    profileId: "default"
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    ...testTool,
    isAvailable: () => true,
    run: async () => ({ ok: true, content: "should not execute" })
  });
  const executeTool = vi.fn();
  const toolPlanRunner = new ToolPlanRunner({
    toolCallPlanner: new ToolCallPlanner({ registry: toolRegistry }),
    toolExecutor: {
      getToolDefinition: (name: string) => name === testTool.name ? testTool : undefined,
      executeTool
    } as never,
    runRecorder,
    sessionId,
    maxConcurrentSafeTools: 4
  });
  const loop = new ProviderTurnLoop({
    providerExecutor,
    model: mockModel,
    primaryModelRoute: primaryRoute,
    modelFallbackRoutes: [fallbackRoute],
    providerPreferences: {
      providerOrder: ["test-provider"]
    },
    sessionDb,
    sessionId,
    profileId: "default",
    trajectoryRecorder,
    runRecorder,
    toolPlanRunner,
    soul: undefined,
    memoryPromptContext: undefined,
    skillsIndex: [],
    ui: undefined,
    agentProfile: undefined,
    budgets: {
      maxProviderIterations: 1,
      maxProviderToolCalls: 8,
      maxRepeatedToolFailures: 3,
      maxProviderWallClockMs: 10_000
    }
  });

  return {
    loop,
    completeSpy,
    executeTool
  };
}

function compressionDiagnostics(
  overrides: Partial<CompactResult["diagnostics"]> = {}
): CompactResult["diagnostics"] {
  return {
    shouldCompress: true,
    reason: "above-threshold",
    preTokens: 100,
    postTokens: 40,
    estimatedSavingsTokens: 60,
    estimatedSavingsRatio: 0.6,
    sourceMessageCount: 2,
    summarizedMessageCount: 1,
    protectedMessageCount: 1,
    protectedFirstN: 0,
    protectedLastN: 1,
    protectedSpans: [{ startMessageId: "current-user", endMessageId: "current-user", messageCount: 1 }],
    protectedCategories: ["current_user_request" as const],
    summaryFormatVersion: "v1",
    summaryChars: 40,
    fallbackUsed: false,
    warnings: [],
    prunedToolResults: 0,
    prunedToolResultChars: 0,
    protectedToolResultsKept: 0,
    scopeKey: "default:test",
    ineffectiveCompressionCount: 0,
    eventWarnings: [],
    ...overrides
  };
}

function forwardingSessionDb(db: InMemorySessionDB, overrides: Partial<SessionDB>): SessionDB {
  return {
    createSession: overrides.createSession ?? db.createSession.bind(db),
    getSession: overrides.getSession ?? db.getSession.bind(db),
    listSessions: overrides.listSessions ?? db.listSessions.bind(db),
    endSession: overrides.endSession ?? db.endSession.bind(db),
    appendMessage: overrides.appendMessage ?? db.appendMessage.bind(db),
    replaceMessages: overrides.replaceMessages ?? db.replaceMessages.bind(db),
    rewriteTranscript: overrides.rewriteTranscript ?? db.rewriteTranscript.bind(db),
    appendEvent: overrides.appendEvent ?? db.appendEvent.bind(db),
    recordProviderUsageEntries: overrides.recordProviderUsageEntries ?? db.recordProviderUsageEntries.bind(db),
    listProviderUsageEntries: overrides.listProviderUsageEntries ?? db.listProviderUsageEntries.bind(db),
    listMessages: overrides.listMessages ?? db.listMessages.bind(db),
    listEvents: overrides.listEvents ?? db.listEvents.bind(db),
    search: overrides.search ?? db.search.bind(db),
    setSessionModelOverride: overrides.setSessionModelOverride ?? db.setSessionModelOverride.bind(db),
    clearSessionModelOverride: overrides.clearSessionModelOverride ?? db.clearSessionModelOverride.bind(db),
    getSessionModelOverride: overrides.getSessionModelOverride ?? db.getSessionModelOverride.bind(db),
    saveFailure: overrides.saveFailure ?? db.saveFailure.bind(db)
  };
}

describe("ProviderTurnLoop streaming callbacks", () => {
  it("continues emitting provider-token events when callbacks are omitted", async () => {
    const harness = await createCompressionHarness();
    harness.completeSpy.mockImplementation(async (_request, _preferences, options) => {
      await options?.onEvent?.({
        kind: "provider-token",
        provider: "test-provider",
        model: "test-model",
        text: "hello"
      });
      return providerExecution("hello");
    });
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop(), { onEvent: (event) => events.push(event) });

    expect(events).toContainEqual({
      kind: "provider-token",
      provider: "test-provider",
      model: "test-model",
      text: "hello"
    });
  });

  it("sends provider-token text to onDelta without changing provider-token event delivery", async () => {
    const harness = await createCompressionHarness();
    harness.completeSpy.mockImplementation(async (_request, _preferences, options) => {
      await options?.onEvent?.({
        kind: "provider-token",
        provider: "test-provider",
        model: "test-model",
        text: "hel"
      });
      await options?.onEvent?.({
        kind: "provider-token",
        provider: "test-provider",
        model: "test-model",
        text: "lo"
      });
      return providerExecution("hello");
    });
    const events: RuntimeEvent[] = [];
    const deltas: string[] = [];
    const order: string[] = [];

    await runBasicProviderTurn(harness.loop(), {
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "provider-token") {
          order.push(`event:${event.text}`);
        }
      },
      onDelta: (text) => {
        deltas.push(text);
        order.push(`delta:${text}`);
      }
    });

    expect(deltas).toEqual(["hel", "lo"]);
    expect(events.filter((event) => event.kind === "provider-token")).toHaveLength(2);
    expect(order).toEqual(["event:hel", "delta:hel", "event:lo", "delta:lo"]);
  });

  it("does not fire a segment break for no-tool provider responses", async () => {
    const harness = await createCompressionHarness();
    harness.completeSpy.mockImplementation(async (_request, _preferences, options) => {
      await options?.onEvent?.({
        kind: "provider-token",
        provider: "test-provider",
        model: "test-model",
        text: "hello"
      });
      return providerExecution("hello");
    });
    const events: RuntimeEvent[] = [];
    const onSegmentBreak = vi.fn();

    await runBasicProviderTurn(harness.loop(), {
      onEvent: (event) => events.push(event),
      onSegmentBreak
    });

    expect(onSegmentBreak).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "provider-token",
      provider: "test-provider",
      model: "test-model",
      text: "hello"
    });
  });

  it("does not fail the provider turn when onDelta throws", async () => {
    const harness = await createCompressionHarness();
    harness.completeSpy.mockImplementation(async (_request, _preferences, options) => {
      await options?.onEvent?.({
        kind: "provider-token",
        provider: "test-provider",
        model: "test-model",
        text: "hello"
      });
      return providerExecution("hello");
    });

    const result = await runBasicProviderTurn(harness.loop(), {
      onDelta: () => {
        throw new Error("observer failed");
      }
    });

    expect(result.providerExecution?.response?.content).toBe("hello");
  });

  it("fires one provider-tool-call segment break before tool execution", async () => {
    const order: string[] = [];
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [
          providerToolCall("call-one"),
          providerToolCall("call-two")
        ]),
        providerExecution("done")
      ],
      toolSteps: [
        { executions: [toolExecution("call-one"), toolExecution("call-two")] }
      ],
      onExecutePlans: () => {
        order.push("execute-tools");
      }
    });

    await runBasicProviderTurn(harness.loop, {
      onSegmentBreak: (reason) => {
        order.push(`segment:${reason ?? ""}`);
      }
    });

    expect(order.slice(0, 2)).toEqual(["segment:provider-tool-call", "execute-tools"]);
    expect(order.filter((entry) => entry === "segment:provider-tool-call")).toHaveLength(1);
  });

  it("does not fail the provider turn when onSegmentBreak throws", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-one")]),
        providerExecution("done")
      ],
      toolSteps: [
        { executions: [toolExecution("call-one")] }
      ]
    });

    const result = await runBasicProviderTurn(harness.loop, {
      onSegmentBreak: () => {
        throw new Error("observer failed");
      }
    });

    expect(result.providerExecution?.response?.content).toContain("done");
  });
});

describe("ProviderTurnLoop provider availability", () => {
  it("records ordinary provider requests against the persisted visible user turn", async () => {
    const harness = await createCompressionHarness();
    await appendHistory(harness.sessionDb, harness.sessionId, "history");
    harness.completeSpy.mockResolvedValueOnce({
      ok: false,
      fallbackUsed: true,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: "2030-01-01T00:00:00.000Z",
          ok: false,
          errorClass: "timeout",
          content: "",
          usage: { inputTokens: 25, outputTokens: 0, totalTokens: 25 }
        },
        {
          provider: "fallback-provider",
          model: "fallback-model",
          state: "preflight",
          ok: false,
          errorClass: "auth",
          content: ""
        }
      ],
      toolCalls: []
    });

    await runBasicProviderTurn(harness.loop(), { visibleTurnId: `${harness.sessionId}-latest` });

    const entries = await harness.sessionDb.listProviderUsageEntries("default", {
      visibleTurnId: `${harness.sessionId}-latest`
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: harness.sessionId,
      provider: "test-provider",
      providerAttemptIndex: 0,
      usageComplete: true
    });
  });

  it("can run provider when executor and configured model are present", async () => {
    const loop = await createProviderTurnLoopForTest();

    expect(loop.canRunProvider()).toBe(true);
  });

  it("resets provider-turn tool budgets once per run", async () => {
    const resetSpy = vi.spyOn(ToolPlanRunner.prototype, "resetPerTurnBudgets");
    const loop = await createProviderTurnLoopForTest();

    await runBasicProviderTurn(loop);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    resetSpy.mockRestore();
  });

  it("cannot run provider without a provider executor", async () => {
    const loop = await createProviderTurnLoopForTest({ providerExecutor: undefined });

    expect(loop.canRunProvider()).toBe(false);
  });

  it("cannot run provider without a model", async () => {
    const loop = await createProviderTurnLoopForTest({ model: undefined });

    expect(loop.canRunProvider()).toBe(false);
  });

  it("cannot run provider for the unconfigured provider", async () => {
    const loop = await createProviderTurnLoopForTest({
      model: {
        ...mockModel,
        provider: "unconfigured"
      }
    });

    expect(loop.canRunProvider()).toBe(false);
  });
});

describe("ProviderTurnLoop request defaults", () => {
  it("uses the normal default provider temperature", async () => {
    const harness = await createCompressionHarness();

    await runBasicProviderTurn(harness.loop());

    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(request.temperature).toBe(0.2);
    expect(request.maxTokens).toBeUndefined();
  });

  it("passes configured benchmark request defaults to the provider", async () => {
    const harness = await createCompressionHarness();

    await runBasicProviderTurn(harness.loop({
      providerRequestDefaults: {
        temperature: 0,
        maxTokens: 1200
      }
    }));

    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(1200);
  });
});

describe("ProviderTurnLoop semantic session compression", () => {
  it("does not own persistent semantic compression or session forking", async () => {
    const harness = await createCompressionHarness();
    await appendHistory(harness.sessionDb, harness.sessionId, "large history ".repeat(200));
    const loop = harness.loop();

    const result = await runBasicProviderTurn(loop);

    expect(result.providerExecution?.ok).toBe(true);
    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(JSON.stringify(request.messages)).toContain("large history");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events.some((event) => event.kind === "session-history-compressed")).toBe(false);
    expect(events.some((event) => event.kind === "session-compaction-forked")).toBe(false);
  });

  it("records prompt and actual input token tracking without compression ownership", async () => {
    const harness = await createCompressionHarness();
    const loop = harness.loop();

    await runBasicProviderTurn(loop);

    expect(loop.lastPromptTokens()).toEqual(expect.any(Number));
    expect(loop.lastPromptTokens()).toBeGreaterThan(0);
    expect(loop.lastActualPromptTokens()).toBe(123);
  });

  it("seeds actual prompt tracking from resumed session usage", async () => {
    const harness = await createCompressionHarness();
    const loop = harness.loop({
      initialContextWindowUsage: {
        usedTokens: 4_200,
        totalTokens: 128_000,
        provider: "test-provider",
        model: "test-model",
        routeRole: "primary"
      }
    });

    expect(loop.lastActualPromptTokens()).toBe(4_200);
  });

  it("retains resumed actual usage when the next provider response omits usage", async () => {
    const harness = await createCompressionHarness();
    const noUsageExecutor = {
      complete: vi.fn(async (): Promise<ProviderExecutionResult> => ({
        ok: true,
        response: {
          ok: true,
          content: "response without usage",
          provider: primaryRoute.provider,
          model: primaryRoute.id
        },
        fallbackUsed: false,
        attempts: [{
          provider: primaryRoute.provider,
          model: primaryRoute.id,
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "response without usage"
        }],
        route: primaryRoute,
        attemptedRouteIndex: 0,
        routeRole: "primary",
        toolCalls: []
      }))
    } as unknown as ProviderExecutor;
    const loop = harness.loop({
      providerExecutor: noUsageExecutor,
      initialContextWindowUsage: {
        usedTokens: 4_200,
        totalTokens: 128_000,
        provider: "test-provider",
        model: "test-model",
        routeRole: "primary"
      }
    });

    await runBasicProviderTurn(loop);

    expect(loop.lastActualPromptTokens()).toBe(4_200);
    expect((await harness.sessionDb.listEvents(harness.sessionId)).filter((event) =>
      event.kind === "context-window-usage"
    )).toEqual([]);
  });

  it("emits distinct context estimate and provider-actual events", async () => {
    const harness = await createCompressionHarness();
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop(), { onEvent: (event) => events.push(event) });

    const estimateEvents = events.filter((event): event is Extract<RuntimeEvent, { kind: "context-estimate" }> =>
      event.kind === "context-estimate"
    );
    expect(estimateEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "assembled-prompt",
        stage: "assembled-prompt",
        total: mockModel.contextWindowTokens
      })
    ]));
    expect(estimateEvents.find((event) => event.source === "assembled-prompt")?.filled).toBeGreaterThan(0);

    const actualEvents = events.filter((event): event is Extract<RuntimeEvent, { kind: "context-window-usage" }> =>
      event.kind === "context-window-usage"
    );
    expect(actualEvents).toEqual([
      {
        kind: "context-window-usage",
        usedTokens: 123,
        totalTokens: mockModel.contextWindowTokens,
        provider: "test-provider",
        model: "test-model",
        source: "provider-actual"
      }
    ]);

    await expect(harness.sessionDb.listEvents(harness.sessionId)).resolves.toContainEqual({
      kind: "context-window-usage",
      usedTokens: 123,
      totalTokens: mockModel.contextWindowTokens,
      provider: "test-provider",
      model: "test-model"
    });
  });

  it("uses the successful fallback route context window for provider actual usage", async () => {
    const harness = await createCompressionHarness();
    const fallbackExecutor = {
      complete: vi.fn(async (): Promise<ProviderExecutionResult> => ({
        ok: true,
        response: {
          ok: true,
          content: "fallback-response",
          provider: fallbackRoute.provider,
          model: fallbackRoute.id,
          usage: {
            inputTokens: 456,
            outputTokens: 10,
            totalTokens: 466
          }
        },
        fallbackUsed: true,
        attempts: [{
          provider: fallbackRoute.provider,
          model: fallbackRoute.id,
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "fallback-response"
        }],
        route: fallbackRoute,
        attemptedRouteIndex: 1,
        routeRole: "fallback",
        toolCalls: []
      }))
    } as unknown as ProviderExecutor;
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop({ providerExecutor: fallbackExecutor }), {
      onEvent: (event) => events.push(event)
    });

    expect(events).toContainEqual({
      kind: "context-window-usage",
      usedTokens: 456,
      totalTokens: fallbackRoute.profile.contextWindowTokens,
      provider: fallbackRoute.provider,
      model: fallbackRoute.id,
      source: "provider-actual",
      routeRole: "fallback"
    });
    await expect(harness.sessionDb.listEvents(harness.sessionId)).resolves.toContainEqual({
      kind: "context-window-usage",
      usedTokens: 456,
      totalTokens: fallbackRoute.profile.contextWindowTokens,
      provider: fallbackRoute.provider,
      model: fallbackRoute.id,
      routeRole: "fallback"
    });
  });

  it("passes native structured tool history for a test-only supported route", async () => {
    const harness = await createCompressionHarness();
    await appendProviderToolHistory(harness.sessionDb, harness.sessionId);
    const loop = harness.loop({
      primaryModelRoute: nativeHistoryRoute
    });

    await runBasicProviderTurn(loop);

    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(request.messages.at(-1)?.role).toBe("user");
    expect(request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: "provider tool call",
        toolCalls: [
          {
            id: "call-native-history",
            name: testTool.name,
            argumentsText: "{\"path\":\"src/index.ts\"}"
          }
        ]
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-native-history",
        content: expect.stringContaining("native replay tool result")
      })
    ]));
    const nativeReplayToolMessage = request.messages.find((message) =>
      message.role === "tool" && message.toolCallId === "call-native-history"
    );
    expect(String(nativeReplayToolMessage?.content)).toContain("[Historical tool result from ");
    expect(String(nativeReplayToolMessage?.content)).toContain("via test.tool; reference only.");
    expect(String(nativeReplayToolMessage?.content)).toContain("native replay tool result");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-selected",
        nativePairs: 1,
        routeRole: "primary",
        preservedEchoMessages: 0,
        placeholderEchoMessages: 0,
        strippedEchoMessages: 0,
        historicalNativeReplay: true
      }),
      expect.objectContaining({
        kind: "structured-tool-history-serialized",
        nativePairs: 1,
        routeRole: "primary",
        preservedEchoMessages: 0,
        placeholderEchoMessages: 0,
        strippedEchoMessages: 0
      })
    ]));
    const serializedEvents = JSON.stringify(events.filter((event) =>
      event.kind.startsWith("structured-tool-history-")
    ));
    expect(serializedEvents).not.toContain("src/index.ts");
    expect(serializedEvents).not.toContain("native replay tool result");
  });

  it("keeps native replay disabled for routes without explicit support", async () => {
    const harness = await createCompressionHarness();
    await appendProviderToolHistory(harness.sessionDb, harness.sessionId);
    const loop = harness.loop();

    await runBasicProviderTurn(loop);

    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(request.messages.some((message) => message.toolCalls !== undefined || message.toolCallId !== undefined)).toBe(false);
    const rendered = JSON.stringify(request.messages);
    expect(rendered).toContain("provider tool call");
    expect(rendered).toContain("native replay tool result");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-skipped",
        reason: "provider_unsupported"
      })
    ]));
  });
});

describe("ProviderTurnLoop OpenAI-compatible stream recovery", () => {
  it("returns recovered visible content instead of an empty successful stream", async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const requestBodies: Array<Record<string, unknown>> = [];
      const registry = new ProviderRegistry();
      registry.register(createOpenAICompatibleProvider({
        id: "openai" as any,
        endpoint: { baseUrl: "https://api.openai.example/v1", apiKey: { kind: "none" } },
        enableNetwork: true,
        fetch: async (_url, init) => {
          requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          if (requestBodies.length === 1) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({}),
              text: async () => "",
              body: sseStream([
                sseData({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
                "data: [DONE]\n\n"
              ])
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: "Recovered visible answer." }
                }
              ]
            }),
            text: async () => "",
            body: null
          };
        }
      }));

      const providerExecutor = new ProviderExecutor({ registry });
      const openAIModel: ModelProfile = {
        id: "gpt-test",
        provider: "openai",
        contextWindowTokens: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      };
      const openAIRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-test",
        profile: openAIModel,
        baseUrl: "https://api.openai.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        apiMode: "openai_chat_completions"
      };
      const sessionDb = new InMemorySessionDB();
      const sessionId = `openai-stream-session-${Date.now()}-${Math.random()}`;
      await sessionDb.createSession({ id: sessionId, profileId: "default", title: "openai-stream" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId,
        modelId: "gpt-test"
      });
      const runRecorder = new RunRecorder({
        sessionDb,
        sessionId,
        trajectoryRecorder,
        profileId: "default"
      });
      const toolPlanRunner = new ToolPlanRunner({
        toolCallPlanner: undefined,
        toolExecutor: {} as any,
        runRecorder,
        sessionId,
        maxConcurrentSafeTools: 4
      });
      const openAILoop = new ProviderTurnLoop({
        providerExecutor,
        model: openAIModel,
        primaryModelRoute: openAIRoute,
        modelFallbackRoutes: [],
        providerPreferences: { providerOrder: ["openai"] },
        sessionDb,
        sessionId,
        profileId: "default",
        trajectoryRecorder,
        runRecorder,
        toolPlanRunner,
        soul: undefined,
        memoryPromptContext: undefined,
        skillsIndex: [],
        ui: undefined,
        agentProfile: undefined,
        budgets: {
          maxProviderIterations: 3,
          maxProviderToolCalls: 4,
          maxRepeatedToolFailures: 2,
          maxProviderWallClockMs: 10_000
        }
      });

      const result = await runBasicProviderTurn(openAILoop);

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]?.stream).toBe(true);
      expect(requestBodies[1]?.stream).toBe(false);
      expect(requestBodies[1]).not.toHaveProperty("stream_options");
      expect(result.iterations).toBe(1);
      expect(result.providerExecution?.response?.content).toBe("Recovered visible answer.");
      expect(result.providerExecution?.response?.usage).toEqual({
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      });
    } finally {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
    }
  });
});

describe("ProviderTurnLoop post-tool empty response recovery", () => {
  it("persists provider tool-call turns before tool execution", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-before-exec")])
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1,
      onExecutePlans: async ({ sessionDb, sessionId }) => {
        const messages = await sessionDb.listMessages(sessionId);
        expect(messages).toContainEqual(expect.objectContaining({
          role: "agent",
          metadata: expect.objectContaining({
            kind: "provider-tool-call-turn",
            nativeReplaySafe: true,
            providerToolCalls: [
              {
                id: "call-before-exec",
                name: testTool.name,
                argumentsText: "{}"
              }
            ]
          })
        }));
      }
    });

    await runBasicProviderTurn(harness.loop);

    expect(harness.executePlans).toHaveBeenCalledTimes(1);
  });

  it("preserves assistant content plus provider tool calls", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("I'll look that up.", [providerToolCall("call-content", "{\"query\":\"docs\"}")])
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    expect(messages).toContainEqual(expect.objectContaining({
      role: "agent",
      content: "I'll look that up.",
      metadata: expect.objectContaining({
        kind: "provider-tool-call-turn",
        providerToolCalls: [
          {
            id: "call-content",
            name: testTool.name,
            argumentsText: "{\"query\":\"docs\"}"
          }
        ]
      })
    }));
  });

  it("requires vision for image-bearing continuation requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "estacoda-provider-turn-vision-"));
    const imagePath = join(dir, "image.png");
    writeFileSync(imagePath, Buffer.from("fake-png"));

    const visionModel: ModelProfile = {
      ...mockModel,
      supportsVision: true
    };
    const visionPrimaryRoute: ResolvedModelRoute = {
      ...primaryRoute,
      profile: visionModel
    };
    const attachment: ChannelAttachment = {
      id: "image-1",
      kind: "image",
      status: "ready",
      localPath: imagePath,
      bytes: 8
    };

    try {
      const harness = await createPostToolNudgeHarness({
        model: visionModel,
        primaryModelRoute: visionPrimaryRoute,
        responses: [
          providerExecution("", [providerToolCall("call-image")]),
          providerExecution("final answer")
        ],
        toolSteps: [
          {
            executions: [toolExecution("call-image")]
          }
        ],
        maxProviderIterations: 2
      });

      await runBasicProviderTurn(harness.loop, { attachments: [attachment] });

      expect(harness.completeSpy).toHaveBeenCalledTimes(2);
      const initialPreferences = harness.completeSpy.mock.calls[0]![1] as { requireVision?: boolean };
      const continuationPreferences = harness.completeSpy.mock.calls[1]![1] as { requireVision?: boolean };
      expect(initialPreferences.requireVision).toBe(true);
      expect(continuationPreferences.requireVision).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses structured native history for supported post-tool continuation", async () => {
    const harness = await createPostToolNudgeHarness({
      primaryModelRoute: nativeHistoryRoute,
      responses: [
        providerExecution("", [providerToolCall("call-live")]),
        providerExecution("final answer")
      ],
      toolSteps: [
        {
          executions: [toolExecution("call-live", "live tool result")]
        }
      ],
      onExecutePlans: async ({ sessionDb, sessionId }) => {
        await sessionDb.appendMessage({
          sessionId,
          role: "tool",
          content: "live tool result",
          metadata: {
            tool_call_id: "call-live",
            tool_call_name: testTool.name
          }
        });
      }
    });

    await runBasicProviderTurn(harness.loop);

    const continuationRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect(continuationRequest.messages.at(-1)?.role).toBe("user");
    expect(JSON.stringify(continuationRequest.messages.at(-1)?.content)).toContain("EstaCoda executed the requested tools.");
    expect(continuationRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        toolCalls: [
          {
            id: "call-live",
            name: testTool.name,
            argumentsText: "{}"
          }
        ]
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-live",
        content: expect.stringContaining("live tool result")
      })
    ]));
    const liveReplayToolMessage = continuationRequest.messages.find((message) =>
      message.role === "tool" && message.toolCallId === "call-live"
    );
    expect(String(liveReplayToolMessage?.content)).toContain("[Historical tool result from ");
    expect(String(liveReplayToolMessage?.content)).toContain("via test.tool; reference only.");
    expect(String(liveReplayToolMessage?.content)).toContain("live tool result");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-selected",
        nativePairs: 1,
        preservedEchoMessages: 0,
        placeholderEchoMessages: 0,
        strippedEchoMessages: 0
      }),
      expect.objectContaining({
        kind: "structured-tool-history-serialized",
        nativePairs: 1,
        preservedEchoMessages: 0,
        placeholderEchoMessages: 0,
        strippedEchoMessages: 0
      })
    ]));
  });

  it("keeps flat post-tool continuation for unsupported native history routes", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-flat")]),
        providerExecution("final answer")
      ],
      toolSteps: [
        {
          executions: [toolExecution("call-flat", "flat tool result")]
        }
      ],
      onExecutePlans: async ({ sessionDb, sessionId }) => {
        await sessionDb.appendMessage({
          sessionId,
          role: "tool",
          content: "flat tool result",
          metadata: {
            tool_call_id: "call-flat",
            tool_call_name: testTool.name
          }
        });
      }
    });

    await runBasicProviderTurn(harness.loop);

    const continuationRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect(continuationRequest.messages.at(-1)?.role).toBe("user");
    expect(continuationRequest.messages.some((message) => message.toolCalls !== undefined || message.toolCallId !== undefined)).toBe(false);
    expect(JSON.stringify(continuationRequest.messages)).toContain("flat tool result");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-skipped",
        reason: "provider_unsupported"
      })
    ]));
  });

  it("normalizes missing stable tool-call IDs before persistence and planning", async () => {
    const toolCall = {
      index: 0,
      name: testTool.name,
      argumentsText: "{\"path\":\"src/index.ts\"}"
    };
    const expectedId = stableToolCallId(toolCall);
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [toolCall])
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const persistedTurn = messages.find((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(persistedTurn?.metadata?.providerToolCalls).toEqual([
      {
        id: expectedId,
        name: testTool.name,
        argumentsText: "{\"path\":\"src/index.ts\"}"
      }
    ]);
    expect(harness.executePlans.mock.calls[0]?.[0].providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: expectedId })
    ]);
  });

  it("marks secret-bearing arguments unsafe and omits faithful arguments", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-secret", "{\"OPENAI_API_KEY\":\"sk-secret\"}")])
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const persisted = messages.find((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(persisted?.metadata).toEqual(expect.objectContaining({
      nativeReplaySafe: false,
      providerToolCalls: [
        {
          id: "call-secret",
          name: testTool.name,
          argumentsRedacted: true
        }
      ]
    }));
    expect(JSON.stringify(persisted)).not.toContain("sk-secret");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-skipped",
        reason: "unsafe_arguments",
        nativeReplayUnsafeTurns: 1
      })
    ]));
    expect(JSON.stringify(events)).not.toContain("sk-secret");
  });

  it("stores bounded provider replay echo for echo-required safe routes", async () => {
    const echoRoute = echoRequiredRoute();
    const reasoning = "private provider reasoning";
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-echo")], {
          route: echoRoute,
          routeRole: "primary",
          response: {
            ok: true,
            content: "",
            model: echoRoute.id,
            provider: echoRoute.provider,
            reasoning,
            reasoningMetadata: {
              present: true,
              chars: reasoning.length,
              format: "reasoning_content"
            }
          }
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const persisted = messages.find((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(persisted?.metadata).toEqual(expect.objectContaining({
      nativeReplaySafe: true,
      providerReplayEcho: {
        field: "reasoning_content",
        value: reasoning,
        providerFamily: "deepseek",
        apiMode: "openai_chat_completions",
        chars: reasoning.length
      }
    }));
  });

  it("persists provider replay echo as protocol material, not replay scope", async () => {
    const echoRoute = echoRequiredRoute();
    const reasoning = "same-turn protocol reasoning";
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-protocol-echo")], {
          route: echoRoute,
          routeRole: "primary",
          attemptedRouteIndex: 0,
          response: {
            ok: true,
            content: "",
            model: echoRoute.id,
            provider: echoRoute.provider,
            reasoning,
            reasoningMetadata: {
              present: true,
              chars: reasoning.length,
              format: "reasoning_content"
            }
          }
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const persisted = messages.find((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(persisted?.metadata).toEqual(expect.objectContaining({
      nativeReplaySafe: true,
      provider: "deepseek",
      model: "deepseek-reasoner",
      routeRole: "primary",
      attemptedRouteIndex: 0,
      providerToolCalls: [
        {
          id: "call-protocol-echo",
          name: testTool.name,
          argumentsText: "{}"
        }
      ],
      providerReplayEcho: {
        field: "reasoning_content",
        value: reasoning,
        providerFamily: "deepseek",
        apiMode: "openai_chat_completions",
        chars: reasoning.length
      }
    }));
    expect(persisted?.metadata).not.toHaveProperty("reasoningReplayScope");
    expect(persisted?.metadata).not.toHaveProperty("semanticReplayAllowed");
    expect(persisted?.metadata).not.toHaveProperty("replayScope");
  });

  it("marks echo-required turns unsafe when echo is missing or oversized", async () => {
    const echoRoute = echoRequiredRoute();
    const oversizedReasoning = "r".repeat(32_001);
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-missing-echo")], {
          route: echoRoute,
          routeRole: "primary",
          response: {
            ok: true,
            content: "",
            model: echoRoute.id,
            provider: echoRoute.provider
          }
        }),
        providerExecution("", [providerToolCall("call-oversized-echo")], {
          route: echoRoute,
          routeRole: "primary",
          response: {
            ok: true,
            content: "",
            model: echoRoute.id,
            provider: echoRoute.provider,
            reasoning: oversizedReasoning,
            reasoningMetadata: {
              present: true,
              chars: oversizedReasoning.length,
              format: "reasoning_content"
            }
          }
        })
      ],
      toolSteps: [
        { executions: [toolExecution("call-missing-echo")] },
        {}
      ],
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const toolTurns = messages.filter((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(toolTurns).toHaveLength(2);
    for (const turn of toolTurns) {
      expect(turn.metadata?.nativeReplaySafe).toBe(false);
      expect(turn.metadata).not.toHaveProperty("providerReplayEcho");
    }
    expect(JSON.stringify(messages)).not.toContain(oversizedReasoning);
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "structured-tool-history-skipped",
        reason: "missing_echo",
        echoMissing: 1,
        nativeReplayUnsafeTurns: 1
      }),
      expect.objectContaining({
        kind: "structured-tool-history-skipped",
        reason: "echo_oversized",
        echoOversized: 1,
        nativeReplayUnsafeTurns: 1
      })
    ]));
    expect(JSON.stringify(events)).not.toContain(oversizedReasoning);
  });

  it("does not store provider replay echo for non-echo routes or unsafe turns", async () => {
    const reasoning = "private non-echo reasoning";
    const echoRoute = echoRequiredRoute();
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-non-echo")], {
          response: {
            ok: true,
            content: "",
            model: "test-model",
            provider: "test-provider",
            reasoning,
            reasoningMetadata: {
              present: true,
              chars: reasoning.length,
              format: "reasoning_content"
            }
          }
        }),
        providerExecution("", [providerToolCall("call-unsafe-echo", "{\"password\":\"secret\"}")], {
          route: echoRoute,
          routeRole: "primary",
          response: {
            ok: true,
            content: "",
            model: echoRoute.id,
            provider: echoRoute.provider,
            reasoning,
            reasoningMetadata: {
              present: true,
              chars: reasoning.length,
              format: "reasoning_content"
            }
          }
        })
      ],
      toolSteps: [
        { executions: [toolExecution("call-non-echo")] },
        {}
      ],
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop);

    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const toolTurns = messages.filter((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(toolTurns).toHaveLength(2);
    for (const turn of toolTurns) {
      expect(turn.metadata).not.toHaveProperty("providerReplayEcho");
    }
    expect(JSON.stringify(messages)).not.toContain(reasoning);
  });

  it("does not recover partial incomplete stream content as final turn content", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        incompleteStreamExecution("Recovered partial answer.")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(result.providerExecution?.ok).toBe(false);
    expect(result.providerExecution?.response).toBeUndefined();
    expect(result.providerExecution?.attempts).toEqual([
      expect.objectContaining({
        ok: false,
        errorClass: "incomplete-stream",
        partialContent: "Recovered partial answer."
      })
    ]);
  });

  it("does not recover incomplete streams without visible partial content", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        incompleteStreamExecution(undefined)
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(result.providerExecution?.ok).toBe(false);
    expect(result.providerExecution?.response).toBeUndefined();
  });

  it("uses prior content when an empty continuation follows housekeeping tools", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Housekeeping-visible answer.", [providerToolCall("call-memory")]),
        providerExecution("")
      ],
      toolSteps: [
        {
          executions: [
            toolExecutionForTool("call-memory", "memory.curate"),
            toolExecutionForTool("call-skill-read", "skill.read"),
            toolExecutionForTool("call-skill-search", "skill.search"),
            toolExecutionForTool("call-skill-view", "skill.view")
          ]
        },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Housekeeping-visible answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    for (const call of harness.completeSpy.mock.calls) {
      expect(call[0] as ProviderRequest).not.toHaveProperty("maxTokens");
    }
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.some((request) => request.includes("You just executed tool calls but returned an empty response."))).toBe(false);
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const continuationEvents = events.filter((event) => event.kind === "provider-continuation");
    expect(continuationEvents.map((event) => "nudge" in event ? event.nudge : undefined)).toEqual([
      false
    ]);
  });

  it("does not reuse content from substantive tools and keeps the post-tool nudge", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Substantive progress text.", [providerToolCall("call-terminal")]),
        providerExecution(""),
        providerExecution("Nudge recovered after terminal.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-terminal", "terminal.run")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after terminal.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const nudgeRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest | undefined;
    expect(JSON.stringify(nudgeRequest?.messages ?? [])).toContain(
      "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task."
    );
  });

  it("does not treat mutating skill promotion as housekeeping", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Promotion progress text.", [providerToolCall("call-promote")]),
        providerExecution(""),
        providerExecution("Nudge recovered after promotion.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-promote", "skill.promote_patch")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after promotion.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("clears stale housekeeping content when a later substantive tool executes", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Housekeeping-visible answer.", [providerToolCall("call-memory")]),
        providerExecution("Substantive progress text.", [providerToolCall("call-terminal")]),
        providerExecution(""),
        providerExecution("Nudge recovered after stale capture cleared.")
      ],
      toolSteps: [
        { executions: [toolExecutionForTool("call-memory", "memory.curate")] },
        { executions: [toolExecutionForTool("call-terminal", "terminal.run")] },
        {},
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(4);
    expect(result.providerExecution?.response?.content).toBe("Nudge recovered after stale capture cleared.");
    expect(result.providerExecution?.response?.content).not.toBe("Housekeeping-visible answer.");
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("adds a nudge on the next iteration when a post-tool continuation is empty and budget remains", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("Recovered final answer.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Recovered final answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const nudgeRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest | undefined;
    expect(nudgeRequest).toBeDefined();
    expect(JSON.stringify(nudgeRequest!.messages)).toContain(
      "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task."
    );
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const continuationEvents = events.filter((event) => event.kind === "provider-continuation");
    expect(continuationEvents.map((event) => "nudge" in event ? event.nudge : undefined)).toEqual([
      false,
      true
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-continuation",
      iteration: 2,
      nudge: true
    }));
  });

  it("records provider completion and continuation safe final-state metadata without raw reasoning", async () => {
    const hiddenReasoning = "hidden runtime reasoning";
    const reasoningMetadata = {
      present: true,
      chars: hiddenReasoning.length,
      format: "reasoning_content" as const
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")], {
          response: {
            ok: true,
            content: "",
            model: "test-model",
            provider: "test-provider",
            finishReason: "tool_calls",
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16,
              reasoningTokens: 2
            },
            reasoning: hiddenReasoning,
            reasoningMetadata
          }
        }),
        providerExecution("Final continuation answer.", [], {
          response: {
            ok: true,
            content: "Final continuation answer.",
            model: "test-model",
            provider: "test-provider",
            finishReason: "stop",
            usage: {
              inputTokens: 20,
              outputTokens: 6,
              totalTokens: 26,
              reasoningTokens: 1
            },
            reasoning: hiddenReasoning,
            reasoningMetadata
          }
        })
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop);

    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const completionEvent = events.find((event) => event.kind === "provider-completion");
    const continuationEvent = events.find((event) => event.kind === "provider-continuation");

    expect(completionEvent).toEqual(expect.objectContaining({
      kind: "provider-completion",
      finishReason: "tool_calls",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        reasoningTokens: 2
      },
      runtimeMetadata: {
        reasoning: reasoningMetadata
      }
    }));
    expect(continuationEvent).toEqual(expect.objectContaining({
      kind: "provider-continuation",
      finishReason: "stop",
      usage: {
        inputTokens: 20,
        outputTokens: 6,
        totalTokens: 26,
        reasoningTokens: 1
      },
      runtimeMetadata: {
        reasoning: reasoningMetadata
      }
    }));
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
  });

  it("persists safe stream diagnostics on provider completion attempts", async () => {
    const hiddenReasoning = "hidden diagnostic reasoning";
    const streamDiagnostics: ProviderStreamDiagnostics = {
      stream: true,
      startedAtMs: 3_000,
      endedAtMs: 3_080,
      durationMs: 80,
      firstEventMs: 8,
      firstTokenMs: 14,
      eventCount: 6,
      tokenChunks: 2,
      visibleChars: "streamed answer".length,
      toolCallChunks: 1,
      transportDone: true,
      finish: "done",
      finishReason: "stop",
      reasoningMetadata: {
        present: true,
        chars: hiddenReasoning.length,
        format: "reasoning"
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("streamed answer", [], {
          attempts: [
            {
              provider: "test-provider",
              model: "test-model",
              state: "dispatched",
              dispatchedAt: DISPATCHED_AT,
              ok: true,
              content: "streamed answer",
              streamDiagnostics
            }
          ]
        })
      ],
      toolSteps: []
    });

    await runBasicProviderTurn(harness.loop);

    const events = await harness.sessionDb.listEvents(harness.sessionId);
    const completionEvent = events.find((event) => event.kind === "provider-completion");

    expect(completionEvent).toEqual(expect.objectContaining({
      kind: "provider-completion",
      attempts: [
        expect.objectContaining({
          provider: "test-provider",
          model: "test-model",
          ok: true,
          streamDiagnostics
        })
      ]
    }));
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
  });

  it("uses nudge text as the final response", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("Nudge produced visible text.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.ok).toBe(true);
    expect(result.providerExecution?.response?.content).toBe("Nudge produced visible text.");
  });

  it("executes tool calls returned by the nudge through the normal tool path", async () => {
    const nudgeToolExecution = toolExecution("call-nudge", "nudge tool result");
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("", [providerToolCall("call-nudge")])
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        { executions: [nudgeToolExecution] }
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(harness.executePlans).toHaveBeenCalledTimes(3);
    const nudgeToolRunInput = harness.executePlans.mock.calls[2]?.[0];
    expect(nudgeToolRunInput).toBeDefined();
    expect(nudgeToolRunInput?.providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: "call-nudge" })
    ]);
    expect(result.toolExecutions).toContain(nudgeToolExecution);
  });

  it("does not nudge empty continuations when no tools executed earlier in the loop", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("")
      ],
      toolSteps: [
        { plans: [toolPlan("call-initial", "blocked")] },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.some((request) => request.includes("You just executed tool calls but returned an empty response."))).toBe(false);
  });

  it("retries empty initial provider responses through the initial provider path", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution(""),
        providerExecution("Recovered initial retry.")
      ],
      toolSteps: [
        {},
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Recovered initial retry.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events.filter((event) => event.kind === "provider-completion")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "provider-continuation")).toHaveLength(0);
  });

  it("stops empty initial retries at the retry budget", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("")
      ],
      toolSteps: [
        {},
        {},
        {},
        {}
      ],
      maxProviderIterations: 5
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(4);
    expect(harness.completeSpy).toHaveBeenCalledTimes(4);
    expect(result.providerExecution?.response?.content).toBe("");
    const events = await harness.sessionDb.listEvents(harness.sessionId);
    expect(events.filter((event) => event.kind === "provider-completion")).toHaveLength(4);
  });

  it("does not exceed the provider iteration budget for empty initial retries", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("")
      ],
      toolSteps: [
        {},
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not exceed the provider iteration budget to nudge an empty final iteration", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
  });

  it("nudges only once when the nudge also returns empty", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution(""),
        providerExecution("")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {},
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    const requests = harness.completeSpy.mock.calls.map((call) => JSON.stringify((call[0] as ProviderRequest).messages));
    expect(requests.filter((request) => request.includes("You just executed tool calls but returned an empty response."))).toHaveLength(1);
  });

  it("leaves existing non-empty continuation behavior unchanged", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")]),
        providerExecution("Normal continuation answer.")
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Normal continuation answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
  });

  it("emits provider actual usage for initial and post-tool continuation responses", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-initial")], {
          response: {
            ok: true,
            content: "",
            model: primaryRoute.id,
            provider: primaryRoute.provider,
            usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
          },
          route: primaryRoute,
          routeRole: "primary"
        }),
        providerExecution("Normal continuation answer.", [], {
          response: {
            ok: true,
            content: "Normal continuation answer.",
            model: primaryRoute.id,
            provider: primaryRoute.provider,
            usage: { inputTokens: 140, outputTokens: 8, totalTokens: 148 }
          },
          route: primaryRoute,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        { executions: [toolExecution("call-initial")] },
        {}
      ],
      maxProviderIterations: 3
    });
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop, { onEvent: (event) => events.push(event) });

    const actualEvents = events.filter((event): event is Extract<RuntimeEvent, { kind: "context-window-usage" }> =>
      event.kind === "context-window-usage"
    );
    expect(actualEvents.map((event) => event.usedTokens)).toEqual([100, 140]);
    expect(actualEvents.every((event) =>
      event.totalTokens === primaryRoute.profile.contextWindowTokens && event.routeRole === "primary"
    )).toBe(true);
    const persistedUsage = (await harness.sessionDb.listEvents(harness.sessionId))
      .filter((event) => event.kind === "context-window-usage");
    expect(persistedUsage.map((event) => event.usedTokens)).toEqual([100, 140]);
  });
});

describe("ProviderTurnLoop reasoning-only response recovery", () => {
  it("retries non-length reasoning-only responses with a local-only visible-answer prefill", async () => {
    const hiddenReasoning = "hidden chain";
    const harness = await createPostToolNudgeHarness({
      responses: [
        reasoningOnlyExecution({ reasoning: hiddenReasoning }),
        providerExecution("Visible answer.")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });
    const events: RuntimeEvent[] = [];

    const result = await runBasicProviderTurn(harness.loop, { onEvent: (event) => events.push(event) });

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Visible answer.");
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    const firstRequest = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    const retryRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect(JSON.stringify(firstRequest.messages)).not.toContain("I’ll answer directly and only include the final visible answer.");
    expect(JSON.stringify(retryRequest.messages)).toContain("I’ll answer directly and only include the final visible answer.");

    const persistedMessages = await harness.sessionDb.listMessages(harness.sessionId);
    expect(JSON.stringify(persistedMessages)).not.toContain("I’ll answer directly and only include the final visible answer.");
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
    expect(JSON.stringify(result.providerExecution?.attempts)).not.toContain(hiddenReasoning);
  });

  it("retries metadata-only reasoning responses without treating them as provider failures", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        metadataOnlyReasoningExecution({ chars: 42 }),
        providerExecution("Visible answer from metadata-only retry.")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(result.providerExecution?.response?.content).toBe("Visible answer from metadata-only retry.");
    const firstAttempt = result.providerExecution?.attempts[0];
    expect(firstAttempt?.ok).toBe(true);
    expect(firstAttempt?.errorClass).toBeUndefined();
    const retryRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect(JSON.stringify(retryRequest.messages)).toContain("I’ll answer directly and only include the final visible answer.");
    const persistedMessages = await harness.sessionDb.listMessages(harness.sessionId);
    expect(JSON.stringify(persistedMessages)).not.toContain("I’ll answer directly and only include the final visible answer.");
    expect(JSON.stringify(result.providerExecution)).not.toContain("opaque hidden detail");
  });

  it("caps reasoning-only prefill retries at two attempts", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        reasoningOnlyExecution({ reasoning: "hidden one" }),
        reasoningOnlyExecution({ reasoning: "hidden two" }),
        reasoningOnlyExecution({ reasoning: "hidden three" }),
        providerExecution("Should not be called.")
      ],
      toolSteps: [],
      maxProviderIterations: 5
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(harness.executePlans).not.toHaveBeenCalled();
    expect(result.providerExecution?.response?.content).toBe(
      "The model produced internal reasoning but did not produce a visible answer. Try again with a narrower request."
    );
    expect(JSON.stringify(result.providerExecution)).not.toContain("hidden one");
    expect(JSON.stringify(result.providerExecution)).not.toContain("hidden two");
    expect(JSON.stringify(result.providerExecution)).not.toContain("hidden three");
  });

  it("does not exceed provider iteration budget for reasoning-only retries", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        reasoningOnlyExecution({ reasoning: "hidden budgeted" }),
        providerExecution("Should not be called.")
      ],
      toolSteps: [],
      maxProviderIterations: 1
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(harness.executePlans).not.toHaveBeenCalled();
    expect(result.providerExecution?.response?.content).toBe(
      "The model produced internal reasoning but did not produce a visible answer. Try again with a narrower request."
    );
  });

  it("checks wall-clock budget before reasoning-only retry calls", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        reasoningOnlyExecution({ reasoning: "hidden wall clock" }),
        providerExecution("Should not be called.")
      ],
      toolSteps: [],
      maxProviderIterations: 3,
      maxProviderWallClockMs: 1000
    });
    const nowSpy = vi.spyOn(Date, "now");
    let nowCalls = 0;
    nowSpy.mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? 1000 : 2001;
    });

    try {
      const result = await runBasicProviderTurn(harness.loop);

      expect(result.iterations).toBe(1);
      expect(harness.completeSpy).toHaveBeenCalledTimes(1);
      expect(result.providerExecution?.response?.content).toBe("");
      expect(harness.executePlans).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not prefill retry length-truncated reasoning-only exhaustion", async () => {
    const hiddenReasoning = "hidden exhausted";
    const harness = await createPostToolNudgeHarness({
      responses: [
        reasoningOnlyExecution({ reasoning: hiddenReasoning, finishReason: "length" }),
        providerExecution("Should not be called.")
      ],
      toolSteps: [],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(harness.executePlans).not.toHaveBeenCalled();
    expect(result.providerExecution?.response?.content).toBe(
      "The model exhausted its output budget while reasoning and did not produce a visible answer. Try again with a higher model.maxTokens value or a narrower request."
    );
    expect(JSON.stringify(result.providerExecution)).not.toContain(hiddenReasoning);
  });
});

describe("ProviderTurnLoop length-truncated text continuation", () => {
  it("continues length-truncated visible text on the successful primary route", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Hello wor" }),
        providerExecution("world.", [], {
          response: {
            ok: true,
            content: "world.",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Hello world.");
    expect(result.providerExecution?.response?.finishReason).toBe("stop");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 1,
      exhausted: false,
      initialFinishReason: "length",
      finalFinishReason: "stop"
    });
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(harness.completeSpy.mock.calls[1]![0].maxTokens).toBe(8192);
    expect(harness.completeSpy.mock.calls[1]![0].messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "Hello wor"
      },
      {
        role: "user",
        content: "Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not repeat previous text."
      }
    ]);
    const continuationOptions = harness.completeSpy.mock.calls[1]![2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(continuationOptions.primaryRoute).toEqual(primaryRoute);
    expect(continuationOptions.fallbackChain).toEqual([fallbackRoute]);
    const sessionMessages = await harness.sessionDb.listMessages(harness.sessionId);
    expect(sessionMessages.map((message) => message.content)).not.toContain("Hello wor");
    expect(sessionMessages.map((message) => message.content)).not.toContain("Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not repeat previous text.");
    const sessionEvents = await harness.sessionDb.listEvents(harness.sessionId);
    const providerCompletion = sessionEvents.find((event) => event.kind === "provider-completion");
    expect(providerCompletion).toEqual(expect.objectContaining({
      kind: "provider-completion",
      runtimeMetadata: {
        continuation: {
          reason: "provider_length",
          attempts: 1,
          exhausted: false,
          initialFinishReason: "length",
          finalFinishReason: "stop"
        }
      }
    }));
  });

  it("continues repeated length-truncated text with increasing caps", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Alpha " }),
        lengthTruncatedTextExecution({ content: "Beta " }),
        providerExecution("Gamma", [], {
          response: {
            ok: true,
            content: "Gamma",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe("Alpha Beta Gamma");
    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(harness.completeSpy.mock.calls[1]![0].maxTokens).toBe(8192);
    expect(harness.completeSpy.mock.calls[2]![0].maxTokens).toBe(12288);
    expect(harness.completeSpy.mock.calls[2]![0].messages.slice(-2)[0]).toEqual({
      role: "assistant",
      content: "Alpha Beta "
    });
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 2,
      exhausted: false,
      initialFinishReason: "length",
      finalFinishReason: "stop"
    });
  });

  it("does not duplicate a continuation that is entirely exact overlap", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Complete repeated text" }),
        providerExecution("repeated text", [], {
          response: {
            ok: true,
            content: "repeated text",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.response?.content).toBe("Complete repeated text");
  });

  it("concatenates normally when there is no exact suffix-prefix overlap", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "First section." }),
        providerExecution(" Second section.", [], {
          response: {
            ok: true,
            content: " Second section.",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.response?.content).toBe("First section. Second section.");
  });

  it("does not fuzzy-trim similar repeated words without exact overlap", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "alpha beta!" }),
        providerExecution("alpha  beta", [], {
          response: {
            ok: true,
            content: "alpha  beta",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.response?.content).toBe("alpha beta!alpha  beta");
  });

  it("bounds exact overlap trimming to the last and first 1000 characters", async () => {
    const repeated = "A".repeat(1001);
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: repeated }),
        providerExecution(`${repeated}tail`, [], {
          response: {
            ok: true,
            content: `${repeated}tail`,
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.response?.content).toBe(`${"A".repeat(1002)}tail`);
  });

  it("returns the best visible partial when continuation attempts remain length-truncated", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "One " }),
        lengthTruncatedTextExecution({ content: "Two " }),
        lengthTruncatedTextExecution({ content: "Three " }),
        lengthTruncatedTextExecution({ content: "Four" })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(4);
    expect(harness.completeSpy).toHaveBeenCalledTimes(4);
    expect(result.providerExecution?.response?.content).toBe("One Two Three Four");
    expect(result.providerExecution?.response?.finishReason).toBe("length");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 3,
      exhausted: true,
      initialFinishReason: "length",
      finalFinishReason: "length"
    });
  });

  it("continues fallback length-truncated text from the successful fallback route", async () => {
    const fallbackFirst = lengthTruncatedTextExecution({
      content: "Fallback par",
      route: fallbackRoute,
      attemptedRouteIndex: 1,
      fallbackUsed: true,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          errorClass: "server",
          content: "primary failed"
        },
        {
          provider: "test-provider",
          model: "test-model-fallback",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "Fallback par",
          finishReason: "length"
        }
      ]
    });
    const harness = await createPostToolNudgeHarness({
      responses: [
        fallbackFirst,
        providerExecution("partial done.", [], {
          response: {
            ok: true,
            content: "partial done.",
            finishReason: "stop",
            model: "test-model-fallback",
            provider: "test-provider"
          },
          route: fallbackRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("Fallback partial done.");
    const continuationOptions = harness.completeSpy.mock.calls[1]?.[2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(continuationOptions.primaryRoute).toEqual(fallbackRoute);
    expect(continuationOptions.fallbackChain).toEqual([]);
    expect(result.providerExecution?.route).toEqual(fallbackRoute);
    expect(result.providerExecution?.attemptedRouteIndex).toBe(1);
    expect(result.providerExecution?.routeRole).toBe("fallback");
  });

  it("preserves later fallbacks when continuing from a successful fallback route", async () => {
    const fallbackFirst = lengthTruncatedTextExecution({
      content: "FallbackA par",
      route: fallbackRoute,
      attemptedRouteIndex: 1,
      fallbackUsed: true,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          errorClass: "server",
          content: "primary failed"
        },
        {
          provider: "test-provider",
          model: "test-model-fallback",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "FallbackA par",
          finishReason: "length"
        }
      ]
    });
    const harness = await createPostToolNudgeHarness({
      responses: [
        fallbackFirst,
        providerExecution("partial from fallbackB.", [], {
          response: {
            ok: true,
            content: "partial from fallbackB.",
            finishReason: "stop",
            model: "test-model-second-fallback",
            provider: "test-provider"
          },
          route: secondFallbackRoute,
          attemptedRouteIndex: 1,
          routeRole: "fallback",
          fallbackUsed: true,
          attempts: [
            {
              provider: "test-provider",
              model: "test-model-fallback",
              state: "dispatched",
              dispatchedAt: DISPATCHED_AT,
              ok: false,
              errorClass: "server",
              content: "fallback A continuation failed"
            },
            {
              provider: "test-provider",
              model: "test-model-second-fallback",
              state: "dispatched",
              dispatchedAt: DISPATCHED_AT,
              ok: true,
              content: "partial from fallbackB.",
              finishReason: "stop"
            }
          ]
        })
      ],
      toolSteps: [
        {}
      ],
      modelFallbackRoutes: [fallbackRoute, secondFallbackRoute],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.providerExecution?.response?.content).toBe("FallbackA partial from fallbackB.");
    const continuationOptions = harness.completeSpy.mock.calls[1]?.[2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(continuationOptions.primaryRoute).toEqual(fallbackRoute);
    expect(continuationOptions.fallbackChain).toEqual([secondFallbackRoute]);
    expect(continuationOptions.primaryRoute).not.toEqual(primaryRoute);
    expect(result.providerExecution?.route).toEqual(secondFallbackRoute);
    expect(result.providerExecution?.attemptedRouteIndex).toBe(2);
    expect(result.providerExecution?.routeRole).toBe("fallback");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 1,
      exhausted: false,
      initialFinishReason: "length",
      finalFinishReason: "stop"
    });
  });

  it("does not continue length-truncated visible text after provider iteration budget is exhausted", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Partial answer" }),
        providerExecution(" should not be requested.")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(result.providerExecution?.response?.content).toBe("Partial answer");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 0,
      exhausted: true,
      initialFinishReason: "length",
      finalFinishReason: "length"
    });
  });

  it("does not text-continue empty length-truncated content", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [], {
          response: {
            ok: true,
            content: "",
            finishReason: "length",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        }),
        providerExecution("should not be requested as continuation")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(result.providerExecution?.response?.content).toBe("should not be requested as continuation");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toBeUndefined();
    expect(JSON.stringify(harness.completeSpy.mock.calls[1]![0].messages)).not.toContain(
      "Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not repeat previous text."
    );
    expect(harness.completeSpy.mock.calls[1]![0].messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: ""
      })
    ]));
  });

  it("does not text-continue content-filtered visible text", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("Filtered partial", [], {
          response: {
            ok: true,
            content: "Filtered partial",
            finishReason: "content_filter",
            model: "test-model",
            provider: "test-provider"
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        }),
        providerExecution("should not be requested as continuation")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(result.providerExecution?.response?.content).toBe("Filtered partial");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toBeUndefined();
  });

  it("checks wall-clock budget before continuation calls", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Partial answer" }),
        providerExecution(" should not be requested.")
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2,
      maxProviderWallClockMs: 10
    });
    let dateCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      dateCalls += 1;
      return dateCalls <= 2 ? 0 : 11;
    });

    try {
      const result = await runBasicProviderTurn(harness.loop);

      expect(result.iterations).toBe(1);
      expect(harness.completeSpy).toHaveBeenCalledTimes(1);
      expect(result.providerExecution?.response?.content).toBe("Partial answer");
      expect(result.providerExecution?.runtimeMetadata?.continuation?.exhausted).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not concatenate continuation reasoning into visible output", async () => {
    const hiddenReasoning = "private continuation reasoning";
    const reasoningMetadata = {
      present: true,
      chars: hiddenReasoning.length,
      format: "reasoning_content" as const
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        lengthTruncatedTextExecution({ content: "Visible " }),
        providerExecution("answer", [], {
          response: {
            ok: true,
            content: "answer",
            finishReason: "stop",
            model: "test-model",
            provider: "test-provider",
            reasoning: hiddenReasoning,
            reasoningMetadata
          },
          runtimeMetadata: {
            reasoning: reasoningMetadata
          },
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.providerExecution?.response?.content).toBe("Visible answer");
    expect(JSON.stringify(result.providerExecution)).not.toContain(hiddenReasoning);
  });
});

describe("ProviderTurnLoop truncated tool-call safety", () => {
  it("retries primary length-truncated tool calls once before executing tools", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        truncatedToolCallExecution({ id: "first-truncated", argumentsText: "{\"secret\":\"discarded-first\"}" }),
        providerExecution("", [providerToolCall("retry-call", "{\"safe\":\"retry\"}")], {
          route: primaryRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        { executions: [toolExecution("retry-call")] }
      ],
      maxProviderIterations: 2
    });
    const events: RuntimeEvent[] = [];

    const result = await runBasicProviderTurn(harness.loop, { onEvent: (event) => {
      events.push(event);
    } });

    expect(result.iterations).toBe(2);
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toEqual(["retry-call"]);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(harness.executePlans.mock.calls[0]![0].providerExecution!.toolCalls).toEqual([
      expect.objectContaining({ id: "retry-call" })
    ]);
    expect(harness.completeSpy.mock.calls[1]![0].maxTokens).toBe(8192);
    expect(harness.completeSpy.mock.calls[1]![0].messages).toEqual(harness.completeSpy.mock.calls[0]![0].messages);
    const retryOptions = harness.completeSpy.mock.calls[1]![2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(retryOptions.primaryRoute).toEqual(primaryRoute);
    expect(retryOptions.fallbackChain).toEqual([fallbackRoute]);
    expect(result.providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: "retry-call" })
    ]);
    expect(result.providerExecution?.attempts).toHaveLength(2);
    expect(result.providerExecution?.runtimeMetadata?.truncation).toEqual({
      kind: "tool_call",
      retried: true,
      refused: false
    });
    const toolCallEvents = events.filter((event) => event.kind === "provider-tool-call");
    expect(toolCallEvents).toEqual([
      expect.objectContaining({
        id: "retry-call",
        argumentsText: "{\"safe\":\"retry\"}"
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("first-truncated");
    expect(JSON.stringify(events)).not.toContain("discarded-first");
  });

  it("retries fallback length-truncated tool calls from the successful fallback route", async () => {
    const fallbackFirst = truncatedToolCallExecution({
      id: "fallback-truncated",
      route: fallbackRoute,
      attemptedRouteIndex: 1,
      fallbackUsed: true,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: false,
          errorClass: "server",
          content: "primary failed"
        },
        {
          provider: "test-provider",
          model: "test-model-fallback",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "",
          finishReason: "length"
        }
      ]
    });
    const harness = await createPostToolNudgeHarness({
      responses: [
        fallbackFirst,
        providerExecution("", [providerToolCall("fallback-retry-call")], {
          route: fallbackRoute,
          attemptedRouteIndex: 0,
          routeRole: "primary"
        })
      ],
      toolSteps: [
        { executions: [toolExecution("fallback-retry-call")] }
      ],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(2);
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toEqual(["fallback-retry-call"]);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const retryOptions = harness.completeSpy.mock.calls[1]?.[2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(retryOptions.primaryRoute).toEqual(fallbackRoute);
    expect(retryOptions.fallbackChain).toEqual([]);
    expect(harness.completeSpy.mock.calls[1]?.[0].maxTokens).toBe(8192);
    expect(result.providerExecution?.route).toEqual(fallbackRoute);
    expect(result.providerExecution?.attemptedRouteIndex).toBe(1);
    expect(result.providerExecution?.routeRole).toBe("fallback");
  });

  it("refuses safely when retry is still length-truncated with tool calls", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        truncatedToolCallExecution({ id: "first-truncated", argumentsText: "{\"secret\":\"discarded-first\"}" }),
        truncatedToolCallExecution({ id: "retry-truncated", argumentsText: "{\"secret\":\"discarded-retry\"}" })
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });
    const events: RuntimeEvent[] = [];

    const result = await runBasicProviderTurn(harness.loop, { onEvent: (event) => {
      events.push(event);
    } });

    expect(result.iterations).toBe(2);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).not.toHaveBeenCalled();
    expect(result.toolExecutions).toEqual([]);
    expect(result.providerExecution?.ok).toBe(true);
    expect(result.providerExecution?.response?.content).toBe("The model response was truncated while generating tool calls, so EstaCoda refused to execute the incomplete tool arguments. Try again with a higher model.maxTokens value or a narrower request.");
    expect(result.providerExecution?.toolCalls).toEqual([]);
    expect(result.providerExecution?.runtimeMetadata?.truncation).toEqual({
      kind: "tool_call",
      retried: true,
      refused: true
    });
    expect(events.filter((event) => event.kind === "provider-tool-call")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("first-truncated");
    expect(JSON.stringify(events)).not.toContain("retry-truncated");
    expect(JSON.stringify(events)).not.toContain("discarded-first");
    expect(JSON.stringify(events)).not.toContain("discarded-retry");
    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    expect(messages.some((message) => message.metadata?.kind === "provider-tool-call-turn")).toBe(false);
  });

  it("refuses without retry when provider iteration budget is exhausted", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        truncatedToolCallExecution({ id: "first-truncated" }),
        providerExecution("", [providerToolCall("should-not-run")])
      ],
      toolSteps: [
        { executions: [toolExecution("should-not-run")] }
      ],
      maxProviderIterations: 1
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(result.iterations).toBe(1);
    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(harness.executePlans).not.toHaveBeenCalled();
    expect(result.toolExecutions).toEqual([]);
    expect(result.providerExecution?.response?.content).toBe("The model response was truncated while generating tool calls, so EstaCoda refused to execute the incomplete tool arguments. Try again with a higher model.maxTokens value or a narrower request.");
    expect(result.providerExecution?.runtimeMetadata?.truncation).toEqual({
      kind: "tool_call",
      retried: false,
      refused: true
    });
  });

  it("refuses without retry when wall-clock budget is exhausted before retry", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        truncatedToolCallExecution({ id: "first-truncated" }),
        providerExecution("", [providerToolCall("should-not-run")])
      ],
      toolSteps: [
        { executions: [toolExecution("should-not-run")] }
      ],
      maxProviderIterations: 2,
      maxProviderWallClockMs: 10
    });
    let dateCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      dateCalls += 1;
      return dateCalls <= 2 ? 0 : 11;
    });

    try {
      const result = await runBasicProviderTurn(harness.loop);

      expect(result.iterations).toBe(1);
      expect(harness.completeSpy).toHaveBeenCalledTimes(1);
      expect(harness.executePlans).not.toHaveBeenCalled();
      expect(result.providerExecution?.response?.content).toBe("The model response was truncated while generating tool calls, so EstaCoda refused to execute the incomplete tool arguments. Try again with a higher model.maxTokens value or a narrower request.");
      expect(result.providerExecution?.runtimeMetadata?.truncation).toEqual({
        kind: "tool_call",
        retried: false,
        refused: true
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns retry provider failures without executing first truncated tool calls", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        truncatedToolCallExecution({ id: "first-truncated" }),
        {
          ok: false,
          fallbackUsed: false,
          attempts: [
            {
              provider: "test-provider",
              model: "test-model",
              state: "dispatched",
              dispatchedAt: DISPATCHED_AT,
              ok: false,
              errorClass: "server",
              content: "retry failed"
            }
          ],
          toolCalls: []
        }
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(harness.executePlans.mock.calls[0]![0].providerExecution!.toolCalls).toEqual([]);
    expect(result.toolExecutions).toEqual([]);
    expect(result.providerExecution?.ok).toBe(false);
    expect(result.providerExecution?.attempts).toHaveLength(2);
  });

  it("keeps finalized malformed tool JSON as a tool-planning error", async () => {
    const harness = await createRealToolPlanningHarness({
      response: providerExecution("", [providerToolCall("bad-json", "{\"path\"")], {
        response: {
          ok: true,
          content: "",
          finishReason: "tool_calls",
          model: "test-model",
          provider: "test-provider"
        }
      })
    });
    const toolPlans: ToolCallPlan[] = [];

    const result = await harness.loop.run({
      userText: "current user request",
      routedText: "current user request",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans,
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(harness.executeTool).not.toHaveBeenCalled();
    expect(result.providerExecution?.ok).toBe(true);
    expect(result.providerExecution?.response?.finishReason).toBe("tool_calls");
    expect(result.providerExecution?.toolCalls).toEqual([
      expect.objectContaining({
        id: "bad-json",
        argumentsText: "{\"path\""
      })
    ]);
    expect(result.toolExecutions).toEqual([]);
    expect(toolPlans).toEqual([
      expect.objectContaining({
        id: "bad-json",
        status: "invalid",
        source: "provider-tool-call"
      })
    ]);
  });
});

describe("ProviderTurnLoop explicit route propagation", () => {
  it("uses the per-turn memory prompt context when assembling provider prompts", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());
    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });
    const loop = await createProviderTurnLoopForTest({ providerExecutor });

    await loop.run({
      userText: "What did we decide last time?",
      routedText: "What did we decide last time?",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: {
        frozenCompactMemory: [],
        safetyMemory: [],
        sessionRecall: [
          {
            id: "session-recall:sess-1",
            kind: "session-recall",
            scope: "session",
            source: "session:sess-1",
            content: `${SESSION_RECALL_UNTRUSTED_NOTICE}\nRuntime recall marker`,
            chars: `${SESSION_RECALL_UNTRUSTED_NOTICE}\nRuntime recall marker`.length,
            entryIds: ["sess-1"],
            trusted: false
          }
        ],
        diagnostics: {
          includedBlocks: [],
          suppressedEntries: 0,
          duplicateEntriesRemoved: 0,
          recallTriggered: true,
          budgetPressure: [],
          compactionPressure: [],
          warnings: []
        }
      },
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    const request = completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect(JSON.stringify(request.messages)).toContain("Runtime recall marker");
    expect(JSON.stringify(request.messages)).toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
  });

  it("always passes primaryRoute and fallbackChain to ProviderExecutor.complete", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());

    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });

    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-123";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [fallbackRoute],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    const result = await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);

    const callArgs = completeSpy.mock.calls[0];
    const request = callArgs[0] as ProviderRequest;
    const executionOptions = callArgs[2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };

    expect(request).not.toHaveProperty("maxTokens");
    expect(executionOptions).toBeDefined();
    expect(executionOptions.primaryRoute).toBeDefined();
    expect(executionOptions.primaryRoute!.provider).toBe("test-provider");
    expect(executionOptions.primaryRoute!.id).toBe("test-model");
    expect(executionOptions.primaryRoute!.baseUrl).toBe("https://primary.example.com/v1");
    expect(executionOptions.primaryRoute!.apiKeyEnv).toBe("PRIMARY_KEY");

    expect(executionOptions.fallbackChain).toBeDefined();
    expect(executionOptions.fallbackChain!.length).toBe(1);
    expect(executionOptions.fallbackChain![0].provider).toBe("test-provider");
    expect(executionOptions.fallbackChain![0].id).toBe("test-model-fallback");
    expect(executionOptions.fallbackChain![0].baseUrl).toBe("https://fallback.example.com/v1");
    expect(executionOptions.fallbackChain![0].apiKeyEnv).toBe("FALLBACK_KEY");

    expect(result.providerExecution).toBeDefined();
    expect(result.providerExecution!.ok).toBe(true);

    completeSpy.mockRestore();
  });

  it("passes undefined fallbackChain when no fallback routes are configured", async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockAdapter());

    const providerExecutor = new ProviderExecutor({ registry });
    const completeSpy = vi.spyOn(providerExecutor, "complete").mockResolvedValue({
      ok: true,
      response: {
        ok: true,
        content: "mock-response",
        model: "test-model",
        provider: "test-provider"
      },
      fallbackUsed: false,
      attempts: [
        {
          provider: "test-provider",
          model: "test-model",
          state: "dispatched",
          dispatchedAt: DISPATCHED_AT,
          ok: true,
          content: "mock-response"
        }
      ],
      toolCalls: []
    });

    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-456";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    const executionOptions = completeSpy.mock.calls[0][2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };

    expect(executionOptions.primaryRoute).toBeDefined();
    expect(executionOptions.fallbackChain).toEqual([]);

    completeSpy.mockRestore();
  });

  it("returns undefined providerExecution when providerExecutor is undefined", async () => {
    const sessionDb = new InMemorySessionDB();
    const sessionId = "test-session-789";
    await sessionDb.createSession({ id: sessionId, profileId: "default", title: "test" });

    const trajectoryRecorder = new TrajectoryRecorder({
      profileId: "default",
      sessionId,
      modelId: "test-model"
    });

    const runRecorder = new RunRecorder({
      sessionDb,
      sessionId,
      trajectoryRecorder,
      profileId: "default"
    });

    const toolPlanRunner = new ToolPlanRunner({
      toolCallPlanner: undefined,
      toolExecutor: {} as any,
      runRecorder,
      sessionId,
      maxConcurrentSafeTools: 4
    });

    const loop = new ProviderTurnLoop({
      providerExecutor: undefined,
      model: mockModel,
      primaryModelRoute: primaryRoute,
      modelFallbackRoutes: [fallbackRoute],
      providerPreferences: {
        providerOrder: ["test-provider"]
      },
      sessionDb,
      sessionId,
      profileId: "default",
      trajectoryRecorder,
      runRecorder,
      toolPlanRunner,
      soul: undefined,
      memoryPromptContext: undefined,
      skillsIndex: [],
      ui: undefined,
      agentProfile: undefined,
      budgets: {
        maxProviderIterations: 2,
        maxProviderToolCalls: 4,
        maxRepeatedToolFailures: 2,
        maxProviderWallClockMs: 10_000
      }
    });

    const result = await loop.run({
      userText: "hello",
      routedText: "hello",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      attachments: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "",
      toolPlans: [],
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(result.providerExecution).toBeUndefined();
    expect(result.iterations).toBe(0);
  });
});
