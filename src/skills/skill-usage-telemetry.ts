import { createHash } from "node:crypto";
import type { SkillRouteTelemetry, SkillSourceKind } from "../contracts/skill.js";

export type SkillRouteTelemetryInput = {
  skillName: string;
  sourceKind: SkillSourceKind;
  selected: boolean;
  explicitInvocation?: boolean;
  confidence?: number;
  labels?: string[];
  evidence?: string[];
  routeId?: string;
  prompt?: string;
  matchedAt?: string;
};

export function createSkillRouteTelemetry(input: SkillRouteTelemetryInput): SkillRouteTelemetry {
  return {
    skillName: input.skillName,
    sourceKind: input.sourceKind,
    routeId: input.routeId ?? (input.prompt === undefined ? undefined : hashSkillRoutePrompt(input.prompt)),
    matchedAt: input.matchedAt ?? new Date().toISOString(),
    selected: input.selected,
    explicitInvocation: input.explicitInvocation ?? false,
    confidence: clampConfidence(input.confidence ?? 0),
    labels: input.labels ?? [],
    evidence: input.evidence ?? []
  };
}

export function hashSkillRoutePrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
