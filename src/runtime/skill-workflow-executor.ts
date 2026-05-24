import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition, SkillWorkflowPlan, SkillWorkflowPlanStep, SkillWorkflowStep } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import { compileSkillWorkflowPlan } from "../skills/skill-workflow-planner.js";
import { packetizeToolExecution, renderToolResultPacket } from "../tools/tool-result-packet.js";
import { summarizeSecurityTarget } from "../tools/tool-executor.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import { toolResultFileChangePreview, toolResultStats } from "./tool-plan-runner.js";
import type { RunRecorder } from "./run-recorder.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import { emit, isAborted } from "../utils/runtime-helpers.js";
import { truncate } from "../utils/formatting.js";

export type SkillWorkflowExecutorOptions = {
  toolExecutor: ToolExecutor;
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  runRecorder: RunRecorder;
};

export class SkillWorkflowExecutor {
  readonly #toolExecutor: ToolExecutor;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;
  readonly #runRecorder: RunRecorder;

  constructor(options: SkillWorkflowExecutorOptions) {
    this.#toolExecutor = options.toolExecutor;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
    this.#runRecorder = options.runRecorder;
  }

  async executeSkillWorkflow(input: {
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    intent: IntentRoute;
    trustedWorkspace: boolean;
    text: string;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord[]> {
    if (input.selectedSkill === undefined || input.intent.confirmationRequired) {
      return [];
    }

    const executions: ToolExecutionRecord[] = [];
    const previousResults: string[] = [];
    const usedTools = new Set<string>();
    const plan = compileSkillWorkflowPlan(input.selectedSkill);
    const stepMap = new Map(plan.steps.map((step, index) => [step.id, { step, index }]));
    const visited = new Set<string>();
    let stepIndex = 0;

    while (stepIndex < plan.steps.length && executions.length < 4) {
      if (isAborted(input.signal)) {
        break;
      }
      const step = plan.steps[stepIndex];
      if (step === undefined || visited.has(step.id)) {
        stepIndex += 1;
        continue;
      }
      visited.add(step.id);
      step.status = "running";
      const execution = await this.#executeWorkflowStep({
        skill: input.selectedSkill,
        step,
        intent: input.intent,
        trustedWorkspace: input.trustedWorkspace,
        previousResults,
        usedTools,
        text: input.intent.invocation?.args ?? input.text,
        onEvent: input.onEvent
      });

      if (execution === undefined) {
        step.status = "failed";
        step.reason = "No available tool for this workflow step yet.";
        const fallbackIndex = nextFallbackIndex(plan, step, stepMap);
        if (fallbackIndex !== undefined) {
          step.status = "fallback-used";
          step.reason = `Falling back to ${plan.steps[fallbackIndex]?.id ?? "next fallback"}.`;
          stepIndex = fallbackIndex;
          continue;
        }
        stepIndex += 1;
        continue;
      }

      executions.push(execution);
      usedTools.add(execution.tool.name);
      step.tool = execution.tool.name;
      step.status = execution.decision === "allow" && execution.result?.ok !== false
        ? "succeeded"
        : execution.decision === "allow"
          ? "failed"
          : "blocked";

      if (execution.result?.content !== undefined) {
        previousResults.push(renderToolResultPacket(packetizeToolExecution({
          execution,
          maxChars: 600
        })));
      }

      if (execution.decision !== "allow") {
        break;
      }
      if (execution.result?.ok === false) {
        const fallbackIndex = nextFallbackIndex(plan, step, stepMap);
        if (fallbackIndex !== undefined) {
          step.status = "fallback-used";
          step.reason = `Falling back to ${plan.steps[fallbackIndex]?.id ?? "next fallback"}.`;
          stepIndex = fallbackIndex;
          continue;
        }
      }
      stepIndex += 1;
    }

    return executions;
  }

