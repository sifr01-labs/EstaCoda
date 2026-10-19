import type { LoadedSkill, SkillDefinition } from "./skill.js";
import type { ToolsetName } from "./tool.js";

export type NativeIntent =
  | "image-generation"
  | "voice-transcription"
  | "speech-generation"
  | "attachment-analysis"
  | "browser-control"
  | "general";

export type IntentRouteEvidence = {
  kind:
    | "jev-decision"
    | "slash-invocation"
    | "explicit-skill-reference"
    | "native-intent"
    | "task-class"
    | "attachment"
    | "skill-routing-label"
    | "skill-trigger-pattern"
    | "skill-negative-pattern"
    | "skill-defer-rule"
    | "semantic-shadow"
    | "toolset-derived"
    | "confirmation-policy";
  source?: string;
  detail: string;
  weight?: number;
};

export type IntentLabel = string;

export type FileOutputRequirement = { format: "markdown" | "text"; path?: string; exactCopy?: { sourcePath?: string } };

/** Turn-local routing/completion hints, never execution authority. */
export type RequestRequirements = {
  /** Runtime-owned locator for a prior admitted Task; never completion evidence. */
  sourceTaskId?: string;
  originTurnId?: string;
  skillReferences: string[];
  delegation?: { count?: number };
  fileOutput?: FileOutputRequirement & { additionalFiles?: FileOutputRequirement[] };
  research?: { domain: "general" | "literature" | "paper"; fresh: boolean };
  issues: Array<"request-too-long" | "ambiguous-file-target" | "unsafe-file-target">;
};

export type SkillInvocation = {
  name: string;
  args: string;
  explicit: boolean;
};

export type IntentTaskClass =
  | "conversation"
  | "repo-inspection"
  | "code-review"
  | "repo-change"
  | "docs-writing"
  | "release-validation"
  | "provider-diagnostics"
  | "browser-operation"
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

export type IntentShadowRouteCandidate = {
  skill: LoadedSkill | SkillDefinition;
  score: number;
  confidence: number;
  evidence: IntentRouteEvidence[];
};

export type IntentShadowRoute = {
  mode: "local-semantic-shadow";
  wouldSelectSkill?: LoadedSkill | SkillDefinition;
  confidence: number;
  candidates: IntentShadowRouteCandidate[];
  rationale: string;
};

export type RequestInterpretation = "information" | "action" | "mixed" | "unspecified";

export type IntentRoute = {
  requestInterpretation?: RequestInterpretation;
  routingDecision?: import("./routing.js").RoutingDecision;
  requestRequirements?: RequestRequirements;
  skillRequests?: Array<{ reference: string; status: "resolved" | "ambiguous" | "unavailable" | "deferred"; candidates: string[] }>;
  nativeIntent: NativeIntent;
  taskClass?: IntentTaskClass;
  labels: IntentLabel[];
  confidence: number;
  suggestedToolsets: ToolsetName[];
  primarySkill?: LoadedSkill | SkillDefinition;
  supportingSkills?: Array<LoadedSkill | SkillDefinition>;
  candidates?: SkillRouteCandidate[];
  rejectedCandidates?: SkillRouteCandidate[];
  shadowSemanticRoute?: IntentShadowRoute;
  suggestedSkills: Array<LoadedSkill | SkillDefinition>;
  invocation?: SkillInvocation;
  confirmationRequired: boolean;
  evidence: IntentRouteEvidence[];
  rationale: string;
};
