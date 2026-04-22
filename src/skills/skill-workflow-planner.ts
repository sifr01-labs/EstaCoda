import type {
  LoadedSkill,
  SkillDefinition,
  SkillWorkflowPlan,
  SkillWorkflowPlanStep,
  SkillWorkflowStep
} from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";

export function compileSkillWorkflowPlan(skill: LoadedSkill | SkillDefinition): SkillWorkflowPlan {
  return {
    skill: skill.name,
    steps: skill.workflow.map((step) => compileStep(skill, step))
  };
}

export function renderSkillWorkflowPlan(plan: SkillWorkflowPlan): string {
  return [
    `Skill workflow plan: ${plan.skill}`,
    ...plan.steps.map((step, index) => [
      `${index + 1}. ${step.id} [${step.status}]`,
      `   goal: ${step.description}`,
      `   toolsets: ${step.preferredToolsets.join(", ")}`,
      step.preferredTool === undefined ? undefined : `   preferred tool: ${step.preferredTool}`,
      step.fallbackTo.length === 0 ? undefined : `   fallback: ${step.fallbackTo.join(", ")}`,
      step.successCriteria.length === 0 ? undefined : `   success: ${step.successCriteria.join("; ")}`,
      step.outputTarget === undefined ? undefined : `   output: ${step.outputTarget}`
    ].filter((line) => line !== undefined).join("\n"))
  ].join("\n");
}

function compileStep(skill: LoadedSkill | SkillDefinition, step: SkillWorkflowStep): SkillWorkflowPlanStep {
  return {
    id: step.id,
    description: step.description,
    preferredToolsets: preferredToolsets(skill, step),
    preferredTool: step.preferredTool,
    fallbackTo: step.fallbackTo ?? [],
    successCriteria: step.successCriteria ?? [],
    outputTarget: step.outputTarget,
    status: "planned"
  };
}

function preferredToolsets(skill: LoadedSkill | SkillDefinition, step: SkillWorkflowStep): ToolsetName[] {
  const toolsets = step.toolsets ?? skill.requiredToolsets;
  return toolsets.length === 0 ? ["core"] : [...toolsets];
}
