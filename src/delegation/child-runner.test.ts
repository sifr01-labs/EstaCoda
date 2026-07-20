import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationConfig } from "../contracts/delegation.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { AgentLoopInput, AgentLoopResponse } from "../runtime/agent-loop.js";
import type { ChildAgentLoopRuntime } from "../runtime/agent-loop-factory.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SubagentRegistry } from "./subagent-registry.js";
import { runDelegatedChild } from "./child-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runDelegatedChild", () => {
  it("returns completed child responses and relays progress", async () => {
    const harness = await createHarness({
      handle: async (input) => {
        await input.onEvent?.({ kind: "tool-start", tool: "file.read" });
        return response({ text: "done" });
      }
    });

    const result = await runDelegatedChild(harness.input());

    expect(result).toMatchObject({ kind: "response", response: { text: "done" } });
    expect(harness.events).toEqual([
      expect.objectContaining({
        kind: "delegation-progress",
        subagentId: "child",
        taskLabel: "Task",
        batchTaskCount: 1,
        childEvent: { kind: "tool-start", tool: "file.read" }
      })
    ]);
    expect(harness.registry.listActiveSubagents()).toHaveLength(1);
  });

  it("aborts only the child on timeout and returns a structured timeout result", async () => {
    vi.useFakeTimers();
    const parentController = new AbortController();
    const childController = new AbortController();
    const harness = await createHarness({
      childAbortController: childController,
      parentSignal: parentController.signal,
      configOverrides: { childTimeoutSeconds: 0.001 },
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });

    const pending = runDelegatedChild(harness.input());
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result).toMatchObject({
      kind: "timeout",
      summary: "Delegated child timed out after 0.001 seconds."
    });
    expect(childController.signal.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("writes bounded redacted timeout diagnostics to a profile-local path", async () => {
    vi.useFakeTimers();
    const diagnosticsRoot = await makeTempDir();
    const harness = await createHarness({
      diagnosticsRoot,
      configOverrides: { childTimeoutSeconds: 0.001 },
      task: "Inspect token=supersecret and then continue ".repeat(20),
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });

    const pending = runDelegatedChild(harness.input());
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.kind).toBe("timeout");
    if (result.kind !== "timeout") {
      return;
    }
    expect(result.diagnostic?.path).toContain(join(diagnosticsRoot, "delegation"));
    const diagnostic = JSON.parse(await readFile(result.diagnostic!.path!, "utf8")) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      reason: "timeout",
      childSessionId: "child",
      parentSessionId: "parent",
      role: "leaf",
      depth: 1,
      provider: "local",
      model: "test",
      timeoutDurationMs: 1
    });
    expect(String(diagnostic.taskHash)).toHaveLength(16);
    expect(String(diagnostic.taskPreview).length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(diagnostic)).not.toContain("supersecret");
    expect(diagnostic).not.toHaveProperty("promptPreview");
  });

  it("does not dump full prompts unless prompt previews are explicitly enabled", async () => {
    vi.useFakeTimers();
    const diagnosticsRoot = await makeTempDir();
    const harness = await createHarness({
      diagnosticsRoot,
      configOverrides: {
        childTimeoutSeconds: 0.001,
        diagnostics: { enabled: true, includePromptPreview: true }
      },
      task: "Prompt preview allowed",
      context: "Context token=hidden",
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });

    const pending = runDelegatedChild(harness.input());
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.kind).toBe("timeout");
    if (result.kind !== "timeout") {
      return;
    }
    const diagnostic = JSON.parse(await readFile(result.diagnostic!.path!, "utf8")) as Record<string, unknown>;
    expect(String(diagnostic.promptPreview)).toContain("Delegated task: Prompt preview allowed");
    expect(JSON.stringify(diagnostic)).not.toContain("hidden");
  });

  it("cancels child execution when the parent aborts", async () => {
    const parent = new AbortController();
    const child = new AbortController();
    const harness = await createHarness({
      childAbortController: child,
      parentSignal: parent.signal,
      handle: async () => {
        child.abort("parent-aborted");
        throw new Error("cancelled by parent");
      }
    });

    const result = await runDelegatedChild(harness.input());

    expect(result).toMatchObject({ kind: "cancelled" });
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("uses Task metadata and renews the Attempt heartbeat", async () => {
    vi.useFakeTimers();
    let resolveChild: ((response: AgentLoopResponse) => void) | undefined;
    let handledInput: AgentLoopInput | undefined;
    const onHeartbeat = vi.fn();
    const harness = await createHarness({
      configOverrides: { heartbeatSeconds: 0.001, heartbeatStaleCyclesIdle: 0 },
      handle: async (input) => {
        handledInput = input;
        return await new Promise<AgentLoopResponse>((resolve) => {
          resolveChild = resolve;
        });
      }
    });

    const pending = runDelegatedChild({
      ...harness.input(),
      prompt: "Durable Task prompt",
      inputMetadata: { durableTask: true, attemptId: "attempt-1" },
      onHeartbeat
    });
    await vi.advanceTimersByTimeAsync(3);
    resolveChild?.(response());
    await pending;

    expect(handledInput).toMatchObject({
      text: "Durable Task prompt",
      inputMetadata: { durableTask: true, attemptId: "attempt-1" }
    });
    expect(onHeartbeat.mock.calls.length).toBeGreaterThan(2);
  });

  it("stops heartbeat touches and writes diagnostics for stale idle children", async () => {
    const diagnosticsRoot = await makeTempDir();
    const harness = await createHarness({
      diagnosticsRoot,
      configOverrides: {
        childTimeoutSeconds: 0.05,
        heartbeatSeconds: 0.001,
        heartbeatStaleCyclesIdle: 0
      },
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });

    const pending = runDelegatedChild(harness.input());
    await sleep(20);

    const events = await harness.db.listEvents("parent");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "delegation-diagnostic",
      reason: "stale-heartbeat",
      childSessionId: "child"
    }));
    await pending;
  });
});

