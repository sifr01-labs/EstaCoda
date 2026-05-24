import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import { SkillWorkflowExecutor } from "./skill-workflow-executor.js";
import { ToolPlanRunner } from "./tool-plan-runner.js";

const fileReadTool: ToolDefinition = {
  name: "file.read",
  description: "Read a file",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["files"],
  progressLabel: "read",
  maxResultSizeChars: 1_000,
};

function runRecorder() {
  return {
    recordToolPlan: vi.fn(),
    recordClassifiedFailure: vi.fn(),
    recordSecurityRiskEscalation: vi.fn(),
    recordWorkflowStep: vi.fn(),
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

function intent(overrides?: Partial<Parameters<SkillWorkflowExecutor["executeSkillWorkflow"]>[0]["intent"]>): Parameters<SkillWorkflowExecutor["executeSkillWorkflow"]>[0]["intent"] {
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

    expect(events).toContainEqual({
      kind: "tool-start",
      tool: "file.read",
      targetSummary: "src/app.ts",
      activityId: "tc1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool-result",
      tool: "file.read",
      targetSummary: "src/app.ts",
      ok: true,
      activityId: "tc1",
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

    expect(events).toContainEqual({
      kind: "tool-result",
      tool: "file.read",
      ok: false,
      targetSummary: "src/app.ts",
      activityId: "tc1",
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

  it("forwards target summaries from skill workflow tools", async () => {
    const events: RuntimeEvent[] = [];
    const executor = new SkillWorkflowExecutor({
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
      workflow: [{ id: "read", description: "Read a URL", preferredTool: "file.read" }],
      permissionExpectations: [],
      examples: [],
      evaluations: [],
    };

    await executor.executeSkillWorkflow({
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

  it("settles skill workflow starts when preferred execution is unavailable", async () => {
    const events: RuntimeEvent[] = [];
    const executor = new SkillWorkflowExecutor({
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
      workflow: [{ id: "read", description: "Read a URL", preferredTool: "file.read" }],
      permissionExpectations: [],
      examples: [],
      evaluations: [],
    };

    await executor.executeSkillWorkflow({
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
      targetSummary: undefined,
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
});
