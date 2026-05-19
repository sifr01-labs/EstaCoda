import type { AgentLoopResponse } from "./agent-loop.js";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { SkillOutcome } from "../contracts/memory.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { renderArtifactProgress } from "../utils/artifact-formatting.js";
import { truncate } from "../utils/formatting.js";

export function renderToolPlanProgress(plans: ToolCallPlan[]): string[] {
  return plans.length === 0
    ? []
    : plans.map((plan) => `tool plan: ${plan.tool || "unknown"} (${plan.status})`);
}

export function buildFallbackResponse(input: {
  label: string;
  selectedSkill: LoadedSkill | SkillDefinition | undefined;
  intent: IntentRoute;
  securityDecision: SecurityDecision;
  toolExecutions: ToolExecutionRecord[];
  toolPlans: ToolCallPlan[];
  skillOutcomes: SkillOutcome[];
  artifacts: ArtifactRecord[];
  context: ContextExpansionResult | undefined;
  projectContext: ProjectContextSnapshot | undefined;
}): AgentLoopResponse {
  const contextProgress = [
    ...(input.context === undefined
      ? []
      : [`context refs: ${input.context.blocks.filter((block) => block.content.length > 0).length}/${input.context.references.length}`]),
    ...(input.projectContext === undefined || input.projectContext.files.length === 0
      ? []
      : [`project context: ${input.projectContext.files.map((file) => file.source).join(", ")}`])
  ];

  if (input.selectedSkill === undefined) {
    return {
      label: input.label,
      text: "I could not generate a full model response for this turn. Check provider configuration or try again once a model provider is available.",
      matchedSkills: [],
      intent: input.intent,
      securityDecision: input.securityDecision,
      toolExecutions: input.toolExecutions,
      toolPlans: input.toolPlans,
      skillOutcomes: input.skillOutcomes,
      artifacts: input.artifacts,
      context: input.context,
      projectContext: input.projectContext,
      providerExecution: undefined,
      progress: [
        "received prompt",
        ...contextProgress,
        `intent: ${input.intent.labels.join(", ")}`,
        "direct response mode",
        "ready for direct response"
      ]
    };
  }

  const confirmationText = input.intent.confirmationRequired
    ? "I matched it, but this route needs confirmation before I persist changes."
    : `I matched the ${input.selectedSkill.name} skill and can begin its workflow without asking first.`;

  return {
    label: input.label,
    text: confirmationText,
    matchedSkills: input.intent.suggestedSkills.map((skill) => skill.name),
    intent: input.intent,
    securityDecision: input.securityDecision,
      toolExecutions: input.toolExecutions,
      toolPlans: input.toolPlans,
      skillOutcomes: input.skillOutcomes,
      artifacts: input.artifacts,
      context: input.context,
    projectContext: input.projectContext,
    providerExecution: undefined,
    progress: [
      "received prompt",
      ...contextProgress,
      `intent: ${input.intent.labels.join(", ")}`,
      `confidence: ${Math.round(input.intent.confidence * 100)}%`,
      `selected skill: ${input.selectedSkill.name}`,
      `security: ${input.securityDecision}`,
      ...input.toolExecutions.map(
        (execution) => `tool: ${execution.tool.name} (${execution.decision}${execution.result === undefined ? "" : `/${execution.result.ok ? "ok" : "error"}`})`
      ),
      ...renderArtifactProgress(input.artifacts),
      `next: ${input.selectedSkill.workflow[0]?.description ?? "run skill workflow"}`
    ]
  };
}

export function cancelledResponse(input: {
  label: string;
  resumeNote: string;
  intent?: IntentRoute;
  securityDecision?: SecurityDecision;
  selectedSkill?: LoadedSkill | SkillDefinition;
  toolExecutions?: ToolExecutionRecord[];
  toolPlans?: ToolCallPlan[];
  artifacts?: ArtifactRecord[];
  context?: ContextExpansionResult;
  projectContext?: ProjectContextSnapshot;
  providerExecution?: ProviderExecutionResult;
}): AgentLoopResponse {
  return {
    label: input.label,
    text: [
      "Cancelled this turn. The session is still available, and you can resume when ready.",
      "",
      input.resumeNote
    ].join("\n"),
    matchedSkills: input.selectedSkill === undefined ? [] : [input.selectedSkill.name],
    intent: input.intent ?? {
      nativeIntent: "general",
      labels: ["general"],
      confidence: 1,
      suggestedSkills: [],
      suggestedToolsets: [],
      confirmationRequired: false,
      evidence: [{
        kind: "native-intent",
        detail: "The active turn was cancelled before completion.",
        weight: 1
      }],
      rationale: "The active turn was cancelled before completion."
    },
    securityDecision: input.securityDecision ?? "allow",
    toolExecutions: input.toolExecutions ?? [],
    toolPlans: input.toolPlans ?? [],
    skillOutcomes: [],
    artifacts: input.artifacts ?? [],
    context: input.context,
    projectContext: input.projectContext,
    providerExecution: input.providerExecution,
    progress: [
      "received prompt",
      "cancelled",
      `resume: ${input.resumeNote}`
    ]
  };
}

export function buildResumeNote(input: {
  stage: string;
  userText: string;
  selectedSkill?: LoadedSkill | SkillDefinition;
  toolPlans?: ToolCallPlan[];
  toolExecutions?: ToolExecutionRecord[];
  providerExecution?: ProviderExecutionResult;
  context?: ContextExpansionResult;
  projectContext?: ProjectContextSnapshot;
}): string {
  const planned = input.toolPlans?.filter((plan) => plan.status === "planned" || plan.status === "cancelled") ?? [];
  const executed = input.toolExecutions?.map((execution) => execution.tool.name) ?? [];
  const provider = input.providerExecution?.response === undefined
    ? undefined
    : `${input.providerExecution.response.provider}/${input.providerExecution.response.model}`;
  const lines = [
    `Resume note: interrupted during ${input.stage}.`,
    `Original request: ${truncate(input.userText, 220)}`,
    input.selectedSkill === undefined ? undefined : `Skill: ${input.selectedSkill.name}`,
    provider === undefined ? undefined : `Provider: ${provider}`,
    executed.length === 0 ? undefined : `Tools completed: ${[...new Set(executed)].join(", ")}`,
    planned.length === 0 ? undefined : `Tool plans to revisit: ${planned.map((plan) => plan.tool || "unknown").join(", ")}`,
    input.context === undefined ? undefined : `Context refs loaded: ${input.context.blocks.filter((block) => block.content.length > 0).length}/${input.context.references.length}`,
    input.projectContext === undefined || input.projectContext.files.length === 0
      ? undefined
      : `Project context: ${input.projectContext.files.map((file) => file.source).join(", ")}`,
    "Send a follow-up like 'resume that' or restate the next step to continue from here."
  ].filter((line) => line !== undefined);

  return lines.join("\n");
}
