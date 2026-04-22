import type { ToolsetName } from "./tool.js";

export type SkillPermissionExpectation =
  | "auto-read"
  | "auto-active-channel-reply"
  | "ask-before-write"
  | "ask-before-external-send"
  | "ask-before-credential-access"
  | "ask-before-destructive-action";

export type SkillWorkflowStep = {
  id: string;
  description: string;
  toolsets?: ToolsetName[];
  preferredTool?: string;
  fallbackTo?: string[];
  successCriteria?: string[];
  outputTarget?: string;
};

export type SkillWorkflowPlanStepStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "fallback-used";

export type SkillWorkflowPlanStep = {
  id: string;
  description: string;
  preferredToolsets: ToolsetName[];
  preferredTool?: string;
  fallbackTo: string[];
  successCriteria: string[];
  outputTarget?: string;
  status: SkillWorkflowPlanStepStatus;
  tool?: string;
  reason?: string;
};

export type SkillWorkflowPlan = {
  skill: string;
  steps: SkillWorkflowPlanStep[];
};

export type SkillEvaluation = {
  input: string;
  shouldUseToolsets?: ToolsetName[];
  shouldNotAskUserFirst?: boolean;
  expectedOutcome?: string;
};

export type SkillDefinition = {
  name: string;
  description: string;
  version: string;
  category?: string;
  platforms?: string[];
  references?: string[];
  metadata?: Record<string, unknown>;
  whenToUse: string[];
  requiredToolsets: ToolsetName[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  workflow: SkillWorkflowStep[];
  permissionExpectations: SkillPermissionExpectation[];
  examples: string[];
  evaluations: SkillEvaluation[];
};

export type SkillSourceKind = "official" | "personal" | "project" | "external";

export type LoadedSkill = SkillDefinition & {
  sourcePath: string;
  sourceKind: SkillSourceKind;
  sourceRoot: string;
  instructions: string;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  version: string;
  category: string;
  requiredToolsets: ToolsetName[];
  sourceKind?: SkillSourceKind;
  sourcePath?: string;
  instructionBytes?: number;
};
