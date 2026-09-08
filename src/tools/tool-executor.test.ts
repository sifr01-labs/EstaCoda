import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityFirstDefaults, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { ExecutionCheckpointJournalController } from "../contracts/execution-checkpoint.js";
import type { RegisteredTool, ToolExecutionContext, ToolResult } from "../contracts/tool.js";
import { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { ToolRegistry } from "./tool-registry.js";
import { summarizeSecurityTarget, ToolExecutor } from "./tool-executor.js";
import { attachEphemeralVisionImages, ephemeralVisionImages } from "../vision/ephemeral-vision-content.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "../security/workspace-approval-controller.js";
import { TurnMcpReadLedger } from "../runtime/turn-tool-feedback-ledger.js";
import {
  ExecutionCheckpointController,
  executionCheckpointOperationId
} from "../runtime/execution-checkpoint-controller.js";
import { hydratableExecutionCheckpoint } from "../session/execution-checkpoint-state.js";
import { semanticMutationKey } from "./execution-operation-ledger.js";
import { ExecutionEvidenceIndex } from "../runtime/execution-evidence-index.js";
import { deriveExecutionFinalOutcome } from "../runtime/execution-outcome.js";
import type { SecureInputTransferGroupConsumer, SecureInputTransferGroupRequest, SecureInputTransferRequestHandler } from "../contracts/secure-input.js";

function createMockPolicy(decision: "allow" | "deny" = "allow"): SecurityPolicy {
  return {
    decide() {
      return decision;
    }
  };
}

function createThrowingTool(name: string, message: string): RegisteredTool {
  return {
    name,
    description: "throws",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "throwing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (): Promise<ToolResult> => {
      throw new Error(message);
    }
  };
}

function createEchoTool(name: string): RegisteredTool {
  return {
    name,
    description: "echoes",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "echoing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (_input, context): Promise<ToolResult> => {
      if (context?.signal?.aborted === true) {
        throw new Error("Should not reach here when pre-cancelled");
      }
      return { ok: true, content: "echo" };
    }
  };
}

function createSensitiveEchoTool(name: string): RegisteredTool {
  return {
    name,
    description: "echoes input back for redaction testing",
    inputSchema: { type: "object", properties: {} },
    riskClass: "read-only-local",
    toolsets: ["core"],
    progressLabel: "echoing",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (input): Promise<ToolResult> => {
      return { ok: true, content: JSON.stringify(input) };
    }
  };
}

function createRequiredUrlTool(name: string): RegisteredTool {
  return {
    name,
    description: "requires url",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    },
    riskClass: "read-only-network",
    toolsets: ["web"],
    progressLabel: "validating",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (): Promise<ToolResult> => {
      return { ok: true, content: "validated" };
    }
  };
}

function createTerminalEchoTool(): RegisteredTool {
  return {
    name: "terminal.run",
    description: "runs command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    },
    riskClass: "workspace-write",
    toolsets: ["shell-write"],
    progressLabel: "running",
    maxResultSizeChars: 1000,
    isAvailable: () => true,
    run: async (_input, context): Promise<ToolResult> => {
      return {
        ok: true,
        content: `environment=${context?.environmentType ?? "missing"}`
      };
    }
  };
}

async function setupExecutor(options: {
  policy?: SecurityPolicy;
  tools?: RegisteredTool[];
  defaultExecutionTimeoutMs?: number;
  sessionDb?: SessionDB;
  createSession?: boolean;
  executionCheckpointController?: ExecutionCheckpointJournalController;
}) {
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool);
  }
  const sessionDb: SessionDB = options.sessionDb ?? new InMemorySessionDB();
  const trajectoryRecorder = new TrajectoryRecorder({
    profileId: "test",
    sessionId: "test-session",
    modelId: "test-model"
  });
  const executor = new ToolExecutor({
    registry,
    securityPolicy: options.policy ?? createMockPolicy("allow"),
    sessionDb,
    trajectoryRecorder,
    workspaceRoot: process.cwd(),
    executionCheckpointController: options.executionCheckpointController,
    defaultExecutionTimeoutMs: options.defaultExecutionTimeoutMs
  });
  if (options.createSession !== false) {
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
  }
  return { executor, sessionDb, trajectoryRecorder };
}

async function createCheckpointController(
  sessionDb: SessionDB,
  options: { hydrate?: boolean } = {}
): Promise<ExecutionCheckpointController> {
  const controller = new ExecutionCheckpointController({
    sessionId: "test-session",
    profileId: "test",
    record: async (event) => { await sessionDb.appendEvent("test-session", event); }
  });
  if (options.hydrate === true) {
    const checkpoint = hydratableExecutionCheckpoint({
      events: await sessionDb.listEvents("test-session"),
      sessionId: "test-session",
      profileId: "test"
    });
    if (checkpoint === undefined) throw new Error("Expected a persisted execution checkpoint.");
    controller.hydrate(checkpoint);
  } else {
    await controller.ensure({
      originTurnId: "turn-one",
      originalObjective: "Import and verify the API specification",
      qualificationReasons: ["cross_system", "verified_mutation"],
      selectedSkillName: "api-integration",
      taskClass: "general",
      intentLabels: ["api.integration"],
      requiredOperations: ["mutation", "verification", "artifact_relay"],
      connectorIds: ["postman"],
      completionFloor: "mutation_with_verification"
    });
  }
  return controller;
}

async function persistedExecutionState(
  sessionDb: SessionDB,
  trajectoryRecorder: TrajectoryRecorder
): Promise<string> {
  return JSON.stringify({
    events: await sessionDb.listEvents("test-session"),
    messages: await sessionDb.listMessages("test-session"),
    trajectory: trajectoryRecorder.snapshot().events
  });
}

