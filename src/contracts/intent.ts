import type { LoadedSkill, SkillDefinition } from "./skill.js";
import type { ToolsetName } from "./tool.js";

export type IntentLabel =
  | "youtube-video"
  | "knowledge-base"
  | "telegram-media"
  | "pdf-document"
  | "codebase-task"
  | "web-research"
  | "skill-creation"
  | "memory-update"
  | "skill-invocation"
  | "general";

export type SkillInvocation = {
  name: string;
  args: string;
  explicit: boolean;
};

export type IntentRoute = {
  labels: IntentLabel[];
  confidence: number;
  suggestedToolsets: ToolsetName[];
  suggestedSkills: Array<LoadedSkill | SkillDefinition>;
  invocation?: SkillInvocation;
  confirmationRequired: boolean;
  rationale: string;
};
