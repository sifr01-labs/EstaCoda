import type { NativeIntent } from "./intent.js";
import type { ToolsetName } from "./tool.js";

export type SkillPermissionExpectation =
  | "auto-read"
  | "auto-active-channel-reply"
  | "ask-before-write"
  | "ask-before-external-send"
  | "ask-before-credential-access"
  | "ask-before-destructive-action";

export type SkillPlaybookStepSpec = {
  id: string;
  description: string;
  toolsets?: ToolsetName[];
  preferredTool?: string;
  toolCandidates?: string[];
  fallbackTo?: string[];
  successCriteria?: string[];
  outputTarget?: string;
};

export type CompiledSkillPlaybookStepStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "fallback-used";

export type CompiledSkillPlaybookStep = {
  id: string;
  description: string;
  preferredToolsets: ToolsetName[];
  preferredTool?: string;
  toolCandidates?: string[];
  fallbackTo: string[];
  successCriteria: string[];
  outputTarget?: string;
  status: CompiledSkillPlaybookStepStatus;
  tool?: string;
  reason?: string;
};

export type CompiledSkillPlaybook = {
  skill: string;
  steps: CompiledSkillPlaybookStep[];
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

export type SkillPromptContentMode = "full" | "contract";

export type SkillContract = {
  summary: string;
  sectionIndex: SkillSectionIndexEntry[];
  referenceIndex: SkillReferenceIndexEntry[];
  scriptIndex: SkillReferenceIndexEntry[];
  originalChars: number;
};

export type SkillSectionIndexEntry = {
  heading: string;
  level: number;
  charOffset: number;
  charLength?: number;
};

export type SkillReferenceIndexEntry = {
  path: string;
  kind: SkillResourceKind;
  chars?: number;
  description?: string;
};

export type SelectedSkillPromptContent = {
  name: string;
  description: string;
  content: string;
  contentMode: SkillPromptContentMode;
  originalChars?: number;
  truncated: boolean;
  referencePaths: string[];
  scriptPaths: string[];
  loadInstruction?: string;
};

export type SkillConfigField = {
  key: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
};

export type SkillPythonCapabilityRequirement = {
  id: string;
  required: boolean;
  groups: string[];
};

export type SkillPythonCapabilitySetupStatus = SkillPythonCapabilityRequirement & {
  status: "available" | "unavailable";
  reason?: string;
  message?: string;
  repairCommand?: string;
  expectedSpecHash?: string;
  installedGroups?: string[];
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
  pythonCapabilities?: SkillPythonCapabilityRequirement[];
  pythonCapabilitySetup?: SkillPythonCapabilitySetupStatus[];
  configFields?: SkillConfigField[];
  visibility?: SkillVisibilityRules;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  playbook: SkillPlaybookStepSpec[];
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
  taskClass?: string;
  promptHash?: string;
};

export type SkillRouteRejectedCandidate = {
  skillName: string;
  reason?: string;
};

export type SkillRouteShadowCandidate = {
  skillName: string;
  score: number;
  confidence: number;
  evidenceKinds: string[];
};

export type SkillRouteShadowTelemetry = {
  mode: "local-semantic-shadow";
  wouldSelectSkill?: string;
  confidence: number;
  candidates: SkillRouteShadowCandidate[];
  rationale: string;
};

export type SkillRouteCorrectionSignal = {
  source: "user" | "developer" | "model";
  kind: "rejected" | "searched" | "selected" | "self-corrected";
  skillName?: string;
  replacementSkillName?: string;
  reason?: string;
};

export type SkillRouteNoSkillResult =
  | "correct"
  | "missed"
  | "not-applicable";

export type SkillRouteFinalOutcomeStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "partial"
  | "cancelled"
  | "unknown";

export type SkillRouteTelemetryDetails = {
  taskClass?: string;
  primarySkill?: string;
  supportingSkills?: string[];
  candidateSkills?: string[];
  candidatesShown?: string[];
  candidatesRejected?: SkillRouteRejectedCandidate[];
  rejectedCandidates?: SkillRouteRejectedCandidate[];
  deferredCandidates?: SkillRouteRejectedCandidate[];
  shadowSemanticRoute?: SkillRouteShadowTelemetry;
  searchedReplacementSkill?: string;
  finalSkillUsed?: string;
  noSkillResult?: SkillRouteNoSkillResult;
  correctionSignals?: SkillRouteCorrectionSignal[];
  modelSelfCorrectionSignal?: string;
  finalOutcomeStatus?: SkillRouteFinalOutcomeStatus;
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
  contract?: SkillContract;
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
