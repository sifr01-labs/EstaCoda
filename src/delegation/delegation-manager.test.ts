import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { AgentLoopInput, AgentLoopResponse } from "../runtime/agent-loop.js";
import type { ChildAgentLoopFactory } from "../runtime/agent-loop-factory.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { DelegationManager, delegatedPrompt } from "./delegation-manager.js";
import { SubagentRegistry } from "./subagent-registry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("DelegationManager", () => {
  it("creates a child session through the factory and sends task text once", async () => {
    const harness = await createHarness();

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Summarize this file",
      allowedToolsets: ["research"],
      allowedTools: ["file.read"],
      trustedWorkspace: true
    });

    expect(harness.factory.createChild).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "parent",
      task: "Summarize this file",
      role: "leaf",
      depth: 1,
      parentVisibleTools: expect.arrayContaining([
        expect.objectContaining({ name: "file.read" })
      ])
    }));
    expect(harness.handleInputs).toHaveLength(1);
    expect(harness.handleInputs[0]?.text).toBe("Summarize this file");
    expect(result).toMatchObject({
      childSessionId: "child",
      status: "completed",
      summary: "child answer"
    });
    expect(result.effectiveAllowedTools).toEqual(["file.read"]);
  });

  it("wraps optional context deterministically without pre-appending duplicate child messages", async () => {
    const harness = await createHarness();

    await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Explain this",
      context: "Only use this context.",
      trustedWorkspace: true
    });

    expect(harness.handleInputs[0]?.text).toBe([
      "Delegated task: Explain this",
      "",
      "Context: Only use this context."
    ].join("\n"));
    await expect(harness.db.listMessages("child")).resolves.toEqual([]);
  });

  it("does not derive status by parsing child prose", async () => {
    const harness = await createHarness({
      response: response({ text: "This says blocked, failed, and denied, but it completed." })
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Use prose words",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
  });

  it("returns blocked from structured child denial even with cheerful prose", async () => {
    const harness = await createHarness({
      beforeResponse: async (db) => {
        await db.appendEvent("child", {
          kind: "security-assessed",
          tool: "terminal.run",
          riskClass: "credential-access",
          assessment: {
            decision: "deny",
            mode: "strict",
            reason: "Child runtime is non-interactive.",
            risk: "high"
          }
        });
      },
      response: response({ text: "All good over here." })
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Needs a denied tool",
      trustedWorkspace: true
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("blocked");
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("returns usage metadata from child provider execution", async () => {
    const harness = await createHarness({
      response: response({
        providerExecution: {
          ok: true,
          fallbackUsed: false,
          attempts: [],
          toolCalls: [],
          response: {
            ok: true,
            provider: "local",
            model: "test",
            content: "child answer",
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
              reasoningTokens: 4
            }
          }
        }
      })
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Report usage",
      trustedWorkspace: true
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      reasoningTokens: 4
    });
    expect(result.aggregateUsage).toEqual(result.usage);
    expect(result.usageUnavailable).toBe(false);
    await expect(harness.db.listEvents("parent")).resolves.toContainEqual(expect.objectContaining({
      kind: "delegation-finished",
      childSessionId: "child",
      usage: result.usage,
      aggregateUsage: result.usage,
      usageUnavailable: false
    }));
  });

  it("does not fail single delegation when child provider usage is missing", async () => {
    const harness = await createHarness();

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "No usage",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
    expect(result.usage).toBeUndefined();
    expect(result.aggregateUsage).toBeUndefined();
    expect(result.usageUnavailable).toBe(true);
    await expect(harness.db.listEvents("parent")).resolves.toContainEqual(expect.objectContaining({
      kind: "delegation-finished",
      childSessionId: "child",
      usageUnavailable: true
    }));
  });

  it("preserves child usage for structured blocked and failed provider responses", async () => {
    const blocked = await createHarness({
      beforeResponse: async (db) => {
        await db.appendEvent("child", {
          kind: "security-assessed",
          tool: "terminal.run",
          riskClass: "workspace-write",
          assessment: {
            decision: "deny",
            mode: "strict",
            reason: "blocked",
            risk: "high"
          }
        });
      },
      response: response({
        providerExecution: providerExecution({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
      })
    });
    const blockedResult = await blocked.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Blocked but counted",
      trustedWorkspace: true
    });

    expect(blockedResult.reason).toBe("blocked");
    expect(blockedResult.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(blockedResult.usageUnavailable).toBe(false);

    const failed = await createHarness({
      response: response({
        providerExecution: {
          ...providerExecution({ inputTokens: 8, outputTokens: 2, totalTokens: 10, reasoningTokens: 1 }),
          ok: false
        }
      })
    });
    const failedResult = await failed.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Provider failed but counted",
      trustedWorkspace: true
    });

    expect(failedResult.reason).toBe("provider-error");
    expect(failedResult.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10, reasoningTokens: 1 });
    expect(failedResult.usageUnavailable).toBe(false);
  });

  it("does not start a child when the parent signal is already aborted", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Cancelled",
      trustedWorkspace: true,
      signal: controller.signal
    });

    expect(harness.factory.createChild).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      childSessionId: "unavailable",
      status: "failed",
      reason: "cancelled"
    });
  });

  it("rejects new child spawns before session creation when spawn is paused", async () => {
    const registry = new SubagentRegistry();
    registry.pauseSpawns("maintenance window");
    const harness = await createHarness({ registry });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Paused",
      trustedWorkspace: true
    });

    expect(harness.factory.createChild).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      childSessionId: "unavailable",
      status: "failed",
      reason: "spawn-paused",
      summary: "Delegation spawn is paused: maintenance window"
    });
  });

  it("allows child spawns after spawn pause resumes", async () => {
    const registry = new SubagentRegistry();
    registry.pauseSpawns("pause");
    registry.resumeSpawns();
    const harness = await createHarness({ registry });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "After pause",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
    expect(harness.factory.createChild).toHaveBeenCalledTimes(1);
  });

  it("rejects delegation before child construction when spawn depth is exceeded", async () => {
    const harness = await createHarness({ currentDepth: 1, maxSpawnDepth: 1 });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Too deep",
      role: "orchestrator",
      trustedWorkspace: true
    });

    expect(harness.factory.createChild).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      childSessionId: "unavailable",
      status: "failed",
      reason: "spawn-depth-exceeded",
      role: "orchestrator",
      depth: 2
    });
  });

  it("propagates parent abort into the child-owned signal during child execution", async () => {
    const controller = new AbortController();
    const harness = await createHarness({
      beforeResponse: async (_db, registry) => {
        expect(registry.listActiveSubagents("parent")).toEqual([
          expect.objectContaining({ subagentId: "child", status: "running", signalAborted: false })
        ]);
        controller.abort();
      }
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Cancel during run",
      trustedWorkspace: true,
      signal: controller.signal
    });

    expect(harness.handleInputs[0]?.signal).not.toBe(controller.signal);
    expect(harness.handleInputs[0]?.signal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("cancelled");
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("parent abort interrupts all active children for the same parent", async () => {
    const controller = new AbortController();
    const registry = new SubagentRegistry();
    const siblingController = new AbortController();
    registry.registerSubagent({
      subagentId: "sibling",
      childSessionId: "sibling",
      parentSessionId: "parent",
      depth: 1,
      role: "leaf",
      goal: "Sibling child",
      model: "model",
      provider: "provider",
      toolCount: 0,
      abortController: siblingController
    });
    const harness = await createHarness({
      registry,
      beforeResponse: async () => {
        controller.abort();
      }
    });

    await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Cancel siblings",
      trustedWorkspace: true,
      signal: controller.signal
    });

    expect(siblingController.signal.aborted).toBe(true);
    expect(registry.listActiveSubagents("parent")).toEqual([
      expect.objectContaining({ subagentId: "sibling", status: "cancelling", signalAborted: true })
    ]);
  });

  it("unregisters active subagents on completion", async () => {
    const harness = await createHarness({
      beforeResponse: async (_db, registry) => {
        expect(registry.listActiveSubagents()).toEqual([
          expect.objectContaining({ subagentId: "child", status: "running" })
        ]);
      }
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Complete",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("unregisters active subagents on provider failure", async () => {
    const harness = await createHarness({
      response: response({
        providerExecution: {
          ok: false,
          fallbackUsed: false,
          attempts: [],
          toolCalls: [],
          response: {
            ok: false,
            provider: "local",
            model: "test",
            content: "provider failed",
            errorClass: "server"
          }
        }
      })
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Fail",
      trustedWorkspace: true
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("provider-error");
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("unregisters active subagents when child handle throws", async () => {
    const harness = await createHarness({
      handleError: new Error("child exploded")
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Throw",
      trustedWorkspace: true
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("runtime-error");
    expect(harness.registry.listActiveSubagents()).toEqual([]);
  });

  it("spawn pause does not interrupt already-running children", async () => {
    const registry = new SubagentRegistry();
    const harness = await createHarness({
      registry,
      beforeResponse: async (_db, activeRegistry, handleInput) => {
        activeRegistry.pauseSpawns("pause future work");
        expect(handleInput.signal?.aborted).toBe(false);
      }
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Keep running",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
    expect(registry.isSpawnPaused()).toBe(true);
  });

  it("registry interrupt aborts the active child-owned signal", async () => {
    const registry = new SubagentRegistry();
    const harness = await createHarness({
      registry,
      beforeResponse: async (_db, activeRegistry, handleInput) => {
        expect(activeRegistry.interruptSubagent("child", "stop child")).toBe(true);
        expect(handleInput.signal?.aborted).toBe(true);
      }
    });

    const result = await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Interrupt child",
      trustedWorkspace: true
    });

    expect(result.status).toBe("completed");
    expect(registry.listActiveSubagents()).toEqual([]);
  });

  it("returns structured timeout status and cleans the registry", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({
      maxSpawnDepth: 1,
      childTimeoutSeconds: 0.001,
      handle: async () => await new Promise<AgentLoopResponse>(() => undefined)
    });

    const pending = harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Timeout",
      trustedWorkspace: true
    });
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result).toMatchObject({
      childSessionId: "child",
      status: "failed",
      reason: "timeout"
    });
    expect(harness.registry.listActiveSubagents()).toEqual([]);
    await expect(harness.db.listEvents("parent")).resolves.toContainEqual(expect.objectContaining({
      kind: "delegation-finished",
      childSessionId: "child",
      reason: "timeout",
      status: "failed"
    }));
  });

  it("relays child progress to the parent event sink with subagent metadata", async () => {
    const events: RuntimeEvent[] = [];
    const harness = await createHarness({
      beforeResponse: async (_db, _registry, handleInput) => {
        await handleInput.onEvent?.({ kind: "provider-attempt", provider: "local", model: "test", fallback: false });
      }
    });

    await harness.manager.delegate({
      parentSessionId: "parent",
      profileId: "default",
      task: "Relay progress",
      trustedWorkspace: true,
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "delegation-progress",
        subagentId: "child",
        childSessionId: "child",
        parentSessionId: "parent",
        role: "leaf",
        depth: 1,
        childEvent: {
          kind: "provider-attempt",
          provider: "local",
          model: "test",
          fallback: false
        }
      })
    ]);
  });

  it("runs batch children with bounded concurrency and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const harness = await createHarness({
      maxConcurrentChildren: 2,
      handle: async (handleInput) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
        return response({ text: `answer for ${handleInput.text}` });
      }
    });

    const pending = harness.manager.delegateBatch({
      parentSessionId: "parent",
      profileId: "default",
      tasks: [
        { task: "one" },
        { task: "two" },
        { task: "three" }
      ],
      trustedWorkspace: true
    });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(harness.handleInputs).toHaveLength(3));
    releases.splice(0).forEach((release) => release());
    const result = await pending;

    expect(maxActive).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.results.map((child) => child.task)).toEqual(["one", "two", "three"]);
    expect(result.results.map((child) => child.index)).toEqual([0, 1, 2]);
    expect(result.results.map((child) => child.childStatus)).toEqual(["completed", "completed", "completed"]);
  });

  it("preserves per-child batch usage and rolls up aggregate child usage", async () => {
    const harness = await createHarness({
      maxConcurrentChildren: 3,
      handle: async (handleInput) => response({
        text: `answer for ${handleInput.text}`,
        providerExecution: providerExecution(
          handleInput.text === "one"
            ? { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 1 }
            : handleInput.text === "two"
              ? { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 4 }
              : { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
        )
      })
    });

    const result = await harness.manager.delegateBatch({
      parentSessionId: "parent",
      profileId: "default",
      tasks: [{ task: "one" }, { task: "two" }, { task: "three" }],
      trustedWorkspace: true
    });

    expect(result.results.map((child) => child.usage)).toEqual([
      { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 1 },
      { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 4 },
      { inputTokens: 100, outputTokens: 200, totalTokens: 300 }
    ]);
    expect(result.aggregateUsage).toEqual({
      inputTokens: 111,
      outputTokens: 222,
      totalTokens: 333,
      reasoningTokens: 5
    });
    expect(result.usageUnavailable).toBe(false);
    expect(result.usageUnavailableCount).toBe(0);
  });

  it("rolls up batch usage while tolerating missing child usage", async () => {
    const harness = await createHarness({
      maxConcurrentChildren: 2,
      handle: async (handleInput) => response({
        text: `answer for ${handleInput.text}`,
        providerExecution: handleInput.text === "counted"
          ? providerExecution({ inputTokens: 6, outputTokens: 7, totalTokens: 13 })
          : undefined
      })
    });

    const result = await harness.manager.delegateBatch({
      parentSessionId: "parent",
      profileId: "default",
      tasks: [{ task: "counted" }, { task: "missing" }],
      trustedWorkspace: true
    });

    expect(result.results.map((child) => child.usageUnavailable)).toEqual([false, true]);
    expect(result.aggregateUsage).toEqual({ inputTokens: 6, outputTokens: 7, totalTokens: 13 });
    expect(result.usageUnavailable).toBe(true);
    expect(result.usageUnavailableCount).toBe(1);
  });

  it("preserves timeout child status when batch aggregate fails", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const harness = await createHarness({
      maxConcurrentChildren: 2,
      childTimeoutSeconds: 0.001,
      handle: async () => {
        calls += 1;
        if (calls === 1) {
          return response({
            text: "fast",
            providerExecution: providerExecution({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
          });
        }
        return await new Promise<AgentLoopResponse>(() => undefined);
      }
    });

    const pending = harness.manager.delegateBatch({
      parentSessionId: "parent",
      profileId: "default",
      tasks: [{ task: "fast" }, { task: "slow" }],
      trustedWorkspace: true
    });
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("child-timeout");
    expect(result.results.map((child) => child.childStatus)).toEqual(["completed", "timeout"]);
    expect(result.results.map((child) => child.usage)).toEqual([
      { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      undefined
    ]);
    expect(result.aggregateUsage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(result.usageUnavailable).toBe(true);
    expect(result.usageUnavailableCount).toBe(1);
  });

  it("parent abort cancels running batch children and skips queued children", async () => {
    const controller = new AbortController();
    let runningSignal: AbortSignal | undefined;
    const harness = await createHarness({
      maxConcurrentChildren: 1,
      handle: async (handleInput) => {
        runningSignal = handleInput.signal;
        controller.abort();
        throw new Error("cancelled by parent");
      }
    });

    const result = await harness.manager.delegateBatch({
      parentSessionId: "parent",
      profileId: "default",
      tasks: [{ task: "running" }, { task: "queued" }],
      trustedWorkspace: true,
      signal: controller.signal
    });

    expect(runningSignal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("cancelled");
    expect(result.results.map((child) => child.childStatus)).toEqual(["cancelled", "cancelled"]);
    expect(harness.factory.createChild).toHaveBeenCalledTimes(1);
  });
});

describe("delegatedPrompt", () => {
  it("keeps the legacy single-task prompt shape when context is absent", () => {
    expect(delegatedPrompt("Do one thing", undefined)).toBe("Do one thing");
  });
});

async function createHarness(input: {
  response?: AgentLoopResponse;
  beforeResponse?: (db: InMemorySessionDB, registry: SubagentRegistry, handleInput: AgentLoopInput) => Promise<void>;
  handle?: (handleInput: AgentLoopInput) => Promise<AgentLoopResponse>;
  handleError?: Error;
  currentDepth?: number;
  maxSpawnDepth?: number;
  maxConcurrentChildren?: number;
  maxBatchTasks?: number;
  childTimeoutSeconds?: number;
  registry?: SubagentRegistry;
} = {}) {
  const db = new InMemorySessionDB({ id: deterministicId() });
  const registry = input.registry ?? new SubagentRegistry();
  await db.createSession({ id: "parent", profileId: "default" });
  const handleInputs: Array<{ text: string; signal?: AbortSignal }> = [];
  let childSequence = 0;
  const factory: ChildAgentLoopFactory = {
    createChild: vi.fn(async () => {
      childSequence += 1;
      const childSessionId = childSequence === 1 ? "child" : `child-${childSequence}`;
      await db.createSession({
        id: childSessionId,
        profileId: "default",
        parentSessionId: "parent",
        metadata: { kind: "delegated-child" }
      });
      return {
        childSessionId,
        childSession: (await db.getSession(childSessionId))!,
        sessionRuntimeContext: { currentSessionId: () => childSessionId } as never,
        builtSession: {} as never,
        agentLoop: {} as never,
        suppressedRuntimeFeatures: [],
        enabledRuntimeFeatures: [],
        approvalMode: "non-interactive-fail-closed" as const,
        toolAccess: {
          effectiveAllowedToolsets: ["files"],
          effectiveAllowedTools: ["file.read"],
          strippedTools: [],
          blockedTools: [],
          rejectedRequestedTools: [],
          rejectedRequestedToolsets: []
        },
        handle: vi.fn(async (handleInput) => {
          handleInputs.push({ text: handleInput.text, signal: handleInput.signal });
          if (input.handle !== undefined) {
            return await input.handle(handleInput);
          }
          await input.beforeResponse?.(db, registry, handleInput);
          if (input.handleError !== undefined) {
            throw input.handleError;
          }
          return input.response ?? response();
        }),
        cleanup: vi.fn(async () => undefined)
      };
    })
  };
  return {
    db,
    registry,
    handleInputs,
    factory,
    manager: new DelegationManager({
      sessionDb: db,
      childFactory: factory,
      trajectoryRecorder: new TrajectoryRecorder({ profileId: "default", sessionId: "parent", modelId: "test" }),
      subagentRegistry: registry,
      currentDepth: input.currentDepth,
      delegationConfig: input.maxSpawnDepth === undefined && input.maxConcurrentChildren === undefined && input.maxBatchTasks === undefined && input.childTimeoutSeconds === undefined ? undefined : {
        maxSpawnDepth: input.maxSpawnDepth ?? 3,
        maxConcurrentChildren: input.maxConcurrentChildren ?? 3,
        maxDelegateCallsPerTurn: 3,
        maxBatchTasks: input.maxBatchTasks ?? 10,
        childTimeoutSeconds: input.childTimeoutSeconds ?? 600,
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
          memoryRecall: "disabled",
          skillLearning: "disabled",
          sessionCompression: "disabled",
          projectContext: "bounded"
        }
      },
      parentVisibleTools: () => [{
        name: "file.read",
        description: "read",
        inputSchema: { type: "object" },
        riskClass: "read-only-local",
        toolsets: ["files"],
        progressLabel: "read",
        maxResultSizeChars: 1000
      }]
    })
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

function providerExecution(usage: ProviderUsage): NonNullable<AgentLoopResponse["providerExecution"]> {
  return {
    ok: true,
    fallbackUsed: false,
    attempts: [],
    toolCalls: [],
    response: {
      ok: true,
      provider: "local",
      model: "test",
      content: "child answer",
      usage
    }
  };
}

function deterministicId() {
  let id = 0;
  return () => `id-${++id}`;
}