  async #executeWorkflowStep(input: {
    skill: LoadedSkill | SkillDefinition;
    step: SkillWorkflowPlanStep;
    intent: IntentRoute;
    trustedWorkspace: boolean;
    previousResults: string[];
    usedTools: Set<string>;
    text: string;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord | undefined> {
    const toolsets = input.step.preferredToolsets;

    for (const toolset of toolsets) {
      const toolInput = {
        skill: input.skill.name,
        intent: input.intent.labels,
        text: input.text,
        url: extractFirstUrl(input.text),
        firstStep: input.skill.workflow[0]?.description,
        workflowStep: input.step.id,
        stepDescription: input.step.description,
        previousResults: input.previousResults.map((result) => truncate(result, 500))
      };
      const preferredTool = firstAvailablePreferredTool(input.step, toolset, input.usedTools);
      const activityId = `skill:${input.skill.name}:${input.step.id}:${toolset}:${preferredTool ?? "auto"}`;
      let emittedStart = false;
      if (preferredTool !== undefined && !input.usedTools.has(preferredTool)) {
        await emit(input.onEvent, {
          kind: "tool-start",
          tool: preferredTool,
          stepId: input.step.id,
          targetSummary: summarizeSecurityTarget(preferredTool, toolInput),
          activityId
        });
        emittedStart = true;
      }
      const execution = preferredTool === undefined || input.usedTools.has(preferredTool)
        ? await this.#toolExecutor.executeFirstAvailable({
            toolset,
            sessionId: this.#currentSessionId(),
            trustedWorkspace: input.trustedWorkspace,
            excludedTools: [...input.usedTools],
            input: toolInput
          })
        : await this.#toolExecutor.executeTool({
            tool: preferredTool,
            sessionId: this.#currentSessionId(),
            trustedWorkspace: input.trustedWorkspace,
            input: toolInput
          });

      if (execution === undefined) {
        if (emittedStart && preferredTool !== undefined) {
          await emit(input.onEvent, {
            kind: "tool-result",
            tool: preferredTool,
            ok: false,
            targetSummary: summarizeSecurityTarget(preferredTool, toolInput),
            activityId
          });
        }
        continue;
      }
      if (!emittedStart) {
        await emit(input.onEvent, {
          kind: "tool-start",
          tool: execution.tool.name,
          stepId: input.step.id,
          targetSummary: execution.targetSummary,
          activityId
        });
      }

      await this.#runRecorder.recordWorkflowStep({
        skill: input.skill.name,
        step: input.step,
        status: execution.decision === "allow" ? "tool-executed" : "blocked",
        toolsets,
        tool: execution.tool.name,
        reason: execution.decision === "allow" ? undefined : `security decision: ${execution.decision}`
      });
      await emit(input.onEvent, {
        kind: "tool-result",
        tool: execution.tool.name,
        decision: execution.decision,
        riskClass: execution.riskClass,
        ok: execution.result?.ok,
        fileChangePreview: toolResultFileChangePreview(execution),
        targetSummary: execution.targetSummary,
        activityId,
        ...toolResultStats(execution)
      });

      return execution;
    }

    await this.#runRecorder.recordWorkflowStep({
      skill: input.skill.name,
      step: input.step,
      status: "no-tool",
      toolsets,
      reason: "No available tool for this workflow step yet."
    });

    return undefined;
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }
}

function preferredToolForStep(
  step: SkillWorkflowStep | SkillWorkflowPlanStep,
  toolset: ToolsetName
): string | undefined {
  if (step.id.includes("extract") && toolset === "web") {
    return "web.extract";
  }

  if (step.id.includes("browser") && toolset === "browser") {
    return "browser.navigate";
  }

  return undefined;
}

function firstAvailablePreferredTool(
  step: SkillWorkflowStep | SkillWorkflowPlanStep,
  toolset: ToolsetName,
  usedTools: Set<string>
): string | undefined {
  const candidates = [
    step.preferredTool,
    ...("toolCandidates" in step ? step.toolCandidates ?? [] : []),
    preferredToolForStep(step, toolset)
  ].filter((tool): tool is string => tool !== undefined && !usedTools.has(tool));

  return candidates[0];
}

function nextFallbackIndex(
  plan: SkillWorkflowPlan,
  step: SkillWorkflowPlanStep,
  stepMap: Map<string, { step: SkillWorkflowPlanStep; index: number }>
): number | undefined {
  for (const fallbackId of step.fallbackTo) {
    const fallback = stepMap.get(fallbackId);
    if (fallback !== undefined && fallback.step.status === "planned") {
      return fallback.index;
    }
  }

  return undefined;
}

function extractFirstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>"')]+/iu.exec(text)?.[0];
}
