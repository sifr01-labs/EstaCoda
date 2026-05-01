import type { LoadedSkill, SkillDefinition } from "./skill.js";
import type { ToolsetName } from "./tool.js";

export type NativeIntent =
  | "image-generation"
  | "voice-transcription"
  | "speech-generation"
  | "attachment-analysis"
  | "general";

export type IntentRouteEvidence = {
  kind:
    | "slash-invocation"
    | "native-intent"
    | "attachment"
    | "skill-routing-label"
    | "skill-trigger-pattern"
    | "skill-negative-pattern"
    | "skill-defer-rule"
    | "toolset-derived"
    | "confirmation-policy";
  source?: string;
  detail: string;
  weight?: number;
};

export type IntentLabel = string;

export type SkillInvocation = {
  name: string;
  args: string;
  explicit: boolean;
};

export type IntentRoute = {
  nativeIntent: NativeIntent;
  labels: IntentLabel[];
  confidence: number;
  suggestedToolsets: ToolsetName[];
  suggestedSkills: Array<LoadedSkill | SkillDefinition>;
  invocation?: SkillInvocation;
  confirmationRequired: boolean;
  evidence: IntentRouteEvidence[];
  rationale: string;
};
