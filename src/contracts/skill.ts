import type { NativeIntent } from "./intent.js";
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
  toolCandidates?: string[];
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
  toolCandidates?: string[];
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
  warnings?: string[];
};

export type SkillEvaluation = {
  input: string;
  shouldUseToolsets?: ToolsetName[];
  shouldNotAskUserFirst?: boolean;
  expectedOutcome?: string;
};

export type SkillVisibilityRules = {
  requiresToolsets?: ToolsetName[];
  fallbackForToolsets?: ToolsetName[];
  requiresTools?: string[];
  fallbackForTools?: string[];
};

export type SkillPattern =
  | { type: "contains"; value: string }
  | { type: "regex"; value: string }
  | { type: "attachment-kind"; value: "image" | "document" | "file" | "audio" | "video" | "voice" }
  | { type: "native-intent"; value: NativeIntent };

export type SkillConfirmationPolicy =
  | "never"
  | "ask"
  | "policy";

export type SkillDeferRule = {
  when: {
    nativeIntent?: NativeIntent;
    modelSupportsVision?: boolean;
    attachmentKinds?: Array<"image" | "document" | "file" | "audio" | "video" | "voice">;
    promptMatches?: SkillPattern[];
  };
  reason: string;
};

export type SkillRouting = {
  labels?: string[];
  triggerPatterns?: SkillPattern[];
  negativePatterns?: SkillPattern[];
  requiredToolsets?: ToolsetName[];
  confirmation?: SkillConfirmationPolicy;
  deferWhen?: SkillDeferRule[];
  priority?: number;
};

export type SkillResourceKind = "reference" | "template" | "script" | "asset";

export type SkillResourceEntry = {
  kind: SkillResourceKind;
  path: string;
  bytes?: number;
  declared?: boolean;
};

export type SkillConfigField = {
  key: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
};

export type SkillDefinition = {
  name: string;
  description: string;
  version: string;
  category?: string;
  platforms?: string[];
  references?: string[];
  metadata?: Record<string, unknown>;
  routing?: SkillRouting;
  intentLabels?: string[];
  triggerPatterns?: string[];
  negativePatterns?: string[];
  whenToUse: string[];
  requiredToolsets: ToolsetName[];
  optionalToolsets?: ToolsetName[];
  requiredEnvironmentVariables?: string[];
  requiredCredentialFiles?: string[];
  configFields?: SkillConfigField[];
  visibility?: SkillVisibilityRules;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  workflow: SkillWorkflowStep[];
  permissionExpectations: SkillPermissionExpectation[];
  examples: string[];
  evaluations: SkillEvaluation[];
};

export type SkillSourceKind = "bundled" | "local" | "external";

export type SkillProvenanceKind =
  | "bundled-seed"
  | "agent-created"
  | "user-created"
  | "imported"
  | "hub-installed"
  | "unknown";

export type SkillLifecycleState =
  | "active"
  | "stale"
  | "archived"
  | "inactive";

export type SkillProvenance = {
  kind: SkillProvenanceKind;
  createdAt?: string;
  createdBy?: "system" | "user" | "agent" | "import" | "hub";
  sourceSessionId?: string;
  sourceSessionIds?: string[];
  sourceObservationIds?: string[];
  importedFrom?: string;
  bundledName?: string;
  bundledVersion?: string;
};

export type SkillRouteTelemetry = {
  skillName: string;
  routeId?: string;
  matchedAt: string;
  selected: boolean;
  explicitInvocation: boolean;
  confidence: number;
  labels: string[];
  evidence: string[];
  sourceKind: SkillSourceKind;
};

export type BundledManifest = {
  version: 1;
  entries: Record<string, BundledManifestEntry>;
};

export type BundledManifestEntry = {
  name: string;
  bundledPath: string;
  localPath: string;
  originHash: string;
  bundledHash: string;
  seededAt: string;
  lastSyncedAt?: string;
};

export type LoadedSkill = SkillDefinition & {
  sourcePath: string;
  sourceKind: SkillSourceKind;
  sourceRoot: string;
  instructions: string;
  resources?: SkillResourceEntry[];
  provenance?: SkillProvenance;
  lifecycleState?: SkillLifecycleState;
  loadWarnings?: string[];
  providerInstructions?: {
    content: string;
    truncated: boolean;
    originalChars: number;
  };
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
  provenanceKind?: SkillProvenanceKind;
  lifecycleState?: SkillLifecycleState;
};
