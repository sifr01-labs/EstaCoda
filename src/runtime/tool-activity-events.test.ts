import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import { SkillPlaybookRunner } from "./skill-playbook-runner.js";
import { groupProviderToolPlans, ToolPlanRunner } from "./tool-plan-runner.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { attachEphemeralVisionImages, ephemeralVisionImages } from "../vision/ephemeral-vision-content.js";

const fileReadTool: ToolDefinition = {
  name: "file.read",
  description: "Read a file",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["files"],
  progressLabel: "read",
  maxResultSizeChars: 1_000,
};

const delegateTool: ToolDefinition = {
  name: "delegate_task",
  description: "Delegate",
  inputSchema: {},
  riskClass: "shared-state-mutation",
  toolsets: ["core"],
  progressLabel: "delegate",
  maxResultSizeChars: 1_000,
};

function runRecorder() {
  return {
    recordToolPlan: vi.fn(),
    recordClassifiedFailure: vi.fn(),
    recordSecurityRiskEscalation: vi.fn(),
    recordSkillPlaybookStep: vi.fn(),
    recordExecutionEvidence: vi.fn(),
  };
}

function execution(overrides?: Partial<ToolExecutionRecord>): ToolExecutionRecord {
  const toolCallId = overrides?.toolCallId ?? "tc1";
  return {
    tool: fileReadTool,
    input: { path: "src/app.ts" },
    decision: "allow",
    riskClass: "read-only-local",
    targetSummary: "src/app.ts",
    toolCallId,
    result: { ok: true, content: "ok" },
    ...overrides,
  };
}

