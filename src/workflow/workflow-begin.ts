import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import { compileSkillPlaybook } from "../skills/skill-playbook-planner.js";
import { convertSkillPlaybookToWorkflowPlan } from "./skill-playbook-to-workflow-plan.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import type { WorkflowPlan, WorkflowRun } from "./types.js";

const MAX_OBJECTIVE_TITLE_LENGTH = 80;

export type BeginExplicitWorkflowInput = {
  engine: WorkflowEngine;
  sessionId: string;
  objective: string;
};

export type BeginExplicitWorkflowResult = {
  run: WorkflowRun;
  plan: WorkflowPlan;
};

export type BeginSkillPlaybookWorkflowInput = {
  engine: WorkflowEngine;
  sessionId: string;
  objective: string;
  skill: LoadedSkill | SkillDefinition;
};

export function summarizeObjective(objective: string): string {
  const normalized = objective.trim().replace(/\s+/gu, " ");
  if (normalized.length <= MAX_OBJECTIVE_TITLE_LENGTH) {
    return normalized.length === 0 ? "Workflow objective" : normalized;
  }
  return `${normalized.slice(0, MAX_OBJECTIVE_TITLE_LENGTH - 3).trimEnd()}...`;
}

export function buildExplicitObjectiveWorkflowPlan(objective: string): WorkflowPlan {
  const normalized = objective.trim().replace(/\s+/gu, " ");
  return {
    name: summarizeObjective(normalized),
    description: normalized,
    steps: [
      {
        name: "Work on objective",
        description: "Continue the requested work through AgentLoop",
        requiresApproval: false,
        skippable: false,
        maxRetries: 0,
        idempotent: false
      }
    ]
  };
}

export async function beginExplicitWorkflowRun(input: BeginExplicitWorkflowInput): Promise<BeginExplicitWorkflowResult> {
  const objective = input.objective.trim().replace(/\s+/gu, " ");
  const plan = buildExplicitObjectiveWorkflowPlan(objective);
  const run = await input.engine.createWorkflowRun({
    sessionId: input.sessionId,
    intent: makeExplicitWorkflowIntent(objective),
    plan,
    metadata: {
      activationReason: "explicit",
      objective
    }
  });
  const startResult = await input.engine.startWorkflowRun(run.id);
  if (!startResult.ok) {
    throw new Error(startResult.error);
  }
  return { run: startResult.run, plan };
}

export async function beginSkillPlaybookWorkflowRun(input: BeginSkillPlaybookWorkflowInput): Promise<BeginExplicitWorkflowResult> {
  const objective = input.objective.trim().replace(/\s+/gu, " ");
  const compiled = compileSkillPlaybook(input.skill);
  const plan = convertSkillPlaybookToWorkflowPlan(compiled);
  const run = await input.engine.createWorkflowRun({
    sessionId: input.sessionId,
    intent: makeSkillPlaybookWorkflowIntent(objective, input.skill.name),
    plan,
    selectedSkill: input.skill.name,
    metadata: {
      activationReason: "playbook",
      objective,
      skillName: input.skill.name,
      ...(plan.metadata === undefined ? {} : { playbook: plan.metadata })
    }
  });
  const startResult = await input.engine.startWorkflowRun(run.id);
  if (!startResult.ok) {
    throw new Error(startResult.error);
  }
  return { run: startResult.run, plan };
}

function makeExplicitWorkflowIntent(objective: string): IntentRoute {
  return {
    nativeIntent: "general",
    labels: ["workflow", "workflow-explicit"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [
      {
        kind: "slash-invocation",
        source: "workflow.begin",
        detail: objective,
        weight: 1
      }
    ],
    rationale: "User explicitly began a durable workflow."
  };
}

function makeSkillPlaybookWorkflowIntent(objective: string, skillName: string): IntentRoute {
  return {
    nativeIntent: "general",
    labels: ["workflow", "workflow-playbook"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [
      {
        kind: "slash-invocation",
        source: "workflow.begin",
        detail: `${skillName}: ${objective}`,
        weight: 1
      }
    ],
    rationale: "User explicitly began a durable workflow from a skill playbook."
  };
}