function expectNoRawSecrets(serialized: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

describe("summarizeSecurityTarget", () => {
  it("summarizes primary target fields for channel tool progress", () => {
    expect(summarizeSecurityTarget("file.search", { pattern: "import.*python-env|from.*python-env" })).toBe("import.*python-env|from.*python-env");
    expect(summarizeSecurityTarget("web.search", { query: "faster-whisper gateway download" })).toBe("faster-whisper gateway download");
    expect(summarizeSecurityTarget("image.generate", { prompt: "draw a square" })).toBe("draw a square");
    expect(summarizeSecurityTarget("delegate_task", { goal: "audit channel progress rendering" })).toBe("audit channel progress rendering");
  });

  it("uses the first line for large text-like inputs", () => {
    expect(summarizeSecurityTarget("execute_code", { code: "import os\nprint(os.getcwd())" })).toBe("import os");
    expect(summarizeSecurityTarget("file.write", { content: "first line\nsecond line" })).toBe("first line");
  });

  it("preserves command and path precedence", () => {
    expect(summarizeSecurityTarget("terminal.run", { command: "pnpm test", path: "src/app.ts" })).toBe("pnpm test");
    expect(summarizeSecurityTarget("file.read", { path: "src/app.ts", query: "ignored" })).toBe("src/app.ts");
  });
});

describe("ToolExecutor exception containment", () => {
  it("returns structured error when tool throws an uncaught exception", async () => {
    const { executor } = await setupExecutor({
      tools: [createThrowingTool("thrower", "boom")]
    });

    const record = await executor.executeTool({
      tool: "thrower",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution failed: boom");
    expect(record?.result?.metadata).toMatchObject({ reason: "error" });
  });

  it("returns structured cancellation result when signal is pre-aborted", async () => {
    const { executor } = await setupExecutor({
      tools: [createEchoTool("echo")]
    });

    const controller = new AbortController();
    controller.abort();

    const record = await executor.executeTool({
      tool: "echo",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      signal: controller.signal
    });

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution cancelled.");
    expect(record?.result?.metadata).toMatchObject({ reason: "cancelled" });
    expect(record?.settlement).toEqual({
      terminalStatus: "cancelled",
      dispatchState: "not_started",
      sideEffectState: "none"
    });
  });

  it("returns structured cancellation result when signal aborts during execution", async () => {
    let confirmDispatch!: () => void;
    const dispatched = new Promise<void>((resolvePromise) => {
      confirmDispatch = resolvePromise;
    });
    const { executor } = await setupExecutor({
      tools: [
        {
          name: "sleeper",
          description: "sleeps",
          inputSchema: { type: "object", properties: {} },
          riskClass: "read-only-local",
          toolsets: ["core"],
          progressLabel: "sleeping",
          maxResultSizeChars: 1000,
          isAvailable: () => true,
          run: async (_input, context): Promise<ToolResult> => {
            confirmDispatch();
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (context?.signal?.aborted === true) {
              throw new Error("AbortError");
            }
            return { ok: true, content: "done" };
          }
        }
      ]
    });

    const controller = new AbortController();
    const promise = executor.executeTool({
      tool: "sleeper",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      signal: controller.signal
    });

    await dispatched;
    controller.abort();
    const record = await promise;

    expect(record).toBeDefined();
    expect(record?.result?.ok).toBe(false);
    expect(record?.result?.content).toBe("Tool execution cancelled.");
    expect(record?.result?.metadata).toMatchObject({ reason: "cancelled" });
    expect(record?.settlement).toEqual({
      terminalStatus: "cancelled",
      dispatchState: "started",
      sideEffectState: "none"
    });
  });

  it("settles a permanently hanging read at its runtime deadline", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => await new Promise<ToolResult>(() => undefined));
    const tool: RegisteredTool = {
      ...createEchoTool("hanging.read"),
      executionTimeoutMs: 10,
      run
    };
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({ tools: [tool] });

    const record = await executor.executeTool({
      tool: tool.name,
      input: { apiKey: "timeout-secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(run).toHaveBeenCalledOnce();
    expect(record?.settlement).toEqual({
      terminalStatus: "timed_out",
      dispatchState: "started",
      sideEffectState: "none",
      timeoutMs: 10
    });
    expect(record?.result).toMatchObject({
      ok: false,
      metadata: {
        reason: "timeout",
        terminalStatus: "timed_out",
        dispatchState: "started",
        sideEffectState: "none",
        timeoutMs: 10
      }
    });
    expect(JSON.stringify(record?.result)).not.toContain("timeout-secret");
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain("timeout-secret");
  });

  it("waits briefly for trusted abort cleanup before classifying an exclusive resource as unsettled", async () => {
    const tool: RegisteredTool = {
      ...createEchoTool("browser.type"),
      toolsets: ["browser"],
      executionTimeoutMs: 10,
      executionAbortSettlementGraceMs: 100,
      executionConcurrency: {
        mode: "exclusive",
        resourceKey: () => "browser:test-session"
      },
      run: async (_input, context): Promise<ToolResult> => {
        await new Promise<void>((resolvePromise) => {
          context?.signal?.addEventListener("abort", () => {
            setTimeout(resolvePromise, 5);
          }, { once: true });
        });
        return { ok: false, content: "Protected input collection was cancelled." };
      }
    };
    const { executor } = await setupExecutor({ tools: [tool] });

    const record = await executor.executeTool({
      tool: tool.name,
      input: { ref: "@e1", protectedInput: { kind: "one-time-code", purpose: "Sign in" } },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.settlement).toEqual({
      terminalStatus: "timed_out",
      dispatchState: "finished",
      sideEffectState: "none",
      timeoutMs: 10
    });
    expect(record?.result?.metadata).toMatchObject({
      reason: "timeout",
      dispatchState: "finished"
    });
  });

  it("marks a timed-out mutation uncertain and blocks an identical replay", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => await new Promise<ToolResult>(() => undefined));
    const tool: RegisteredTool = {
      ...createEchoTool("mcp.postman.updateCollection"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      executionTimeoutMs: 10,
      run
    };
    const { executor } = await setupExecutor({ tools: [tool] });
    const request = {
      tool: tool.name,
      input: { collectionId: "alpha" },
      trustedWorkspace: true,
      sessionId: "test-session"
    } as const;

    const timedOut = await executor.executeTool(request);
    const replay = await executor.executeTool(request);

    expect(timedOut?.settlement).toEqual({
      terminalStatus: "timed_out",
      dispatchState: "started",
      sideEffectState: "possible",
      timeoutMs: 10
    });
    expect(timedOut?.result?.content).toContain("outcome is uncertain");
    expect(replay).toMatchObject({
      decision: "deny",
      settlement: {
        terminalStatus: "failed",
        dispatchState: "not_started",
        sideEffectState: "none"
      },
      result: {
        ok: false,
        metadata: { reason: "uncertain-mutation-replay" }
      }
    });
    expect(run).toHaveBeenCalledOnce();

    executor.resetPerTurnBudgets();
    const nextTurn = await executor.executeTool(request);
    expect(nextTurn?.settlement?.terminalStatus).toBe("timed_out");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("blocks an identical mutation after the runner reports an unknown outcome", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "mutated" }));
    const tool: RegisteredTool = {
      ...createEchoTool("mcp.postman.updateCollection"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      run
    };
    const { executor } = await setupExecutor({ tools: [tool] });
    const input = { collectionId: "alpha" };

    executor.markMutationOutcomeUncertain(tool.name, input);
    const replay = await executor.executeTool({
      tool: tool.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(replay).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "uncertain-mutation-replay" } }
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not dispatch protected input after its call times out before delivery", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "unexpected" }));
    const tool: RegisteredTool = {
      ...createEchoTool("mcp.postman.createEnvironment"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      protectedArguments: [{ path: "/token", handling: { persistence: "none", sharing: "private" } }],
      capabilityMetadata: { protectedInput: { groupedDelivery: false, sources: ["browser"] } },
      executionTimeoutMs: 5,
      run
    };
    const { executor } = await setupExecutor({ tools: [tool] });
    const execution = await executor.executeTool({
      tool: tool.name,
      input: { token: { protectedInput: { kind: "api-key" } } },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: async (request, consume) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        await consume(new TextEncoder().encode("late-secret"), {
          requestId: "late",
          scope: { profileId: "test", sessionId: "test-session" },
          request,
          signal: new AbortController().signal
        });
        return { status: "delivered", destinationLabel: "late", persisted: false };
      }
    });

    expect(execution?.settlement).toEqual({
      terminalStatus: "timed_out",
      dispatchState: "not_started",
      sideEffectState: "none",
      timeoutMs: 5
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("ToolExecutor MCP read deduplication", () => {
  it("executes one Postman workspace and collection discovery chain per turn", async () => {
    const calls = new Map<string, ReturnType<typeof vi.fn>>();
    const readNames = ["getAuthenticatedUser", "getWorkspaces", "getCollections", "getCollection"];
    const tools = readNames.map((name): RegisteredTool => {
      const run = vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({ name, id: `${name}-confirmed` })
      }));
      calls.set(name, run);
      return {
        name: `mcp.postman.${name}`,
        description: `Postman ${name}`,
        inputSchema: { type: "object", additionalProperties: true },
        riskClass: "read-only-network",
        toolsets: ["mcp"],
        progressLabel: "reading Postman",
        maxResultSizeChars: 12_000,
        isAvailable: () => true,
        run
      };
    });
    const mutationRun = vi.fn(async () => ({ ok: true, content: "updated" }));
    tools.push({
      name: "mcp.postman.updateCollection",
      description: "Update collection",
      inputSchema: { type: "object", additionalProperties: true },
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating Postman",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: mutationRun
    });
    const { executor } = await setupExecutor({ tools });
    const scope = { profileId: "test", sessionId: "test-session" };
    const ledger = new TurnMcpReadLedger(scope);
    const inputs: Record<string, Record<string, unknown>> = {
      getAuthenticatedUser: {},
      getWorkspaces: {},
      getCollections: { workspaceId: "mtn-workspace" },
      getCollection: { collectionId: "mtn-products" }
    };

    for (const name of [...readNames, ...readNames]) {
      await executor.executeTool({
        tool: `mcp.postman.${name}`,
        input: inputs[name]!,
        trustedWorkspace: true,
        sessionId: "test-session",
        readLedger: ledger,
        readLedgerScope: scope
      });
    }

    expect(Object.fromEntries([...calls].map(([name, run]) => [name, run.mock.calls.length]))).toEqual({
      getAuthenticatedUser: 1,
      getWorkspaces: 1,
      getCollections: 1,
      getCollection: 1
    });

    await executor.executeTool({
      tool: "mcp.postman.updateCollection",
      input: { collectionId: "mtn-products", name: "MTN Products" },
      trustedWorkspace: true,
      sessionId: "test-session",
      readLedger: ledger,
      readLedgerScope: scope
    });
    await executor.executeTool({
      tool: "mcp.postman.getCollection",
      input: inputs.getCollection!,
      trustedWorkspace: true,
      sessionId: "test-session",
      readLedger: ledger,
      readLedgerScope: scope
    });

    expect(mutationRun).toHaveBeenCalledTimes(1);
    expect(calls.get("getCollection")).toHaveBeenCalledTimes(2);
  });
});

describe("ToolExecutor delegate call budget", () => {
  it("skips excess budgeted delegate_task calls and records skipped metadata", async () => {
    let calls = 0;
    const delegateTool: RegisteredTool = {
      name: "delegate_task",
      description: "delegate",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" }
        },
        required: ["task"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "delegating",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run: async () => {
        calls += 1;
        return { ok: true, content: "delegated" };
      }
    };
    const { executor, sessionDb } = await setupExecutor({
      tools: [delegateTool]
    });
    const delegateCallBudget = new DelegateCallBudget(1);

    const first = await executor.executeTool({
      tool: "delegate_task",
      input: { task: "A" },
      trustedWorkspace: true,
      sessionId: "test-session",
      delegateCallBudget
    });
    const second = await executor.executeTool({
      tool: "delegate_task",
      input: { task: "B" },
      trustedWorkspace: true,
      sessionId: "test-session",
      delegateCallBudget
    });

    expect(calls).toBe(1);
    expect(first?.result?.ok).toBe(true);
    expect(second).toMatchObject({
      decision: "deny",
      result: {
        ok: false,
        metadata: {
          reason: "delegate-call-limit",
          status: "skipped",
          limit: 1,
          skippedCount: 1
        }
      }
    });
    await expect(sessionDb.listMessages("test-session")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        metadata: expect.objectContaining({
          tool: "delegate_task",
          reason: "delegate-call-limit",
          skippedCount: 1,
          limit: 1
        })
      })
    ]));
  });

  it("does not consume delegate call budget for invalid delegate_task input", async () => {
    let calls = 0;
    const delegateTool: RegisteredTool = {
      name: "delegate_task",
      description: "delegate",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" }
        },
        required: ["task"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "delegating",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run: async () => {
        calls += 1;
        return { ok: true, content: "delegated" };
      }
    };
    const { executor } = await setupExecutor({ tools: [delegateTool] });
    const delegateCallBudget = new DelegateCallBudget(1);

    const invalid = await executor.executeTool({
      tool: "delegate_task",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      delegateCallBudget
    });
    const valid = await executor.executeTool({
      tool: "delegate_task",
      input: { task: "A" },
      trustedWorkspace: true,
      sessionId: "test-session",
      delegateCallBudget
    });

    expect(invalid).toMatchObject({
      decision: "deny",
      result: {
        ok: false,
        content: "Invalid tool input: missing required field 'task'"
      }
    });
    expect(valid?.result?.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not apply provider-turn delegate budget to direct tool execution", async () => {
    let calls = 0;
    const delegateTool: RegisteredTool = {
      name: "delegate_task",
      description: "delegate",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" }
        },
        required: ["task"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "delegating",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run: async () => {
        calls += 1;
        return { ok: true, content: "delegated" };
      }
    };
    const { executor } = await setupExecutor({ tools: [delegateTool] });

    const first = await executor.executeTool({
      tool: "delegate_task",
      input: { task: "A" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });
    const second = await executor.executeTool({
      tool: "delegate_task",
      input: { task: "B" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(first?.result?.ok).toBe(true);
    expect(second?.result?.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not apply delegate call budget to unrelated tools", async () => {
    const { executor } = await setupExecutor({
      tools: [createEchoTool("echo")]
    });
    const delegateCallBudget = new DelegateCallBudget(0);

    const result = await executor.executeTool({
      tool: "echo",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      delegateCallBudget
    });

    expect(result?.result?.ok).toBe(true);
  });
});

describe("ToolExecutor input redaction", () => {
  it("redacts sensitive keys in session events", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      provider: "openai",
      apiKey: "sk-secret123",
      api_key: "sk-secret456",
      password: "hunter2",
      token: "tok-abc",
      secret: "shh",
      credential: "creds",
      nested: {
        apiKey: "nested-secret"
      }
    };

    await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const events = await sessionDb.listEvents("test-session");
    const toolCalled = events.find((e) => e.kind === "tool-called");
    expect(toolCalled).toBeDefined();
    expect(toolCalled?.kind === "tool-called" ? toolCalled.input : undefined).toMatchObject({
      provider: "openai",
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      password: "[REDACTED]",
      token: "[REDACTED]",
      secret: "[REDACTED]",
      credential: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]"
      }
    });
    expectNoRawSecrets(JSON.stringify(events), [
      "sk-secret123",
      "sk-secret456",
      "hunter2",
      "tok-abc",
      "nested-secret"
    ]);
  });

  it("does not mutate the original input passed to tool.run", async () => {
    const { executor } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      provider: "openai",
      apiKey: "sk-secret123"
    };

    const record = await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.result?.ok).toBe(true);
    expect(record?.result?.content).toContain("sk-secret123");
    expect(input.apiKey).toBe("sk-secret123");
  });

  it("redacts sensitive keys in trajectory records", async () => {
    const { executor, trajectoryRecorder } = await setupExecutor({
      tools: [createSensitiveEchoTool("setup")]
    });

    const input = {
      apiKey: "sk-secret123"
    };

    await executor.executeTool({
      tool: "setup",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const trajectory = trajectoryRecorder.snapshot();
    const toolCallEvent = trajectory.events.find((e) => e.kind === "tool-call");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent?.data).toMatchObject({
      tool: "setup",
      input: {
        apiKey: "[REDACTED]"
      }
    });
  });

  it("granularly redacts secret-bearing web.extract URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://x.test/?token=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("token=secret");
    expect(trajectory).not.toContain("token=secret");
    expect(persisted).toContain("https://x.test/?token=[REDACTED]");
    expect(trajectory).toContain("https://x.test/?token=[REDACTED]");
  });

  it("granularly redacts secret-bearing browser.navigate URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("browser.navigate")]
    });

    await executor.executeTool({
      tool: "browser.navigate",
      input: { url: "https://x.test/?api_key=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("api_key=secret");
    expect(trajectory).not.toContain("api_key=secret");
    expect(persisted).toContain("https://x.test/?api_key=[REDACTED]");
    expect(trajectory).toContain("https://x.test/?api_key=[REDACTED]");
  });

  it("granularly redacts secret-bearing web.crawl URLs before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.crawl")]
    });

    await executor.executeTool({
      tool: "web.crawl",
      input: { url: "https://x.test/?key=secret" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("key=secret");
    expect(trajectory).not.toContain("key=secret");
    expect(persisted).toContain("https://x.test/?key=[REDACTED]");
    expect(trajectory).toContain("https://x.test/?key=[REDACTED]");
  });

  it.each([
    ["token URL", { url: "https://x.test/?token=secret" }, ["token=secret"]],
    ["password URL", { url: "https://x.test/?password=secret" }, ["password=secret"]],
    ["client secret URL", { url: "https://x.test/?client_secret=secret" }, ["client_secret=secret"]],
    ["access token URL", { url: "https://x.test/?access_token=secret" }, ["access_token=secret"]],
    ["userinfo URL", { url: "https://user:pass@x.test/path" }, ["user:pass"]],
    ["authorization bearer text", { note: "Authorization: Bearer secret" }, ["Bearer secret"]],
    ["nested params URL", { params: { url: "https://x.test/?password=secret" } }, ["password=secret"]]
  ])("redacts %s before any execution persistence", async (_label, input, secrets) => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input,
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, secrets);
    expect(persisted).toContain("[REDACTED]");
  });

  it("preserves surrounding markdown while redacting persisted tool-result secrets", async () => {
    const markdownTool: RegisteredTool = {
      ...createEchoTool("file.read"),
      run: async (): Promise<ToolResult> => ({
        ok: true,
        content: [
          "# Extraction",
          "",
          "Visible paragraph stays available for replay.",
          "OPENAI_API_KEY=markdown-secret-value",
          "Next paragraph also stays available."
        ].join("\n")
      })
    };
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [markdownTool]
    });

    await executor.executeTool({
      tool: "file.read",
      input: { path: "notes.md" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expect(persisted).not.toContain("markdown-secret-value");
    expect(persisted).toContain("Visible paragraph stays available for replay.");
    expect(persisted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(persisted).toContain("Next paragraph also stays available.");
  });

  it("preserves .env and JSON structure around redacted persisted secrets", async () => {
    const structuredTool: RegisteredTool = {
      ...createEchoTool("file.read"),
      run: async (): Promise<ToolResult> => ({
        ok: true,
        content: [
          "APP_NAME=estacoda",
          "SERVICE_TOKEN=env-secret-value",
          "{\"safe\":\"keep-me\",\"client_secret\":\"json-secret-value\",\"nested\":{\"apiKey\":\"nested-secret-value\"}}"
        ].join("\n")
      })
    };
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [structuredTool]
    });

    await executor.executeTool({
      tool: "file.read",
      input: { path: ".env.example" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["env-secret-value", "json-secret-value", "nested-secret-value"]);
    expect(persisted).toContain("APP_NAME=estacoda");
    expect(persisted).toContain("SERVICE_TOKEN=[REDACTED]");
    expect(persisted).toContain("\\\"safe\\\":\\\"keep-me\\\"");
    expect(persisted).toContain("\\\"client_secret\\\":\\\"[REDACTED]\\\"");
    expect(persisted).toContain("\\\"apiKey\\\":\\\"[REDACTED]\\\"");
  });

  it("redacts provider-native JSON argument strings across persisted events and messages", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });
    const providerNativeToolCall = {
      id: "call-provider-secret",
      type: "function",
      function: {
        name: "web.extract",
        arguments: JSON.stringify({
          url: "https://x.test/?token=secret",
          params: {
            url: "https://x.test/?password=secret"
          },
          note: "Authorization: Bearer secret"
        })
      }
    };

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page" },
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-stable-secret",
      toolCallName: "web.extract",
      providerNativeToolCall
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["token=secret", "password=secret", "Bearer secret"]);
    expect(persisted).toContain("call-provider-secret");
    expect(persisted).toContain("web.extract");
    expect(persisted).toContain("https://x.test/?token=[REDACTED]");
    expect(persisted).toContain("https://x.test/?password=[REDACTED]");
    expect(persisted).toContain("Authorization: Bearer [REDACTED]");
  });

  it("strips ambiguous provider-native argument strings before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page" },
      trustedWorkspace: true,
      sessionId: "test-session",
      providerNativeToolCall: {
        id: "call-provider-ambiguous",
        type: "function",
        function: {
          name: "web.extract",
          arguments: "url=https://x.test/?token=secret"
        }
      }
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["token=secret", "url=https://x.test"]);
    expect(persisted).toContain("[REDACTED_PROVIDER_ARGUMENTS]");
  });

  it("redacts provider-native payloads on validation-error persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createRequiredUrlTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: 42 },
      trustedWorkspace: true,
      sessionId: "test-session",
      providerNativeToolCall: {
        id: "call-provider-validation",
        type: "function",
        function: {
          name: "web.extract",
          arguments: JSON.stringify({
            url: "https://x.test/?access_token=secret"
          })
        }
      }
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expectNoRawSecrets(persisted, ["access_token=secret"]);
    expect(persisted).toContain("call-provider-validation");
    expect(persisted).toContain("https://x.test/?access_token=[REDACTED]");
  });

  it("redacts Runtime.evaluate expressions before persistence", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("browser.cdp")]
    });

    await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Runtime.evaluate",
        params: {
          expression: "fetch('https://x.test/?token=secret')"
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).not.toContain("fetch");
    expect(trajectory).not.toContain("fetch");
    expect(persisted).toContain("[REDACTED_CDP_EXPRESSION]");
    expect(trajectory).toContain("[REDACTED_CDP_EXPRESSION]");
  });

  it("redacts Runtime.callFunctionOn function declarations before persistence", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createEchoTool("browser.cdp")]
    });

    await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Runtime.callFunctionOn",
        params: {
          functionDeclaration: "function () { return 'https://x.test/?token=secret'; }"
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    expect(persisted).not.toContain("function ()");
    expect(persisted).not.toContain("token=secret");
    expect(persisted).toContain("[REDACTED_CDP_EXPRESSION]");
  });

  it("keeps safe inputs readable in persisted records", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("web.extract")]
    });

    await executor.executeTool({
      tool: "web.extract",
      input: { url: "https://example.test/page", maxContentChars: 1000 },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    const trajectory = JSON.stringify(trajectoryRecorder.snapshot().events);
    expect(persisted).toContain("https://example.test/page");
    expect(trajectory).toContain("https://example.test/page");
  });
});

