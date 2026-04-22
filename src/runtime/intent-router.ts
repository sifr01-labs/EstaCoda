import type { IntentLabel, IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";
import type { SkillRegistry } from "../skills/skill-registry.js";

export type IntentRouterOptions = {
  skillRegistry: SkillRegistry;
};

export class IntentRouter {
  readonly #skillRegistry: SkillRegistry;

  constructor(options: IntentRouterOptions) {
    this.#skillRegistry = options.skillRegistry;
  }

  route(prompt: string): IntentRoute {
    const slashInvocation = parseSlashInvocation(prompt, this.#skillRegistry);

    if (slashInvocation !== undefined) {
      return {
        labels: ["skill-invocation"],
        confidence: 1,
        suggestedToolsets: slashInvocation.skill.requiredToolsets,
        suggestedSkills: [slashInvocation.skill],
        invocation: {
          name: slashInvocation.skill.name,
          args: slashInvocation.args,
          explicit: true
        },
        confirmationRequired: false,
        rationale: `Explicit slash skill invocation for ${slashInvocation.skill.name}.`
      };
    }

    const normalized = normalize(prompt);
    const labels = detectLabels(normalized);
    const suggestedToolsets = toolsetsFor(labels);
    const promptMatchedSkills = this.#skillRegistry.matchPrompt(prompt);
    const intentMatchedSkills = this.#skillRegistry
      .list()
      .filter((skill) => skillMatchesIntent(skill, labels));
    const suggestedSkills = dedupeSkills([...intentMatchedSkills, ...promptMatchedSkills]);

    return {
      labels: labels.length === 0 ? ["general"] : labels,
      confidence: confidenceFor(labels, suggestedSkills),
      suggestedToolsets,
      suggestedSkills,
      confirmationRequired: requiresConfirmation(labels),
      rationale: rationaleFor(labels, suggestedSkills)
    };
  }
}

function detectLabels(normalized: string): IntentLabel[] {
  const labels: IntentLabel[] = [];

  if (hasAny(normalized, ["youtube.com", "youtu.be", "youtube", "video", "transcript"])) {
    labels.push("youtube-video");
  }

  if (hasAny(normalized, ["knowledge base", "kb", "durable notes", "archive", "everything discussed"])) {
    labels.push("knowledge-base");
  }

  if (hasAny(normalized, ["telegram", "chat", "uploaded", "sent it", "image", "photo", "voice note"])) {
    labels.push("telegram-media");
  }

  if (hasAny(normalized, [".pdf", "pdf", "document"])) {
    labels.push("pdf-document");
  }

  if (hasAny(normalized, ["fix", "codebase", "test", "bug", "typescript", "python", "repo"])) {
    labels.push("codebase-task");
  }

  if (hasAny(normalized, ["research", "look up", "search", "sources", "compare"])) {
    labels.push("web-research");
  }

  if (hasAny(normalized, ["create skill", "make this reusable", "turn this into a skill", "skill from"])) {
    labels.push("skill-creation");
  }

  if (hasAny(normalized, ["remember", "from now on", "my preference", "i prefer"])) {
    labels.push("memory-update");
  }

  return dedupe(labels);
}

function toolsetsFor(labels: IntentLabel[]): ToolsetName[] {
  const toolsets: ToolsetName[] = [];

  for (const label of labels) {
    if (label === "youtube-video") {
      toolsets.push("web", "browser", "research");
    }

    if (label === "knowledge-base") {
      toolsets.push("research", "files", "memory");
    }

    if (label === "telegram-media") {
      toolsets.push("telegram", "media", "files");
    }

    if (label === "pdf-document") {
      toolsets.push("media", "files", "research");
    }

    if (label === "codebase-task") {
      toolsets.push("coding", "files", "shell-readonly");
    }

    if (label === "web-research") {
      toolsets.push("web", "browser", "research");
    }

    if (label === "skill-creation") {
      toolsets.push("research", "files", "memory");
    }

    if (label === "memory-update") {
      toolsets.push("memory");
    }
  }

  return dedupe(toolsets);
}

function skillMatchesIntent(skill: SkillDefinition, labels: IntentLabel[]): boolean {
  if (skill.name === "youtube-knowledge-base") {
    return labels.includes("youtube-video") || labels.includes("knowledge-base");
  }

  if (skill.name === "telegram-media-analysis") {
    return labels.includes("telegram-media");
  }

  return false;
}

function confidenceFor(labels: IntentLabel[], skills: Array<LoadedSkill | SkillDefinition>): number {
  if (skills.length > 0 && labels.length >= 2) {
    return 0.9;
  }

  if (skills.length > 0) {
    return 0.8;
  }

  if (labels.length > 0) {
    return 0.65;
  }

  return 0.35;
}

function requiresConfirmation(labels: IntentLabel[]): boolean {
  return labels.includes("memory-update") || labels.includes("skill-creation");
}

function rationaleFor(labels: IntentLabel[], skills: Array<LoadedSkill | SkillDefinition>): string {
  if (skills.length > 0) {
    return `Matched ${skills.map((skill) => skill.name).join(", ")} from intent labels ${labels.join(", ")}.`;
  }

  if (labels.length > 0) {
    return `Detected intent labels ${labels.join(", ")} but no skill matched yet.`;
  }

  return "No specialized intent detected.";
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function dedupeSkills(skills: Array<LoadedSkill | SkillDefinition>): Array<LoadedSkill | SkillDefinition> {
  const seen = new Set<string>();
  const result: Array<LoadedSkill | SkillDefinition> = [];

  for (const skill of skills) {
    if (seen.has(skill.name)) {
      continue;
    }

    seen.add(skill.name);
    result.push(skill);
  }

  return result;
}

function parseSlashInvocation(
  prompt: string,
  registry: SkillRegistry
): { skill: LoadedSkill | SkillDefinition; args: string } | undefined {
  const trimmed = prompt.trim();
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+(?<args>[\s\S]*))?$/u.exec(trimmed);

  if (match === null) {
    return undefined;
  }

  const skillName = match[1];
  const skill = registry.get(skillName);

  if (skill === undefined) {
    return undefined;
  }

  return {
    skill,
    args: match.groups?.args ?? ""
  };
}
