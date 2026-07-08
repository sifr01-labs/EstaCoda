import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, ChannelMessage, ChannelReply, ChannelSessionKey } from "../../contracts/channel.js";
import type { DelegationConfig } from "../../contracts/delegation.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName, RegisteredTool } from "../../contracts/tool.js";
import type { AgentLoopInput, AgentLoopResponse } from "../../runtime/agent-loop.js";
import type { ChildAgentLoopFactory } from "../../runtime/agent-loop-factory.js";
import { ChannelGateway, InMemoryChannelSessionStore } from "../../channels/channel-gateway.js";
import { DEFAULT_DELEGATION_CONFIG } from "../../config/delegation-defaults.js";
import { DelegationManager } from "../../delegation/delegation-manager.js";
import { SubagentRegistry } from "../../delegation/subagent-registry.js";
import { applyChildToolAccessResult, resolveChildToolAccess } from "../../delegation/toolset-security.js";
import { ActiveTurnRegistry } from "../../gateway/active-turn-registry.js";
import { InMemorySessionDB } from "../../session/in-memory-session-db.js";
import type { SmokeCase, SmokeContext } from "../smoke-case.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { TrajectoryRecorder } from "../../trajectory/trajectory-recorder.js";
import type { Runtime } from "../../runtime/create-runtime.js";

export const delegation_mvp_case: SmokeCase = {
  id: "delegation-mvp",
  name: "Delegation MVP subagent parity smoke coverage",
  tags: ["delegation", "subagent", "runtime", "security"],
  run: async (context) => {
    await smokeSingleDelegation(context);
    await smokeToolBounds(context);
    await smokeDepthLimit(context);
    await smokeBatchDelegation(context);
    await smokeInterruptCleanup(context);
    await smokeGatewayProtection();
    await smokeTimeoutDiagnostics();
  }
};

async function smokeSingleDelegation(context: SmokeContext): Promise<void> {
  const harness = await createDelegationHarness({
    response: response({ text: "child completed simple task" })
  });
  const result = await harness.manager.delegate({
    parentSessionId: "parent",
    profileId: "smoke",
    task: "Summarize this fixture",
    trustedWorkspace: true
  });

  assert(result.status === "completed", `single delegation status should complete, got ${result.status}`);
  assert(result.summary === "child completed simple task", "parent should receive child summary");
  const child = await harness.db.getSession(result.childSessionId);
  assert(child !== undefined, "child session should exist");
  assert(child?.parentSessionId === "parent", "child session should point at parent session");
  assert(child?.metadata?.kind === "delegated-child", "child session should be marked delegated-child");
}

async function smokeToolBounds(context: SmokeContext): Promise<void> {
  const tools = [
    ...context.tools.list(),
    tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
  ];
  const result = resolveChildToolAccess({
    parentVisibleTools: tools,
    childCandidateTools: tools,
    config: DEFAULT_DELEGATION_CONFIG,
    request: { role: "leaf", depth: 1 }
  });
  const effective = new Set(result.effectiveAllowedTools);

  for (const blocked of ["terminal.run", "file.write", "file.patch", "session_search", "delegate_task"]) {
    assert(!effective.has(blocked), `default child schema should exclude ${blocked}`);
  }

  const childRegistry = new ToolRegistry();
  for (const tool of tools.map(fakeRegisteredTool)) {
    childRegistry.register(tool);
  }
  applyChildToolAccessResult(childRegistry, result);
  assert(childRegistry.get("terminal.run") === undefined, "stripped terminal.run must not be executable");
  assert(childRegistry.get("session_search") === undefined, "stripped session_search must not be executable");
  assert(childRegistry.get("file.read") !== undefined, "default child profile should keep useful read-only file tools");
}