async function createHarness(input: {
  handle?: (input: AgentLoopInput) => Promise<AgentLoopResponse>;
  childAbortController?: AbortController;
  parentSignal?: AbortSignal;
  configOverrides?: Partial<DelegationConfig>;
  diagnosticsRoot?: string;
  task?: string;
  context?: string;
} = {}) {
  const db = new InMemorySessionDB({ id: deterministicId() });
  await db.createSession({ id: "parent", profileId: "default" });
  await db.createSession({ id: "child", profileId: "default", parentSessionId: "parent" });
  const registry = new SubagentRegistry();
  const childAbortController = input.childAbortController ?? new AbortController();
  registry.registerSubagent({
    subagentId: "child",
    childSessionId: "child",
    parentSessionId: "parent",
    role: "leaf",
    depth: 1,
    goal: input.task ?? "Task",
    model: "test",
    provider: "local",
    toolCount: 1,
    abortController: childAbortController
  });
  const events: unknown[] = [];
  const child = childRuntime(input.handle ?? (async () => response()));
  const task = input.task ?? "Task";
  return {
    db,
    registry,
    events,
    input: () => ({
      child,
      childAbortController,
      parentSignal: input.parentSignal,
      subagentRegistry: registry,
      subagentId: "child",
      sessionDb: db,
      delegationConfig: { ...config(), ...input.configOverrides, diagnostics: input.configOverrides?.diagnostics ?? config().diagnostics },
      diagnosticsRoot: input.diagnosticsRoot,
      parentSessionId: "parent",
      childSessionId: "child",
      role: "leaf" as const,
      depth: 1,
      task,
      context: input.context,
      trustedWorkspace: true,
      provider: "local",
      model: "test",
      effectiveAllowedTools: ["file.read"],
      parentOnEvent: (event: RuntimeEvent) => {
        events.push(event);
      }
    })
  };
}

function childRuntime(handle: (input: AgentLoopInput) => Promise<AgentLoopResponse>): ChildAgentLoopRuntime {
  return {
    childSession: {} as never,
    childSessionId: "child",
    sessionRuntimeContext: { currentSessionId: () => "child" } as never,
    builtSession: {} as never,
    agentLoop: {} as never,
    suppressedRuntimeFeatures: [],
    enabledRuntimeFeatures: [],
    approvalMode: "non-interactive-fail-closed",
    toolAccess: {
      effectiveAllowedToolsets: ["files"],
      effectiveAllowedTools: ["file.read"],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: []
    },
    handle,
    cleanup: async () => undefined
  };
}

function response(overrides: Partial<AgentLoopResponse> = {}): AgentLoopResponse {
  return {
    label: "EstaCoda",
    text: "child answer",
    matchedSkills: [],
    intent: {
      nativeIntent: "general",
      labels: ["general"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      rationale: "test",
      evidence: []
    },
    securityDecision: "allow",
    toolExecutions: [],
    toolPlans: [],
    skillOutcomes: [],
    artifacts: [],
    context: undefined,
    projectContext: undefined,
    progress: [],
    ...overrides
  };
}

function config(): DelegationConfig {
  return {
    maxSpawnDepth: 1,
    maxConcurrentChildren: 3,
    maxDelegateCallsPerTurn: 3,
    maxBatchTasks: 10,
    childTimeoutSeconds: 10,
    heartbeatSeconds: 30,
    heartbeatStaleCyclesIdle: 3,
    heartbeatStaleCyclesInTool: 6,
    recoverJsonStringTasks: true,
    diagnostics: { enabled: true, includePromptPreview: false },
    defaultAllowedRiskClasses: ["read-only-local", "read-only-network"],
    defaultExcludedToolsets: ["browser", "media", "mcp"],
    defaultAllowedToolsets: [],
    blockedToolNames: ["delegate_task"],
    blockedToolPrefixes: [],
    childRuntime: {
      memoryRecall: "disabled" as const,
      skillLearning: "disabled" as const,
      sessionCompression: "disabled" as const,
      projectContext: "bounded" as const
    }
  };
}

function deterministicId() {
  let id = 0;
  return () => `id-${++id}`;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-child-runner-"));
  tempDirs.push(dir);
  return dir;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
