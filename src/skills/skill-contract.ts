import type {
  LoadedSkill,
  SelectedSkillPromptContent,
  SkillContract,
  SkillReferenceIndexEntry,
  SkillResourceEntry,
  SkillSectionIndexEntry
} from "../contracts/skill.js";
import {
  SKILL_CONTRACT_MAX_CHARS,
  SKILL_ROOT_INLINE_MAX_CHARS
} from "./skill-limits.js";

export function buildSkillContract(skill: LoadedSkill): SkillContract | undefined {
  if (skill.instructions.length <= SKILL_ROOT_INLINE_MAX_CHARS) {
    return undefined;
  }

  const sectionIndex = extractSectionIndex(skill.instructions);
  const referenceIndex = buildReferenceIndex(skill.resources);
  const scriptIndex = buildScriptIndex(skill.resources);

  return {
    summary: buildContractSummary({
      skill,
      sectionIndex,
      referenceIndex,
      scriptIndex
    }),
    sectionIndex,
    referenceIndex,
    scriptIndex,
    originalChars: skill.instructions.length
  };
}

export function selectSkillPromptContent(skill: LoadedSkill): SelectedSkillPromptContent {
  const referencePaths = resourcePaths(skill.resources, (resource) => resource.kind !== "script");
  const scriptPaths = resourcePaths(skill.resources, (resource) => resource.kind === "script");

  if (skill.instructions.length <= SKILL_ROOT_INLINE_MAX_CHARS) {
    return {
      name: skill.name,
      description: skill.description,
      content: skill.instructions,
      contentMode: "full",
      originalChars: skill.instructions.length,
      truncated: false,
      referencePaths,
      scriptPaths
    };
  }

  const contract = skill.contract ?? buildSkillContract(skill);
  const loadInstruction = fullLoadInstruction(skill.name);

  return {
    name: skill.name,
    description: skill.description,
    content: contract?.summary ?? fallbackContractSummary(skill, loadInstruction),
    contentMode: "contract",
    originalChars: skill.instructions.length,
    truncated: true,
    referencePaths,
    scriptPaths,
    loadInstruction
  };
}

function buildContractSummary(input: {
  skill: LoadedSkill;
  sectionIndex: SkillSectionIndexEntry[];
  referenceIndex: SkillReferenceIndexEntry[];
  scriptIndex: SkillReferenceIndexEntry[];
}): string {
  const loadInstruction = fullLoadInstruction(input.skill.name);
  const lines = [
    `Skill contract: ${input.skill.name}`,
    `Description: ${input.skill.description}`,
    `Original root instruction chars: ${input.skill.instructions.length}`,
    `Inline prompt cap: ${SKILL_ROOT_INLINE_MAX_CHARS}`,
    "The root SKILL.md instructions exceed the inline prompt cap. This contract is an index, not the full skill body.",
    `Load full root instructions later with: ${loadInstruction}`,
    "Reference/resource contents are not included in this contract.",
    "",
    "Heading index:",
    ...formatHeadingIndex(input.sectionIndex),
    "",
    "Linked resources:",
    ...formatResourceIndex(input.referenceIndex),
    "",
    "Linked scripts:",
    ...formatResourceIndex(input.scriptIndex)
  ];

  return capContractSummary(lines.join("\n"));
}

function fallbackContractSummary(skill: LoadedSkill, loadInstruction: string): string {
  return capContractSummary([
    `Skill contract: ${skill.name}`,
    `Description: ${skill.description}`,
    `Original root instruction chars: ${skill.instructions.length}`,
    `Inline prompt cap: ${SKILL_ROOT_INLINE_MAX_CHARS}`,
    "The root SKILL.md instructions exceed the inline prompt cap. This contract is an index, not the full skill body.",
    `Load full root instructions later with: ${loadInstruction}`,
    "Reference/resource contents are not included in this contract."
  ].join("\n"));
}

function extractSectionIndex(instructions: string): SkillSectionIndexEntry[] {
  const sections: SkillSectionIndexEntry[] = [];
  const lines = instructions.matchAll(/[^\n]*(?:\n|$)/gu);
  let offset = 0;
  let inFence = false;

  for (const match of lines) {
    const line = match[0];
    if (line.length === 0) {
      break;
    }

    const withoutNewline = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (/^ {0,3}(```|~~~)/u.test(withoutNewline)) {
      inFence = !inFence;
      offset += line.length;
      continue;
    }

    if (!inFence) {
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(withoutNewline);
      if (heading !== null) {
        const marker = heading[1] ?? "";
        const text = (heading[2] ?? "").trim();
        if (text.length > 0) {
          const markerOffset = withoutNewline.indexOf(marker);
          sections.push({
            heading: text,
            level: marker.length,
            charOffset: offset + Math.max(0, markerOffset)
          });
        }
      }
    }

    offset += line.length;
  }

  return sections.map((section, index) => ({
    ...section,
    charLength: (sections[index + 1]?.charOffset ?? instructions.length) - section.charOffset
  }));
}

function buildReferenceIndex(resources: SkillResourceEntry[] | undefined): SkillReferenceIndexEntry[] {
  return (resources ?? [])
    .filter((resource) => resource.kind !== "script")
    .map(resourceIndexEntry);
}

function buildScriptIndex(resources: SkillResourceEntry[] | undefined): SkillReferenceIndexEntry[] {
  return (resources ?? [])
    .filter((resource) => resource.kind === "script")
    .map(resourceIndexEntry);
}

function resourceIndexEntry(resource: SkillResourceEntry): SkillReferenceIndexEntry {
  return {
    path: resource.path,
    kind: resource.kind
  };
}

function formatHeadingIndex(sections: SkillSectionIndexEntry[]): string[] {
  if (sections.length === 0) {
    return ["- No Markdown headings were found in the root instructions."];
  }

  const importantSections = sections.filter((section) => section.level <= 3);
  const displayedSections = importantSections.length > 0 ? importantSections : sections;

  return displayedSections
    .slice(0, 12)
    .map((section) => `- ${"#".repeat(section.level)} ${section.heading} @${section.charOffset}`);
}

function formatResourceIndex(resources: SkillReferenceIndexEntry[]): string[] {
  if (resources.length === 0) {
    return ["- None indexed."];
  }

  return resources
    .slice(0, 20)
    .map((resource) => {
      const labels = [
        resource.path,
        `kind=${resource.kind}`,
        resource.chars === undefined ? undefined : `chars=${resource.chars}`,
        resource.description === undefined ? undefined : `description=${resource.description}`
      ].filter((label): label is string => label !== undefined);
      return `- ${labels.join(" · ")}`;
    });
}

function resourcePaths(
  resources: SkillResourceEntry[] | undefined,
  include: (resource: SkillResourceEntry) => boolean
): string[] {
  return (resources ?? [])
    .filter(include)
    .map((resource) => resource.path)
    .sort((left, right) => left.localeCompare(right));
}

function fullLoadInstruction(skillName: string): string {
  return `skill.read({ "name": ${JSON.stringify(skillName)}, "mode": "full" })`;
}

function capContractSummary(summary: string): string {
  if (summary.length <= SKILL_CONTRACT_MAX_CHARS) {
    return summary;
  }

  const marker = "\n\n[Contract summary truncated. Load the full root instructions with skill.read({ \"name\": \"<skill>\", \"mode\": \"full\" }).]\n";
  const headChars = Math.max(0, SKILL_CONTRACT_MAX_CHARS - marker.length);
  return `${summary.slice(0, headChars).trimEnd()}${marker}`;
}
