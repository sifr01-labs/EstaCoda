import type { ChannelAttachment, ChannelAttachmentKind, ChannelKind } from "../contracts/channel.js";
import type {
  IntentLabel,
  IntentRoute,
  IntentRouteEvidence,
  IntentTaskClass,
  NativeIntent,
  SkillRouteCandidate
} from "../contracts/intent.js";
import type { ModelProfile } from "../contracts/provider.js";
import type { LoadedSkill, SkillDefinition, SkillDeferRule, SkillPattern } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { SkillRegistry } from "../skills/skill-registry.js";

export type IntentRouterOptions = {
  skillRegistry: SkillRegistry;
  model?: ModelProfile;
};

export type IntentRouteOptions = {
  attachments?: ChannelAttachment[];
  channel?: ChannelKind;
  surface?: ChannelKind;
  model?: ModelProfile;
  trustedWorkspace?: boolean;
};

type SlashInvocationMatch =
  | {
      kind: "known";
      skill: LoadedSkill | SkillDefinition;
      args: string;
    }
  | {
      kind: "unknown";
      name: string;
      args: string;
    };

type SkillMatch = {
  skill: LoadedSkill | SkillDefinition;
  evidence: IntentRouteEvidence[];
  score: number;
  deferred: boolean;
  deferReason?: string;
};

const NATIVE_INTENT_TOOLSETS: Record<NativeIntent, ToolsetName[]> = {
  "image-generation": ["media", "files"],
  "voice-transcription": ["media", "files"],
  "speech-generation": ["media", "files"],
  "attachment-analysis": ["media", "files"],
  "general": []
};

const PRIMARY_SKILL_MIN_SCORE = 0.7;
const SUPPORTING_SKILL_LIMIT = 3;

export class IntentRouter {
  readonly #skillRegistry: SkillRegistry;
  readonly #model: ModelProfile | undefined;

  constructor(options: IntentRouterOptions) {
    this.#skillRegistry = options.skillRegistry;
    this.#model = options.model;
  }

