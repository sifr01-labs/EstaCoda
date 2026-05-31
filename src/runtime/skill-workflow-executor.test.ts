import { describe, expect, it, vi } from "vitest";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { SkillWorkflowExecutor } from "./skill-workflow-executor.js";

function runRecorder() {
  return {
    recordWorkflowStep: vi.fn(),
  };
}

function intent(): Parameters<SkillWorkflowExecutor["executeSkillWorkflow"]>[0]["intent"] {
  return {
    nativeIntent: "general",
    labels: ["test"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test",
  };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: "Test tool",
    inputSchema: {},
    riskClass: "read-only-local",
    toolsets: ["files"],
    progressLabel: "test",
    maxResultSizeChars: 1_000,
  };
}

function execution(toolName: string): ToolExecutionRecord {
  return {
    tool: toolDefinition(toolName),
    input: {},
    decision: "allow",
    riskClass: "read-only-local",
    targetSummary: toolName,
    result: { ok: true, content: "ok" },
  };
}

function skillWithSteps(count: number): SkillDefinition {
  return {
    name: "many-steps",
    description: "Many deterministic steps",
    version: "1.0.0",
    whenToUse: [],
    requiredToolsets: ["files"],
    workflow: Array.from({ length: count }, (_, index) => ({
      id: `step-${index + 1}`,
      description: `Run step ${index + 1}`,
      preferredTool: `test.tool.${index + 1}`,
    })),
    permissionExpectations: [],
    examples: [],
    evaluations: [],
  };
}

describe("SkillWorkflowExecutor execution cap", () => {
  it("continues deterministic skill workflows past four executable steps", async () => {
    const executeTool = vi.fn(async (request: { tool: string }) => execution(request.tool));
    const executor = new SkillWorkflowExecutor({
      toolExecutor: {
        executeTool,
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
    });

    const executions = await executor.executeSkillWorkflow({
      selectedSkill: skillWithSteps(5),
      intent: intent(),
      trustedWorkspace: true,
      text: "run",
    });

    expect(executions).toHaveLength(5);
    expect(executeTool).toHaveBeenCalledTimes(5);
  });

  it("stops deterministic skill workflows at fifty executable steps", async () => {
    const executeTool = vi.fn(async (request: { tool: string }) => execution(request.tool));
    const executor = new SkillWorkflowExecutor({
      toolExecutor: {
        executeTool,
      } as never,
      runRecorder: runRecorder() as never,
      sessionId: "s1",
    });

    const executions = await executor.executeSkillWorkflow({
      selectedSkill: skillWithSteps(60),
      intent: intent(),
      trustedWorkspace: true,
      text: "run",
    });

    expect(executions).toHaveLength(50);
    expect(executeTool).toHaveBeenCalledTimes(50);
  });
});