async function smokeDepthLimit(_context: SmokeContext): Promise<void> {
  const delegationTool = tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"]);
  const readTool = tool("file.read", "read-only-local", ["files"]);
  const config = delegationConfig({ maxSpawnDepth: 2 });

  const leaf = resolveChildToolAccess({
    parentVisibleTools: [delegationTool, readTool],
    childCandidateTools: [delegationTool, readTool],
    config,
    request: { role: "leaf", depth: 1 }
  });
  assert(!leaf.effectiveAllowedTools.includes("delegate_task"), "leaf child must not receive delegate_task");

  const orchestrator = resolveChildToolAccess({
    parentVisibleTools: [delegationTool, readTool],
    childCandidateTools: [delegationTool, readTool],
    config,
    request: { role: "orchestrator", depth: 1 }
  });
  assert(orchestrator.effectiveAllowedTools.includes("delegate_task"), "orchestrator should spawn within depth");

  const overDepthToolAccess = resolveChildToolAccess({
    parentVisibleTools: [delegationTool, readTool],
    childCandidateTools: [delegationTool, readTool],
    config,
    request: { role: "orchestrator", depth: 2 }
  });
  assert(!overDepthToolAccess.effectiveAllowedTools.includes("delegate_task"), "orchestrator at max depth must not spawn");

  const harness = await createDelegationHarness({ currentDepth: 2, config });
  const result = await harness.manager.delegate({
    parentSessionId: "parent",
    profileId: "smoke",
    task: "Try one more child",
    role: "orchestrator",
    trustedWorkspace: true
  });
  assert(result.reason === "spawn-depth-exceeded", `over-depth should fail before child creation, got ${result.reason}`);
  assert(harness.createChildCalls() === 0, "over-depth delegation should not create a child session");
  const sessions = await harness.db.listSessions("smoke");
  assert(sessions.every((session) => session.parentSessionId === undefined), "over-depth should not create child sessions");
}

async function smokeBatchDelegation(_context: SmokeContext): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const harness = await createDelegationHarness({
    config: delegationConfig({ maxConcurrentChildren: 2, maxBatchTasks: 3, maxSpawnDepth: 2 }),
    handle: async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active -= 1;
      return response({ text: `answer ${input.text}` });
    }
  });
  const result = await harness.manager.delegateBatch({
    parentSessionId: "parent",
    profileId: "smoke",
    trustedWorkspace: true,
    tasks: [
      { task: "one" },
      { task: "two" },
      { task: "three" }
    ]
  });

  assert(result.status === "completed", `batch should complete, got ${result.status}`);
  assert(result.maxObservedConcurrency > 1, "batch should observe parallel child execution");
  assert(maxActive > 1, "child handles should run concurrently");
  assert(maxActive <= 2, `batch concurrency should stay capped at 2, got ${maxActive}`);
  assert(
    result.results.map((child) => child.summary).join("|") === "answer one|answer two|answer three",
    "batch results should remain in input order"
  );
}

async function smokeInterruptCleanup(_context: SmokeContext): Promise<void> {
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const controller = new AbortController();
  const harness = await createDelegationHarness({
    handle: async (input) => {
      started?.();
      return await new Promise<AgentLoopResponse>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("child aborted")));
      });
    }
  });

  const pending = harness.manager.delegate({
    parentSessionId: "parent",
    profileId: "smoke",
    task: "Wait until cancelled",
    trustedWorkspace: true,
    signal: controller.signal
  });
  await startedPromise;
  assert(harness.registry.hasActiveSubagents("parent"), "subagent should be active before parent abort");
  controller.abort("smoke-stop");
  const result = await pending;

  assert(result.reason === "cancelled" || result.reason === "runtime-error", `abort should cancel child work, got ${result.reason}`);
  assert(!harness.registry.hasActiveSubagents("parent"), "subagent registry should clean up after abort");
}

