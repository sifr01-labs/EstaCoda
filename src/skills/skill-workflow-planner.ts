import type {
  LoadedSkill,
  SkillDefinition,
  SkillWorkflowPlan,
  SkillWorkflowPlanStep,
  SkillWorkflowStep
} from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";

export function compileSkillWorkflowPlan(skill: LoadedSkill | SkillDefinition): SkillWorkflowPlan {
  const warnings = workflowWarnings(skill.workflow);

  return {
    skill: skill.name,
    steps: skill.workflow.map((step) => compileStep(skill, step)),
    ...(warnings.length === 0 ? {} : { warnings })
  };
}

export function renderSkillWorkflowPlan(plan: SkillWorkflowPlan): string {
  return [
    `Skill workflow plan: ${plan.skill}`,
    ...(plan.warnings === undefined || plan.warnings.length === 0
      ? []
      : [
          "Workflow warnings:",
          ...plan.warnings.map((warning) => `- ${warning}`)
        ]),
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
    toolCandidates: step.toolCandidates,
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

function workflowWarnings(steps: SkillWorkflowStep[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const stepIds = new Set(steps.map((step) => step.id));
  const fallbackGraph = new Map<string, string[]>();

  for (const step of steps) {
    if (seen.has(step.id)) {
      duplicates.add(step.id);
    }
    seen.add(step.id);

    const fallbackTo = step.fallbackTo ?? [];
    fallbackGraph.set(step.id, fallbackTo);

    for (const fallbackId of fallbackTo) {
      if (!stepIds.has(fallbackId)) {
        warnings.push(`Step "${step.id}" falls back to missing step "${fallbackId}".`);
      }
    }
  }

  for (const duplicate of [...duplicates].sort()) {
    warnings.push(`Duplicate workflow step id "${duplicate}".`);
  }

  for (const cycle of fallbackCycles(fallbackGraph)) {
    warnings.push(`Fallback cycle detected: ${cycle.join(" -> ")}.`);
  }

  return warnings;
}

function fallbackCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const emitted = new Set<string>();

  for (const stepId of graph.keys()) {
    visitFallback(stepId, graph, [], cycles, emitted);
  }

  return cycles;
}

function visitFallback(
  stepId: string,
  graph: Map<string, string[]>,
  path: string[],
  cycles: string[][],
  emitted: Set<string>
): void {
  const existingIndex = path.indexOf(stepId);

  if (existingIndex !== -1) {
    const cycle = [...path.slice(existingIndex), stepId];
    const key = canonicalCycleKey(cycle);

    if (!emitted.has(key)) {
      emitted.add(key);
      cycles.push(cycle);
    }

    return;
  }

  const fallbackTo = graph.get(stepId) ?? [];

  for (const fallbackId of fallbackTo) {
    if (graph.has(fallbackId)) {
      visitFallback(fallbackId, graph, [...path, stepId], cycles, emitted);
    }
  }
}

function canonicalCycleKey(cycle: string[]): string {
  const uniqueCycle = cycle.slice(0, -1);

  if (uniqueCycle.length === 0) {
    return cycle.join(">");
  }

  const rotations = uniqueCycle.map((_, index) => [
    ...uniqueCycle.slice(index),
    ...uniqueCycle.slice(0, index)
  ].join(">"));

  return rotations.sort()[0] ?? cycle.join(">");
}