describe("ToolExecutor tool-call metadata persistence", () => {
  it("retains grounded resource relationships from actual tool results before a runtime restart", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const controller = await createCheckpointController(sessionDb);
    const pageUrl = "https://catalog.example.com/exact-route-73#/v2";
    const sha256 = "b".repeat(64);
    const receipts: Array<[string, Record<string, unknown>]> = [
      ["browser.extract", { links: [{ text: "Product B", href: pageUrl }, { text: "Product C", href: "https://catalog.example.com/other-90" }] }],
      ["browser.download", { outcome: "download-completed", pageUrl, artifactId: "artifact-b", sha256 }],
      ["mcp.catalog.import", { _estacoda_continuity_facts: [
        { field: "artifactId", value: "artifact-b", kind: "identifier" },
        { field: "artifactHash", value: sha256, kind: "identifier" },
        { field: "resourceId", value: "destination-b", kind: "identifier" }
      ] }]
    ];
    const tools: RegisteredTool[] = receipts.map(([name, metadata]) => ({
      ...createEchoTool(name), riskClass: "read-only-network",
      toolsets: name.startsWith("browser.") ? ["browser"] : ["mcp"],
      ...(name.startsWith("mcp.") ? { connector: { kind: "mcp" as const, id: "catalog" } } : {}),
      run: async () => ({ ok: true, content: "bounded receipt", metadata })
    }));
    const { executor } = await setupExecutor({ sessionDb, createSession: false, tools, executionCheckpointController: controller });
    const retain = controller.retainResources.bind(controller);
    vi.spyOn(controller, "retainResources").mockImplementationOnce(async (revision, rows) => {
      // Another completed read wins the revision while a source receipt is being saved.
      await controller.retainFacts(revision, [{ kind: "workspace_id", value: "concurrent-workspace",
        sourceTool: "mcp.catalog.read", connectorId: "catalog", observedAt: new Date().toISOString() }]);
      return await retain(revision, rows);
    });
    for (const tool of tools) {
      const record = await executor.executeTool({ tool: tool.name, input: {}, trustedWorkspace: true, sessionId: "test-session" });
      expect(record?.result?.ok).toBe(true);
    }
    const resumed = await createCheckpointController(sessionDb, { hydrate: true });
    expect(resumed.current()!.safeFacts).toEqual(expect.arrayContaining([expect.objectContaining({ value: "concurrent-workspace" })]));
    expect(resumed.current()!.resources).toMatchObject([
      { name: "Product B", sourceUrl: pageUrl, artifactReferences: [{ id: "artifact-b", sha256 }], destinationFacts: [{ kind: "resource_id", value: "destination-b", connectorId: "catalog" }] },
      { name: "Product C", artifactReferences: [], destinationFacts: [] }
    ]);
  });
  it("retains only reviewed safe facts across runtime recreation", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const controller = await createCheckpointController(sessionDb);
    const secret = "sk-fact-secret-1234567890";
    const read: RegisteredTool = {
      ...createEchoTool("mcp.postman.getWorkspaceAndCollection"),
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      run: async () => ({
        ok: true,
        content: "reviewed lookup complete",
        metadata: {
          _estacoda_continuity_facts: [
            { field: "workspaceId", value: "workspace-1", kind: "identifier" },
            { field: "collectionId", value: "collection-1", kind: "identifier" },
            { field: "workspaceId", value: secret, kind: "identifier" },
            { field: "arbitraryField", value: "must-not-be-retained", kind: "identifier" }
          ]
        }
      })
    };
    const { executor } = await setupExecutor({
      tools: [read],
      sessionDb,
      createSession: false,
      executionCheckpointController: controller
    });

    await executor.executeTool({
      tool: read.name,
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one",
      toolCallId: "read-identifiers"
    });
    const resumed = await createCheckpointController(sessionDb, { hydrate: true });

    expect(resumed.current()?.safeFacts).toEqual([
      expect.objectContaining({ kind: "workspace_id", value: "workspace-1" }),
      expect.objectContaining({ kind: "collection_id", value: "collection-1" })
    ]);
    const persistedEvents = await sessionDb.listEvents("test-session");
    const persisted = JSON.stringify(persistedEvents);
    const checkpointEvents = JSON.stringify(persistedEvents.filter((event) => event.kind === "execution-checkpoint-updated"));
    expect(persisted).not.toContain(secret);
    expect(checkpointEvents).not.toContain("must-not-be-retained");
  });

  it("persists dispatch before mutation, verifies uncertain recovery, and keeps different updates possible", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const firstController = await createCheckpointController(sessionDb);
    let retryAllowed = false;
    let destinationPresent = false;
    let observedDispatchedBeforeRun = false;
    let activeController = firstController;
    const secret = "sk-journal-secret-1234567890";
    const secretHash = createHash("sha256").update(secret).digest("hex");
    const runMutation = vi.fn(async (): Promise<ToolResult> => {
      observedDispatchedBeforeRun = activeController.current()?.operations.some((operation) =>
        operation.status === "dispatched"
      ) === true;
      if (!retryAllowed) return await new Promise<ToolResult>(() => undefined);
      return { ok: true, content: "imported" };
    });
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.importSpec"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      executionTimeoutMs: 10,
      operationJournal: {
        identify: (input) => ({
          destinationId: String(input.workspaceId),
          subjectId: String(input.productId),
          artifactHash: String(input.artifactHash),
          operationRevision: Number(input.operationRevision ?? 1)
        })
      },
      run: runMutation
    };
    const verifier: RegisteredTool = {
      ...createEchoTool("mcp.postman.getImportedSpec"),
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      capabilityMetadata: { verification: { verifies: [mutation.name] } },
      operationJournal: {
        identify: () => undefined,
        verify: (input) => ({
          destinationId: String(input.workspaceId),
          subjectId: String(input.productId),
          artifactHash: String(input.artifactHash),
          operationRevision: Number(input.operationRevision ?? 1),
          outcome: destinationPresent ? "present" : "absent"
        })
      },
      run: async () => ({ ok: true, content: destinationPresent ? "present" : "absent" })
    };
    const first = await setupExecutor({
      tools: [mutation, verifier],
      sessionDb,
      createSession: false,
      executionCheckpointController: firstController
    });
    const input = {
      workspaceId: "workspace-1",
      productId: "loans-v2",
      artifactHash: "a".repeat(64),
      operationRevision: 1,
      apiKey: secret
    };

    const interrupted = await first.executor.executeTool({
      tool: mutation.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one",
      toolCallId: "import-interrupted"
    });

    expect(observedDispatchedBeforeRun).toBe(true);
    expect(interrupted?.settlement).toMatchObject({ terminalStatus: "timed_out", sideEffectState: "possible" });
    expect(firstController.current()?.operations).toEqual([
      expect.objectContaining({ status: "uncertain", destinationId: "workspace-1", subjectId: "loans-v2" })
    ]);
    expect(firstController.current()?.operations[0]?.id).toBe(executionCheckpointOperationId({
      connectorId: "postman",
      operation: mutation.name,
      destinationId: "workspace-1",
      subjectId: "loans-v2",
      artifactHash: "a".repeat(64),
      operationRevision: 1
    }));

    const resumedController = await createCheckpointController(sessionDb, { hydrate: true });
    activeController = resumedController;
    const resumed = await setupExecutor({
      tools: [mutation, verifier],
      sessionDb,
      createSession: false,
      executionCheckpointController: resumedController
    });
    const replay = await resumed.executor.executeTool({
      tool: mutation.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "import-replay"
    });
    expect(replay).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "uncertain-mutation-replay", operationStatus: "uncertain" } }
    });

    await resumed.executor.executeTool({
      tool: verifier.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "verify-absent"
    });
    expect(resumedController.current()?.operations[0]?.status).toBe("failed");

    retryAllowed = true;
    const retried = await resumed.executor.executeTool({
      tool: mutation.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "import-retry"
    });
    expect(retried).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(resumedController.current()?.operations[0]?.status).toBe("settled");

    destinationPresent = true;
    await resumed.executor.executeTool({
      tool: verifier.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "verify-present"
    });
    expect(resumedController.current()?.operations[0]?.status).toBe("verified");
    const verifiedReplay = await resumed.executor.executeTool({
      tool: mutation.name,
      input,
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "import-after-verification"
    });
    expect(verifiedReplay).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "completed-mutation-replay", operationStatus: "verified" } }
    });

    const differentUpdate = await resumed.executor.executeTool({
      tool: mutation.name,
      input: { ...input, productId: "payments-v1" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-two",
      toolCallId: "import-different-product"
    });
    expect(differentUpdate).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(runMutation).toHaveBeenCalledTimes(3);

    const persisted = JSON.stringify(await sessionDb.listEvents("test-session"));
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(secretHash);
    expect(persisted).not.toContain(semanticMutationKey(mutation.name, input));
  });

  it("returns one coherent blocker when an uncertain mutation has no reliable verifier", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const firstController = await createCheckpointController(sessionDb);
    const run = vi.fn(async (): Promise<ToolResult> => await new Promise<ToolResult>(() => undefined));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.destination.publish"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "destination" },
      executionTimeoutMs: 10,
      operationJournal: {
        identify: (input) => ({ destinationId: String(input.destinationId), subjectId: String(input.subjectId) })
      },
      run
    };
    const first = await setupExecutor({
      tools: [mutation],
      sessionDb,
      createSession: false,
      executionCheckpointController: firstController
    });
    const request = {
      tool: mutation.name,
      input: { destinationId: "workspace-1", subjectId: "loans-v2" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one"
    } as const;
    await first.executor.executeTool(request);

    const resumedController = await createCheckpointController(sessionDb, { hydrate: true });
    const resumed = await setupExecutor({
      tools: [mutation],
      sessionDb,
      createSession: false,
      executionCheckpointController: resumedController
    });
    const blocked = await resumed.executor.executeTool({ ...request, visibleTurnId: "turn-two" });

    expect(blocked).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "uncertain-mutation-replay" } }
    });
    expect(blocked?.result?.content).toContain("No reliable verifier or idempotency mechanism is registered");
    expect(run).toHaveBeenCalledOnce();
  });

  it("journals and dispatches an artifact mutation identified by an opaque UUID", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const controller = await createCheckpointController(sessionDb);
    const artifactId = "1274c0c6-6a48-440d-a707-9198d9fa5c35";
    const artifactHash = "a".repeat(64);
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "spec created" }));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.createSpec"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      operationJournal: {
        identify: () => ({ subjectId: artifactId, artifactHash, operationRevision: 1 })
      },
      run
    };
    const { executor } = await setupExecutor({
      tools: [mutation],
      sessionDb,
      createSession: false,
      executionCheckpointController: controller
    });

    const execution = await executor.executeTool({
      tool: mutation.name,
      input: { artifact: { reference: `artifact://${artifactId}`, sha256: artifactHash } },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one",
      toolCallId: "create-spec"
    });

    expect(execution).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(run).toHaveBeenCalledOnce();
    expect(controller.current()?.operations).toEqual([
      expect.objectContaining({ subjectId: artifactId, artifactHash, status: "settled" })
    ]);
  });

  it("does not dispatch a checkpointed mutation when its declared journal identity is unsafe", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const controller = await createCheckpointController(sessionDb);
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "must not run" }));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.importSpec"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      operationJournal: { identify: () => ({ destinationId: "password=hunter2" }) },
      run
    };
    const { executor } = await setupExecutor({
      tools: [mutation],
      sessionDb,
      createSession: false,
      executionCheckpointController: controller
    });

    const blocked = await executor.executeTool({
      tool: mutation.name,
      input: { workspaceId: "workspace-1" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one"
    });

    expect(blocked).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "operation-journal-unavailable" } }
    });
    expect(run).not.toHaveBeenCalled();
    expect(controller.current()?.operations).toEqual([]);
  });

  it("applies a runtime-owned live authentication gate after security without dispatching a mutation", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "must not run" }));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.updateCollection"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      run
    };
    const { executor, sessionDb } = await setupExecutor({ tools: [mutation] });

    const execution = await executor.executeTool({
      tool: mutation.name,
      input: { collectionId: "collection-1" },
      trustedWorkspace: true,
      sessionId: "test-session",
      runtimeAdmissionGuard: ({ executionEffect }) => executionEffect?.kind === "mutation"
        ? {
            code: "authentication-live-state-required",
            reason: "Complete and verify the live authentication challenge first."
          }
        : undefined
    });

    expect(execution).toMatchObject({
      decision: "deny",
      settlement: { dispatchState: "not_started", sideEffectState: "none" },
      result: { metadata: { reason: "authentication-live-state-required", runtimeAdmissionBlocked: true } }
    });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(await sessionDb.listEvents("test-session"))).toContain("authentication-live-state-required");
  });

  it("does not let a terminal checkpoint govern later unrelated mutations", async () => {
    const sessionDb: SessionDB = new InMemorySessionDB();
    await sessionDb.createSession({ profileId: "test", id: "test-session" });
    const controller = await createCheckpointController(sessionDb);
    await controller.prepareForTurn("cancel");
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "updated" }));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.unrelatedUpdate"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      operationJournal: { identify: () => ({ destinationId: "password=hunter2" }) },
      run
    };
    const { executor } = await setupExecutor({
      tools: [mutation],
      sessionDb,
      createSession: false,
      executionCheckpointController: controller
    });

    const execution = await executor.executeTool({
      tool: mutation.name,
      input: { target: "unrelated" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-after-cancel"
    });

    expect(execution).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(run).toHaveBeenCalledOnce();
  });

  it("blocks equivalent successful mutations until verification and after verified completion", async () => {
    const runMutation = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "created" }));
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.createCollection"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      resolveSecurity: (input) => ({
        riskClass: "external-side-effect",
        targetKey: `collection:${String(input.collectionId)}`,
        targetSummary: `Collection ${String(input.collectionId)}`
      }),
      run: runMutation
    };
    const verifier: RegisteredTool = {
      ...createEchoTool("mcp.postman.getCollection"),
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      capabilityMetadata: { verification: { verifies: [mutation.name] } },
      resolveSecurity: (input) => ({
        riskClass: "read-only-network",
        targetKey: `collection:${String(input.collectionId)}`,
        targetSummary: `Collection ${String(input.collectionId)}`
      })
    };
    const { executor } = await setupExecutor({ tools: [mutation, verifier] });
    const request = {
      tool: mutation.name,
      input: { collectionId: "loans-v2", collection: { name: "Loans v2" } },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one"
    };

    const created = await executor.executeTool({ ...request, toolCallId: "call-create" });
    const pendingReplay = await executor.executeTool({ ...request, toolCallId: "call-replay-pending" });
    const verified = await executor.executeTool({
      tool: verifier.name,
      input: { collectionId: "loans-v2" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one",
      toolCallId: "call-verify"
    });
    const verifiedReplay = await executor.executeTool({ ...request, toolCallId: "call-replay-verified" });

    expect(created).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(pendingReplay).toMatchObject({
      decision: "deny",
      completedReplayOf: "call-create",
      result: { metadata: { reason: "completed-mutation-replay", operationStatus: "verification-required" } }
    });
    expect(pendingReplay?.result?.content).toContain("already succeeded");
    expect(pendingReplay?.result?.content).toContain("registered independent verification tool");
    expect(verified).toMatchObject({ decision: "allow", result: { ok: true } });
    expect(verifiedReplay).toMatchObject({
      decision: "deny",
      result: { metadata: { reason: "completed-mutation-replay", operationStatus: "verified" } }
    });
    expect(runMutation).toHaveBeenCalledTimes(1);

    const evidence = new ExecutionEvidenceIndex();
    for (const record of [created, pendingReplay, verified, verifiedReplay]) {
      expect(record).toBeDefined();
      if (record !== undefined) evidence.record(record, "turn-one");
    }
    const restored = new ExecutionEvidenceIndex();
    restored.hydrate(evidence.recordsForTurn("turn-one"));
    expect(deriveExecutionFinalOutcome({
      toolExecutions: [], executionReceipts: restored.recordsForTurn("turn-one"),
      completionFloor: "mutation_with_verification"
    }).status).toBe("completed_with_recovered_errors");

    await executor.executeTool({
      ...request,
      visibleTurnId: "turn-two",
      toolCallId: "call-next-turn"
    });
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  it("does not apply connector operation replay policy to ordinary local mutations", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "done" }));
    const tool: RegisteredTool = {
      ...createEchoTool("local.update"),
      riskClass: "workspace-write",
      toolsets: ["files"],
      run
    };
    const { executor } = await setupExecutor({ tools: [tool] });
    const request = {
      tool: tool.name,
      input: { path: "notes.txt", content: "same" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visibleTurnId: "turn-one"
    };

    const first = await executor.executeTool({ ...request, toolCallId: "local-first" });
    const second = await executor.executeTool({ ...request, toolCallId: "local-second" });

    expect(first?.decision).toBe("allow");
    expect(second?.decision).toBe("allow");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves trusted execution effects without projecting capability metadata into tool definitions", async () => {
    const mutation: RegisteredTool = {
      ...createEchoTool("mcp.postman.updateCollection"),
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      operationJournal: { identify: () => ({ subjectId: "collection-alpha" }) },
      resolveSecurity: () => ({
        riskClass: "external-side-effect",
        targetKey: "collection:alpha",
        targetSummary: "Collection Alpha"
      })
    };
    const verifier: RegisteredTool = {
      ...createEchoTool("mcp.postman.getCollection"),
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      connector: { kind: "mcp", id: "postman" },
      capabilityMetadata: { verification: { verifies: [mutation.name] } },
      executionConcurrency: {
        mode: "exclusive",
        resourceKey: (_input, context) => `postman:${context.sessionId}`
      },
      executionTimeoutMs: 1_234,
      resolveSecurity: () => ({
        riskClass: "read-only-network",
        targetKey: "collection:alpha",
        targetSummary: "Collection Alpha"
      })
    };
    const { executor } = await setupExecutor({ tools: [mutation, verifier] });

    const mutationExecution = await executor.executeTool({
      tool: mutation.name,
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-update"
    });
    const verificationExecution = await executor.executeTool({
      tool: verifier.name,
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-verify"
    });

    expect(mutationExecution).toMatchObject({
      tool: { name: mutation.name, connector: { kind: "mcp", id: "postman" } },
      targetKey: "collection:alpha",
      targetSummary: "Collection Alpha",
      executionEffect: {
        kind: "mutation",
        connector: { kind: "mcp", id: "postman" }
      }
    });
    expect(verificationExecution).toMatchObject({
      executionEffect: {
        kind: "verification",
        verifies: [mutation.name],
        connector: { kind: "mcp", id: "postman" }
      }
    });
    expect(executor.getToolDefinition(verifier.name)).not.toHaveProperty("capabilityMetadata");
    expect(executor.getToolDefinition(verifier.name)).not.toHaveProperty("executionConcurrency");
    expect(executor.getToolDefinition(verifier.name)).not.toHaveProperty("executionTimeoutMs");
    expect(executor.getToolDefinition(mutation.name)).not.toHaveProperty("operationJournal");
    expect(executor.getToolExecutionConcurrency(verifier.name, {}, "test-session")).toEqual({
      mode: "exclusive",
      resourceKey: "postman:test-session"
    });
  });

  it("fails closed when a trusted execution resource resolver cannot produce a key", async () => {
    const tool: RegisteredTool = {
      ...createEchoTool("browser.snapshot"),
      executionConcurrency: {
        mode: "exclusive",
        resourceKey: () => {
          throw new Error("unresolved browser session");
        }
      }
    };
    const { executor } = await setupExecutor({ tools: [tool] });

    expect(executor.getToolExecutionConcurrency(tool.name, {}, "test-session")).toEqual({
      mode: "exclusive",
      resourceKey: "runtime:unresolved-exclusive-resource"
    });
  });

  it.each(["envelope", "plaintext"])("collects a declared protected argument from %s input and scrubs tool echoes", async (mode) => {
    const sentinel = "declared-tool-sentinel-secret";
    const observed: unknown[] = [];
    const tool: RegisteredTool = {
      ...createEchoTool("trusted.api.call"),
      protectedArguments: [{ path: "/auth/token", handling: { persistence: "none", sharing: "private" } }],
      capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: ["browser"] } },
      run: async (input) => {
        observed.push(input);
        return { ok: true, content: `remote echoed ${String(input.auth?.token)}`, metadata: { echoed: input.auth?.token } };
      }
    };
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({ tools: [tool] });
    const execution = await executor.executeTool({
      tool: tool.name,
      input: {
        auth: {
          token: mode === "plaintext" ? "discarded-model-literal" : { protectedInput: { kind: "access-token", purpose: "Authenticate trusted API" } }
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: async (request, consume) => {
        expect(request.destination).toEqual({ type: "tool-argument", toolName: tool.name, argumentPath: "/auth/token" });
        const value = new TextEncoder().encode(sentinel);
        try {
          await consume(value, {
            requestId: "request",
            scope: { profileId: "test", sessionId: "test-session" },
            request,
            signal: new AbortController().signal
          });
        } finally {
          value.fill(0);
        }
        return { status: "delivered", destinationLabel: "Trusted tool argument", persisted: false };
      }
    });

    expect(observed).toEqual([{ auth: { token: sentinel } }]);
    expect(execution?.result).toEqual({
      ok: true,
      content: "remote echoed [PROTECTED_INPUT]",
      metadata: { echoed: "[PROTECTED_INPUT]" }
    });
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain(sentinel);
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain("discarded-model-literal");
    expect(JSON.stringify(execution)).not.toContain("discarded-model-literal");
  });

  it("dispatches a protected argument from browser source metadata without invoking ordinary collection", async () => {
    const sentinel = "browser-relay-sentinel";
    const run = vi.fn(async (input: Record<string, unknown>): Promise<ToolResult> => ({
      ok: true,
      content: `stored ${String((input.auth as Record<string, unknown>).token)}`,
    }));
    const tool: RegisteredTool = {
      ...createEchoTool("trusted.browser-relay"),
      protectedArguments: [{ path: "/auth/token", handling: { persistence: "none", sharing: "private" } }],
      capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: ["browser"] } },
      run,
    };
    const handler = vi.fn() as unknown as SecureInputTransferRequestHandler;
    handler.requestGroup = vi.fn();
    handler.transfer = vi.fn(async (transfer, consume) => {
      expect(transfer.source).toEqual({
        type: "browser-field",
        sessionId: "browser-1",
        ref: "@e4",
        identity: { documentEpoch: 3, actionRevision: 7, observationId: 9 },
        expectedOrigin: "https://portal.example.com",
        tabRef: "@t1",
      });
      const bytes = new TextEncoder().encode(sentinel);
      try {
        await consume(bytes, {
          requestId: "transfer-1",
          scope: { profileId: "profile", sessionId: "test-session" },
          request: transfer.request,
          signal: new AbortController().signal,
        });
      } finally {
        bytes.fill(0);
      }
      return { status: "delivered" as const, destinationLabel: "auth.token for trusted.browser-relay", persisted: false };
    });
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({ tools: [tool] });

    const execution = await executor.executeTool({
      tool: tool.name,
      input: {
        auth: {
          token: {
            protectedInput: {
              kind: "access-token",
              purpose: "Configure destination auth",
              source: {
                type: "browser-field",
                sessionId: "browser-1",
                ref: "@e4",
                identity: { documentEpoch: 3, actionRevision: 7, observationId: 9 },
                expectedOrigin: "https://portal.example.com",
                tabRef: "@t1",
              },
            },
          },
        },
      },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(handler.transfer).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({ auth: { token: sentinel } }, expect.objectContaining({
      onSecureInputRequest: undefined,
    }));
    expect(execution?.result).toEqual({
      ok: true,
      content: "Protected value transferred to auth.token for trusted.browser-relay. Verify the destination state with a separate read.",
      metadata: { protectedTransfer: true },
    });
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain(sentinel);
  });

  it.each(["browser", "user"])("dispatches two protected %s values once and preserves the sanitized destination receipt", async (sourceMode) => {
    const secrets = ["grouped-key-sentinel", "grouped-secret-sentinel"];
    const run = vi.fn(async (input: Record<string, unknown>): Promise<ToolResult> => ({
      ok: true,
      content: JSON.stringify({ environment: { id: "environment-fixture" }, echoed: input }),
      metadata: { _estacoda_continuity_facts: [{ field: "environmentId", value: "environment-fixture", kind: "identifier" }] },
    }));
    const tool: RegisteredTool = {
      ...createEchoTool("mcp.postman.createEnvironment"),
      protectedArguments: [
        {
          path: "/environment/values/*/value",
          handling: { persistence: "destination-managed", sharing: "workspace" },
        }
      ],
      capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: ["browser"] } },
      run
    };
    const handler = vi.fn() as unknown as SecureInputTransferRequestHandler;
    handler.requestGroup = vi.fn();
    handler.transfer = vi.fn();
    handler.transferGroup = vi.fn(async (group: SecureInputTransferGroupRequest, consume: SecureInputTransferGroupConsumer) => {
      expect(group.items.map((item) => item.request.destination)).toEqual([
        { type: "tool-argument", toolName: tool.name, argumentPath: "/environment/values/0/value" },
        { type: "tool-argument", toolName: tool.name, argumentPath: "/environment/values/1/value" },
      ]);
      expect(group.items.every((item) => item.handling?.sharing === "workspace")).toBe(true);
      const bytes = secrets.map((secret) => new TextEncoder().encode(secret));
      try {
        await consume(bytes.map((value, index) => ({
          id: `argument-${index + 1}`,
          value,
          context: {
            requestId: `group-${index + 1}`,
            scope: { profileId: "profile", sessionId: "test-session" },
            request: group.items[index]!.request,
            signal: new AbortController().signal,
          },
        })));
      } finally {
        bytes.forEach((value) => value.fill(0));
      }
      return {
        status: "delivered" as const,
        items: group.items.map((item) => ({
          id: item.id,
          receipt: { status: "delivered" as const, destinationLabel: tool.name, persisted: true },
        })),
      };
    });
    handler.collectGroup = handler.transferGroup as SecureInputTransferRequestHandler["collectGroup"];
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({ tools: [tool] });
    const browserSource = (ref: string) => ({
      type: "browser-field" as const,
      sessionId: "browser-1",
      ref,
      identity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
      expectedOrigin: "https://portal.example.com",
      tabRef: "@t1",
    });
    const execution = await executor.executeTool({
      tool: tool.name,
      input: {
        workspace: "workspace-fixture",
        environment: {
          name: "Service credentials",
          values: [
            {
              enabled: true,
              key: "service_client_id",
              type: "secret",
              value: { protectedInput: { kind: "api-key", ...(sourceMode === "browser" ? { source: browserSource("@e1") } : {}) } },
            },
            {
              enabled: true,
              key: "service_client_secret",
              type: "secret",
              value: { protectedInput: { kind: "client-secret", ...(sourceMode === "browser" ? { source: browserSource("@e2") } : {}) } },
            },
          ],
        },
      },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: handler,
    });
    expect(handler.transferGroup).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      workspace: "workspace-fixture",
      environment: {
        name: "Service credentials",
        values: [
          { enabled: true, key: "service_client_id", type: "secret", value: secrets[0] },
          { enabled: true, key: "service_client_secret", type: "secret", value: secrets[1] },
        ],
      },
    }, expect.objectContaining({ onSecureInputRequest: undefined }));
    expect(execution?.result).toMatchObject({
      ok: true,
      content: expect.stringContaining("environment-fixture"),
      metadata: { protectedTransfer: true, protectedValueCount: 2,
        _estacoda_continuity_facts: [{ field: "environmentId", value: "environment-fixture", kind: "identifier" }] },
    });
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain(secrets[0]);
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain(secrets[1]);
  });

  it("surfaces all grouped protected-source failures with safe structured metadata", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "unexpected" }));
    const tool: RegisteredTool = {
      ...createEchoTool("mcp.postman.createEnvironment"),
      protectedArguments: [{
        path: "/environment/values/*/value",
        handling: { persistence: "destination-managed", sharing: "workspace" },
      }],
      capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: ["browser"] } },
      run,
    };
    const handler = vi.fn() as unknown as SecureInputTransferRequestHandler;
    handler.requestGroup = vi.fn();
    handler.transfer = vi.fn();
    handler.transferGroup = vi.fn(async () => ({
      status: "failed" as const,
      items: [],
      reason: "Protected transfer could not start:\n- argument-1: source-empty\n- argument-2: tab-mismatch",
      failure: {
        code: "protected-source-validation" as const,
        phase: "before-authorization" as const,
        sources: [
          { id: "argument-1", reason: "source-empty" as const },
          { id: "argument-2", reason: "tab-mismatch" as const },
        ],
      },
    }));
    const source = (ref: string) => ({
      type: "browser-field" as const,
      sessionId: "browser-1",
      ref,
      identity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
      expectedOrigin: "https://portal.example.com",
      tabRef: "@t1",
    });
    const { executor } = await setupExecutor({ tools: [tool] });

    const execution = await executor.executeTool({
      tool: tool.name,
      input: {
        environment: {
          values: [
            { value: { protectedInput: { kind: "api-key", source: source("@e1") } } },
            { value: { protectedInput: { kind: "client-secret", source: source("@e2") } } },
          ],
        },
      },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: handler,
    });

    expect(run).not.toHaveBeenCalled();
    expect(execution?.result).toEqual({
      ok: false,
      content: "Protected transfer could not start:\n- argument-1: source-empty\n- argument-2: tab-mismatch",
      metadata: {
        reason: "protected-tool-argument-unavailable",
        protectedSourceFailure: {
          code: "protected-source-validation",
          phase: "before-authorization",
          sources: [
            { id: "argument-1", reason: "source-empty" },
            { id: "argument-2", reason: "tab-mismatch" },
          ],
        },
      },
    });
    expect(JSON.stringify(execution?.result)).not.toContain("portal.example.com");
  });

  it("enforces registered grouped-delivery and browser-relay capabilities before collection", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "unexpected" }));
    const browserSource = (ref: string) => ({
      type: "browser-field" as const,
      sessionId: "browser-1",
      ref,
      identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
      expectedOrigin: "https://portal.example.com",
      tabRef: "@t1"
    });
    const groupedTool: RegisteredTool = {
      ...createEchoTool("trusted.no-group"),
      protectedArguments: [{
        path: "/values/*/value",
        handling: { persistence: "destination-managed", sharing: "workspace" }
      }],
      capabilityMetadata: { protectedInput: { groupedDelivery: false, sources: ["browser"] } },
      run
    };
    const browserTool: RegisteredTool = {
      ...createEchoTool("trusted.no-browser"),
      protectedArguments: [{ path: "/token", handling: { persistence: "none", sharing: "private" } }],
      capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: [] } },
      run
    };
    const { executor } = await setupExecutor({ tools: [groupedTool, browserTool] });

    const grouped = await executor.executeTool({
      tool: groupedTool.name,
      input: {
        values: [
          { value: { protectedInput: { kind: "api-key", source: browserSource("@e1") } } },
          { value: { protectedInput: { kind: "client-secret", source: browserSource("@e2") } } }
        ]
      },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: vi.fn()
    });
    const browser = await executor.executeTool({
      tool: browserTool.name,
      input: { token: { protectedInput: { kind: "api-key", source: browserSource("@e3") } } },
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest: vi.fn()
    });

    expect(grouped?.result).toMatchObject({ ok: false, content: expect.stringContaining("Grouped") });
    expect(browser?.result).toMatchObject({ ok: false, content: expect.stringContaining("browser-source") });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects undeclared and ambiguously declared protected envelopes before dispatch", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "unexpected" }));
    const source = {
      type: "browser-field" as const,
      sessionId: "browser-1",
      ref: "@e1",
      identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
      expectedOrigin: "https://portal.example.com",
    };
    for (const protectedArguments of [
      [{ path: "/other", handling: { persistence: "unknown" as const, sharing: "unknown" as const } }],
      [
        { path: "/values/*/value", handling: { persistence: "unknown" as const, sharing: "unknown" as const } },
        { path: "/values/*/value", handling: { persistence: "none" as const, sharing: "private" as const } },
      ],
    ]) {
      const tool: RegisteredTool = {
        ...createEchoTool("trusted.invalid-group"),
        protectedArguments,
        capabilityMetadata: { protectedInput: { groupedDelivery: true, sources: ["browser"] } },
        run
      };
      const { executor } = await setupExecutor({ tools: [tool] });
      const execution = await executor.executeTool({
        tool: tool.name,
        input: { values: [{ value: { protectedInput: { kind: "api-key", source } } }] },
        trustedWorkspace: true,
        sessionId: "test-session",
        onSecureInputRequest: vi.fn(),
      });
      expect(execution?.result?.ok).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("passes secure-input coordination independently from approval", async () => {
    const onSecureInputRequest = vi.fn(async () => ({
      status: "delivered" as const,
      destinationLabel: "Verified destination",
      persisted: false
    }));
    const tool: RegisteredTool = {
      ...createEchoTool("protected-input-tool"),
      run: async (_input, context) => {
        expect(context?.onApprovalRequest).toBeUndefined();
        expect(context?.onSecureInputRequest).toBe(onSecureInputRequest);
        const receipt = await context!.onSecureInputRequest!({
          kind: "api-key",
          purpose: "Authenticate request",
          destination: {
            type: "tool-argument",
            toolName: "protected-input-tool",
            argumentPath: "credential"
          },
          retention: "use-once"
        }, async () => undefined);
        return { ok: receipt.status === "delivered", content: JSON.stringify(receipt) };
      }
    };
    const { executor } = await setupExecutor({ tools: [tool] });

    const execution = await executor.executeTool({
      tool: "protected-input-tool",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      onSecureInputRequest
    });

    expect(onSecureInputRequest).toHaveBeenCalledOnce();
    expect(execution?.result?.content).toContain("Verified destination");
  });

  it("persists only the safe protected-input descriptor under credential-shaped keys", async () => {
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({
      tools: [createEchoTool("protected-input-metadata")]
    });

    await executor.executeTool({
      tool: "protected-input-metadata",
      input: {
        credential: {
          ref: "@password",
          protectedInput: {
            kind: "password",
            purpose: "Sign in",
            retention: "use-once",
            value: "must-never-persist"
          },
          unexpected: "also-must-not-persist"
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const persisted = await persistedExecutionState(sessionDb, trajectoryRecorder);
    expect(persisted).toContain("@password");
    expect(persisted).toContain("Sign in");
    expect(persisted).not.toContain("must-never-persist");
    expect(persisted).not.toContain("also-must-not-persist");
  });

  it("rejects plaintext and protected input in the same envelope", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "must not run" }));
    const { executor } = await setupExecutor({
      tools: [{ ...createEchoTool("protected-input-conflict"), run }]
    });

    const execution = await executor.executeTool({
      tool: "protected-input-conflict",
      input: {
        credential: {
          text: "plaintext-secret",
          protectedInput: { kind: "password" }
        }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(execution?.decision).toBe("deny");
    expect(execution?.result?.content).toContain("cannot include a plaintext 'text' value");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the stable tool-call identity into the tool handler context", async () => {
    let observedToolCallId: string | undefined;
    const tool: RegisteredTool = {
      ...createEchoTool("stateful"),
      run: async (_input, context) => {
        observedToolCallId = context?.toolCallId;
        return { ok: true, content: "done" };
      }
    };
    const { executor } = await setupExecutor({ tools: [tool] });

    await executor.executeTool({
      tool: "stateful",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "provider-call-stable"
    });

    expect(observedToolCallId).toBe("provider-call-stable");
  });

  it("persists stable tool-call metadata on tool events and tool result messages", async () => {
    const { executor, sessionDb } = await setupExecutor({
      tools: [createEchoTool("echo")]
    });
    const providerNativeToolCall = {
      id: "call-provider-1",
      type: "function",
      function: {
        name: "echo"
      }
    };

    await executor.executeTool({
      tool: "echo",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    });

    const events = await sessionDb.listEvents("test-session");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-called",
      tool: "echo",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "echo",
      toolCallId: "call-stable-1",
      toolCallName: "echo",
      providerNativeToolCall
    }));

    const messages = await sessionDb.listMessages("test-session");
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata).toMatchObject({
      tool: "echo",
      tool_call_id: "call-stable-1",
      tool_call_name: "echo",
      provider_native_tool_call: providerNativeToolCall
    });
  });

  it("persists redacted tool context summary metadata on tool result messages", async () => {
    const contextTool: RegisteredTool = {
      ...createEchoTool("context-tool"),
      run: async (): Promise<ToolResult> => ({
        ok: true,
        content: "result",
        metadata: {
          _estacoda_context_summary: "Read file with token sk-secret1234567890abcdef"
        }
      })
    };
    const { executor, sessionDb } = await setupExecutor({
      tools: [contextTool]
    });

    await executor.executeTool({
      tool: "context-tool",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const messages = await sessionDb.listMessages("test-session");
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata?._estacoda_context_summary).toBe("Read file with token [REDACTED]");
    expect(JSON.stringify(toolMessage)).not.toContain("sk-secret1234567890abcdef");
  });

  it("ignores non-string tool context summary metadata on tool result messages", async () => {
    const contextTool: RegisteredTool = {
      ...createEchoTool("context-tool"),
      run: async (): Promise<ToolResult> => ({
        ok: true,
        content: "result",
        metadata: {
          _estacoda_context_summary: 123
        } as unknown as ToolResult["metadata"]
      })
    };
    const { executor, sessionDb } = await setupExecutor({
      tools: [contextTool]
    });

    await executor.executeTool({
      tool: "context-tool",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    const messages = await sessionDb.listMessages("test-session");
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.metadata).not.toHaveProperty("_estacoda_context_summary");
  });
});

