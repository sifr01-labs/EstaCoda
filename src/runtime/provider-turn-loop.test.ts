import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionCompressionConfig } from "../config/runtime-config.js";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { BrowserBackend } from "../contracts/browser.js";
import { browserCapabilities } from "../browser/browser-capabilities.js";
import type { ContextExpansionResult } from "../contracts/context.js";
import type { ModelProfile, ResolvedModelRoute, ProviderRequest, ProviderResponse, ProviderStreamDiagnostics } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ReplacementSessionMessage, SessionDB, SessionEvent } from "../contracts/session.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { RegisteredTool, ToolDefinition } from "../contracts/tool.js";
import type { SecureInputRequestHandler } from "../contracts/secure-input.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { createOpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { SessionCompressionService, type CompactResult } from "../prompt/session-compression-service.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { ToolCallPlanner } from "../tools/tool-call-planner.js";
import {
  buildProviderToolSchemaCatalog,
  type OpenAICompatibleToolSchema,
  type ProviderToolSchemaCatalog
} from "../tools/tool-schema.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createPlanTools } from "../tools/plan-tools.js";
import { RunRecorder } from "./run-recorder.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
import { ProviderTurnLoop, providerEfficiencySignals, type ProviderTurnLoopOptions } from "./provider-turn-loop.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import { ExecutionPlanController } from "./execution-plan-controller.js";
import { ExecutionCapabilityPreflight } from "./execution-capability-preflight.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { ExecutionWorkingSetController } from "./execution-working-set.js";
import { ExecutionCheckpointController } from "./execution-checkpoint-controller.js";
import { EXECUTION_SUPERVISION_PROMPTS } from "./execution-supervision-controller.js";
import { attachEphemeralVisionImages } from "../vision/ephemeral-vision-content.js";
import { createSessionRuntimeContext } from "./session-runtime-context.js";

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
  const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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
      maxRepeatedBrowserObservations: 3,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6,
      maxProviderWallClockMs: 10_000,
      finalizationReserveMs: 0
    },
    ...overrides
  });
}

async function createCompressionHarness() {
  const registry = new ProviderRegistry();
  registry.register(createMockAdapter());
  const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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
      maxRepeatedBrowserObservations: 3,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6,
      maxProviderWallClockMs: 10_000,
      finalizationReserveMs: 0
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
    toolExecutions?: ToolExecutionRecord[];
    toolPlans?: ToolCallPlan[];
    context?: ContextExpansionResult;
    visibleTurnId?: string;
    userText?: string;
    providerTools?: OpenAICompatibleToolSchema[];
    toolExpansionCandidates?: Parameters<ProviderTurnLoop["run"]>[0]["toolExpansionCandidates"];
    providerToolSchemaCatalog?: ProviderToolSchemaCatalog;
    signal?: AbortSignal;
    onSecureInputRequest?: SecureInputRequestHandler;
    onApprovalRequest?: Parameters<ProviderTurnLoop["run"]>[0]["onApprovalRequest"];
  } = {}
): Promise<Awaited<ReturnType<ProviderTurnLoop["run"]>>> {
  return await loop.run({
    visibleTurnId: callbacks.visibleTurnId,
    userText: callbacks.userText ?? "current user request",
    routedText: callbacks.userText ?? "current user request",
    selectedSkill: undefined,
    selectedSkillInstructions: undefined,
    selectedSkillResources: undefined,
    selectedSkillSetup: undefined,
    intent: { labels: ["general"], confidence: 1, nativeIntent: "general", evidence: [], suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, rationale: "" },
    securityDecision: "allow",
    toolExecutions: callbacks.toolExecutions ?? [],
    context: callbacks.context,
    projectContext: undefined,
    attachments: callbacks.attachments,
    memoryPromptContext: undefined,
    providerTools: callbacks.providerTools ?? [],
    toolExpansionCandidates: callbacks.toolExpansionCandidates,
    fallbackText: "",
    toolPlans: callbacks.toolPlans ?? [],
    trustedWorkspace: false,
    initialRiskClass: "read-only-local",
    onEvent: callbacks.onEvent,
    onDelta: callbacks.onDelta,
    onSegmentBreak: callbacks.onSegmentBreak,
    onSecureInputRequest: callbacks.onSecureInputRequest,
    onApprovalRequest: callbacks.onApprovalRequest,
    signal: callbacks.signal
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

function providerToolCall(
  id: string,
  argumentsText = "{}",
  name = testTool.name
): ProviderExecutionResult["toolCalls"][number] {
  return {
    id,
    name,
    argumentsText
  };
}

function toolProviderSchema(name: string): OpenAICompatibleToolSchema {
  return {
    type: "function",
    function: {
      name,
      description: `${name} test schema`,
      parameters: { type: "object", properties: {} }
    }
  };
}

function planProviderSchema(): OpenAICompatibleToolSchema {
  return toolProviderSchema("plan");
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
  noProgressNudgeIteration?: number;
  maxNoProgressIterations?: number;
  finalizationReserveMs?: number;
  taskExecution?: ProviderTurnLoopOptions["taskExecution"];
  executionPlanReader?: ProviderTurnLoopOptions["executionPlanReader"];
  executionPlanController?: ExecutionPlanController;
  executionWorkingSet?: ProviderTurnLoopOptions["executionWorkingSet"];
  executionCheckpointController?: ProviderTurnLoopOptions["executionCheckpointController"];
  browserSessionLease?: ProviderTurnLoopOptions["browserSessionLease"];
  browserBackend?: BrowserBackend;
  sessionRuntimeContext?: ProviderTurnLoopOptions["sessionRuntimeContext"];
  sessionId?: string;
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
  const sessionId = input.sessionId ?? `nudge-session-${Date.now()}-${Math.random()}`;
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
    const runtimeCalls = stepInput.providerExecution?.toolCalls ?? [];
    for (const [index, plan] of (step.plans ?? []).entries()) {
      if (runtimeCalls[index]?.id !== undefined) plan.id = runtimeCalls[index].id;
      stepInput.toolPlans.push(plan);
    }
    for (const [index, execution] of (step.executions ?? []).entries()) {
      if (runtimeCalls[index]?.id !== undefined) execution.toolCallId = runtimeCalls[index].id;
      const plan = toolPlan(execution.toolCallId ?? execution.tool.name);
      plan.tool = execution.tool.name;
      plan.result = execution.result;
      stepInput.toolPlans.push(plan);
      await stepInput.onExecution?.(execution);
    }
    return {
      executions: step.executions ?? [],
      maxObservedRisk: stepInput.riskBaseline
    };
  });
  const executeInternalTool = vi.fn(async (stepInput: Parameters<ToolPlanRunner["executeInternalTool"]>[0]) => {
    const step = input.toolSteps[toolStepIndex] ?? {};
    toolStepIndex += 1;
    const plan: ToolCallPlan = {
      id: stepInput.id,
      tool: stepInput.tool,
      input: stepInput.value,
      source: "internal",
      status: "executed"
    };
    stepInput.toolPlans.push(plan);
    const execution = step.executions?.[0];
    if (execution !== undefined) {
      execution.toolCallId = stepInput.id;
      await stepInput.onExecution?.(execution);
    }
    return {
      ...(execution === undefined ? {} : { execution }),
      maxObservedRisk: stepInput.riskBaseline
    };
  });
  const toolPlanRunner = {
    executePlans,
    executeInternalTool
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
      maxRepeatedBrowserObservations: 3,
      noProgressNudgeIteration: input.noProgressNudgeIteration ?? 3,
      maxNoProgressIterations: input.maxNoProgressIterations ?? 6,
      maxProviderWallClockMs: input.maxProviderWallClockMs ?? 10_000,
      finalizationReserveMs: input.finalizationReserveMs ?? 0
    },
    taskExecution: input.taskExecution,
    executionPlanReader: input.executionPlanController ?? input.executionPlanReader,
    executionWorkingSet: input.executionWorkingSet,
    executionCheckpointController: input.executionCheckpointController,
    browserSessionLease: input.browserSessionLease,
    browserBackend: input.browserBackend,
    sessionRuntimeContext: input.sessionRuntimeContext
  });

  return {
    loop,
    completeSpy,
    executePlans,
    executeInternalTool,
    sessionDb,
    sessionId
  };
}

async function createRealToolPlanningHarness(input: {
  response: ProviderExecutionResult;
  taskExecution?: ProviderTurnLoopOptions["taskExecution"];
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
      maxRepeatedBrowserObservations: 3,
      noProgressNudgeIteration: 3,
      maxNoProgressIterations: 6,
      maxProviderWallClockMs: 10_000,
      finalizationReserveMs: 0
    },
    taskExecution: input.taskExecution
  });

  return {
    loop,
    completeSpy,
    executeTool,
    sessionId
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
    getSessionForProfile: overrides.getSessionForProfile ?? db.getSessionForProfile.bind(db),
    listSessions: overrides.listSessions ?? db.listSessions.bind(db),
    listSessionSummaries: overrides.listSessionSummaries ?? db.listSessionSummaries.bind(db),
    hasUserMessageForProfile: overrides.hasUserMessageForProfile ?? db.hasUserMessageForProfile.bind(db),
    setSessionTitleIfPlaceholder: overrides.setSessionTitleIfPlaceholder ?? db.setSessionTitleIfPlaceholder.bind(db),
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

describe("providerEfficiencySignals", () => {
  it("nudges at half the configured provider-call budget and prefers a grounded API artifact", () => {
    expect(providerEfficiencySignals({
      providerCalls: 9,
      providerCallBudget: 20,
      providerTokens: 0,
      repeatedMcpReads: 0,
      machineReadableApiDescriptionAvailable: false
    })).not.toEqual(expect.arrayContaining([expect.stringContaining("provider calls have been used")]));

    const signals = providerEfficiencySignals({
      providerCalls: 10,
      providerCallBudget: 20,
      providerTokens: 0,
      repeatedMcpReads: 0,
      machineReadableApiDescriptionAvailable: true
    });
    expect(signals).toEqual(expect.arrayContaining([
      expect.stringContaining("10 provider calls have been used"),
      expect.stringContaining("grounded machine-readable API description")
    ]));
  });
});

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

  it("continues to a truthful final response after a tool timeout", async () => {
    const timedOut = toolExecution("call-timeout");
    timedOut.settlement = {
      terminalStatus: "timed_out",
      dispatchState: "started",
      sideEffectState: "none",
      timeoutMs: 10
    };
    timedOut.result = {
      ok: false,
      content: "Tool execution timed out without a side effect. The call may be retried if it is still needed.",
      metadata: {
        reason: "timeout",
        terminalStatus: "timed_out",
        dispatchState: "started",
        sideEffectState: "none",
        timeoutMs: 10
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-timeout")]),
        providerExecution("The read timed out, so I could not confirm the requested state.")
      ],
      toolSteps: [{ executions: [timedOut] }]
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(result.providerExecution?.response?.content).toBe(
      "The read timed out, so I could not confirm the requested state."
    );
    expect(JSON.stringify(harness.completeSpy.mock.calls[1]?.[0])).toContain("timed out without a side effect");
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

  it("propagates complete Task lineage into provider-planned tool execution", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-task-tool")]),
        providerExecution("done")
      ],
      toolSteps: [{ executions: [toolExecution("call-task-tool")] }],
      taskExecution: {
        taskId: "task-leaf",
        rootTaskId: "task-root",
        planRevisionId: "revision-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        originSessionId: "origin-session",
        originTurnId: "origin-turn"
      }
    });

    await runBasicProviderTurn(harness.loop, { visibleTurnId: "worker-visible-turn" });

    expect(harness.executePlans.mock.calls[0]?.[0].providerUsageLineage).toEqual({
      executionSessionId: harness.sessionId,
      visibleTurnId: "origin-turn",
      taskId: "task-leaf",
      rootTaskId: "task-root",
      planRevisionId: "revision-1",
      stepId: "step-1",
      attemptId: "attempt-1"
    });
  });

  it("forwards Task lineage through ToolPlanRunner to ToolExecutor", async () => {
    const harness = await createRealToolPlanningHarness({
      response: providerExecution("", [providerToolCall("call-task-tool")]),
      taskExecution: {
        taskId: "task-leaf",
        rootTaskId: "task-root",
        planRevisionId: "revision-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        originTurnId: "origin-turn"
      }
    });

    await runBasicProviderTurn(harness.loop, { visibleTurnId: "worker-visible-turn" });

    expect(harness.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      providerUsageLineage: {
        executionSessionId: harness.sessionId,
        visibleTurnId: "origin-turn",
        taskId: "task-leaf",
        rootTaskId: "task-root",
        planRevisionId: "revision-1",
        stepId: "step-1",
        attemptId: "attempt-1"
      }
    }));
  });

  it("forwards current-turn image attachment provenance through ToolPlanRunner", async () => {
    const harness = await createRealToolPlanningHarness({
      response: providerExecution("", [providerToolCall("call-vision-tool")])
    });

    await runBasicProviderTurn(harness.loop, {
      attachments: [{
        id: "image-current-turn",
        kind: "image",
        status: "ready",
        localPath: "/profile/channel-media/inbound/image.png"
      }],
      context: {
        originalText: "inspect @file:workspace-reference.png",
        expandedText: "inspect @file:workspace-reference.png",
        references: [{
          raw: "@file:workspace-reference.png",
          kind: "file",
          target: "workspace-reference.png"
        }],
        blocks: [],
        warnings: []
      }
    });

    expect(harness.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      visionInputProvenance: {
        attachmentPaths: ["/profile/channel-media/inbound/image.png"],
        explicitReferencePaths: ["workspace-reference.png"]
      }
    }));
  });
});