async function smokeGatewayProtection(): Promise<void> {
  const adapter = createSmokeAdapter();
  const activeTurns = new ActiveTurnRegistry();
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const handled: string[] = [];

  const gateway = new ChannelGateway({
    adapters: [adapter],
    sessionStore: new InMemoryChannelSessionStore(),
    authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
    activeTurnRegistry: activeTurns,
    busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 }),
    runtimeForSession: async ({ sessionId }) => runtimeStub({
      hasActiveSubagents: (parentSessionId) => parentSessionId === sessionId,
      handle: async ({ text, signal }) => {
        handled.push(text);
        if (text === "first") {
          firstStarted?.();
          await new Promise<void>((resolve, reject) => {
            releaseFirst = resolve;
            signal?.addEventListener("abort", () => reject(new Error("unexpected subagent interrupt")));
          });
        }
        return response({ text: `handled ${text}` });
      }
    })
  });

  const first = gateway.receive(message("first"));
  await firstStartedPromise;
  const queued = await gateway.receive(message("second"));
  assert(queued.replyText === "", "ordinary message should be queued while subagents are active");
  assert(adapter.sentText.includes("Queued (position 1)"), "gateway should send bounded queued copy");
  assert(activeTurns.stats().totalAborted === 0, "ordinary message must not abort active delegation turn");
  releaseFirst?.();
  await first;
  await waitFor(() => handled.includes("second"));

  let stopped = false;
  let stopStarted: (() => void) | undefined;
  const stopStartedPromise = new Promise<void>((resolve) => { stopStarted = resolve; });
  const stopGateway = new ChannelGateway({
    adapters: [createSmokeAdapter()],
    sessionStore: new InMemoryChannelSessionStore(),
    authPolicy: { telegram: { allowedUserIds: ["user-1"] } },
    activeTurnRegistry: new ActiveTurnRegistry(),
    busyPolicyResolver: () => ({ busyPolicy: "interrupt", queueDepth: 3 }),
    runtimeForSession: async () => runtimeStub({
      hasActiveSubagents: () => true,
      handle: async ({ signal }) => {
        stopStarted?.();
        return await new Promise<AgentLoopResponse>((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            stopped = true;
            reject(new Error("stopped"));
          });
          setTimeout(() => resolve(response({ text: "done" })), 250);
        });
      }
    })
  });
  const active = stopGateway.receive(message("first"));
  await stopStartedPromise;
  const stop = await stopGateway.receive(message("/stop"));
  await active;
  assert(stop.replyText.includes("Cancelled"), "/stop should bypass queue and cancel active work");
  assert(stopped, "/stop should abort active child work");
}

async function smokeTimeoutDiagnostics(): Promise<void> {
  const diagnosticsRoot = await mkdtemp(join(tmpdir(), "estacoda-delegation-smoke-diagnostics-"));
  try {
    const harness = await createDelegationHarness({
      diagnosticsRoot,
      config: delegationConfig({
        childTimeoutSeconds: 0.005,
        heartbeatSeconds: 600
      }),
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });
    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "smoke",
      task: "timeout diagnostic smoke secret=sk-test",
      trustedWorkspace: true
    });

    assert(result.reason === "timeout", `timeout smoke should preserve timeout reason, got ${result.reason}`);
    assert(result.diagnosticPath !== undefined, "timeout should return diagnostic path");
    assert(result.diagnosticPath.startsWith(diagnosticsRoot), "diagnostic path should stay under profile-local diagnostics root");
    assert(existsSync(result.diagnosticPath), "timeout diagnostic file should exist");
    const diagnostic = await readFile(result.diagnosticPath, "utf8");
    assert(diagnostic.includes("\"reason\": \"timeout\""), "diagnostic should be structured timeout JSON");
    assert(!diagnostic.includes("promptPreview"), "diagnostic should omit full prompt preview by default");
    assert(!diagnostic.includes("sk-test"), "diagnostic preview should redact secret-like values");
  } finally {
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
}

async function createDelegationHarness(input: {
  response?: AgentLoopResponse;
  handle?: (input: AgentLoopInput) => Promise<AgentLoopResponse>;
  currentDepth?: number;
  config?: DelegationConfig;
  diagnosticsRoot?: string;
} = {}) {
  const db = new InMemorySessionDB({ id: sequence("delegation-smoke") });
  const registry = new SubagentRegistry();
  const config = input.config ?? delegationConfig({ maxSpawnDepth: 2 });
  await db.createSession({ id: "parent", profileId: "smoke" });
  let childIndex = 0;
  let createChildCalls = 0;
  const factory: ChildAgentLoopFactory = {
    createChild: async (createInput) => {
      createChildCalls += 1;
      childIndex += 1;
      const childSessionId = `child-${childIndex}`;
      const toolAccess = resolveChildToolAccess({
        parentVisibleTools: createInput.parentVisibleTools,
        childCandidateTools: createInput.parentVisibleTools,
        config,
        request: {
          role: createInput.role ?? "leaf",
          depth: createInput.depth ?? 1,
          allowedToolsets: createInput.allowedToolsets,
          allowedTools: createInput.allowedTools
        }
      });
      const childSession = await db.createSession({
        id: childSessionId,
        profileId: createInput.profileId,
        parentSessionId: createInput.parentSessionId,
        metadata: {
          kind: "delegated-child",
          role: createInput.role ?? "leaf",
          depth: createInput.depth ?? 1
        }
      });

      return {
        childSession,
        childSessionId,
        sessionRuntimeContext: { currentSessionId: () => childSessionId } as never,
        builtSession: {} as never,
        agentLoop: {} as never,
        suppressedRuntimeFeatures: ["memoryRecall", "skillLearning", "sessionCompression"],
        enabledRuntimeFeatures: ["agentLoop", "providerExecution", "toolExecution"],
        approvalMode: "non-interactive-fail-closed" as const,
        toolAccess,
        handle: async (handleInput) => input.handle?.(handleInput) ?? input.response ?? response({ text: "child answer" }),
        cleanup: async () => undefined
      };
    }
  };

  return {
    db,
    registry,
    createChildCalls: () => createChildCalls,
    manager: new DelegationManager({
      sessionDb: db,
      childFactory: factory,
      trajectoryRecorder: new TrajectoryRecorder({ profileId: "smoke", sessionId: "parent", modelId: "smoke-model" }),
      delegationConfig: config,
      currentDepth: input.currentDepth,
      subagentRegistry: registry,
      diagnosticsRoot: input.diagnosticsRoot,
      parentVisibleTools: () => [
        tool("file.read", "read-only-local", ["files"]),
        tool("file.grep", "read-only-local", ["files"]),
        tool("web.search", "read-only-network", ["web"]),
        tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
      ]
    })
  };
}

