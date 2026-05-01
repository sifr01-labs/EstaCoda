import type { LoadedSkill, SkillDefinition, SkillLifecycleState } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";

export type SkillVisibilityContext = {
  platform: string;
  availableToolsets: Set<ToolsetName>;
  availableTools: Set<string>;
  lifecycleState?: SkillLifecycleState;
  explicitInvocation?: boolean;
  routeConfidence?: number;
};

export type SkillVisibilityResult = {
  visible: boolean;
  reasons: string[];
};

export function evaluateSkillVisibility(
  skill: LoadedSkill | SkillDefinition,
  context: SkillVisibilityContext
): SkillVisibilityResult {
  const reasons: string[] = [];
  const lifecycleState = context.lifecycleState ?? ("lifecycleState" in skill ? skill.lifecycleState : undefined);

  if (lifecycleState === "archived" && context.explicitInvocation !== true) {
    reasons.push("archived");
  }

  if (
    lifecycleState === "stale" &&
    context.explicitInvocation !== true &&
    (context.routeConfidence ?? 0) < 0.85
  ) {
    reasons.push("stale-weak-match");
  }

  const platform = normalizePlatform(context.platform);
  const skillPlatforms = (skill.platforms ?? []).map(normalizePlatform).filter((entry) => entry.length > 0);

  if (skillPlatforms.length > 0 && !skillPlatforms.includes(platform)) {
    reasons.push(`platform:${platform}`);
  }

  for (const toolset of skill.requiredToolsets) {
    if (!context.availableToolsets.has(toolset)) {
      reasons.push(`missing-toolset:${toolset}`);
    }
  }

  for (const toolset of skill.visibility?.requiresToolsets ?? []) {
    if (!context.availableToolsets.has(toolset)) {
      reasons.push(`requires-toolset:${toolset}`);
    }
  }

  for (const toolset of skill.visibility?.fallbackForToolsets ?? []) {
    if (context.availableToolsets.has(toolset)) {
      reasons.push(`fallback-toolset:${toolset}`);
    }
  }

  for (const tool of skill.visibility?.requiresTools ?? []) {
    if (!context.availableTools.has(tool)) {
      reasons.push(`requires-tool:${tool}`);
    }
  }

  for (const tool of skill.visibility?.fallbackForTools ?? []) {
    if (context.availableTools.has(tool)) {
      reasons.push(`fallback-tool:${tool}`);
    }
  }

  return {
    visible: reasons.length === 0,
    reasons
  };
}

function normalizePlatform(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized === "darwin" || normalized === "macos" || normalized === "mac" || normalized === "osx") {
    return "darwin";
  }

  if (normalized === "win32" || normalized === "windows" || normalized === "win") {
    return "win32";
  }

  return normalized;
}
