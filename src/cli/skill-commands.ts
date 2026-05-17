import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliOptions, CliCommandResult } from "./cli.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";

export async function skillsCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const homeDir = options.homeDir ?? process.env.HOME ?? "";

  switch (subcommand) {
    case "list":
      return listSkills(homeDir, subArgs);
    case "inspect":
      return inspectSkill(homeDir, subArgs);
    case "view":
      return viewSkill(homeDir, subArgs);
    default:
      return {
        handled: true,
        exitCode: 1,
        output: [
          "Usage: estacoda skills <subcommand>",
          "",
          "Subcommands:",
          "  list                       List available skills",
          "  inspect <skill>            Show metadata for a skill",
          "  view <skill>               View the full SKILL.md content for a skill",
          ""
        ].join("\n")
      };
  }
}

type SkillRef = {
  name: string;
  description: string;
  version: string;
  category: string;
  path: string;
};

async function scanSkills(root: string): Promise<SkillRef[]> {
  const skills: SkillRef[] = [];
  if (!existsSync(root)) return skills;

  async function scan(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          const content = await readFile(path, "utf8");
          const parsed = parseSkillFrontmatter(content);
          skills.push({
            name: parsed.name ?? "unknown",
            description: parsed.description ?? "",
            version: parsed.version ?? "",
            category: parsed.category ?? "general",
            path
          });
        } catch {
          // skip malformed
        }
      }
    }
  }

  await scan(root);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = value;
    }
  }
  return result;
}

async function listSkills(homeDir: string, _args: string[]): Promise<CliCommandResult> {
  const skillsRoot = resolveSkillsRoot(homeDir);
  const skills = await scanSkills(skillsRoot);

  if (skills.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No skills found."
    };
  }

  const lines: string[] = [];
  for (const skill of skills) {
    lines.push(`${skill.name} (${skill.category}) — ${skill.description}`);
  }

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

async function inspectSkill(homeDir: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda skills inspect <skill>" };
  }

  const skillsRoot = resolveSkillsRoot(homeDir);
  const skills = await scanSkills(skillsRoot);
  const skill = skills.find((s) => s.name === id);

  if (skill === undefined) {
    return { handled: true, exitCode: 1, output: `Skill not found: ${id}` };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Name:        ${skill.name}`,
      `Description: ${skill.description}`,
      `Version:     ${skill.version || "unset"}`,
      `Category:    ${skill.category}`,
      `Path:        ${skill.path}`
    ].join("\n")
  };
}

async function viewSkill(homeDir: string, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda skills view <skill>" };
  }

  const skillsRoot = resolveSkillsRoot(homeDir);
  const skills = await scanSkills(skillsRoot);
  const skill = skills.find((s) => s.name === id);

  if (skill === undefined) {
    return { handled: true, exitCode: 1, output: `Skill not found: ${id}` };
  }

  try {
    const content = await readFile(skill.path, "utf8");
    return {
      handled: true,
      exitCode: 0,
      output: content
    };
  } catch {
    return { handled: true, exitCode: 1, output: `Could not read skill file: ${skill.path}` };
  }
}

function resolveSkillsRoot(homeDir: string): string {
  const profileId = readActiveProfile({ homeDir }).profileId ?? defaultProfileId();
  return resolveProfileStateHome({ homeDir, profileId }).skillsPath;
}