function response(input: { text: string }): AgentLoopResponse {
  return {
    label: "smoke",
    text: input.text,
    matchedSkills: [],
    intent: {
      nativeIntent: "general",
      labels: ["general"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      rationale: "smoke",
      evidence: []
    },
    securityDecision: "allow",
    toolExecutions: [],
    toolPlans: [],
    skillOutcomes: [],
    artifacts: [],
    context: undefined,
    projectContext: undefined,
    progress: []
  };
}

function runtimeStub(overrides: Partial<Runtime>): Runtime {
  return {
    agentEvolutionPolicy: () => ({ enabled: false }),
    describe: () => "smoke runtime",
    getStatus: () => ({ sections: [] }) as never,
    getModelInfo: () => ({ title: "model", items: [] }) as never,
    getStartup: () => ({ title: "startup", sections: [] }) as never,
    getStartupReadiness: async () => ({ ready: true, checks: [] }) as never,
    tools: () => [],
    skills: () => [],
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    handle: async (input) => response({ text: input.text }),
    trustWorkspace: async () => undefined,
    isWorkspaceTrusted: async () => true,
    revokeWorkspaceTrust: async () => true,
    dispose: async () => undefined,
    sessionDb: new InMemorySessionDB(),
    sessionId: "smoke-gateway-session",
    ...overrides
  } as Runtime;
}

function createSmokeAdapter(): ChannelAdapter & { sentText: string[] } {
  const sentText: string[] = [];
  return {
    kind: "telegram",
    sentText,
    delivery: {
      sendText: async (_sessionKey: ChannelSessionKey, text: string) => {
        sentText.push(text);
      }
    },
    send: async (reply: ChannelReply) => {
      if (reply.text !== undefined) {
        sentText.push(reply.text);
      }
    }
  };
}

function message(text: string): ChannelMessage {
  return {
    id: `message-${text}`,
    channel: "telegram",
    sessionKey: {
      platform: "telegram",
      chatId: "123456",
      userId: "user-1"
    },
    text,
    sender: { id: "user-1" },
    attachments: [],
    receivedAt: new Date("2026-04-16T00:00:00.000Z").toISOString()
  };
}

function delegationConfig(overrides: Partial<DelegationConfig>): DelegationConfig {
  return {
    ...DEFAULT_DELEGATION_CONFIG,
    ...overrides,
    diagnostics: {
      ...DEFAULT_DELEGATION_CONFIG.diagnostics,
      ...overrides.diagnostics
    },
    childRuntime: {
      ...DEFAULT_DELEGATION_CONFIG.childRuntime,
      ...overrides.childRuntime
    }
  };
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskClass,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1000
  };
}

function fakeRegisteredTool(definition: ToolDefinition): RegisteredTool {
  return {
    ...definition,
    isAvailable: () => true,
    run: async () => ({ ok: true, content: definition.name })
  };
}

function sequence(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for smoke condition.");
    }
    await delay(5);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
