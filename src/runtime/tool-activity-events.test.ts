import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import { SkillPlaybookRunner } from "./skill-playbook-runner.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";
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
  };
}

function execution(overrides?: Partial<ToolExecutionRecord>): ToolExecutionRecord {
  return {
    tool: fileReadTool,
    input: { path: "src/app.ts" },
    decision: "allow",
    riskClass: "read-only-local",
    targetSummary: "src/app.ts",
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
  it("forwards target summaries from provider tool plans", async () => {
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
        executeTool: vi.fn().mockResolvedValue(execution()),
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
});
