import type { ChannelAttachment, ChannelAttachmentKind, ChannelKind } from "../contracts/channel.js";
import type { IntentLabel, IntentRoute, IntentRouteEvidence, NativeIntent } from "../contracts/intent.js";
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
      const evidence: IntentRouteEvidence[] = [{
        kind: "slash-invocation",
        source: slashInvocation.skill.name,
        detail: `Explicit slash skill invocation for ${slashInvocation.skill.name}.`,
        weight: 1
      }];
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
        labels,
        confidence: confidenceFromEvidence(evidence),
        suggestedToolsets,
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
      const evidence: IntentRouteEvidence[] = [{
        kind: "slash-invocation",
        source: slashInvocation.name,
        detail: `Unknown slash invocation: /${slashInvocation.name}.`,
        weight: 1
      }];

      return {
        nativeIntent: "general",
        labels: ["skill-invocation"],
        confidence: confidenceFromEvidence(evidence),
        suggestedToolsets: [],
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
      .filter((match) => !match.deferred)
      .sort(compareSkillMatches);
    const suggestedSkills = skillMatches.map((match) => match.skill);
    const evidence = [
      ...native.evidence,
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
      labels: labels.length === 0 ? ["general"] : labels,
      confidence: confidenceFromEvidence(evidence),
      suggestedToolsets,
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