describe("ProviderTurnLoop provider availability", () => {
  it("passes the persisted visible user turn to the canonical provider boundary", async () => {
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

    expect(harness.completeSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        usage: expect.objectContaining({
          sourceKind: "main",
          executionSessionId: harness.sessionId,
          visibleTurnId: `${harness.sessionId}-latest`
        })
      })
    );
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
  it("uses registry max output metadata for request accounting", async () => {
    const harness = await createCompressionHarness();
    const modelWithOutputLimit: ModelProfile = {
      ...mockModel,
      maxOutputTokens: 16_384
    };

    await runBasicProviderTurn(harness.loop({
      model: modelWithOutputLimit,
      primaryModelRoute: {
        ...primaryRoute,
        profile: modelWithOutputLimit
      }
    }));

    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId)).find(
      (event): event is Extract<SessionEvent, { kind: "prompt-assembled" }> => event.kind === "prompt-assembled"
    );
    expect(promptEvent?.budget.requestAccounting?.outputReservationTokens).toBe(16_384);
  });

  it("accounts for the exact native schemas sent in the provider request", async () => {
    const harness = await createCompressionHarness();
    const providerTools = [
      toolProviderSchema("fixture.first"),
      toolProviderSchema("fixture.second")
    ];
    const loop = harness.loop();

    await runBasicProviderTurn(loop, { providerTools });

    const request = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    const promptEvent = (await harness.sessionDb.listEvents(harness.sessionId)).find(
      (event): event is Extract<SessionEvent, { kind: "prompt-assembled" }> => event.kind === "prompt-assembled"
    );
    const accounting = promptEvent?.budget.requestAccounting;
    const serializedSchemas = JSON.stringify(request.tools);

    expect(request.tools).toEqual(providerTools);
    expect(JSON.stringify(request.messages)).not.toContain("fixture.first test schema");
    expect(JSON.stringify(request.messages)).not.toContain("fixture.second test schema");
    expect(accounting).toMatchObject({
      selectedToolCount: request.tools?.length,
      serializedSchemaBytes: Buffer.byteLength(serializedSchemas, "utf8"),
      outputReservationTokens: mockModel.contextWindowTokens
    });
    expect(accounting?.estimatedSchemaTokens).toBeGreaterThan(0);
    expect(accounting?.estimatedMessageTokens).toBeGreaterThan(0);
    expect(accounting?.estimatedInputTokens).toBe(
      (accounting?.estimatedMessageTokens ?? 0) + (accounting?.estimatedSchemaTokens ?? 0)
    );
    expect(accounting?.totalEstimatedRequestTokens).toBe(
      (accounting?.estimatedInputTokens ?? 0) + mockModel.contextWindowTokens
    );
    expect(loop.lastPromptTokens()).toBe(accounting?.estimatedInputTokens);
  });

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

      const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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
          maxRepeatedBrowserObservations: 3,
          noProgressNudgeIteration: 3,
          maxNoProgressIterations: 6,
          maxProviderWallClockMs: 10_000,
          finalizationReserveMs: 0
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
  it("replays only the newest raw tool batch in flat continuation feedback", async () => {
    const firstRawResult = "FIRST_RAW_TOOL_RESULT";
    const secondRawResult = "SECOND_RAW_TOOL_RESULT";
    const firstExecution = toolExecution("call-first", firstRawResult);
    const secondExecution = toolExecution("call-second", secondRawResult);
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-first")]),
        providerExecution("", [providerToolCall("call-second")]),
        providerExecution("Completed after both tool batches.")
      ],
      toolSteps: [
        { executions: [firstExecution] },
        { executions: [secondExecution] },
        {}
      ],
      maxProviderIterations: 3
    });

    await runBasicProviderTurn(harness.loop);

    const thirdRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest;
    const continuation = JSON.stringify(thirdRequest.messages.at(-1)?.content);
    expect(continuation).toContain(secondRawResult);
    expect(firstExecution.toolCallId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(continuation).toContain(firstExecution.toolCallId!);
    expect(continuation).not.toContain(firstRawResult);
  });

  it("does not continue provider narration merely because a Mission remains unfinished", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Build the collection",
      originTurnId: "turn-plan",
      revision: 1,
      status: "active",
      items: [
        { id: "build", content: "Build collection", status: "in_progress" },
        { id: "verify", content: "Verify collection", status: "pending" }
      ]
    });
    const harness = await createPostToolNudgeHarness({
      responses: Array.from({ length: 7 }, (_, index) => providerExecution(`Narration ${index + 1}`)),
      toolSteps: [],
      executionPlanReader: planStore,
      maxProviderIterations: 8
    });

    const result = await runBasicProviderTurn(harness.loop);
    const recoveryText = "The foreground tool loop has repeated the same calls or results without material progress.";
    const requests = harness.completeSpy.mock.calls.map((call) => call[0] as ProviderRequest);

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => JSON.stringify(request.messages).includes(recoveryText))).toHaveLength(0);
    expect(result.providerExecution?.response?.content).toBe("Narration 1");
  });

  it("stops a repeated tool loop despite changing provider result representations", async () => {
    const toolNames = Array.from({ length: 7 }, () => "mcp.postman.getCollection");
    const harness = await createPostToolNudgeHarness({
      responses: toolNames.map((toolName, index) => providerExecution("", [
        providerToolCall(`call-loop-${index + 1}`, "{}", toolName)
      ])),
      toolSteps: toolNames.map((toolName, index) => ({
        executions: [toolExecutionForTool(
          `call-loop-${index + 1}`,
          toolName,
          `Changing representation ${index + 1}`
        )]
      })),
      maxProviderIterations: 12
    });
    const events: RuntimeEvent[] = [];

    const result = await runBasicProviderTurn(harness.loop, {
      onEvent: (event) => events.push(event)
    });
    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);
    const nudgeText = "The foreground tool loop has repeated the same calls or results without material progress.";

    expect(harness.completeSpy).toHaveBeenCalledTimes(7);
    expect(harness.executePlans).toHaveBeenCalledTimes(7);
    expect(requests.filter((request) => JSON.stringify(request.messages).includes(nudgeText))).toHaveLength(1);
    expect(result.providerExecution?.response?.content).toContain("foreground tool loop stopped");
    expect(result.providerExecution?.response?.content).toContain("independent of any plan");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "provider-budget-exhausted",
        budget: "tool-loop-no-progress-iterations",
        limit: 6,
        observed: 6
      })
    ]));
  });

  it("truthfully stops checkpointed work when only non-semantic reads repeat", async () => {
    const checkpoint = new ExecutionCheckpointController({
      sessionId: "checkpoint-no-progress-session",
      profileId: "default",
      now: () => "2030-01-01T00:00:00.000Z",
      createId: () => "checkpoint:no-progress"
    });
    await checkpoint.ensure({
      originTurnId: "turn-no-progress",
      originalObjective: "Import and verify the Postman collection",
      qualificationReasons: ["external_multi_step"],
      intentLabels: ["api.integration"],
      requiredOperations: ["read", "mutation", "verification"],
      connectorIds: ["postman"],
      completionFloor: "mutation_with_verification"
    });
    const toolNames = Array.from({ length: 5 }, () => "mcp.postman.getCollection");
    const harness = await createPostToolNudgeHarness({
      sessionId: "checkpoint-no-progress-session",
      responses: toolNames.map((toolName, index) => providerExecution("", [
        providerToolCall(`call-checkpoint-loop-${index + 1}`, "{}", toolName)
      ])),
      toolSteps: toolNames.map((toolName, index) => ({
        executions: [toolExecutionForTool(
          `call-checkpoint-loop-${index + 1}`,
          toolName,
          `Changing representation ${index + 1}`
        )]
      })),
      executionCheckpointController: checkpoint,
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 3,
      maxProviderIterations: 8
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(checkpoint.current()?.progressRevision).toBe(0);
    expect(result.terminationCause).toBe("tool_loop_no_progress");
    expect(result.providerExecution?.response?.content).toContain("foreground tool loop stopped");
  });

  it("does not stop checkpointed work while new connector mutations and declared verification advance it", async () => {
    const checkpoint = new ExecutionCheckpointController({
      sessionId: "checkpoint-connector-progress-session",
      profileId: "default",
      now: () => "2030-01-01T00:00:00.000Z",
      createId: () => "checkpoint:connector-progress"
    });
    await checkpoint.ensure({
      originTurnId: "turn-connector-progress",
      originalObjective: "Import and verify the Postman collection",
      qualificationReasons: ["external_multi_step"],
      intentLabels: ["api.integration"],
      requiredOperations: ["read", "mutation", "verification"],
      connectorIds: ["postman"],
      completionFloor: "mutation_with_verification"
    });
    const postmanExecution = (input: {
      id: string;
      tool: string;
      effect: NonNullable<ToolExecutionRecord["executionEffect"]>;
      riskClass?: ToolExecutionRecord["riskClass"];
    }): ToolExecutionRecord => {
      const record = toolExecutionForTool(input.id, input.tool, `${input.tool} completed`);
      record.tool.toolsets = ["mcp"];
      record.tool.riskClass = input.riskClass ?? "read-only-network";
      record.riskClass = record.tool.riskClass;
      record.executionEffect = input.effect;
      return record;
    };
    const steps = [
      postmanExecution({
        id: "call-create-spec",
        tool: "mcp.postman.createSpec",
        riskClass: "external-side-effect",
        effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
      }),
      postmanExecution({
        id: "call-get-spec",
        tool: "mcp.postman.getSpec",
        effect: {
          kind: "verification",
          verifies: ["mcp.postman.createSpec"],
          connector: { kind: "mcp", id: "postman" }
        }
      }),
      postmanExecution({
        id: "call-generate-collection",
        tool: "mcp.postman.generateCollection",
        riskClass: "external-side-effect",
        effect: { kind: "mutation", connector: { kind: "mcp", id: "postman" } }
      }),
      postmanExecution({
        id: "call-get-spec-collections",
        tool: "mcp.postman.getSpecCollections",
        effect: {
          kind: "verification",
          verifies: ["mcp.postman.generateCollection"],
          connector: { kind: "mcp", id: "postman" }
        }
      }),
      toolExecutionForTool("call-browser-navigate", "browser.navigate", "product page opened"),
      toolExecutionForTool("call-browser-snapshot", "browser.snapshot", "product page inspected")
    ];
    const harness = await createPostToolNudgeHarness({
      sessionId: "checkpoint-connector-progress-session",
      responses: [
        ...steps.map((execution) => providerExecution("", [providerToolCall(
          execution.toolCallId!,
          "{}",
          execution.tool.name
        )])),
        providerExecution("Imported and verified the collection, then continued to the next product.")
      ],
      toolSteps: steps.map((execution) => ({ executions: [execution] })),
      executionCheckpointController: checkpoint,
      noProgressNudgeIteration: 2,
      maxNoProgressIterations: 4,
      maxProviderIterations: 8
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(7);
    expect(result.terminationCause).toBe("normal");
    expect(result.providerExecution?.response?.content).toContain("Imported and verified");
  });

  it("reuses a successful Postman workspace argument without parsing connector prose", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Configure MTN products in Postman",
      originTurnId: "turn-working-set",
      revision: 1,
      status: "active",
      items: [{ id: "inspect", content: "Inspect Postman", status: "in_progress" }]
    });
    const workingSet = new ExecutionWorkingSetController({
      profileId: "default",
      sessionId: "placeholder"
    });
    const workspaceRead = toolExecutionForTool(
      "call-workspaces-working-set",
      "mcp.postman.getCollections",
      "| Collection | ID |\n| MTN Products | collection-123 |"
    );
    workspaceRead.input = { workspace: "workspace-456" };
    workspaceRead.riskClass = "read-only-network";
    workspaceRead.tool.riskClass = "read-only-network";
    workspaceRead.tool.toolsets = ["mcp"];
    workspaceRead.result = {
      ok: true,
      content: "| Collection | ID |\n| MTN Products | collection-123 |"
    };
    const collectionCreate = toolExecutionForTool(
      "call-create-collection",
      "mcp.postman.createCollection",
      "collection created"
    );
    collectionCreate.input = { workspace: "workspace-456", collection: { name: "MTN Products" } };
    collectionCreate.riskClass = "external-side-effect";
    collectionCreate.tool.riskClass = "external-side-effect";
    collectionCreate.tool.toolsets = ["mcp"];
    collectionCreate.executionEffect = { kind: "mutation", connector: { kind: "mcp", id: "postman" } };
    const dispatchedTools: string[] = [];
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall(
          "call-workspaces-working-set",
          JSON.stringify({ workspace: "workspace-456" }),
          "mcp.postman.getCollections"
        )]),
        providerExecution("", [providerToolCall(
          "call-create-collection",
          JSON.stringify({ workspace: "workspace-456", collection: { name: "MTN Products" } }),
          "mcp.postman.createCollection"
        )]),
        providerExecution("Created the collection in the known workspace.")
      ],
      toolSteps: [{ executions: [workspaceRead] }, { executions: [collectionCreate] }],
      executionPlanReader: planStore,
      executionWorkingSet: workingSet,
      onExecutePlans: ({ stepInput }) => {
        const current = stepInput.toolPlans.at(-1)?.tool;
        if (current !== undefined) dispatchedTools.push(current);
      },
      maxProviderIterations: 3
    });

    await runBasicProviderTurn(harness.loop);

    const continuation = JSON.stringify((harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest).messages);
    expect(continuation).toContain("Authoritative execution working state");
    expect(continuation).toContain("Workspace: workspace-456");
    expect(continuation.match(/MTN Products/gu)).toHaveLength(1);
    expect(dispatchedTools).toEqual([
      "mcp.postman.getCollections",
      "mcp.postman.createCollection"
    ]);
  });

  it("grounds provider continuations in the current controlled browser tab", async () => {
    const browserExecution = toolExecutionForTool(
      "call-browser-state",
      "browser.snapshot",
      "Historical-looking snapshot excerpt"
    );
    browserExecution.riskClass = "read-only-network";
    browserExecution.tool.riskClass = "read-only-network";
    browserExecution.result = {
      ok: true,
      content: "Current browser snapshot",
      metadata: {
        snapshot: {
          sessionId: "browser-session",
          url: "https://example.com/oauth",
          title: "OAuth V1",
          identity: { documentEpoch: 4, actionRevision: 12, observationId: 15 },
          observedAt: "2026-08-13T00:00:00.000Z",
          readiness: "complete",
          tab: {
            ref: "@t3",
            url: "https://example.com/oauth",
            title: "OAuth V1",
            controlled: true
          }
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-browser-state", "{}", "browser.snapshot")]),
        providerExecution("Continue on OAuth V1.")
      ],
      toolSteps: [{ executions: [browserExecution] }],
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop);

    const continuation = JSON.stringify((harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest).messages);
    expect(continuation).toContain("Authoritative current browser state");
    expect(continuation).toContain("Controlled tab: @t3 (controlled)");
    expect(continuation).toContain("supersedes browser state found in conversation history");
  });

  it("corrects a provider stop on a visible OTP challenge before it reaches ordinary chat", async () => {
    const challengeSnapshot = toolExecutionForTool(
      "call-otp-snapshot",
      "browser.snapshot",
      "Current browser snapshot"
    );
    challengeSnapshot.tool.toolsets = ["browser"];
    challengeSnapshot.result = {
      ok: true,
      content: "Current browser snapshot",
      metadata: {
        snapshot: {
          sessionId: "browser-session",
          url: "https://portal.example.com/challenge",
          title: "Verify account",
          identity: { documentEpoch: 4, actionRevision: 12, observationId: 15 },
          observedAt: "2026-08-13T00:00:00.000Z",
          readiness: "complete",
          tab: {
            ref: "@t3",
            url: "https://portal.example.com/challenge",
            title: "Verify account",
            controlled: true
          },
          elements: [
            { ref: "@e19", role: "textbox", name: "Enter authenticator code", withinText: "Authenticate" },
            { ref: "@e20", role: "button", name: "Authenticate", withinText: "Authenticate" }
          ]
        }
      }
    };
    const protectedInput = toolExecutionForTool(
      "call-otp-input",
      "browser.type",
      "Protected input delivered and submitted."
    );
    protectedInput.tool.toolsets = ["browser"];
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-otp-snapshot", "{}", "browser.snapshot")]),
        providerExecution("Please paste the verification code here."),
        providerExecution("", [providerToolCall(
          "call-otp-input",
          JSON.stringify({
            ref: "@e19",
            identity: { documentEpoch: 4, actionRevision: 12, observationId: 15 },
            tabRef: "@t3",
            protectedInput: { kind: "one-time-code", purpose: "Verify account" },
            submitRef: "@e20"
          }),
          "browser.type"
        )]),
        providerExecution("Authentication continued securely.")
      ],
      toolSteps: [
        { executions: [challengeSnapshot] },
        {},
        { executions: [protectedInput] },
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser.snapshot"), toolProviderSchema("browser.type")]
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(4);
    const correctionRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest;
    expect(JSON.stringify(correctionRequest.messages)).toContain(
      "Do not ask the user to send the code in ordinary chat."
    );
    expect(harness.executePlans.mock.calls[2]?.[0].providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u), name: "browser.type" })
    ]);
    expect(result.providerExecution?.response?.content).toBe("Authentication continued securely.");
    expect(result.providerExecution?.response?.content).not.toContain("paste the verification code");
  });

  it("submits a newly detected OTP challenge locally before the next provider continuation", async () => {
    const challengeIdentity = { documentEpoch: 4, actionRevision: 12, observationId: 15 };
    const authenticatedIdentity = { documentEpoch: 5, actionRevision: 13, observationId: 16 };
    const challengeSnapshot = {
      sessionId: "browser-session",
      url: "https://portal.example.com/challenge",
      title: "Two-factor authentication",
      identity: challengeIdentity,
      observedAt: "2026-08-13T00:00:00.000Z",
      readiness: "complete" as const,
      tab: {
        ref: "@t3",
        url: "https://portal.example.com/challenge",
        title: "Two-factor authentication",
        controlled: true
      },
      elements: [
        { ref: "@e19", role: "textbox", name: "Enter authenticator code" },
        { ref: "@e20", role: "button", name: "Authenticate", withinText: "Two-factor authentication" }
      ]
    };
    const credentials = toolExecutionForTool("call-credentials", "browser.fill_protected_form", "challenge shown");
    credentials.tool.toolsets = ["browser"];
    credentials.result = {
      ok: true,
      content: "Credentials submitted; challenge required.",
      metadata: {
        secureInputGroupReceipt: { status: "delivered" },
        protectedDelivery: {
          delivery: "delivered",
          submission: "clicked",
          documentChanged: true,
          challengeState: "departed",
          conditionMet: true,
          beforeIdentity: { documentEpoch: 3, actionRevision: 11, observationId: 14 },
          afterIdentity: challengeIdentity,
          sensitiveInputActive: false
        },
        snapshot: challengeSnapshot
      }
    };
    const challengeSubmission = toolExecutionForTool("runtime-otp", "browser.type", "challenge submitted");
    challengeSubmission.tool.toolsets = ["browser"];
    challengeSubmission.result = {
      ok: true,
      content: "Protected input delivered and submitted.",
      metadata: {
        secureInputReceipt: { status: "delivered" },
        protectedDelivery: {
          delivery: "delivered",
          submission: "clicked",
          documentChanged: true,
          challengeState: "departed",
          conditionMet: true,
          beforeIdentity: challengeIdentity,
          afterIdentity: authenticatedIdentity,
          sensitiveInputActive: false
        },
        snapshot: {
          ...challengeSnapshot,
          url: "https://portal.example.com/account",
          title: "Account home",
          identity: authenticatedIdentity,
          tab: {
            ...challengeSnapshot.tab,
            url: "https://portal.example.com/account",
            title: "Account home"
          },
          elements: [
            { ref: "@account", role: "link", name: "My profile" },
            { ref: "@logout", role: "button", name: "Sign out" }
          ]
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-credentials", "{}", "browser.fill_protected_form")]),
        providerExecution("Authentication verified; continuing the original task.")
      ],
      toolSteps: [
        { executions: [credentials] },
        { executions: [challengeSubmission] }
      ],
      maxProviderIterations: 3
    });
    const secureInput = vi.fn<SecureInputRequestHandler>(async () => ({
      status: "delivered",
      destinationLabel: "Verification code",
      persisted: false
    }));

    const result = await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser.fill_protected_form"), toolProviderSchema("browser.type")],
      onSecureInputRequest: secureInput
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executeInternalTool).toHaveBeenCalledOnce();
    expect(harness.executeInternalTool.mock.calls[0]?.[0]).toMatchObject({
      tool: "browser.type",
      value: {
        ref: "@e19",
        identity: challengeIdentity,
        tabRef: "@t3",
        protectedInput: { kind: "one-time-code", retention: "use-once" },
        submitRef: "@e20"
      }
    });
    expect(result.toolExecutions.map((execution) => execution.tool.name)).toEqual([
      "browser.fill_protected_form",
      "browser.type"
    ]);
    expect(result.providerExecution?.response?.content).toContain("Authentication verified");
  });

  it("stops with user input required when a live OTP challenge has no protected input handler", async () => {
    const challengeIdentity = { documentEpoch: 4, actionRevision: 12, observationId: 15 };
    const credentials = toolExecutionForTool("call-credentials", "browser.fill_protected_form", "challenge shown");
    credentials.tool.toolsets = ["browser"];
    credentials.result = {
      ok: true,
      content: "Credentials submitted; challenge required.",
      metadata: {
        secureInputGroupReceipt: { status: "delivered" },
        protectedDelivery: {
          delivery: "delivered",
          submission: "clicked",
          documentChanged: true,
          challengeState: "departed",
          conditionMet: true,
          beforeIdentity: { documentEpoch: 3, actionRevision: 11, observationId: 14 },
          afterIdentity: challengeIdentity,
          sensitiveInputActive: false
        },
        snapshot: {
          sessionId: "browser-session",
          url: "https://portal.example.com/challenge",
          title: "Two-factor authentication",
          identity: challengeIdentity,
          observedAt: "2026-08-13T00:00:00.000Z",
          readiness: "complete",
          tab: {
            ref: "@t3",
            url: "https://portal.example.com/challenge",
            title: "Two-factor authentication",
            controlled: true
          },
          elements: [
            { ref: "@e19", role: "textbox", name: "Verification code" },
            { ref: "@e20", role: "button", name: "Verify" }
          ]
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-credentials", "{}", "browser.fill_protected_form")])
      ],
      toolSteps: [{ executions: [credentials] }],
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser.fill_protected_form"), toolProviderSchema("browser.type")]
    });

    expect(harness.completeSpy).toHaveBeenCalledOnce();
    expect(harness.executeInternalTool).not.toHaveBeenCalled();
    expect(result.terminationCause).toBe("user_input_required");
    expect(result.providerExecution?.response?.content).toContain("protected one-time-code input is unavailable");
  });

  it("does not retry an older OTP challenge after protected input was cancelled", async () => {
    const challengeSnapshot = toolExecutionForTool(
      "call-cancelled-otp-snapshot",
      "browser.snapshot",
      "Current browser snapshot"
    );
    challengeSnapshot.tool.toolsets = ["browser"];
    challengeSnapshot.result = {
      ok: true,
      content: "Current browser snapshot",
      metadata: {
        snapshot: {
          sessionId: "browser-session",
          url: "https://portal.example.com/challenge",
          title: "Verify account",
          identity: { documentEpoch: 4, actionRevision: 12, observationId: 15 },
          observedAt: "2026-08-13T00:00:00.000Z",
          readiness: "complete",
          tab: {
            ref: "@t3",
            url: "https://portal.example.com/challenge",
            title: "Verify account",
            controlled: true
          },
          elements: [
            { ref: "@e19", role: "textbox", name: "Verification code", label: "One-time code" },
            { ref: "@e20", role: "button", name: "Verify", withinText: "Two-factor authentication" }
          ]
        }
      }
    };
    const cancelledInput = toolExecutionForTool(
      "call-cancelled-otp-input",
      "browser.type",
      "Protected input collection was cancelled."
    );
    cancelledInput.tool.toolsets = ["browser"];
    cancelledInput.result = {
      ok: false,
      content: "Protected input collection was cancelled.",
      metadata: { reason: "cancelled" }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-cancelled-otp-snapshot", "{}", "browser.snapshot")]),
        providerExecution("", [providerToolCall(
          "call-cancelled-otp-input",
          JSON.stringify({
            ref: "@e19",
            identity: { documentEpoch: 4, actionRevision: 12, observationId: 15 },
            tabRef: "@t3",
            protectedInput: { kind: "one-time-code", purpose: "Verify account" },
            submitRef: "@e20"
          }),
          "browser.type"
        )]),
        providerExecution("The protected verification prompt was cancelled.")
      ],
      toolSteps: [
        { executions: [challengeSnapshot] },
        { executions: [cancelledInput] },
        {}
      ],
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser.snapshot"), toolProviderSchema("browser.type")]
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(result.providerExecution?.response?.content).toBe("The protected verification prompt was cancelled.");
  });

  it("refreshes persisted browser state when manual browser changes occur between turns", async () => {
    const sessionRuntimeContext = createSessionRuntimeContext("runtime-session");
    sessionRuntimeContext.setBrowserState({
      sessionStatus: "active",
      sessionId: "runtime-session:main",
      controlledTab: { ref: "@t1", url: "https://example.com/old", controlled: true },
      tabs: [{ ref: "@t1", url: "https://example.com/old", controlled: true }],
      identity: { documentEpoch: 2, actionRevision: 4, observationId: 6 },
      readiness: "complete",
      freshness: "current"
    });
    const currentSnapshot = {
      sessionId: "runtime-session:main",
      url: "https://example.com/manual",
      title: "Manually selected",
      identity: { documentEpoch: 3, actionRevision: 5, observationId: 7 },
      observedAt: "2026-08-13T00:01:00.000Z",
      readiness: "complete" as const,
      tab: {
        ref: "@t2",
        url: "https://example.com/manual",
        title: "Manually selected",
        controlled: true
      }
    };
    const browserBackend: BrowserBackend = {
      kind: "mock",
      capabilities: browserCapabilities({ snapshots: true, tabs: true }),
      isAvailable: () => true,
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => ({
        session: { id: "runtime-session:main", backend: "mock", createdAt: currentSnapshot.observedAt },
        snapshot: currentSnapshot
      }),
      snapshot: async () => currentSnapshot,
      tabs: async () => ({
        sessionId: "runtime-session:main",
        tabs: [
          { ref: "@t1", url: "https://example.com/old", controlled: false },
          currentSnapshot.tab
        ],
        blockedCount: 0
      })
    };
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("Done.")],
      toolSteps: [],
      maxProviderIterations: 1,
      browserBackend,
      sessionRuntimeContext,
      sessionId: "runtime-session"
    });

    await runBasicProviderTurn(harness.loop);

    const initial = JSON.stringify((harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest).messages);
    expect(initial).toContain("Controlled tab: @t2 (controlled)");
    expect(initial).toContain("External/manual browser changes were detected");
    expect(sessionRuntimeContext.browserState()).toMatchObject({
      controlledTab: { ref: "@t2" },
      externalChangeDetected: true,
      freshness: "current"
    });
  });

  it("holds and renews the browser session lease for the foreground provider turn without a Mission", async () => {
    const browserSessionLease = {
      acquire: vi.fn(),
      renew: vi.fn(),
      release: vi.fn()
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-browser", "{}", "browser.snapshot")]),
        providerExecution("Complete.")
      ],
      toolSteps: [{ executions: [toolExecutionForTool("call-browser", "browser.snapshot", "state")] }],
      browserSessionLease,
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop, { visibleTurnId: "turn-browser-lease" });

    expect(browserSessionLease.acquire).toHaveBeenCalledWith(
      `${harness.sessionId}:main`,
      "provider-turn:default:turn-browser-lease"
    );
    expect(browserSessionLease.renew).toHaveBeenCalled();
    expect(browserSessionLease.release).toHaveBeenCalledWith(
      `${harness.sessionId}:main`,
      "provider-turn:default:turn-browser-lease"
    );
  });

  it("releases the browser session lease when the foreground provider turn completes or is cancelled", async () => {
    const completedPlanStore = new ExecutionPlanStore();
    completedPlanStore.replace({
      objective: "Configure MTN products in Postman",
      originTurnId: "turn-browser-complete",
      revision: 1,
      status: "active",
      items: [{ id: "update", content: "Update Postman", status: "in_progress" }]
    });
    const completedLease = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn() };
    const completedHarness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-update", "{}", "mcp.postman.updateCollection")]),
        providerExecution("Complete.")
      ],
      toolSteps: [{ executions: [toolExecutionForTool("call-update", "mcp.postman.updateCollection", "updated")] }],
      executionPlanReader: completedPlanStore,
      browserSessionLease: completedLease,
      maxProviderIterations: 2,
      onExecutePlans: () => {
        completedPlanStore.replace({
          objective: "Configure MTN products in Postman",
          originTurnId: "turn-browser-complete",
          revision: 2,
          status: "completed",
          items: [{
            id: "update",
            content: "Update Postman",
            status: "completed",
            completionKind: "reasoning"
          }]
        });
      }
    });

    await runBasicProviderTurn(completedHarness.loop, { visibleTurnId: "turn-browser-complete" });
    expect(completedLease.release).toHaveBeenCalledWith(
      `${completedHarness.sessionId}:main`,
      "provider-turn:default:turn-browser-complete"
    );

    const cancelledPlanStore = new ExecutionPlanStore();
    cancelledPlanStore.replace({
      objective: "Inspect MTN",
      originTurnId: "turn-browser-cancelled",
      revision: 1,
      status: "active",
      items: [{ id: "inspect", content: "Inspect MTN", status: "in_progress" }]
    });
    const cancelledLease = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn() };
    const cancelledHarness = await createPostToolNudgeHarness({
      responses: [providerExecution("unused")],
      toolSteps: [],
      executionPlanReader: cancelledPlanStore,
      browserSessionLease: cancelledLease
    });
    const controller = new AbortController();
    controller.abort();

    await runBasicProviderTurn(cancelledHarness.loop, {
      visibleTurnId: "turn-browser-cancelled",
      signal: controller.signal
    });
    expect(cancelledLease.release).toHaveBeenCalledWith(
      `${cancelledHarness.sessionId}:main`,
      "provider-turn:default:turn-browser-cancelled"
    );
  });

  it.each(["blocked", "abandoned"] as const)(
    "keeps browser lease ownership independent when a Mission becomes %s",
    async (terminalStatus) => {
      const planStore = new ExecutionPlanStore();
      const originTurnId = `turn-browser-${terminalStatus}`;
      planStore.replace({
        objective: "Configure MTN products in Postman",
        originTurnId,
        revision: 1,
        status: "active",
        items: [{ id: "update", content: "Update Postman", status: "in_progress" }]
      });
      const browserSessionLease = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn() };
      const harness = await createPostToolNudgeHarness({
        responses: [
          providerExecution("", [providerToolCall("call-terminal", "{}", "mcp.postman.updateCollection")]),
          providerExecution("Stopped.")
        ],
        toolSteps: [{ executions: [toolExecutionForTool(
          "call-terminal",
          "mcp.postman.updateCollection",
          terminalStatus === "blocked" ? "authentication expired" : "cancelled"
        )] }],
        executionPlanReader: planStore,
        browserSessionLease,
        maxProviderIterations: 2,
        onExecutePlans: () => {
          planStore.replace({
            objective: "Configure MTN products in Postman",
            originTurnId,
            revision: 2,
            status: terminalStatus,
            items: [{
              id: "update",
              content: "Update Postman",
              status: terminalStatus === "blocked" ? "blocked" : "cancelled",
              blocker: {
                kind: "external_state",
                summary: terminalStatus === "blocked" ? "Authentication expired" : "User cancelled"
              }
            }]
          });
        }
      });

      await runBasicProviderTurn(harness.loop, { visibleTurnId: originTurnId });

      expect(browserSessionLease.release).toHaveBeenCalledWith(
        `${harness.sessionId}:main`,
        `provider-turn:default:${originTurnId}`
      );
    }
  );

  it("executes a provider-authored plan with the first substantive tool batch", async () => {
    const planStore = new ExecutionPlanStore();
    const controller = new ExecutionPlanController(planStore);
    const firstCalls = [
      providerToolCall("call-plan", JSON.stringify({
        operation: "write",
        objective: "Inspect MTN products and update Postman",
        items: [
          { id: "execute", content: "Inspect MTN product details", status: "in_progress" },
          { id: "update", content: "Update Postman", status: "pending" },
          { id: "verify", content: "Verify the collection", status: "pending" }
        ]
      }), "plan"),
      providerToolCall("call-browser", "{}", "browser.snapshot"),
      providerToolCall("call-postman", "{}", "mcp.postman.getCollection")
    ];
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", firstCalls),
        providerExecution("Mission complete.")
      ],
      toolSteps: [
        {
          executions: [
            {
              ...toolExecutionForTool("call-plan", "plan", "plan refined"),
              riskClass: "read-only-local",
              tool: { ...testTool, name: "plan", riskClass: "read-only-local", toolsets: ["core"] }
            },
            toolExecutionForTool("call-browser", "browser.snapshot", "six products"),
            toolExecutionForTool("call-postman", "mcp.postman.getCollection", "collection")
          ]
        },
        {}
      ],
      executionPlanController: controller,
      maxProviderIterations: 3,
      onExecutePlans: ({ stepInput }) => {
        if (stepInput.providerExecution?.toolCalls.some((call) => call.name === "plan")) {
          return controller.write({
            objective: "Inspect MTN products and update Postman",
            items: [
              { id: "execute", content: "Inspect MTN product details", status: "in_progress" },
              { id: "update", content: "Update Postman", status: "pending" },
              { id: "verify", content: "Verify the collection", status: "pending" }
            ]
          }, "visible-turn").then(() => undefined);
        }
      }
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Look at the approved app and set up all 6 products in our Postman collection, then verify the result.",
      providerTools: [planProviderSchema(), toolProviderSchema("browser.snapshot"), toolProviderSchema("mcp.postman.getCollection")]
    });

    const executedBatches = harness.executePlans.mock.calls
      .map(([call]) => call.providerExecution?.toolCalls.map((toolCall) => toolCall.name) ?? [])
      .filter((names) => names.length > 0);
    expect(executedBatches).toEqual([
      ["plan", "browser.snapshot", "mcp.postman.getCollection"]
    ]);
    const firstRequest = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect((firstRequest.tools as OpenAICompatibleToolSchema[] | undefined)?.map((tool) => tool.function.name)).toEqual([
      "plan",
      "browser.snapshot",
      "mcp.postman.getCollection"
    ]);
    expect(JSON.stringify(firstRequest.messages)).not.toContain("Active execution plan");
    expect(JSON.stringify(firstRequest.messages)).not.toContain("Before doing anything else");
  });

  it("does not widen the next provider inventory from Plan text", async () => {
    const registry = new ToolRegistry();
    const requirementTools: RegisteredTool[] = [
      {
        ...testTool,
        name: "browser.snapshot",
        riskClass: "read-only-network",
        toolsets: ["browser"],
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "source records" })
      },
      {
        ...testTool,
        name: "mcp.target.read",
        riskClass: "read-only-network",
        toolsets: ["mcp"],
        connector: { kind: "mcp", id: "target" },
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "target state" })
      },
      {
        ...testTool,
        name: "mcp.target.update",
        riskClass: "external-side-effect",
        toolsets: ["mcp"],
        connector: { kind: "mcp", id: "target" },
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "updated" })
      },
      {
        ...testTool,
        name: "mcp.target.verify",
        riskClass: "read-only-network",
        toolsets: ["mcp"],
        connector: { kind: "mcp", id: "target" },
        capabilityMetadata: { verification: { verifies: ["mcp.target.update"] } },
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "verified" })
      }
    ];
    for (const tool of requirementTools) registry.register(tool);
    const planTool = {
      ...testTool,
      name: "plan",
      riskClass: "read-only-local" as const,
      toolsets: ["core" as const]
    };
    const catalog = buildProviderToolSchemaCatalog({ tools: [planTool, ...requirementTools] });
    const controller = new ExecutionPlanController(
      new ExecutionPlanStore(),
      undefined,
      undefined,
      new ExecutionCapabilityPreflight({ registry })
    );
    const proposal = {
      objective: "Move source records into the destination and verify the result",
      items: [
        { id: "inspect", content: "Inspect source records", status: "in_progress" as const },
        { id: "read", content: "Read destination state", status: "pending" as const },
        { id: "update", content: "Update destination state", status: "pending" as const },
        { id: "verify", content: "Verify destination state", status: "pending" as const }
      ],
      requirements: [
        { id: "source", itemId: "inspect", tool: "browser.snapshot", capability: "read" as const },
        { id: "target-read", itemId: "read", tool: "mcp.target.read", capability: "read" as const },
        { id: "target-update", itemId: "update", tool: "mcp.target.update", capability: "mutate" as const },
        { id: "target-verify", itemId: "verify", tool: "mcp.target.verify", capability: "verify" as const }
      ]
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-plan", JSON.stringify({ operation: "write", ...proposal }), "plan")]),
        providerExecution("", [providerToolCall("call-browser", "{}", "browser.snapshot")]),
        providerExecution("Continuing with the source records.")
      ],
      toolSteps: [
        {
          executions: [{
            ...toolExecutionForTool("call-plan", "plan", "plan accepted"),
            tool: planTool
          }]
        },
        { executions: [toolExecutionForTool("call-browser", "browser.snapshot", "source records")] },
        {}
      ],
      executionPlanController: controller,
      maxProviderIterations: 3,
      onExecutePlans: async ({ sessionId, stepInput }) => {
        if (stepInput.providerExecution?.toolCalls.some((call) => call.name === "plan")) {
          await controller.write(proposal, "visible-turn", undefined, {
            source: "provider",
            sessionId
          });
        }
      }
    });
    const initialTools = catalog.entries
      .filter((entry) => entry.tool.name !== "browser.snapshot")
      .map((entry) => entry.schema);

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Move the approved records into Target and verify the result.",
      providerTools: initialTools,
      providerToolSchemaCatalog: catalog
    });

    const firstRequest = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    const secondRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect((firstRequest.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name)).not.toContain("browser_snapshot");
    expect((secondRequest.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name)).toEqual([
      "plan",
      "mcp_target_read",
      "mcp_target_update",
      "mcp_target_verify"
    ]);
    expect(controller.current()).not.toHaveProperty("requirements");
    expect(controller.current()).not.toHaveProperty("capabilityPreflight");
  });

  it("keeps execution evidence out of Plan progress during standard continuation", async () => {
    const evidence = new ExecutionEvidenceIndex();
    const controller = new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidence);
    await controller.write({
      objective: "Locate and verify the destination collection",
      items: [{ id: "locate-collection", content: "Locate the destination collection", status: "in_progress" }]
    }, "visible-turn");
    const planTool = createPlanTools({ controller })[0]!;
    const readExecution = toolExecutionForTool("call-read", "mcp.target.read", "raw destination payload");
    readExecution.riskClass = "read-only-network";
    readExecution.tool.riskClass = "read-only-network";
    readExecution.targetSummary = "destination collection";
    const rejectedPlanExecution = {
      ...toolExecutionForTool("call-plan-missing", "plan", "pending"),
      tool: { ...testTool, name: "plan", riskClass: "read-only-local" as const, toolsets: ["core" as const] }
    };
    const acceptedPlanExecution = {
      ...toolExecutionForTool("call-plan-retry", "plan", "pending"),
      tool: { ...testTool, name: "plan", riskClass: "read-only-local" as const, toolsets: ["core" as const] }
    };
    const missingEvidenceMerge = {
      operation: "merge" as const,
      items: [{ id: "locate-collection", content: "Locate the destination collection", status: "completed" as const }]
    };
    const repairedMerge = {
      operation: "merge" as const,
      items: [{
        id: "locate-collection",
        content: "Locate the destination collection",
        status: "completed" as const,
        evidenceCallIds: [] as string[]
      }]
    };
    const repairedPlanCall = providerToolCall("call-plan-retry", JSON.stringify(repairedMerge), "plan");
    let stateAfterLightweightUpdate: string | undefined;
    let runtimeReadId: string | undefined;
    let executionBatch = 0;
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-read", "{}", "mcp.target.read")]),
        providerExecution("", [providerToolCall("call-plan-missing", JSON.stringify(missingEvidenceMerge), "plan")]),
        providerExecution("", [repairedPlanCall]),
        providerExecution("Mission complete.")
      ],
      toolSteps: [
        { executions: [readExecution] },
        { executions: [rejectedPlanExecution] },
        { executions: [acceptedPlanExecution] }
      ],
      executionPlanReader: controller,
      executionPlanController: controller,
      maxProviderIterations: 4,
      onExecutePlans: async ({ stepInput }) => {
        executionBatch += 1;
        const call = stepInput.providerExecution?.toolCalls[0];
        if (executionBatch === 1 && call?.id !== undefined) {
          runtimeReadId = call.id;
          readExecution.toolCallId = call.id;
          repairedMerge.items[0]!.evidenceCallIds = [call.id];
          repairedPlanCall.argumentsText = JSON.stringify(repairedMerge);
          evidence.record(readExecution, "visible-turn");
        } else if (executionBatch === 2) {
          rejectedPlanExecution.result = await planTool.run(missingEvidenceMerge, { visibleTurnId: "visible-turn" });
          stateAfterLightweightUpdate = controller.current()?.items[0]?.status;
        } else if (executionBatch === 3) {
          acceptedPlanExecution.result = await planTool.run(repairedMerge, { visibleTurnId: "visible-turn" });
        }
      }
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Locate the destination collection and verify it.",
      providerTools: [planProviderSchema(), toolProviderSchema("mcp.target.read")]
    });

    const continuationRequest = harness.completeSpy.mock.calls[2]?.[0] as ProviderRequest;
    const continuationContext = JSON.stringify(continuationRequest.messages);
    expect(continuationContext).not.toContain("completion-evidence-required");
    expect(runtimeReadId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(continuationContext).toContain(runtimeReadId!);
    expect(stateAfterLightweightUpdate).toBe("completed");
    expect(controller.current()).toMatchObject({
      status: "completed",
      items: [{
        id: "locate-collection",
        status: "completed"
      }]
    });
    expect(controller.current()?.items[0]).not.toHaveProperty("evidenceCallIds");
    expect(controller.current()?.items[0]).not.toHaveProperty("evidence");
  });

  it("does not let Plan text govern runtime continuation", async () => {
    const registry = new ToolRegistry();
    for (const name of ["mcp.target.read", "mcp.target.verify"]) {
      registry.register({
        ...testTool,
        name,
        riskClass: "read-only-network",
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "unused" })
      });
    }
    const controller = new ExecutionPlanController(
      new ExecutionPlanStore(),
      undefined,
      undefined,
      new ExecutionCapabilityPreflight({ registry })
    );
    const proposal = {
      objective: "Provision a destination from a browser source",
      items: [
        { id: "inspect-source", content: "Inspect source", status: "in_progress" as const },
        { id: "update-target", content: "Update destination", status: "pending" as const },
        { id: "verify-target", content: "Verify destination", status: "pending" as const }
      ],
      requirements: [
        { id: "destination-read", itemId: "inspect-source", tool: "mcp.target.read", capability: "read" as const },
        { id: "destination-write", itemId: "update-target", tool: "mcp.target.update", capability: "mutate" as const },
        { id: "destination-verify", itemId: "verify-target", tool: "mcp.target.verify", capability: "verify" as const }
      ]
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-plan", JSON.stringify({ operation: "write", ...proposal }), "plan")]),
        providerExecution("", [providerToolCall("call-browser", "{}", "browser.navigate")])
      ],
      toolSteps: [{
        executions: [{
          ...toolExecutionForTool("call-plan", "plan", "plan blocked"),
          riskClass: "read-only-local",
          tool: { ...testTool, name: "plan", riskClass: "read-only-local", toolsets: ["core"] }
        }]
      }],
      executionPlanController: controller,
      maxProviderIterations: 3,
      onExecutePlans: async ({ sessionId, stepInput }) => {
        if (stepInput.providerExecution?.toolCalls.some((call) => call.name === "plan")) {
          await controller.write(proposal, "visible-turn", undefined, {
            source: "provider",
            sessionId
          });
        }
      }
    });

    const result = await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Inspect the source, provision the destination, and verify it.",
      providerTools: [planProviderSchema(), toolProviderSchema("browser.navigate")]
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(2);
    expect(result.providerExecution?.response?.content).not.toContain("stopped before substantive work");
    expect(controller.current()?.status).toBe("active");
    expect(controller.current()).not.toHaveProperty("requirements");
    expect(controller.current()).not.toHaveProperty("capabilityPreflight");
  });

  it("does not create a provisional Mission before the model's first action", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const mutationCall = providerToolCall("call-update", "{}", "mcp.postman.updateCollection");
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [mutationCall])],
      toolSteps: [{ executions: [toolExecutionForTool("call-update", "mcp.postman.updateCollection", "updated")] }],
      executionPlanController: controller,
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Update the collection and then verify the resulting state.",
      providerTools: [planProviderSchema(), toolProviderSchema("mcp.postman.updateCollection")]
    });

    const executedBatches = harness.executePlans.mock.calls
      .map(([call]) => call.providerExecution?.toolCalls.map((toolCall) => toolCall.name) ?? [])
      .filter((names) => names.length > 0);
    expect(executedBatches).toEqual([["mcp.postman.updateCollection"]]);
    expect(harness.completeSpy).toHaveBeenCalledOnce();
    const firstRequest = harness.completeSpy.mock.calls[0]?.[0] as ProviderRequest;
    expect((firstRequest.tools as OpenAICompatibleToolSchema[] | undefined)?.map((tool) => tool.function.name)).toEqual([
      "plan",
      "mcp.postman.updateCollection"
    ]);
    expect(JSON.stringify(firstRequest.messages)).not.toContain("Active execution plan");
    expect(controller.current()).toBeUndefined();
  });

  it("surfaces a trusted authentication blocker without creating a Mission", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const protectedFormExecution: ToolExecutionRecord = {
      ...toolExecutionForTool("call-auth", "browser.fill_protected_form", "credentials not provided"),
      result: {
        ok: false,
        content: "Protected form input cancelled.",
        metadata: {
          secureInputGroupReceipt: { status: "cancelled" }
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-auth", "{}", "browser.fill_protected_form")])
      ],
      toolSteps: [{ executions: [protectedFormExecution] }],
      executionPlanController: controller,
      maxProviderIterations: 2
    });

    const result = await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-auth-turn",
      userText: "Access the developer workspace and update its Postman collection.",
      providerTools: [planProviderSchema(), toolProviderSchema("browser.fill_protected_form")]
    });

    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(result.providerExecution?.response?.content).toContain("Authentication needs your input");
    expect(result.terminationCause).toBe("user_input_required");
    expect(controller.current()).toBeUndefined();
  });

  it("keeps a repaired five-step MTN Mission instead of substituting the provisional fallback", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    let activeSessionId: string | undefined;
    const planTool = createPlanTools({
      controller,
      currentSessionId: () => {
        if (activeSessionId === undefined) throw new Error("test session is not active");
        return activeSessionId;
      }
    })[0]!;
    const proposal = {
      operation: "write" as const,
      objective: "Configure approved MTN products in Postman and verify the result",
      items: [
        { id: "inspect", content: "Inspect the approved MTN app", status: "in_progress" as const, completionKind: "reasoning" as const },
        { id: "products", content: "Identify MTN products", status: "pending" as const, completionKind: "reasoning" as const },
        { id: "postman", content: "Inspect Postman", status: "pending" as const, completionKind: "reasoning" as const },
        { id: "update", content: "Update Postman collection", status: "pending" as const, completionKind: "reasoning" as const },
        { id: "verify", content: "Verify Postman collection", status: "pending" as const, completionKind: "reasoning" as const }
      ]
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-plan", JSON.stringify(proposal), "plan")]),
        providerExecution("Mission is active.")
      ],
      toolSteps: [{
        executions: [{
          ...toolExecutionForTool("call-plan", "plan", "plan repaired"),
          riskClass: "read-only-local",
          tool: { ...testTool, name: "plan", riskClass: "read-only-local", toolsets: ["core"] }
        }]
      }],
      executionPlanController: controller,
      maxProviderIterations: 2,
      onExecutePlans: async ({ sessionId, stepInput }) => {
        if (!stepInput.providerExecution?.toolCalls.some((call) => call.name === "plan")) return;
        activeSessionId = sessionId;
        const result = await planTool.run(proposal, { visibleTurnId: "visible-turn" });
        expect(result.ok).toBe(true);
      }
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Inspect the approved MTN app, configure all products in Postman, and verify every change.",
      providerTools: [planProviderSchema(), toolProviderSchema("mcp.postman.updateCollection")]
    });

    expect(controller.current()).toMatchObject({
      objective: proposal.objective,
      originTurnId: "visible-turn",
      items: proposal.items.map((item) => ({ id: item.id, content: item.content, status: item.status }))
    });
    expect(controller.current()?.items).toHaveLength(5);
    expect(controller.current()?.items.map((item) => item.id)).not.toEqual(["execute", "verify"]);
  });

  it("does not activate a Mission for simple or read-only multi-part work", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-nav", "{}", "browser.navigate")])],
      toolSteps: [{ executions: [toolExecutionForTool("call-nav", "browser.navigate", "opened")] }],
      executionPlanController: controller,
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Open developers.mtn.com.",
      providerTools: [planProviderSchema(), toolProviderSchema("browser.navigate")]
    });

    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(controller.current()).toBeUndefined();
  });

  it("does not mutate an existing Mission while executing substantive tools", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    await controller.write({
      objective: "Existing Mission",
      items: [{ id: "existing", content: "Keep working", status: "in_progress" }]
    }, "older-turn");
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-update", "{}", "mcp.postman.updateCollection")])],
      toolSteps: [{ executions: [toolExecutionForTool("call-update", "mcp.postman.updateCollection", "updated")] }],
      executionPlanController: controller,
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "newer-turn",
      userText: "Update the collection and then verify the resulting state.",
      providerTools: [planProviderSchema(), toolProviderSchema("mcp.postman.updateCollection")]
    });

    expect(controller.current()).toMatchObject({
      objective: "Existing Mission",
      originTurnId: "older-turn",
      revision: 1
    });
  });

  it("does not auto-activate when the foreground plan tool is unavailable", async () => {
    const controller = new ExecutionPlanController(new ExecutionPlanStore());
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-update", "{}", "mcp.postman.updateCollection")])],
      toolSteps: [{ executions: [toolExecutionForTool("call-update", "mcp.postman.updateCollection", "updated")] }],
      executionPlanController: controller,
      maxProviderIterations: 1
    });

    await runBasicProviderTurn(harness.loop, {
      visibleTurnId: "visible-turn",
      userText: "Update the collection and then verify the resulting state.",
      providerTools: [toolProviderSchema("mcp.postman.updateCollection")]
    });

    expect(controller.current()).toBeUndefined();
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
  });

  it("does not let a plan transition reset runtime tool-loop progress", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Build and verify",
      originTurnId: "turn-progress-reset",
      revision: 1,
      status: "active",
      items: [
        { id: "build", content: "Build", status: "in_progress" },
        { id: "verify", content: "Verify", status: "pending" }
      ]
    });
    let executionCount = 0;
    const harness = await createPostToolNudgeHarness({
      responses: Array.from({ length: 8 }, (_, index) => providerExecution("", [
        providerToolCall(`call-progress-${index + 1}`)
      ])),
      toolSteps: Array.from({ length: 8 }, (_, index) => ({
        executions: [toolExecutionForTool(`call-progress-${index + 1}`, "web.extract", "same evidence")]
      })),
      executionPlanReader: planStore,
      maxProviderIterations: 8,
      onExecutePlans: () => {
        executionCount += 1;
        if (executionCount === 3) {
          planStore.replace({
            objective: "Build and verify",
            originTurnId: "turn-progress-reset",
            revision: 2,
            status: "active",
            items: [
              { id: "build", content: "Build", status: "completed", evidenceCallIds: ["call-progress-3"], evidence: [{
                toolCallId: "call-progress-3",
                tool: "web.extract",
                outcome: "success",
                riskClass: "read-only-network"
              }] },
              { id: "verify", content: "Verify", status: "in_progress" }
            ]
          });
        }
      }
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(7);
    expect(result.providerExecution?.response?.content).toContain("foreground tool loop stopped");
    const nudgeText = "The foreground tool loop has repeated the same calls or results without material progress.";
    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);
    expect(requests.filter((request) => JSON.stringify(request.messages).includes(nudgeText))).toHaveLength(1);
  });

  it("stops before new tool work when the emergency finalization reserve is reached", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Update external state",
      originTurnId: "turn-deadline",
      revision: 1,
      status: "active",
      items: [{ id: "update", content: "Update", status: "in_progress" }]
    });
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-deadline")])],
      toolSteps: [{ executions: [toolExecutionForTool("call-deadline", "mcp.postman.updateCollection")] }],
      executionPlanReader: planStore,
      maxProviderWallClockMs: 100,
      finalizationReserveMs: 20
    });
    let dateCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      dateCalls += 1;
      return dateCalls <= 2 ? 0 : 85;
    });

    try {
      const result = await runBasicProviderTurn(harness.loop);

      expect(harness.executePlans).not.toHaveBeenCalled();
      expect(result.providerExecution?.response?.content).toContain("emergency deadline reserve");
      expect(result.terminationCause).toBe("deadline_reached");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not interrupt a consequential mutation merely to preserve finalization time", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Update external state",
      originTurnId: "turn-running-mutation",
      revision: 1,
      status: "active",
      items: [{ id: "update", content: "Update", status: "in_progress" }]
    });
    let now = 0;
    const mutation = toolExecutionForTool(
      "call-running-mutation",
      "mcp.postman.updateCollection",
      "updated"
    );
    mutation.riskClass = "external-side-effect";
    mutation.tool.riskClass = "external-side-effect";
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-running-mutation")])],
      toolSteps: [{ executions: [mutation] }],
      executionPlanReader: planStore,
      maxProviderIterations: 3,
      maxProviderWallClockMs: 100,
      finalizationReserveMs: 20,
      onExecutePlans: () => {
        now = 90;
      }
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      const result = await runBasicProviderTurn(harness.loop);

      expect(harness.executePlans).toHaveBeenCalledTimes(1);
      expect(harness.completeSpy).toHaveBeenCalledTimes(1);
      expect(result.toolExecutions).toEqual([expect.objectContaining({
        toolCallId: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u),
        result: expect.objectContaining({ ok: true })
      })]);
      expect(result.providerExecution?.response?.content).toContain("emergency deadline reserve");
      expect(result.terminationCause).toBe("deadline_reached");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not suspend runtime execution for a Mission-authored blocker", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Sign in and finish setup",
      originTurnId: "turn-user-input",
      revision: 1,
      status: "active",
      items: [
        { id: "credentials", content: "Enter credentials", status: "in_progress" },
        { id: "finish", content: "Finish setup", status: "pending" },
      ]
    });
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution("", [providerToolCall("call-inspect", "{}", "browser.snapshot")])],
      toolSteps: [{ executions: [toolExecutionForTool("call-inspect", "browser.snapshot", "login form")] }],
      executionPlanReader: planStore,
      maxProviderIterations: 5,
      onExecutePlans: () => {
        planStore.replace({
          objective: "Sign in and finish setup",
          originTurnId: "turn-user-input",
          revision: 2,
          status: "active",
          items: [
            {
              id: "credentials",
              content: "Enter credentials",
              status: "blocked",
              blocker: { kind: "user_input_required", summary: "Enter the email and password in the secure prompt." }
            },
            { id: "finish", content: "Finish setup", status: "pending" },
          ]
        });
      }
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(2);
    expect(result.providerExecution?.response?.content).not.toContain("Mission needs your input");
  });

  it("continues normally after a failed plan update even when the optional plan is blocked", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Sign in to the correct fictional portal",
      originTurnId: "turn-plan-repair",
      revision: 1,
      status: "active",
      items: [
        {
          id: "credentials",
          content: "Submit credentials",
          status: "blocked",
          blocker: { kind: "user_input_required", summary: "Provide the credentials." }
        },
        { id: "verify", content: "Verify authentication", status: "pending" }
      ]
    });
    const failedPlanUpdate = toolExecutionForTool("call-plan-repair", "plan", "invalid Mission update");
    failedPlanUpdate.result = {
      ok: false,
      content: "Only blocked or cancelled items may include a blocker."
    };
    let executionBatch = 0;
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-plan-repair", "{}", "plan")]),
        providerExecution("", [providerToolCall("call-correct-navigation", "{}", "browser.navigate")]),
        providerExecution("Recovered on the correct fictional portal.")
      ],
      toolSteps: [
        { executions: [failedPlanUpdate] },
        { executions: [toolExecutionForTool("call-correct-navigation", "browser.navigate", "correct portal opened")] }
      ],
      executionPlanReader: planStore,
      maxProviderIterations: 3,
      onExecutePlans: () => {
        executionBatch += 1;
        if (executionBatch !== 2) return;
        planStore.replace({
          objective: "Sign in to the correct fictional portal",
          originTurnId: "turn-plan-repair",
          revision: 2,
          status: "completed",
          items: [
            { id: "credentials", content: "Submit credentials", status: "completed" },
            { id: "verify", content: "Verify authentication", status: "completed" }
          ]
        });
      }
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(harness.executePlans).toHaveBeenCalledTimes(3);
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toHaveLength(2);
    expect(result.toolExecutions.every((execution) =>
      /^tool-call-[a-f0-9]{24}$/u.test(execution.toolCallId ?? "")
    )).toBe(true);
    expect(result.providerExecution?.response?.content).toContain("Recovered on the correct fictional portal.");
    expect(result.providerExecution?.response?.content).not.toContain("Mission needs your input");
  });

  it("uses standard tool-result continuation for repeated failed plan updates", async () => {
    const planStore = new ExecutionPlanStore();
    planStore.replace({
      objective: "Recover a fictional sign-in",
      originTurnId: "turn-bounded-plan-repair",
      revision: 1,
      status: "active",
      items: [
        {
          id: "credentials",
          content: "Submit credentials",
          status: "blocked",
          blocker: { kind: "user_input_required", summary: "Provide the credentials." }
        },
        { id: "verify", content: "Verify authentication", status: "pending" }
      ]
    });
    const failed = (id: string) => {
      const execution = toolExecutionForTool(id, "plan", "invalid Mission update");
      execution.result = { ok: false, content: "Invalid Mission update." };
      return execution;
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-plan-first", "{}", "plan")]),
        providerExecution("", [providerToolCall("call-plan-second", "{}", "plan")]),
        providerExecution("must not run")
      ],
      toolSteps: [
        { executions: [failed("call-plan-first")] },
        { executions: [failed("call-plan-second")] }
      ],
      executionPlanReader: planStore,
      maxProviderIterations: 4
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(result.providerExecution?.response?.content).toBe("must not run");
  });

  it("does not charge protected operator input time to the provider wall-clock budget", async () => {
    let now = 0;
    const handler: SecureInputRequestHandler = async () => {
      now = 90;
      return { status: "delivered", destinationLabel: "Verified field", persisted: false };
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-protected", "{}", "browser.type")]),
        providerExecution("Sign-in fields are ready.")
      ],
      toolSteps: [{ executions: [toolExecutionForTool("call-protected", "browser.type", "delivered")] }],
      maxProviderIterations: 2,
      maxProviderWallClockMs: 100,
      finalizationReserveMs: 20,
      onExecutePlans: async ({ stepInput }) => {
        await stepInput.onSecureInputRequest?.({
          kind: "password",
          purpose: "Sign in",
          destination: {
            type: "browser-field",
            sessionId: "browser-session",
            ref: "@e1",
            expectedOrigin: "https://example.com"
          },
          retention: "use-once"
        }, async () => undefined);
      }
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      const result = await runBasicProviderTurn(harness.loop, { onSecureInputRequest: handler });

      expect(harness.completeSpy).toHaveBeenCalledTimes(2);
      expect(result.providerExecution?.response?.content).toContain("Sign-in fields are ready.");
      expect(result.providerExecution?.response?.content).not.toContain("emergency deadline");
    } finally {
      nowSpy.mockRestore();
    }
  });
  it("suppresses only a repeated whole-state observation while preserving grounded exploration", async () => {
    const sensitivePageText = "private account marker";
    const snapshotExecution = (id: string): ToolExecutionRecord => ({
      ...toolExecutionForTool(id, "browser.snapshot", "Rendered browser snapshot."),
      result: {
        ok: true,
        content: "Rendered browser snapshot.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/account",
            title: "Account",
            text: sensitivePageText
          }
        }
      }
    });
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-snapshot-1", "{}", "browser.snapshot")]),
        providerExecution("", [providerToolCall("call-snapshot-2", "{}", "browser.snapshot")]),
        providerExecution("I will use a different grounded inspection before acting.")
      ],
      toolSteps: [
        { executions: [snapshotExecution("call-snapshot-1")] },
        { executions: [snapshotExecution("call-snapshot-2")] }
      ],
      maxProviderIterations: 4
    });
    const events: RuntimeEvent[] = [];

    const providerTools = [
      "browser_snapshot",
      "browser_find",
      "browser_extract",
      "browser_screenshot",
      "browser_console",
      "browser_cdp",
      "browser_click",
      "browser_scroll",
      "browser_tabs",
      "browser_switch_tab",
      "browser_dialog",
      "browser_back",
      "browser_navigate",
      "browser_press",
      "browser_type",
      "browser_fill_protected_form",
      "browser_select",
      "mcp_postman_updateCollection"
    ].map(toolProviderSchema);
    const result = await runBasicProviderTurn(harness.loop, {
      onEvent: (event) => events.push(event),
      providerTools
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(3);
    expect(result.iterations).toBe(3);
    expect(result.providerExecution?.response?.content).toBe(
      "I will use a different grounded inspection before acting."
    );
    expect(result.terminationCause).toBe("normal");

    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);
    const nudge = EXECUTION_SUPERVISION_PROMPTS.browserEvidence;
    expect(requests.filter((request) => JSON.stringify(request.messages).includes(nudge))).toHaveLength(1);
    const recoveryRequest = requests[2]!;
    const recoveryTools = (recoveryRequest.tools as OpenAICompatibleToolSchema[])
      .map((tool) => tool.function.name);
    expect(recoveryTools).not.toContain("browser_snapshot");
    expect(recoveryTools).toContain("browser_find");
    expect(recoveryTools).toContain("browser_extract");
    expect(recoveryTools).toContain("browser_click");
    expect(recoveryTools).toContain("browser_tabs");
    expect(recoveryTools).toContain("mcp_postman_updateCollection");
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "provider-budget-exhausted",
      budget: "repeated-browser-observations"
    }));
    expect(JSON.stringify(requests)).not.toContain(sensitivePageText);
  });

  it("allows find, structural snapshot, no-change repair, bounded retarget, and a different grounded action", async () => {
    const onApprovalRequest = vi.fn(async () => "approved" as const);
    const findResult: ToolExecutionRecord = {
      ...toolExecutionForTool("call-find", "browser.find", "No exact clickable match."),
      result: {
        ok: true,
        content: "No exact clickable match.",
        metadata: {
          status: "not-found",
          tabRef: "@t1",
          identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
          candidates: [],
          nearbyCandidates: [{
            ref: "@e7",
            role: "button",
            name: "Edit",
            regionText: "TikTok Connect Callback URL Edit Delete"
          }]
        }
      }
    };
    const structuralSnapshot: ToolExecutionRecord = {
      ...toolExecutionForTool("call-snapshot", "browser.snapshot", "Rendered app controls."),
      result: {
        ok: true,
        content: "Rendered app controls.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/apps",
            title: "Apps",
            text: "TikTok Connect",
            identity: { documentEpoch: 1, actionRevision: 2, observationId: 2 },
            elements: [
              { ref: "@e6", role: "link", name: "Callback URL", regionText: "TikTok Connect Callback URL Edit Delete" },
              { ref: "@e7", role: "button", name: "Edit", regionText: "TikTok Connect Callback URL Edit Delete" },
              { ref: "@e8", role: "button", name: "Delete", regionText: "TikTok Connect Callback URL Edit Delete" }
            ]
          }
        }
      }
    };
    const noChangeClick: ToolExecutionRecord = {
      ...toolExecutionForTool("call-callback", "browser.click", "The action was dispatched but the page did not change."),
      input: { ref: "@e6", tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:@e6",
      result: {
        ok: true,
        content: "The action was dispatched but the page did not change.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/apps",
            actionDelta: { outcome: "no-change", actionDispatched: true }
          }
        }
      }
    };
    const failedRetarget: ToolExecutionRecord = {
      ...toolExecutionForTool("call-missing", "browser.click", "Browser target was not found."),
      input: { locator: { text: "TikTok Connect" }, tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:text:TikTok Connect",
      result: {
        ok: false,
        content: "Browser target was not found. No action was dispatched.",
        metadata: { reason: "browser-target-not-found", actionDispatched: false }
      }
    };
    const changedClick: ToolExecutionRecord = {
      ...toolExecutionForTool("call-edit", "browser.click", "App editor opened."),
      input: { ref: "@e7", tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:@e7",
      result: {
        ok: true,
        content: "App editor opened.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/apps/tiktok",
            actionDelta: { outcome: "changed", actionDispatched: true }
          }
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-find", JSON.stringify({ text: "TikTok Connect" }), "browser.find")]),
        providerExecution("", [providerToolCall("call-snapshot", "{}", "browser.snapshot")]),
        providerExecution("", [providerToolCall("call-callback", JSON.stringify({ ref: "@e6", tabRef: "@t1" }), "browser.click")]),
        providerExecution("", [providerToolCall("call-missing", JSON.stringify({ locator: { text: "TikTok Connect" }, tabRef: "@t1" }), "browser.click")]),
        providerExecution("", [providerToolCall("call-edit", JSON.stringify({ ref: "@e7", tabRef: "@t1" }), "browser.click")]),
        providerExecution("Recovered after opening the grounded app editor.")
      ],
      toolSteps: [
        { executions: [findResult] },
        { executions: [structuralSnapshot] },
        { executions: [noChangeClick] },
        { executions: [failedRetarget] },
        { executions: [changedClick] }
      ],
      maxProviderIterations: 7
    });
    const providerTools = [
      "browser.snapshot",
      "browser.find",
      "browser.extract",
      "browser.click",
      "browser.scroll",
      "browser.tabs",
      "browser.switch_tab",
      "mcp.postman.updateCollection"
    ].map(toolProviderSchema);

    const result = await runBasicProviderTurn(harness.loop, { providerTools, onApprovalRequest });
    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);
    const afterNoChangeTools = (requests[3]!.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name);
    const afterTargetFailureTools = (requests[4]!.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name);

    expect(result.terminationCause).toBe("normal");
    expect(result.providerExecution?.response?.content).toBe("Recovered after opening the grounded app editor.");
    expect(afterNoChangeTools).toEqual(providerTools.map((tool) => tool.function.name));
    expect(afterTargetFailureTools).toEqual(providerTools.map((tool) => tool.function.name));
    expect(JSON.stringify(requests[3]!.messages)).toContain("same strategy and semantic outcome");
    expect(JSON.stringify(requests[4]!.messages)).toContain("different grounded element, visible region");
    expect(harness.executePlans.mock.calls[4]?.[0].onApprovalRequest).toBe(onApprovalRequest);
    expect(harness.executePlans.mock.calls[4]?.[0].providerExecution?.toolCalls[0]?.argumentsText).toBe(
      JSON.stringify({ ref: "@e7", tabRef: "@t1" })
    );
  });

  it("expands the active browser toolbox once after authoritative visual-escalation evidence", async () => {
    const noChangeClick: ToolExecutionRecord = {
      ...toolExecutionForTool("call-click", "browser.click", "The action was dispatched but the page did not change."),
      input: { ref: "@e6", tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:@e6",
      result: {
        ok: true,
        content: "The action was dispatched but the page did not change.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/apps",
            actionDelta: { outcome: "no-change", actionDispatched: true }
          }
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-click", JSON.stringify({ ref: "@e6", tabRef: "@t1" }), "browser.click")]),
        providerExecution("Recovered with visual inspection.")
      ],
      toolSteps: [{ executions: [noChangeClick] }],
      maxProviderIterations: 3
    });
    const events: RuntimeEvent[] = [];
    await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser_click")],
      toolExpansionCandidates: [{
        toolName: "browser.vision",
        source: "active-browser",
        schema: toolProviderSchema("browser_vision")
      }],
      onEvent: (event) => events.push(event)
    });

    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);
    expect((requests[0]?.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name))
      .toEqual(["browser_click"]);
    expect((requests[1]?.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name))
      .toEqual(["browser_click", "browser_vision"]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provider-tool-inventory",
      phase: "expanded",
      addedTools: ["browser_vision"],
      expansionReason: "browser:native-action-no-change"
    }));
    const persisted = await harness.sessionDb.listEvents(harness.sessionId);
    expect(persisted.filter((event) => event.kind === "provider-tool-inventory")).toHaveLength(1);
  });

  it("does not record an expansion when no provider iteration remains to receive it", async () => {
    const noChangeClick: ToolExecutionRecord = {
      ...toolExecutionForTool("call-click", "browser.click", "The action was dispatched but the page did not change."),
      input: { ref: "@e6", tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:@e6",
      result: {
        ok: true,
        content: "The action was dispatched but the page did not change.",
        metadata: {
          snapshot: {
            sessionId: "browser-session",
            url: "https://example.com/apps",
            actionDelta: { outcome: "no-change", actionDispatched: true }
          }
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-click", JSON.stringify({ ref: "@e6", tabRef: "@t1" }), "browser.click")])
      ],
      toolSteps: [{ executions: [noChangeClick] }],
      maxProviderIterations: 1
    });
    const events: RuntimeEvent[] = [];

    await runBasicProviderTurn(harness.loop, {
      providerTools: [toolProviderSchema("browser_click")],
      toolExpansionCandidates: [{
        toolName: "browser.vision",
        source: "active-browser",
        schema: toolProviderSchema("browser_vision")
      }],
      onEvent: (event) => events.push(event)
    });

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "provider-tool-inventory",
      phase: "expanded"
    }));
    const persisted = await harness.sessionDb.listEvents(harness.sessionId);
    expect(persisted.filter((event) => event.kind === "provider-tool-inventory")).toHaveLength(0);
  });

  it("stops a repeated unresolved target after one bounded retargeting opportunity", async () => {
    const missingTarget = (id: string): ToolExecutionRecord => ({
      ...toolExecutionForTool(id, "browser.click", "Browser target was not found."),
      input: { locator: { text: "Missing control" }, tabRef: "@t1" },
      targetKey: "browser:browser-session:@t1:text:Missing control",
      result: {
        ok: false,
        content: "Browser target was not found. No action was dispatched.",
        metadata: { reason: "browser-target-not-found", actionDispatched: false }
      }
    });
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-missing-1", JSON.stringify({ locator: { text: "Missing control" }, tabRef: "@t1" }), "browser.click")]),
        providerExecution("", [providerToolCall("call-missing-2", JSON.stringify({ locator: { text: "Missing control" }, tabRef: "@t1" }), "browser.click")]),
        providerExecution("This response must not be reached.")
      ],
      toolSteps: [
        { executions: [missingTarget("call-missing-1")] },
        { executions: [missingTarget("call-missing-2")] }
      ],
      maxProviderIterations: 4
    });
    const providerTools = [
      "browser.snapshot",
      "browser.find",
      "browser.click",
      "browser.tabs",
      "browser.switch_tab"
    ].map(toolProviderSchema);

    const result = await runBasicProviderTurn(harness.loop, { providerTools });
    const requests = harness.completeSpy.mock.calls.map(([request]) => request as ProviderRequest);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("different grounded element, visible region");
    expect((requests[1]!.tools as OpenAICompatibleToolSchema[]).map((tool) => tool.function.name))
      .toEqual(providerTools.map((tool) => tool.function.name));
    expect(result.terminationCause).toBe("browser_no_progress");
    expect(result.providerExecution?.response?.content).toContain("ineffective target was repeated");
  });

  it("stops before a substitute continuation when a delegated Task owns the answer", async () => {
    const activePlan = new ExecutionPlanStore();
    activePlan.replace({
      objective: "Delegate the work",
      originTurnId: "turn-delegate",
      revision: 1,
      status: "active",
      items: [{ id: "delegate", content: "Delegate the work", status: "in_progress" }]
    });
    const delegation = {
      ...toolExecutionForTool("call-delegate", "delegate_task", "Created durable Task task-owned."),
      riskClass: "shared-state-mutation" as const,
      result: {
        ok: true,
        content: "Created durable Task task-owned.",
        metadata: {
          taskId: "task-owned",
          status: "running",
          execution: "foreground",
          childTask: false,
          primaryResultStepId: "step-synthesis"
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("The workers have not returned, but here is a premature substitute.", [{
          id: "call-delegate",
          name: "delegate_task",
          argumentsText: "{}"
        }]),
        providerExecution("The workers have not returned, but here is my direct synthesis.")
      ],
      toolSteps: [{ executions: [delegation] }],
      executionPlanReader: activePlan
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(result.delegatedAnswerOwnership).toEqual({
      tasks: [{ taskId: "task-owned", status: "running", execution: "foreground" }]
    });
    expect(result.providerExecution?.response?.content).toContain("premature substitute");
    expect(result.providerExecution?.response?.content).not.toContain("direct synthesis");
    const messages = await harness.sessionDb.listMessages(harness.sessionId);
    const protocolTurn = messages.find((message) => message.metadata?.kind === "provider-tool-call-turn");
    expect(protocolTurn?.content).toBe("");
    expect(JSON.stringify(messages)).not.toContain("premature substitute");
  });

  it("stops before empty-response recovery when a preplanned delegation owns the answer", async () => {
    const delegation = {
      ...toolExecutionForTool("call-preplanned", "delegate_task", "Created durable Task task-preplanned."),
      riskClass: "shared-state-mutation" as const,
      result: {
        ok: true,
        content: "Created durable Task task-preplanned.",
        metadata: {
          taskId: "task-preplanned",
          status: "queued",
          execution: "background",
          childTask: false,
          primaryResultStepId: "step-synthesis"
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [providerExecution(""), providerExecution("Unrequested substitute continuation.")],
      toolSteps: [{ executions: [delegation] }]
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(1);
    expect(result.delegatedAnswerOwnership).toEqual({
      tasks: [{ taskId: "task-preplanned", status: "queued", execution: "background" }]
    });
    expect(result.providerExecution?.response?.content).toBe("");
  });

  it("keeps ordinary continuation behavior for inspection-only delegation", async () => {
    const inspection = {
      ...toolExecutionForTool("call-inspection", "delegate_task", "Created durable Task task-inspection."),
      riskClass: "shared-state-mutation" as const,
      result: {
        ok: true,
        content: "Created durable Task task-inspection.",
        metadata: {
          taskId: "task-inspection",
          status: "running",
          execution: "foreground",
          childTask: false
        }
      }
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [{ id: "call-inspection", name: "delegate_task", argumentsText: "{}" }]),
        providerExecution("Inspection Task created; I can continue this turn.")
      ],
      toolSteps: [{ executions: [inspection] }]
    });

    const result = await runBasicProviderTurn(harness.loop);

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(result.delegatedAnswerOwnership).toBeUndefined();
    expect(result.providerExecution?.response?.content).toContain("I can continue this turn");
  });

  it("persists provider tool-call turns before tool execution", async () => {
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("call-before-exec")])
      ],
      toolSteps: [
        {}
      ],
      maxProviderIterations: 1,
      onExecutePlans: async ({ sessionDb, sessionId, stepInput }) => {
        const runtimeId = stepInput.providerExecution?.toolCalls[0]?.id;
        const messages = await sessionDb.listMessages(sessionId);
        expect(messages).toContainEqual(expect.objectContaining({
          role: "agent",
          metadata: expect.objectContaining({
            kind: "provider-tool-call-turn",
            nativeReplaySafe: true,
            providerToolCalls: [
              {
                id: runtimeId,
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
    const runtimeId = harness.executePlans.mock.calls[0]?.[0].providerExecution?.toolCalls[0]?.id;
    expect(messages).toContainEqual(expect.objectContaining({
      role: "agent",
      content: "I'll look that up.",
      metadata: expect.objectContaining({
        kind: "provider-tool-call-turn",
        providerToolCalls: [
          {
            id: runtimeId,
            name: testTool.name,
            argumentsText: "{\"query\":\"docs\"}"
          }
        ]
      })
    }));
  });

  it("uses initial ephemeral images once and post-tool images on continuation", async () => {
    const visionModel: ModelProfile = {
      ...mockModel,
      supportsVision: true
    };
    const visionPrimaryRoute: ResolvedModelRoute = {
      ...primaryRoute,
      profile: visionModel
    };
    const initialExecution = toolExecutionForTool("initial-image", "vision.analyze");
    initialExecution.result = attachEphemeralVisionImages(initialExecution.result!, [{
      content: { type: "image_url", image_url: { url: "data:image/png;base64,aW5pdGlhbA==" } },
      usage: { width: 10, height: 20, detail: "auto" },
      delivery: "initial"
    }]);
    const continuationExecution = toolExecutionForTool("call-image", "vision.analyze");
    continuationExecution.result = attachEphemeralVisionImages(continuationExecution.result!, [{
      content: { type: "image_url", image_url: { url: "data:image/png;base64,Y29udGludWF0aW9u" } },
      usage: { width: 30, height: 40, detail: "auto" },
      delivery: "continuation"
    }]);
    const harness = await createPostToolNudgeHarness({
      model: visionModel,
      primaryModelRoute: visionPrimaryRoute,
      responses: [
        providerExecution("", [providerToolCall("call-image")]),
        providerExecution("final answer")
      ],
      toolSteps: [{ executions: [continuationExecution] }],
      maxProviderIterations: 2
    });

    await runBasicProviderTurn(harness.loop, { toolExecutions: [initialExecution] });

    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    const initialRequest = harness.completeSpy.mock.calls[0]![0] as ProviderRequest;
    const continuationRequest = harness.completeSpy.mock.calls[1]![0] as ProviderRequest;
    expect(JSON.stringify(initialRequest.messages)).toContain("aW5pdGlhbA==");
    expect(JSON.stringify(initialRequest.messages)).not.toContain("Y29udGludWF0aW9u");
    expect(JSON.stringify(continuationRequest.messages)).toContain("Y29udGludWF0aW9u");
    expect(JSON.stringify(continuationRequest.messages)).not.toContain("aW5pdGlhbA==");
    expect((harness.completeSpy.mock.calls[0]![1] as { requireVision?: boolean }).requireVision).toBe(true);
    expect((harness.completeSpy.mock.calls[1]![1] as { requireVision?: boolean }).requireVision).toBe(true);
    expect(harness.completeSpy.mock.calls[0]![2]?.usage?.imageInputs).toEqual([
      { width: 10, height: 20, detail: "auto" }
    ]);
    expect(harness.completeSpy.mock.calls[1]![2]?.usage?.imageInputs).toEqual([
      { width: 30, height: 40, detail: "auto" }
    ]);
  });

  it("uses structured native history for supported post-tool continuation", async () => {
    let liveRuntimeId: string | undefined;
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
      onExecutePlans: async ({ sessionDb, sessionId, stepInput }) => {
        const runtimeId = stepInput.providerExecution?.toolCalls[0]?.id;
        if (runtimeId !== undefined) liveRuntimeId = runtimeId;
        await sessionDb.appendMessage({
          sessionId,
          role: "tool",
          content: "live tool result",
          metadata: {
            tool_call_id: liveRuntimeId,
            tool_call_name: testTool.name
          }
        });
      }
    });

    await runBasicProviderTurn(harness.loop);

    expect(liveRuntimeId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    const continuationRequest = harness.completeSpy.mock.calls[1]?.[0] as ProviderRequest;
    expect(continuationRequest.messages.at(-1)?.role).toBe("user");
    expect(JSON.stringify(continuationRequest.messages.at(-1)?.content)).toContain("EstaCoda executed the requested tools.");
    expect(continuationRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        toolCalls: [
          {
            id: liveRuntimeId,
            name: testTool.name,
            argumentsText: "{}"
          }
        ]
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: liveRuntimeId,
        content: expect.stringContaining("live tool result")
      })
    ]));
    const liveReplayToolMessage = continuationRequest.messages.find((message) =>
      message.role === "tool" && message.toolCallId === liveRuntimeId
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
      onExecutePlans: async ({ sessionDb, sessionId, stepInput }) => {
        await sessionDb.appendMessage({
          sessionId,
          role: "tool",
          content: "flat tool result",
          metadata: {
            tool_call_id: stepInput.providerExecution?.toolCalls[0]?.id,
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

  it("assigns a runtime-owned tool-call ID before persistence and planning", async () => {
    const toolCall = {
      index: 0,
      name: testTool.name,
      argumentsText: "{\"path\":\"src/index.ts\"}"
    };
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
    const persistedId = (persistedTurn?.metadata?.providerToolCalls as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(persistedId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(persistedTurn?.metadata?.providerToolCalls).toEqual([
      expect.objectContaining({
        id: persistedId,
        name: testTool.name,
        argumentsText: "{\"path\":\"src/index.ts\"}"
      })
    ]);
    expect(harness.executePlans.mock.calls[0]?.[0].providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: persistedId })
    ]);
  });

  it("namespaces repeated provider IDs across iterations and preserves both calls", async () => {
    const firstExecution = toolExecution("browser_download_1", "first download");
    const secondExecution = toolExecution("browser_download_1", "second download");
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [providerToolCall("browser_download_1")]),
        providerExecution("", [providerToolCall("browser_download_1")]),
        providerExecution("done")
      ],
      toolSteps: [
        { executions: [firstExecution] },
        { executions: [secondExecution] }
      ],
      maxProviderIterations: 3
    });

    const result = await runBasicProviderTurn(harness.loop);
    const runtimeIds = harness.executePlans.mock.calls
      .slice(0, 2)
      .map(([stepInput]) => stepInput.providerExecution?.toolCalls[0]?.id);
    const persistedTurns = (await harness.sessionDb.listMessages(harness.sessionId))
      .filter((message) => message.metadata?.kind === "provider-tool-call-turn");

    expect(runtimeIds).toHaveLength(2);
    expect(runtimeIds.every((id) => /^tool-call-[a-f0-9]{24}$/u.test(id ?? ""))).toBe(true);
    expect(new Set(runtimeIds).size).toBe(2);
    expect(JSON.stringify(runtimeIds)).not.toContain("browser_download_1");
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toEqual(runtimeIds);
    expect(persistedTurns.map((message) =>
      (message.metadata?.providerToolCalls as Array<{ id: string }>)[0]?.id
    )).toEqual(runtimeIds);
  });

  it("namespaces identical calls without provider IDs across iterations", async () => {
    const anonymousCall = {
      index: 0,
      name: testTool.name,
      argumentsText: "{}"
    };
    const harness = await createPostToolNudgeHarness({
      responses: [
        providerExecution("", [{ ...anonymousCall }]),
        providerExecution("", [{ ...anonymousCall }]),
        providerExecution("done")
      ],
      toolSteps: [
        { executions: [toolExecution("anonymous-one")] },
        { executions: [toolExecution("anonymous-two")] }
      ],
      maxProviderIterations: 3
    });

    await runBasicProviderTurn(harness.loop);
    const runtimeIds = harness.executePlans.mock.calls
      .slice(0, 2)
      .map(([stepInput]) => stepInput.providerExecution?.toolCalls[0]?.id);

    expect(runtimeIds.every((id) => /^tool-call-[a-f0-9]{24}$/u.test(id ?? ""))).toBe(true);
    expect(new Set(runtimeIds).size).toBe(2);
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
    const persistedId = (persisted?.metadata?.providerToolCalls as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(persistedId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(persisted?.metadata).toEqual(expect.objectContaining({
      nativeReplaySafe: false,
      providerToolCalls: [
        {
          id: persistedId,
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
    const runtimeId = (persisted?.metadata?.providerToolCalls as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(runtimeId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
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
    const runtimeId = (persisted?.metadata?.providerToolCalls as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(runtimeId).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(persisted?.metadata).toEqual(expect.objectContaining({
      nativeReplaySafe: true,
      provider: "deepseek",
      model: "deepseek-reasoner",
      routeRole: "primary",
      attemptedRouteIndex: 0,
      providerToolCalls: [
        {
          id: runtimeId,
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
      expect.objectContaining({ id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u) })
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
      expect(result.providerExecution?.response?.content).toContain("emergency deadline reserve");
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
      exhaustionCause: "budget_exhausted",
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
    expect(result.terminationCause).toBe("budget_exhausted");
    expect(result.providerExecution?.runtimeMetadata?.continuation).toEqual({
      reason: "provider_length",
      attempts: 0,
      exhausted: true,
      exhaustionCause: "budget_exhausted",
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
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toEqual([
      expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u)
    ]);
    expect(harness.completeSpy).toHaveBeenCalledTimes(2);
    expect(harness.executePlans).toHaveBeenCalledTimes(1);
    expect(harness.executePlans.mock.calls[0]![0].providerExecution!.toolCalls).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u) })
    ]);
    expect(harness.completeSpy.mock.calls[1]![0].maxTokens).toBe(8192);
    expect(harness.completeSpy.mock.calls[1]![0].messages).toEqual(harness.completeSpy.mock.calls[0]![0].messages);
    const retryOptions = harness.completeSpy.mock.calls[1]![2] as { primaryRoute?: ResolvedModelRoute; fallbackChain?: ResolvedModelRoute[] };
    expect(retryOptions.primaryRoute).toEqual(primaryRoute);
    expect(retryOptions.fallbackChain).toEqual([fallbackRoute]);
    expect(result.providerExecution?.toolCalls).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u) })
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
        id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u),
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
    expect(result.toolExecutions.map((execution) => execution.toolCallId)).toEqual([
      expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u)
    ]);
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
        id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u),
        argumentsText: "{\"path\""
      })
    ]);
    expect(result.toolExecutions).toEqual([]);
    expect(toolPlans).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^tool-call-[a-f0-9]{24}$/u),
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
    const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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

    const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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
        maxRepeatedBrowserObservations: 3,
        noProgressNudgeIteration: 3,
        maxNoProgressIterations: 6,
        maxProviderWallClockMs: 10_000,
        finalizationReserveMs: 0
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

    const providerExecutor = new ProviderExecutor({ registry, allowUnenforcedAttributedSpend: true });
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
        maxRepeatedBrowserObservations: 3,
        noProgressNudgeIteration: 3,
        maxNoProgressIterations: 6,
        maxProviderWallClockMs: 10_000,
        finalizationReserveMs: 0
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

  it("returns undefined providerExecution and cancels unresolved plans when providerExecutor is undefined", async () => {
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
        maxRepeatedBrowserObservations: 3,
        noProgressNudgeIteration: 3,
        maxNoProgressIterations: 6,
        maxProviderWallClockMs: 10_000,
        finalizationReserveMs: 0
      }
    });

    const toolPlans = [toolPlan("call-pending", "planned")];
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
      toolPlans,
      trustedWorkspace: false,
      initialRiskClass: "read-only-local"
    });

    expect(result.providerExecution).toBeUndefined();
    expect(result.iterations).toBe(0);
    expect(result.terminationCause).toBe("provider_failed");
    expect(toolPlans).toEqual([
      expect.objectContaining({
        id: "call-pending",
        status: "cancelled",
        error: "Provider turn ended before the planned tool call produced a result."
      })
    ]);
  });
});
