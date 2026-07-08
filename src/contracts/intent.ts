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
    | "task-class"
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

export type IntentTaskClass =
  | "code-review"
  | "repo-change"
  | "docs-writing"
  | "release-validation"
  | "architecture-advice"
  | "research"
  | "media-generation"
  | "attachment-analysis"
  | "general";

export type SkillRouteCandidateRole =
  | "primary"
  | "supporting"
  | "candidate"
  | "rejected"
  | "deferred";

export type SkillRouteCandidate = {
  skill: LoadedSkill | SkillDefinition;
  role: SkillRouteCandidateRole;
  score: number;
  confidence: number;
  evidence: IntentRouteEvidence[];
  reason?: string;
};

export type IntentRoute = {
  nativeIntent: NativeIntent;
  taskClass?: IntentTaskClass;
  labels: IntentLabel[];
  confidence: number;
  suggestedToolsets: ToolsetName[];
  primarySkill?: LoadedSkill | SkillDefinition;
  supportingSkills?: Array<LoadedSkill | SkillDefinition>;
  candidates?: SkillRouteCandidate[];
  rejectedCandidates?: SkillRouteCandidate[];
  suggestedSkills: Array<LoadedSkill | SkillDefinition>;
  invocation?: SkillInvocation;
  confirmationRequired: boolean;
  evidence: IntentRouteEvidence[];
  rationale: string;
};