function intent(overrides?: Partial<Parameters<SkillPlaybookRunner["runSkillPlaybook"]>[0]["intent"]>): Parameters<SkillPlaybookRunner["runSkillPlaybook"]>[0]["intent"] {
  return {
    nativeIntent: "general",
    labels: ["test"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test",
    ...overrides,
  };
}

function providerExecution(): ProviderExecutionResult {
  return {
    ok: true,
    fallbackUsed: false,
    attempts: [],
    toolCalls: [{}],
  };
}

describe("runtime tool activity events", () => {
  it("keeps plan updates sequential with evidence-producing tool calls", () => {
    const entries = [
      { plan: { id: "read", tool: "file.read" } as never, definition: fileReadTool },
      {
        plan: { id: "plan", tool: "plan" } as never,
        definition: { ...fileReadTool, name: "plan", toolsets: ["core"] }
      },
      { plan: { id: "read-2", tool: "file.read" } as never, definition: fileReadTool }
    ];

    expect(groupProviderToolPlans(entries, 4).map((group) => ({
      concurrent: group.concurrent,
      tools: group.entries.map((entry) => entry.plan.tool)
    }))).toEqual([
      { concurrent: true, tools: ["file.read"] },
      { concurrent: false, tools: ["plan"] },
      { concurrent: true, tools: ["file.read"] }
    ]);
  });

  it("separates concurrent-safe plans that share an exclusive execution resource", () => {
    const browserTool = { ...fileReadTool, name: "browser.download", toolsets: ["browser"] };
    const entries = [
      {
        plan: { id: "download", tool: "browser.download" } as never,
        definition: browserTool,
        concurrency: { mode: "exclusive" as const, resourceKey: "browser:session-1" }
      },
      {
        plan: { id: "switch", tool: "browser.switch_tab" } as never,
        definition: { ...browserTool, name: "browser.switch_tab" },
        concurrency: { mode: "exclusive" as const, resourceKey: "browser:session-1" }
      }
    ];

    expect(groupProviderToolPlans(entries, 4).map((group) =>
      group.entries.map((entry) => entry.plan.tool)
    )).toEqual([
      ["browser.download"],
      ["browser.switch_tab"]
    ]);
  });

  it("keeps concurrent-safe plans for independent execution resources in one batch", () => {
    const browserTool = { ...fileReadTool, name: "browser.snapshot", toolsets: ["browser"] };
    const entries = [
      {
        plan: { id: "snapshot-1", tool: "browser.snapshot" } as never,
        definition: browserTool,
        concurrency: { mode: "exclusive" as const, resourceKey: "browser:session-1" }
      },
      {
        plan: { id: "snapshot-2", tool: "browser.snapshot" } as never,
        definition: browserTool,
        concurrency: { mode: "exclusive" as const, resourceKey: "browser:session-2" }
      }
    ];

    expect(groupProviderToolPlans(entries, 4).map((group) =>
      group.entries.map((entry) => entry.plan.id)
    )).toEqual([["snapshot-1", "snapshot-2"]]);
  });

  it("preserves the configured cap for independent concurrent-safe plans", () => {
    const entries = ["one", "two", "three"].map((id) => ({
      plan: { id, tool: "file.read" } as never,
      definition: fileReadTool
    }));

    expect(groupProviderToolPlans(entries, 2).map((group) =>
      group.entries.map((entry) => entry.plan.id)
    )).toEqual([
      ["one", "two"],
      ["three"]
    ]);
  });

  it("uses resolved execution resources when running provider tool plans", async () => {
    const observedMaximums: number[] = [];

    for (const resourceKeys of [
      ["browser:session-1", "browser:session-1"],
      ["browser:session-1", "browser:session-2"]
    ]) {
      let planIndex = 0;
      let active = 0;
      let maxActive = 0;
      const executeTool = vi.fn(async (request: { tool: string; toolCallId?: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return execution({
          tool: { ...fileReadTool, name: request.tool, toolsets: ["browser"] },
          toolCallId: request.toolCallId,
          input: {}
        });
      });
      const runner = new ToolPlanRunner({
        toolCallPlanner: {
          planFromProviderDelta: () => {
            const index = planIndex++;
            return {
              id: `browser-${index}`,
              tool: index === 0 ? "browser.download" : "browser.switch_tab",
              input: {},
              source: "provider-tool-call",
              status: "planned"
            };
          }
        } as never,
        toolExecutor: {
          getToolDefinition: (name: string) => ({ ...fileReadTool, name, toolsets: ["browser"] }),
          getToolExecutionConcurrency: (_name: string, _input: unknown, _sessionId: string) => ({
            mode: "exclusive",
            resourceKey: resourceKeys[planIndex - 1]!
          }),
          executeTool
        } as never,
        runRecorder: runRecorder() as never,
        sessionId: "s1",
        maxConcurrentSafeTools: 4
      });

      await runner.executePlans({
        providerExecution: { ...providerExecution(), toolCalls: [{}, {}] },
        toolPlans: [],
        trustedWorkspace: true,
        remainingToolCalls: 2,
        riskBaseline: "read-only-local"
      });
      observedMaximums.push(maxActive);
    }

    expect(observedMaximums).toEqual([1, 2]);
  });

  it("does not start another browser operation on a resource with a timed-out call", async () => {
    let planIndex = 0;
    const plans: import("../contracts/tool-plan.js").ToolCallPlan[] = [];
    const executeTool = vi.fn(async (request: { tool: string; toolCallId: string }) => execution({
      tool: { ...fileReadTool, name: request.tool, toolsets: ["browser"] },
      toolCallId: request.toolCallId,
      settlement: {
        terminalStatus: "timed_out",
        dispatchState: "started",
        sideEffectState: "none",
        timeoutMs: 10
      },
      result: { ok: false, content: "Timed out.", metadata: { reason: "timeout" } }
    }));
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => {
          const index = planIndex++;
          return {
            id: index === 0 ? "download" : "switch-tab",
            tool: index === 0 ? "browser.download" : "browser.switch_tab",
            input: { sessionId: "shared-session" },
            source: "provider-tool-call",
            status: "planned"
          };
        }
      } as never,
      toolExecutor: {
        getToolDefinition: (name: string) => ({ ...fileReadTool, name, toolsets: ["browser"] }),
        getToolExecutionConcurrency: () => ({
          mode: "exclusive",
          resourceKey: "browser:shared-session"
        }),
        executeTool
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 4
    });

    const result = await runner.executePlans({
      providerExecution: { ...providerExecution(), toolCalls: [{}, {}] },
      toolPlans: plans,
      trustedWorkspace: true,
      remainingToolCalls: 2,
      riskBaseline: "read-only-local"
    });

    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.executions.map((item) => item.toolCallId)).toEqual(["download"]);
    expect(plans.map((plan) => ({ id: plan.id, status: plan.status, reason: plan.result?.metadata?.reason }))).toEqual([
      { id: "download", status: "executed", reason: "timeout" },
      { id: "switch-tab", status: "blocked", reason: "execution-resource-unsettled" }
    ]);

    runner.resetPerTurnBudgets();
    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local"
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("continues on an exclusive browser resource after aborted input cleanup settles", async () => {
    let planIndex = 0;
    const executeTool = vi.fn(async (request: { tool: string; toolCallId: string }) => execution({
      tool: { ...fileReadTool, name: request.tool, toolsets: ["browser"] },
      toolCallId: request.toolCallId,
      settlement: request.toolCallId === "protected-input"
        ? {
            terminalStatus: "timed_out",
            dispatchState: "finished",
            sideEffectState: "none",
            timeoutMs: 60_000
          }
        : {
            terminalStatus: "completed",
            dispatchState: "finished",
            sideEffectState: "none"
          },
      result: request.toolCallId === "protected-input"
        ? { ok: false, content: "Protected input timed out.", metadata: { reason: "timeout" } }
        : { ok: true, content: "Browser recovered." }
    }));
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => {
          const index = planIndex++;
          return {
            id: index === 0 ? "protected-input" : "snapshot",
            tool: index === 0 ? "browser.type" : "browser.snapshot",
            input: { sessionId: "shared-session" },
            source: "provider-tool-call",
            status: "planned"
          };
        }
      } as never,
      toolExecutor: {
        getToolDefinition: (name: string) => ({ ...fileReadTool, name, toolsets: ["browser"] }),
        getToolExecutionConcurrency: () => ({
          mode: "exclusive",
          resourceKey: "browser:shared-session"
        }),
        executeTool
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 4
    });

    const result = await runner.executePlans({
      providerExecution: { ...providerExecution(), toolCalls: [{}, {}] },
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 2,
      riskBaseline: "read-only-local"
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.executions.map((item) => item.toolCallId)).toEqual(["protected-input", "snapshot"]);
  });

  it("preserves successful sibling receipts when one concurrent execution rejects", async () => {
    let planIndex = 0;
    const recorder = runRecorder();
    const plans: import("../contracts/tool-plan.js").ToolCallPlan[] = [];
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => {
          const index = planIndex++;
          return {
            id: index === 0 ? "rejected-read" : "successful-read",
            tool: "file.read",
            input: { path: index === 0 ? "missing.ts" : "present.ts" },
            source: "provider-tool-call",
            status: "planned"
          };
        }
      } as never,
      toolExecutor: {
        getToolDefinition: () => fileReadTool,
        executeTool: vi.fn(async (request: { toolCallId: string }) => {
          if (request.toolCallId === "rejected-read") throw new Error("unexpected runtime failure");
          return execution({
            toolCallId: request.toolCallId,
            input: { path: "present.ts" },
            result: { ok: true, content: "confirmed sibling" }
          });
        })
      } as never,
      runRecorder: recorder as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 2
    });

    const result = await runner.executePlans({
      providerExecution: { ...providerExecution(), toolCalls: [{}, {}] },
      toolPlans: plans,
      trustedWorkspace: true,
      remainingToolCalls: 2,
      riskBaseline: "read-only-local"
    });

    expect(result.executions).toEqual([
      expect.objectContaining({
        toolCallId: "rejected-read",
        settlement: expect.objectContaining({ dispatchState: "unknown", sideEffectState: "none" }),
        result: expect.objectContaining({ ok: false, metadata: expect.objectContaining({ reason: "tool-execution-unknown" }) })
      }),
      expect.objectContaining({ toolCallId: "successful-read", result: { ok: true, content: "confirmed sibling" } })
    ]);
    expect(plans.map((plan) => ({ id: plan.id, status: plan.status }))).toEqual([
      { id: "rejected-read", status: "executed" },
      { id: "successful-read", status: "executed" }
    ]);
    expect(plans[0]?.error).toContain("did not produce an authoritative result");
    expect(recorder.recordClassifiedFailure).toHaveBeenCalledWith(
      { kind: "tool-execution", execution: result.executions[0] },
      "tool-execution"
    );
  });

  it("keeps a timed-out read beside a successful concurrent receipt", async () => {
    let planIndex = 0;
    const plans: import("../contracts/tool-plan.js").ToolCallPlan[] = [];
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => {
          const index = planIndex++;
          return {
            id: index === 0 ? "timed-out-read" : "successful-read",
            tool: "file.read",
            input: { path: `${index}.ts` },
            source: "provider-tool-call",
            status: "planned"
          };
        }
      } as never,
      toolExecutor: {
        getToolDefinition: () => fileReadTool,
        executeTool: vi.fn(async (request: { toolCallId: string }) => execution({
          toolCallId: request.toolCallId,
          settlement: request.toolCallId === "timed-out-read" ? {
            terminalStatus: "timed_out",
            dispatchState: "started",
            sideEffectState: "none",
            timeoutMs: 10
          } : {
            terminalStatus: "completed",
            dispatchState: "finished",
            sideEffectState: "none"
          },
          result: request.toolCallId === "timed-out-read"
            ? { ok: false, content: "Timed out.", metadata: { reason: "timeout" } }
            : { ok: true, content: "confirmed sibling" }
        }))
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 2
    });

    const result = await runner.executePlans({
      providerExecution: { ...providerExecution(), toolCalls: [{}, {}] },
      toolPlans: plans,
      trustedWorkspace: true,
      remainingToolCalls: 2,
      riskBaseline: "read-only-local"
    });

    expect(result.executions.map((item) => item.toolCallId)).toEqual(["timed-out-read", "successful-read"]);
    expect(plans.map((plan) => ({ status: plan.status, ok: plan.result?.ok }))).toEqual([
      { status: "executed", ok: false },
      { status: "executed", ok: true }
    ]);
  });

  it("forwards target summaries from provider tool plans", async () => {
    const events: RuntimeEvent[] = [];
    const recorder = runRecorder();
    const evidenceIndex = new ExecutionEvidenceIndex();
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => ({
          id: "tc1",
          tool: "file.read",
          input: { path: "src/app.ts" },
          source: "provider-tool-call",
          status: "planned",
        }),
      } as never,
      toolExecutor: {
        getToolDefinition: () => fileReadTool,
        executeTool: vi.fn().mockResolvedValue(execution()),
      } as never,
      runRecorder: recorder as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
      executionEvidenceIndex: evidenceIndex,
    });

    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      visibleTurnId: "turn-current",
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-start",
      tool: "file.read",
      targetSummary: "src/app.ts",
      displayPreview: "src/app.ts",
      activityId: "tc1",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "file.read",
      targetSummary: "src/app.ts",
      displayPreview: "src/app.ts",
      ok: true,
      activityId: "tc1",
    }));
    expect(recorder.recordExecutionEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: "execution-evidence-recorded",
      toolCallId: "tc1",
      tool: "file.read",
      status: "success",
      riskClass: "read-only-local",
      targetSummary: "src/app.ts"
    }));
    expect(evidenceIndex.resolve(["tc1"])).toEqual([expect.objectContaining({
      toolCallId: "tc1",
      tool: "file.read"
    })]);
    expect(evidenceIndex.candidatesForTurn({ visibleTurnId: "turn-current" })).toEqual([
      expect.objectContaining({ toolCallId: "tc1", tool: "file.read" })
    ]);
    expect(evidenceIndex.candidatesForTurn({ visibleTurnId: "turn-earlier" })).toEqual([]);
  });

  it("keeps security summaries separate from compact display previews", async () => {
    const events: RuntimeEvent[] = [];
    const command = "cd app && export CI=true && pnpm test && echo done";
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => ({
          id: "tc1",
          tool: "terminal.run",
          input: { command },
          source: "provider-tool-call",
          status: "planned",
        }),
      } as never,
      toolExecutor: {
        getToolDefinition: () => ({ ...fileReadTool, name: "terminal.run", progressLabel: "run command" }),
        executeTool: vi.fn().mockResolvedValue(execution({
          tool: { ...fileReadTool, name: "terminal.run", progressLabel: "run command" },
          input: { command },
          targetSummary: command,
        })),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
    });

    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-start",
      tool: "terminal.run",
      targetSummary: command,
      displayPreview: "pnpm test",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "terminal.run",
      targetSummary: command,
      displayPreview: "pnpm test",
    }));
  });

  it("settles provider tool starts when execution becomes unavailable", async () => {
    const events: RuntimeEvent[] = [];
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => ({
          id: "tc1",
          tool: "file.read",
          input: { path: "src/app.ts" },
          source: "provider-tool-call",
          status: "planned",
        }),
      } as never,
      toolExecutor: {
        getToolDefinition: () => fileReadTool,
        executeTool: vi.fn().mockResolvedValue(undefined),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
    });

    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "file.read",
      ok: false,
      targetSummary: "src/app.ts",
      displayPreview: "src/app.ts",
      activityId: "tc1",
    }));
  });

  it("records unavailable provider calls from trusted registry resolution", async () => {
    const recorder = runRecorder();
    const evidenceIndex = new ExecutionEvidenceIndex();
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => ({
          id: "tc-missing",
          tool: "mcp.target.update",
          input: {},
          source: "provider-tool-call",
          status: "unavailable",
          error: "Tool is not registered: mcp.target.update",
        }),
      } as never,
      toolExecutor: {} as never,
      runRecorder: recorder as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
      executionEvidenceIndex: evidenceIndex,
    });

    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
      visibleTurnId: "turn-1",
    });

    expect(recorder.recordExecutionEvidence).toHaveBeenCalledWith({
      kind: "execution-evidence-recorded",
      toolCallId: "tc-missing",
      tool: "mcp.target.update",
      status: "unavailable",
      visibleTurnId: "turn-1",
    });
  });

  it("emits failed tool results for invalid provider tool plans", async () => {
    const events: RuntimeEvent[] = [];
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => ({
          id: "tc1",
          tool: "",
          input: {},
          source: "provider-tool-call",
          status: "invalid",
          error: "Provider tool call did not include a tool name.",
        }),
      } as never,
      toolExecutor: {
        getToolDefinition: () => undefined,
        executeTool: vi.fn(),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
    });

    await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual({
      kind: "tool-result",
      tool: "provider-tool",
      ok: false,
      targetSummary: "Provider tool call did not include a tool name.",
      activityId: "tc1",
    });
  });

  it("resets delegate call budgets between provider turns", async () => {
    let planIndex = 0;
    const executeTool = vi.fn(async (request: {
      input: Record<string, unknown>;
      delegateCallBudget?: DelegateCallBudget;
    }) => {
      const budget = request.delegateCallBudget?.tryConsume();
      if (budget?.allowed === false) {
        return execution({
          tool: delegateTool,
          decision: "deny",
          riskClass: "shared-state-mutation",
          result: {
            ok: false,
            content: "delegate_task call skipped",
            metadata: {
              reason: "delegate-call-limit",
              limit: budget.limit,
              skippedCount: budget.skippedCount
            }
          }
        });
      }
      return execution({
        tool: delegateTool,
        input: request.input,
        riskClass: "shared-state-mutation",
        result: { ok: true, content: "delegated" }
      });
    });
    const runner = new ToolPlanRunner({
      toolCallPlanner: {
        planFromProviderDelta: () => {
          planIndex += 1;
          return {
            id: `delegate-${planIndex}`,
            tool: "delegate_task",
            input: { task: `task ${planIndex}` },
            source: "provider-tool-call",
            status: "planned",
          };
        },
      } as never,
      toolExecutor: {
        getToolDefinition: () => delegateTool,
        executeTool,
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
      maxConcurrentSafeTools: 1,
      delegateTaskCallLimit: 1,
    });

    const firstTurn = await runner.executePlans({
      providerExecution: {
        ...providerExecution(),
        toolCalls: [{}, {}],
      },
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 2,
      riskBaseline: "read-only-local",
    });
    runner.resetPerTurnBudgets();
    const secondTurn = await runner.executePlans({
      providerExecution: providerExecution(),
      toolPlans: [],
      trustedWorkspace: true,
      remainingToolCalls: 1,
      riskBaseline: "read-only-local",
    });

    expect(firstTurn.executions.map((item) => item.result?.ok)).toEqual([true, false]);
    expect(firstTurn.executions[1]?.result?.metadata).toMatchObject({
      reason: "delegate-call-limit",
      limit: 1,
      skippedCount: 1
    });
    expect(secondTurn.executions[0]?.result?.ok).toBe(true);
  });

  it("forwards target summaries from skill playbook tools", async () => {
    const events: RuntimeEvent[] = [];
    const executor = new SkillPlaybookRunner({
      toolExecutor: {
        executeTool: vi.fn().mockResolvedValue(execution()),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
    });
    const skill: SkillDefinition = {
      name: "reader",
      description: "Read",
      version: "1.0.0",
      whenToUse: [],
      requiredToolsets: ["files"],
      playbook: [{ id: "read", description: "Read a URL", preferredTool: "file.read" }],
      permissionExpectations: [],
      examples: [],
      evaluations: [],
    };

    await executor.runSkillPlaybook({
      selectedSkill: skill,
      intent: intent(),
      trustedWorkspace: true,
      text: "Read https://example.test/doc",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-start", tool: "file.read", targetSummary: "https://example.test/doc" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-result", tool: "file.read", targetSummary: "src/app.ts", ok: true }));
  });

  it("settles skill playbook starts when preferred execution is unavailable", async () => {
    const events: RuntimeEvent[] = [];
    const executor = new SkillPlaybookRunner({
      toolExecutor: {
        executeTool: vi.fn().mockResolvedValue(undefined),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
    });
    const skill: SkillDefinition = {
      name: "reader",
      description: "Read",
      version: "1.0.0",
      whenToUse: [],
      requiredToolsets: ["files"],
      playbook: [{ id: "read", description: "Read a URL", preferredTool: "file.read" }],
      permissionExpectations: [],
      examples: [],
      evaluations: [],
    };

    await executor.runSkillPlaybook({
      selectedSkill: skill,
      intent: intent(),
      trustedWorkspace: true,
      text: "Read https://example.test/doc",
      onEvent: (event) => {
        events.push(event);
      },
    });

    const activityId = "skill:reader:read:files:file.read";
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-start",
      tool: "file.read",
      activityId,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "file.read",
      ok: false,
      activityId,
    }));
  });

  it("emits native tool results with target summaries", async () => {
    const events: RuntimeEvent[] = [];
    const executor = new NativeToolExecutor({
      toolExecutor: {
        getToolDefinition: () => ({
          ...fileReadTool,
          name: "image.generate",
          progressLabel: "generate image",
        }),
        executeTool: vi.fn().mockResolvedValue(execution({
          tool: { ...fileReadTool, name: "image.generate", progressLabel: "generate image" },
          input: { prompt: "draw a square" },
          targetSummary: undefined,
        })),
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
    });

    await executor.executeDeterministicNativeTools({
      intent: intent({ labels: ["image"], nativeIntent: "image-generation" }),
      text: "draw a square",
      trustedWorkspace: true,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-start",
      tool: "image.generate",
      targetSummary: "draw a square",
      activityId: expect.stringMatching(/^native-image-/),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "image.generate",
      ok: true,
      targetSummary: undefined,
      activityId: expect.stringMatching(/^native-image-/),
    }));
  });

  it("dispatches ready initial images through vision with runtime-only provenance", async () => {
    const result = attachEphemeralVisionImages({ ok: true, content: "prepared" }, [{
      content: { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      usage: { width: 1, height: 1, detail: "auto" },
      delivery: "continuation"
    }]);
    const executeTool = vi.fn().mockResolvedValue(execution({
      tool: { ...fileReadTool, name: "vision.analyze" },
      result
    }));
    const executor = new NativeToolExecutor({
      toolExecutor: {
        getToolDefinition: () => ({ ...fileReadTool, name: "vision.analyze" }),
        executeTool
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1"
    });

    const outcome = await executor.executeDeterministicNativeTools({
      intent: intent({ labels: ["attachment-analysis"], nativeIntent: "attachment-analysis" }),
      text: "What is in this image?",
      attachments: [{
        id: "image-1",
        kind: "image",
        status: "ready",
        localPath: "/media/browser-screenshot.png",
        mimeType: "image/png"
      }],
      trustedWorkspace: true,
      visibleTurnId: "turn-1",
      providerUsageLineage: { executionSessionId: "s1", visibleTurnId: "turn-1" },
      visionInputProvenance: {
        attachmentPaths: ["/media/browser-screenshot.png"],
        explicitReferencePaths: []
      }
    });

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: "vision.analyze",
      input: { path: "/media/browser-screenshot.png", prompt: "What is in this image?" },
      visionDispatchPhase: "initial-attachment",
      visibleTurnId: "turn-1"
    }));
    expect(outcome.plans[0]?.status).toBe("executed");
    expect(ephemeralVisionImages(outcome.executions[0]?.result, "initial")).toHaveLength(1);
  });

  it("dispatches multiple initial images as one bounded vision batch", async () => {
    const result = attachEphemeralVisionImages({ ok: true, content: "prepared" }, [{
      content: { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      usage: { width: 1, height: 1, detail: "auto" },
      delivery: "continuation"
    }]);
    const executeTool = vi.fn().mockResolvedValue(execution({
      tool: { ...fileReadTool, name: "vision.analyze" },
      result
    }));
    const executor = new NativeToolExecutor({
      toolExecutor: {
        getToolDefinition: () => ({ ...fileReadTool, name: "vision.analyze" }),
        executeTool
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1"
    });

    const outcome = await executor.executeDeterministicNativeTools({
      intent: intent({ labels: ["attachment-analysis"], nativeIntent: "attachment-analysis" }),
      text: "Compare these images",
      attachments: ["one.png", "two.png", "three.png"].map((name, index) => ({
        id: `image-${index + 1}`,
        kind: "image" as const,
        status: "ready" as const,
        localPath: `/media/${name}`,
        mimeType: "image/png"
      })),
      trustedWorkspace: true
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: expect.stringMatching(/^native-vision-/u),
      input: {
        paths: ["/media/one.png", "/media/two.png", "/media/three.png"],
        prompt: "Compare these images"
      }
    }));
    expect(outcome.plans).toHaveLength(1);
  });
});