describe("ToolExecutor command environment", () => {
  it("passes explicit backend environmentType into command safety and tool context", async () => {
    let observedRequest: SecurityRequest | undefined;
    const policy: SecurityPolicy = {
      decide() {
        return "allow";
      },
      assess(request) {
        observedRequest = request;
        return {
          decision: "allow",
          mode: "adaptive",
          reason: "test",
          risk: "medium"
        };
      }
    };
    const { executor } = await setupExecutor({
      policy,
      tools: [createTerminalEchoTool()]
    });

    const record = await executor.executeTool({
      tool: "terminal.run",
      input: { command: "sudo apt update" },
      trustedWorkspace: true,
      sessionId: "test-session",
      environmentType: "docker"
    });

    expect(record?.decision).toBe("allow");
    expect(record?.riskClass).toBe("workspace-write");
    expect(record?.result?.content).toBe("environment=docker");
    expect(observedRequest?.environmentType).toBe("docker");
  });

  it("ignores environmentType supplied inside tool input", async () => {
    let observedRequest: SecurityRequest | undefined;
    const policy: SecurityPolicy = {
      decide() {
        return "allow";
      },
      assess(request) {
        observedRequest = request;
        return {
          decision: "deny",
          mode: "adaptive",
          reason: "test",
          risk: "high"
        };
      }
    };
    const { executor } = await setupExecutor({
      policy,
      tools: [createTerminalEchoTool()]
    });

    const record = await executor.executeTool({
      tool: "terminal.run",
      input: { command: "sudo apt update", environmentType: "docker" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.decision).toBe("deny");
    expect(record?.result).toBeUndefined();
    expect(observedRequest?.environmentType).toBe("host");
    expect(observedRequest?.riskClass).toBe("destructive-local");
  });

  it("requires an exact operator approval before reading a browser profile database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "estacoda-browser-profile-approval-"));
    try {
      const controller = new WorkspaceApprovalController({
        store: new WorkspaceApprovalStore({ path: join(directory, "approvals.json") })
      });
      const policy: SecurityPolicy = {
        decide: (request) => capabilityFirstDefaults.decide(request),
        assess: async (request) => await controller.assess(capabilityFirstDefaults, request, {
          workspaceRoot: process.cwd(),
          sessionId: "test-session",
          mode: "strict"
        })
      };
      const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "history inspected" }));
      const { executor } = await setupExecutor({
        policy,
        tools: [{ ...createTerminalEchoTool(), run }]
      });
      const input = {
        command: 'sqlite3 "$HOME/Library/Application Support/Google/Chrome/Default/History" "select url from urls"'
      };

      const approved = await executor.executeTool({
        tool: "terminal.run",
        input,
        trustedWorkspace: true,
        sessionId: "test-session",
        onApprovalRequest: async (request) => {
          expect(run).not.toHaveBeenCalled();
          expect(request.riskClass).toBe("credential-access");
          await controller.grant({
            workspaceRoot: process.cwd(),
            sessionId: "test-session",
            toolName: request.tool.name,
            riskClass: request.riskClass,
            targetKey: request.targetKey,
            targetSummary: request.targetSummary,
            scope: "once"
          });
          return "approved";
        }
      });
      const withoutAnotherApproval = await executor.executeTool({
        tool: "terminal.run",
        input,
        trustedWorkspace: true,
        sessionId: "test-session"
      });

      expect(approved?.decision).toBe("allow");
      expect(approved?.riskClass).toBe("credential-access");
      expect(withoutAnotherApproval?.decision).toBe("ask");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ToolExecutor browser CDP gating", () => {
  it("requires approval for raw browser.cdp even when the default policy allows other active external side effects", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "ran" }));
    const cdpTool: RegisteredTool = {
      name: "browser.cdp",
      description: "raw cdp",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          params: { type: "object" }
        },
        required: ["method"]
      },
      riskClass: "external-side-effect",
      toolsets: ["dangerous"],
      progressLabel: "running cdp",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run
    };
    const { executor } = await setupExecutor({
      policy: capabilityFirstDefaults,
      tools: [cdpTool]
    });

    const record = await executor.executeTool({
      tool: "browser.cdp",
      input: {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "Enter" }
      },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(record?.decision).toBe("ask");
    expect(run).not.toHaveBeenCalled();
  });

  it("resumes the exact browser.cdp call once after an in-turn approval", async () => {
    let approved = false;
    const run = vi.fn(async (_input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
      expect(context?.onApprovalRequest).toBeUndefined();
      return { ok: true, content: "ran once" };
    });
    const policy: SecurityPolicy = {
      decide: () => approved ? "allow" : "ask",
      assess: (request) => ({
        decision: approved ? "allow" : "ask",
        mode: "adaptive",
        reason: approved ? "Exact call approved." : "Raw CDP requires approval.",
        risk: request.riskClass === "external-side-effect" ? "medium" : "high"
      })
    };
    const cdpTool: RegisteredTool = {
      name: "browser.cdp",
      description: "raw cdp",
      inputSchema: { type: "object", properties: { method: { type: "string" } }, required: ["method"] },
      riskClass: "external-side-effect",
      toolsets: ["dangerous"],
      progressLabel: "running cdp",
      maxResultSizeChars: 1000,
      isAvailable: () => true,
      run
    };
    const { executor } = await setupExecutor({ policy, tools: [cdpTool] });
    const onApprovalRequest = vi.fn(async (request) => {
      expect(request.tool.name).toBe("browser.cdp");
      expect(request.input).toEqual({ method: "Runtime.evaluate" });
      approved = true;
      return "approved" as const;
    });

    const record = await executor.executeTool({
      tool: "browser.cdp",
      input: { method: "Runtime.evaluate" },
      trustedWorkspace: true,
      sessionId: "test-session",
      onApprovalRequest
    });

    expect(onApprovalRequest).toHaveBeenCalledOnce();
    expect(record?.decision).toBe("allow");
    expect(record?.result?.content).toBe("ran once");
    expect(run).toHaveBeenCalledOnce();
  });

  it("binds a one-time grant to the redacted security target and consumes it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "estacoda-tool-approval-"));
    try {
      const controller = new WorkspaceApprovalController({
        store: new WorkspaceApprovalStore({ path: join(directory, "approvals.json") })
      });
      const basePolicy: SecurityPolicy = { decide: () => "ask" };
      const policy: SecurityPolicy = {
        decide: (request) => basePolicy.decide(request),
        assess: async (request) => await controller.assess(basePolicy, request, {
          workspaceRoot: process.cwd(),
          sessionId: "test-session",
          mode: "adaptive"
        })
      };
      const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "extracted" }));
      const { executor } = await setupExecutor({
        policy,
        tools: [{ ...createRequiredUrlTool("web.extract"), run }]
      });
      const secret = "approval-secret";
      const input = { url: `https://example.test/page?token=${secret}` };

      const approved = await executor.executeTool({
        tool: "web.extract",
        input,
        trustedWorkspace: true,
        sessionId: "test-session",
        onApprovalRequest: async (request) => {
          expect(request.targetKey).not.toContain(secret);
          await controller.grant({
            workspaceRoot: process.cwd(),
            sessionId: "test-session",
            toolName: request.tool.name,
            riskClass: request.riskClass,
            targetKey: request.targetKey,
            targetSummary: request.targetSummary,
            scope: "once"
          });
          return "approved";
        }
      });
      const second = await executor.executeTool({
        tool: "web.extract",
        input,
        trustedWorkspace: true,
        sessionId: "test-session"
      });

      expect(approved?.decision).toBe("allow");
      expect(second?.decision).toBe("ask");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not run an in-turn call when the operator denies approval", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "must not run" }));
    const askPolicy: SecurityPolicy = {
      decide: () => "ask"
    };
    const tool = { ...createEchoTool("approval.test"), run };
    const { executor } = await setupExecutor({ policy: askPolicy, tools: [tool] });

    const record = await executor.executeTool({
      tool: "approval.test",
      input: { value: "one" },
      trustedWorkspace: true,
      sessionId: "test-session",
      onApprovalRequest: async () => "denied"
    });

    expect(record?.decision).toBe("deny");
    expect(record?.result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("never invokes the approval handler for a policy denial", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "must not run" }));
    const onApprovalRequest = vi.fn(async () => "approved" as const);
    const { executor } = await setupExecutor({
      policy: createMockPolicy("deny"),
      tools: [{ ...createEchoTool("hardline.test"), run }]
    });

    const record = await executor.executeTool({
      tool: "hardline.test",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session",
      onApprovalRequest
    });

    expect(record?.decision).toBe("deny");
    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("ToolExecutor dynamic data-egress security", () => {
  it("keeps ephemeral image bytes out of sessions, trajectories, and exported records", async () => {
    const encodedPayload = "cGVyc2lzdGVuY2Utc2VudGluZWw=";
    const tool: RegisteredTool = {
      ...createEchoTool("vision.analyze"),
      run: async () => attachEphemeralVisionImages({ ok: true, content: "prepared image" }, [{
        content: { type: "image_url", image_url: { url: `data:image/png;base64,${encodedPayload}` } },
        usage: { width: 1, height: 1, detail: "auto" },
        delivery: "continuation"
      }])
    };
    const { executor, sessionDb, trajectoryRecorder } = await setupExecutor({ tools: [tool] });

    const record = await executor.executeTool({
      tool: "vision.analyze",
      input: { path: "image.png" },
      trustedWorkspace: true,
      sessionId: "test-session"
    });

    expect(ephemeralVisionImages(record?.result)).toHaveLength(1);
    expect(await persistedExecutionState(sessionDb, trajectoryRecorder)).not.toContain(encodedPayload);
    expect(JSON.stringify(record)).not.toContain(encodedPayload);
  });

  it("uses runtime-derived provenance and the dynamic hosted destination before running", async () => {
    let observedRequest: SecurityRequest | undefined;
    const run = vi.fn(async (_input, context): Promise<ToolResult> => ({
      ok: true,
      content: context?.securityResolution?.dataEgress?.sourceProvenance ?? "missing"
    }));
    const tool: RegisteredTool = {
      ...createEchoTool("vision.analyze"),
      resolveSecurity: vi.fn((_input, context) => ({
        riskClass: "external-side-effect" as const,
        targetKey: "vision.analyze:hosted-egress:openai",
        targetSummary: "send image to openai",
        dataEgress: {
          kind: "vision-image" as const,
          inference: "hosted" as const,
          sourceProvenance: context.visionInputProvenance?.attachmentPaths.includes("/media/image.png")
            ? "current-turn-attachment" as const
            : "agent-discovered" as const,
          sensitivePath: false,
          destinations: ["openai@https://api.openai.com/v1"]
        }
      })),
      run
    };
    const policy: SecurityPolicy = {
      decide: () => "allow",
      assess(request) {
        observedRequest = request;
        return { decision: "allow", mode: "adaptive", reason: "test", risk: "low" };
      }
    };
    const { executor } = await setupExecutor({ policy, tools: [tool] });

    const record = await executor.executeTool({
      tool: "vision.analyze",
      input: { path: "/media/image.png" },
      trustedWorkspace: true,
      sessionId: "test-session",
      visionInputProvenance: {
        attachmentPaths: ["/media/image.png"],
        explicitReferencePaths: []
      }
    });

    expect(observedRequest).toMatchObject({
      riskClass: "external-side-effect",
      targetKey: "vision.analyze:hosted-egress:openai",
      context: {
        dataEgress: { sourceProvenance: "current-turn-attachment" }
      }
    });
    expect(record).toMatchObject({
      decision: "allow",
      riskClass: "external-side-effect",
      result: { content: "current-turn-attachment" }
    });
  });

  it("fails closed when dynamic security resolution throws", async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "unsafe" }));
    const tool: RegisteredTool = {
      ...createEchoTool("vision.analyze"),
      resolveSecurity: () => {
        throw new Error("provenance unavailable");
      },
      run
    };
    const { executor } = await setupExecutor({ tools: [tool] });
    const record = await executor.executeTool({
      tool: "vision.analyze",
      input: {},
      trustedWorkspace: true,
      sessionId: "test-session"
    });
    expect(record).toMatchObject({ decision: "deny", targetSummary: "dynamic tool security preflight failed" });
    expect(run).not.toHaveBeenCalled();
  });
});