  route(prompt: string, options: IntentRouteOptions = {}): IntentRoute {
    const model = options.model ?? this.#model;
    const normalized = normalize(prompt);
    const slashInvocation = parseSlashInvocation(prompt, this.#skillRegistry);

    if (slashInvocation?.kind === "known") {
      const nativeIntent = nativeIntentFromSkill(slashInvocation.skill) ?? "general";
      const task = detectTaskClass(normalized, nativeIntent);
      const evidence: IntentRouteEvidence[] = [{
        kind: "slash-invocation",
        source: slashInvocation.skill.name,
        detail: `Explicit slash skill invocation for ${slashInvocation.skill.name}.`,
        weight: 1
      }, ...task.evidence];
      const confidence = confidenceFromEvidence(evidence);
      const labels = dedupe([
        "skill-invocation",
        ...routingLabels(slashInvocation.skill)
      ]);
      const suggestedToolsets = dedupe([
        ...routingToolsets(slashInvocation.skill),
        ...slashInvocation.skill.requiredToolsets
      ]);

      return {
        nativeIntent,
        taskClass: task.taskClass,
        labels,
        confidence,
        suggestedToolsets,
        primarySkill: slashInvocation.skill,
        supportingSkills: [],
        candidates: [{
          skill: slashInvocation.skill,
          role: "primary",
          score: 1,
          confidence,
          evidence
        }],
        rejectedCandidates: [],
        suggestedSkills: [slashInvocation.skill],
        invocation: {
          name: slashInvocation.skill.name,
          args: slashInvocation.args,
          explicit: true
        },
        confirmationRequired: confirmationForSkills([slashInvocation.skill], evidence),
        evidence,
        rationale: `Explicit slash skill invocation for ${slashInvocation.skill.name}.`
      };
    }

    if (slashInvocation?.kind === "unknown") {
      const task = detectTaskClass(normalized, "general");
      const evidence: IntentRouteEvidence[] = [{
        kind: "slash-invocation",
        source: slashInvocation.name,
        detail: `Unknown slash invocation: /${slashInvocation.name}.`,
        weight: 1
      }, ...task.evidence];

      return {
        nativeIntent: "general",
        taskClass: task.taskClass,
        labels: ["skill-invocation"],
        confidence: confidenceFromEvidence(evidence),
        suggestedToolsets: [],
        supportingSkills: [],
        candidates: [],
        rejectedCandidates: [],
        suggestedSkills: [],
        invocation: {
          name: slashInvocation.name,
          args: slashInvocation.args,
          explicit: true
        },
        confirmationRequired: false,
        evidence,
        rationale: `Unknown slash invocation /${slashInvocation.name}; no skill was selected.`
      };
    }

    const native = detectNativeIntent(normalized, options.attachments);
    const task = detectTaskClass(normalized, native.nativeIntent);
    const labels = dedupe([
      native.nativeIntent,
      ...native.labels
    ].filter((label) => label !== "general"));
    const skillMatches = this.#skillRegistry
      .list()
      .map((skill) => matchSkill(skill, {
        prompt,
        normalized,
        nativeIntent: native.nativeIntent,
        labels,
        attachments: options.attachments,
        model
      }))
      .filter((match): match is SkillMatch => match !== undefined)
      .sort(compareSkillMatches);
    const activeSkillMatches = skillMatches.filter((match) => !match.deferred);
    const selectedMatches = selectSkillMatches(activeSkillMatches);
    const primarySkill = selectedMatches.primary?.skill;
    const supportingSkills = selectedMatches.supporting.map((match) => match.skill);
    const suggestedSkills = primarySkill === undefined
      ? supportingSkills
      : [primarySkill, ...supportingSkills];
    const supportingSkillNames = new Set(supportingSkills.map((skill) => skill.name));
    const candidates = skillMatches.map((match) => routeCandidateFromMatch(match, {
      primarySkillName: primarySkill?.name,
      supportingSkillNames
    }));
    const rejectedCandidates = candidates.filter((candidate) =>
      candidate.role === "rejected" || candidate.role === "deferred"
    );
    const evidence = [
      ...native.evidence,
      ...task.evidence,
      ...skillMatches.flatMap((match) => match.evidence),
      ...toolsetEvidence(native.nativeIntent, suggestedSkills)
    ];
    const suggestedToolsets = dedupe([
      ...NATIVE_INTENT_TOOLSETS[native.nativeIntent],
      ...suggestedSkills.flatMap((skill) => routingToolsets(skill))
    ]);
    const confirmationRequired = confirmationForSkills(suggestedSkills, evidence);

    return {
      nativeIntent: native.nativeIntent,
      taskClass: task.taskClass,
      labels: labels.length === 0 ? ["general"] : labels,
      confidence: confidenceFromEvidence(evidence),
      suggestedToolsets,
      primarySkill,
      supportingSkills,
      candidates,
      rejectedCandidates,
      suggestedSkills,
      confirmationRequired,
      evidence,
      rationale: rationaleFor(native.nativeIntent, labels, suggestedSkills, evidence)
    };
  }
}

function detectNativeIntent(normalized: string, attachments: ChannelAttachment[] | undefined): {
  nativeIntent: NativeIntent;
  labels: IntentLabel[];
  evidence: IntentRouteEvidence[];
} {
  const readyAttachments = readyRoutableAttachments(attachments);

  if (hasReadyImageAttachment(attachments) && asksToUseAttachedImage(normalized)) {
    return {
      nativeIntent: "attachment-analysis",
      labels: ["attachment-analysis"],
      evidence: [{
        kind: "attachment",
        detail: "Ready image attachment with prompt asking to use or transform the attached image.",
        weight: 0.85
      }]
    };
  }

  if (matchesImageGeneration(normalized)) {
    return {
      nativeIntent: "image-generation",
      labels: ["image-generation"],
      evidence: [{
        kind: "native-intent",
        detail: "Prompt explicitly asks to create or generate an image.",
        weight: 0.95
      }]
    };
  }

  if (hasReadyAttachmentKind(readyAttachments, ["audio", "voice"]) && matchesVoiceTranscription(normalized)) {
    return {
      nativeIntent: "voice-transcription",
      labels: ["voice-transcription"],
      evidence: [{
        kind: "native-intent",
        detail: "Prompt explicitly asks to transcribe or read attached audio.",
        weight: 0.95
      }]
    };
  }

  if (matchesVoiceTranscription(normalized)) {
    return {
      nativeIntent: "voice-transcription",
      labels: ["voice-transcription"],
      evidence: [{
        kind: "native-intent",
        detail: "Prompt explicitly asks to transcribe or read audio.",
        weight: 0.9
      }]
    };
  }

  if (matchesSpeechGeneration(normalized)) {
    return {
      nativeIntent: "speech-generation",
      labels: ["speech-generation"],
      evidence: [{
        kind: "native-intent",
        detail: "Prompt explicitly asks for speech or read-aloud output.",
        weight: 0.9
      }]
    };
  }

  if (readyAttachments.length > 0) {
    return {
      nativeIntent: "attachment-analysis",
      labels: ["attachment-analysis"],
      evidence: [{
        kind: "attachment",
        detail: `Ready attachment context: ${readyAttachments.map((attachment) => attachment.kind).join(", ")}.`,
        weight: 0.8
      }]
    };
  }

  return {
    nativeIntent: "general",
    labels: [],
    evidence: [{
      kind: "native-intent",
      detail: "No narrow native intent matched.",
      weight: 0.35
    }]
  };
}

function detectTaskClass(normalized: string, nativeIntent: NativeIntent): {
  taskClass: IntentTaskClass;
  evidence: IntentRouteEvidence[];
} {
  const nativeTaskClass = taskClassFromNativeIntent(nativeIntent);
  if (nativeTaskClass !== "general") {
    return {
      taskClass: nativeTaskClass,
      evidence: [{
        kind: "task-class",
        detail: `Native intent ${nativeIntent} maps to task class ${nativeTaskClass}.`,
        weight: 0
      }]
    };
  }

  const taskClass = taskClassFromPrompt(normalized);
  return {
    taskClass,
    evidence: taskClass === "general"
      ? []
      : [{
          kind: "task-class",
          detail: `Prompt matched deterministic task class ${taskClass}.`,
          weight: 0
        }]
  };
}

function taskClassFromPrompt(normalized: string): IntentTaskClass {
  if (matchesReleaseValidation(normalized)) {
    return "release-validation";
  }
  if (matchesDocsWriting(normalized)) {
    return "docs-writing";
  }
  if (matchesCodeReview(normalized)) {
    return "code-review";
  }
  if (matchesArchitectureAdvice(normalized)) {
    return "architecture-advice";
  }
  if (matchesResearch(normalized)) {
    return "research";
  }
  if (matchesRepoChange(normalized)) {
    return "repo-change";
  }

  return "general";
}

function matchSkill(skill: LoadedSkill | SkillDefinition, input: {
  prompt: string;
  normalized: string;
  nativeIntent: NativeIntent;
  labels: IntentLabel[];
  attachments?: ChannelAttachment[];
  model?: ModelProfile;
}): SkillMatch | undefined {
  const routing = skill.routing;
  if (routing === undefined) {
    return undefined;
  }

  const negative = firstMatchingPattern(routing.negativePatterns, input);
  if (negative !== undefined) {
    return {
      skill,
      evidence: [{
        kind: "skill-negative-pattern",
        source: skill.name,
        detail: `Negative pattern matched: ${describePattern(negative)}.`,
        weight: -1
      }],
      score: -1,
      deferred: true,
      deferReason: "Negative routing pattern matched."
    };
  }

  const evidence: IntentRouteEvidence[] = [];

  for (const pattern of routing.triggerPatterns ?? []) {
    if (patternMatches(pattern, input)) {
      evidence.push({
        kind: pattern.type === "native-intent"
          ? "native-intent"
          : pattern.type === "attachment-kind"
            ? "attachment"
            : "skill-trigger-pattern",
        source: skill.name,
        detail: `Matched ${describePattern(pattern)}.`,
        weight: pattern.type === "regex" ? 0.75 : 0.7
      });
    }
  }

  const labelMatches = (routing.labels ?? []).filter((label) => input.labels.includes(label));
  for (const label of labelMatches) {
    evidence.push({
      kind: "skill-routing-label",
      source: skill.name,
      detail: `Skill routing label matched: ${label}.`,
      weight: 0.7
    });
  }

  const deferred = firstMatchingDeferRule(routing.deferWhen, input);
  if (deferred !== undefined) {
    evidence.push({
      kind: "skill-defer-rule",
      source: skill.name,
      detail: deferred.reason,
      weight: 0
    });
    return {
      skill,
      evidence,
      score: 0,
      deferred: true,
      deferReason: deferred.reason
    };
  }

  if (evidence.length === 0) {
    return undefined;
  }

  return {
    skill,
    evidence,
    score: Math.max(...evidence.map((entry) => entry.weight ?? 0)) + ((routing.priority ?? 0) / 1_000),
    deferred: false
  };
}

function firstMatchingPattern(patterns: SkillPattern[] | undefined, input: Parameters<typeof patternMatches>[1]): SkillPattern | undefined {
  return (patterns ?? []).find((pattern) => patternMatches(pattern, input));
}

function firstMatchingDeferRule(rules: SkillDeferRule[] | undefined, input: {
  prompt: string;
  normalized: string;
  nativeIntent: NativeIntent;
  attachments?: ChannelAttachment[];
  model?: ModelProfile;
}): SkillDeferRule | undefined {
  return (rules ?? []).find((rule) => {
    if (rule.when.nativeIntent !== undefined && rule.when.nativeIntent !== input.nativeIntent) {
      return false;
    }
    if (rule.when.modelSupportsVision !== undefined && rule.when.modelSupportsVision !== (input.model?.supportsVision === true)) {
      return false;
    }
    const attachmentKinds = rule.when.attachmentKinds ?? [];
    if (attachmentKinds.length > 0) {
      const kinds = new Set(readyRoutableAttachments(input.attachments).map((attachment) => attachment.kind));
      if (!attachmentKinds.some((kind) => kinds.has(kind))) {
        return false;
      }
    }
    const promptMatches = rule.when.promptMatches ?? [];
    if (promptMatches.length > 0 && !promptMatches.some((pattern) => patternMatches(pattern, input))) {
      return false;
    }

    return true;
  });
}

function patternMatches(pattern: SkillPattern, input: {
  normalized: string;
  nativeIntent: NativeIntent;
  attachments?: ChannelAttachment[];
}): boolean {
  switch (pattern.type) {
    case "contains":
      return input.normalized.includes(normalize(pattern.value));
    case "regex":
      try {
        return new RegExp(pattern.value, "iu").test(input.normalized);
      } catch {
        return input.normalized.includes(normalize(pattern.value));
      }
    case "attachment-kind":
      return readyRoutableAttachments(input.attachments).some((attachment) => attachment.kind === pattern.value);
    case "native-intent":
      return input.nativeIntent === pattern.value;
  }
}

function readyRoutableAttachments(attachments: ChannelAttachment[] | undefined): Array<ChannelAttachment & { kind: Exclude<ChannelAttachmentKind, "link" | "unknown"> }> {
  return (attachments ?? []).filter((attachment): attachment is ChannelAttachment & { kind: Exclude<ChannelAttachmentKind, "link" | "unknown"> } =>
    (attachment.status === undefined || attachment.status === "ready") &&
    isRoutableAttachmentKind(attachment.kind)
  );
}

function hasReadyAttachmentKind(
  attachments: Array<ChannelAttachment & { kind: Exclude<ChannelAttachmentKind, "link" | "unknown"> }>,
  kinds: Array<Exclude<ChannelAttachmentKind, "link" | "unknown">>
): boolean {
  return attachments.some((attachment) => kinds.includes(attachment.kind));
}

function hasReadyImageAttachment(attachments: ChannelAttachment[] | undefined): boolean {
  return readyRoutableAttachments(attachments).some((attachment) => attachment.kind === "image");
}

function asksToUseAttachedImage(normalized: string): boolean {
  return /\b(this|attached|uploaded|reference|based on|use this|from this|edit|modify|transform|turn this|make this)\b/iu.test(normalized) &&
    /\b(image|picture|photo|attachment|upload|reference)\b/iu.test(normalized);
}

function matchesImageGeneration(normalized: string): boolean {
  return /\b(generate|create|make|draw|render)\b.{0,80}\b(image|picture|illustration|icon|poster|logo|visual|artwork)\b/iu.test(normalized) ||
    /\b(image|picture|illustration|icon|poster|logo|visual|artwork)\b.{0,80}\b(generate|create|make|draw|render)\b/iu.test(normalized);
}

function matchesVoiceTranscription(normalized: string): boolean {
  return /\b(transcribe|transcription|read|summarize)\b.{0,80}\b(audio|voice|voice note|recording|speech)\b/iu.test(normalized);
}

function matchesSpeechGeneration(normalized: string): boolean {
  return /\b(text to speech|tts|read aloud|speak this|say this|spoken reply|generate speech)\b/iu.test(normalized);
}

function matchesCodeReview(normalized: string): boolean {
  return /\b(review|audit|inspect)\b.{0,80}\b(pr|pull request|merge request|diff|patch|implementation|code)\b/iu.test(normalized) ||
    /\b(pr|pull request|merge request|diff|patch|implementation|code)\b.{0,80}\b(review|audit|inspect)\b/iu.test(normalized);
}

function matchesRepoChange(normalized: string): boolean {
  return /\b(implement|fix|change|update|modify|refactor|add|remove)\b.{0,80}\b(code|repo|repository|file|files|test|tests|feature|bug|command|cli)\b/iu.test(normalized) ||
    /\b(can you|please|let'?s)\b.{0,40}\b(implement|fix|change|update|modify|refactor|add|remove)\b/iu.test(normalized);
}

function matchesDocsWriting(normalized: string): boolean {
  return /\b(write|draft|create|update|revise|edit)\b.{0,80}\b(docs|documentation|readme|guide|manual|release notes|changelog)\b/iu.test(normalized) ||
    /\b(docs|documentation|readme|guide|manual|release notes|changelog)\b.{0,80}\b(write|draft|create|update|revise|edit)\b/iu.test(normalized);
}

function matchesReleaseValidation(normalized: string): boolean {
  return /\b(validate|verify|check|test|smoke)\b.{0,80}\b(release|branch|merge|before merge|pre[- ]?merge|readiness)\b/iu.test(normalized) ||
    /\b(release|branch|merge|before merge|pre[- ]?merge|readiness)\b.{0,80}\b(validate|verify|check|test|smoke)\b/iu.test(normalized);
}

function matchesArchitectureAdvice(normalized: string): boolean {
  return /\b(what do you think|thoughts|opinion|feedback|review)\b.{0,80}\b(architecture|design|approach|plan|proposal|system)\b/iu.test(normalized) ||
    /\b(architecture|design|approach|plan|proposal|system)\b.{0,80}\b(what do you think|thoughts|opinion|feedback)\b/iu.test(normalized);
}

function matchesResearch(normalized: string): boolean {
  return /\b(research|investigate|look up|find sources|survey)\b/iu.test(normalized) ||
    /\bcompare\b.{0,80}\b(options|approaches|papers|sources|evidence|market|competitors)\b/iu.test(normalized);
}

function routingLabels(skill: LoadedSkill | SkillDefinition): string[] {
  return skill.routing?.labels ?? [];
}

function routingToolsets(skill: LoadedSkill | SkillDefinition): ToolsetName[] {
  return skill.routing?.requiredToolsets ?? skill.requiredToolsets;
}

function nativeIntentFromSkill(skill: LoadedSkill | SkillDefinition): NativeIntent | undefined {
  return skill.routing?.triggerPatterns?.find((pattern): pattern is SkillPattern & { type: "native-intent" } =>
    pattern.type === "native-intent"
  )?.value;
}

function confirmationForSkills(skills: Array<LoadedSkill | SkillDefinition>, evidence: IntentRouteEvidence[]): boolean {
  const requested = skills.some((skill) => skill.routing?.confirmation === "ask");
  if (requested) {
    evidence.push({
      kind: "confirmation-policy",
      detail: "Skill routing metadata requests confirmation.",
      weight: 0
    });
  }

  return requested;
}

function toolsetEvidence(nativeIntent: NativeIntent, skills: Array<LoadedSkill | SkillDefinition>): IntentRouteEvidence[] {
  const evidence: IntentRouteEvidence[] = [];
  const nativeToolsets = NATIVE_INTENT_TOOLSETS[nativeIntent];
  if (nativeToolsets.length > 0) {
    evidence.push({
      kind: "toolset-derived",
      detail: `Native intent ${nativeIntent} suggests ${nativeToolsets.join(", ")}.`,
      weight: 0
    });
  }
  for (const skill of skills) {
    const toolsets = routingToolsets(skill);
    if (toolsets.length > 0) {
      evidence.push({
        kind: "toolset-derived",
        source: skill.name,
        detail: `Skill metadata suggests ${toolsets.join(", ")}.`,
        weight: 0
      });
    }
  }

  return evidence;
}

function confidenceFromEvidence(evidence: IntentRouteEvidence[]): number {
  return Math.max(0.35, ...evidence.map((entry) => entry.weight ?? 0));
}

function compareSkillMatches(left: SkillMatch, right: SkillMatch): number {
  return right.score - left.score ||
    (right.skill.routing?.priority ?? 0) - (left.skill.routing?.priority ?? 0) ||
    left.skill.name.localeCompare(right.skill.name);
}

function selectSkillMatches(matches: SkillMatch[]): {
  primary?: SkillMatch;
  supporting: SkillMatch[];
} {
  const eligible = matches.filter((match) => match.score >= PRIMARY_SKILL_MIN_SCORE);
  return {
    primary: eligible[0],
    supporting: eligible.slice(1, SUPPORTING_SKILL_LIMIT + 1)
  };
}

function routeCandidateFromMatch(
  match: SkillMatch,
  selected: {
    primarySkillName: string | undefined;
    supportingSkillNames: ReadonlySet<string>;
  }
): SkillRouteCandidate {
  const role: SkillRouteCandidate["role"] = isNegativeMatch(match)
    ? "rejected"
    : match.deferred
      ? "deferred"
      : match.skill.name === selected.primarySkillName
        ? "primary"
        : selected.supportingSkillNames.has(match.skill.name)
          ? "supporting"
          : "candidate";
  return {
    skill: match.skill,
    role,
    score: match.score,
    confidence: clampConfidence(match.score),
    evidence: match.evidence,
    reason: match.deferReason
  };
}

function isNegativeMatch(match: SkillMatch): boolean {
  return match.evidence.some((entry) => entry.kind === "skill-negative-pattern");
}

function taskClassFromNativeIntent(nativeIntent: NativeIntent): IntentTaskClass {
  switch (nativeIntent) {
    case "image-generation":
    case "speech-generation":
      return "media-generation";
    case "attachment-analysis":
    case "voice-transcription":
      return "attachment-analysis";
    case "general":
      return "general";
  }
}

function rationaleFor(nativeIntent: NativeIntent, labels: string[], skills: Array<LoadedSkill | SkillDefinition>, evidence: IntentRouteEvidence[]): string {
  if (skills.length > 0) {
    return `Matched ${skills.map((skill) => skill.name).join(", ")} via ${evidence.map((entry) => entry.kind).join(", ")}.`;
  }
  if (nativeIntent !== "general") {
    return `Detected native intent ${nativeIntent}.`;
  }
  if (labels.length > 0) {
    return `Detected route labels ${labels.join(", ")}.`;
  }

  return "No specialized intent detected.";
}

function describePattern(pattern: SkillPattern): string {
  return `${pattern.type}:${pattern.value}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRoutableAttachmentKind(kind: ChannelAttachmentKind): kind is Exclude<ChannelAttachmentKind, "link" | "unknown"> {
  return kind === "image" ||
    kind === "document" ||
    kind === "file" ||
    kind === "audio" ||
    kind === "video" ||
    kind === "voice";
}

function parseSlashInvocation(
  prompt: string,
  registry: SkillRegistry
): SlashInvocationMatch | undefined {
  const trimmed = prompt.trim();
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+(?<args>[\s\S]*))?$/u.exec(trimmed);

  if (match === null) {
    return undefined;
  }

  const name = match[1];
  const args = match.groups?.args ?? "";
  const skill = registry.get(name);

  return skill === undefined
    ? { kind: "unknown", name, args }
    : { kind: "known", skill, args };
}
