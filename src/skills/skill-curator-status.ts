import type { SkillLifecycleState, SkillSourceKind } from "../contracts/skill.js";
import type { SkillUsageRecord } from "./skill-evolution.js";

export type SkillCuratorRecommendation =
  | "keep"
  | "review"
  | "archive"
  | "restore";

export type SkillCuratorStatus = {
  skillName: string;
  source?: SkillSourceKind;
  state: SkillLifecycleState;
  pinned: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  successRate?: number;
  recommendation: SkillCuratorRecommendation;
  reason: string;
};

export function summarizeSkillCuratorStatus(records: SkillUsageRecord[]): SkillCuratorStatus[] {
  return records
    .map((record: SkillUsageRecord) => summarizeUsageRecord(record))
    .sort((left: SkillCuratorStatus, right: SkillCuratorStatus) =>
      priorityForRecommendation(left.recommendation) - priorityForRecommendation(right.recommendation) ||
      left.skillName.localeCompare(right.skillName)
    );
}

function summarizeUsageRecord(record: SkillUsageRecord): SkillCuratorStatus {
  const attempts = record.successCount + record.failureCount;
  const successRate = attempts === 0 ? undefined : record.successCount / attempts;
  const recommendation = recommend(record, successRate);

  return {
    skillName: record.skillName,
    source: record.source,
    state: record.state,
    pinned: record.pinned,
    useCount: record.useCount,
    viewCount: record.viewCount,
    patchCount: record.patchCount,
    successRate,
    recommendation,
    reason: reasonFor(record, recommendation, successRate)
  };
}

function recommend(record: SkillUsageRecord, successRate: number | undefined): SkillCuratorRecommendation {
  if (record.pinned) {
    return "keep";
  }

  if (record.state === "archived") {
    return record.useCount > 0 ? "restore" : "keep";
  }

  if (record.useCount === 0 && record.viewCount === 0) {
    return "archive";
  }

  if (successRate !== undefined && successRate < 0.5 && record.failureCount >= 3) {
    return "review";
  }

  return "keep";
}

function reasonFor(
  record: SkillUsageRecord,
  recommendation: SkillCuratorRecommendation,
  successRate: number | undefined
): string {
  if (record.pinned) {
    return "Skill is pinned.";
  }

  if (recommendation === "archive") {
    return "Skill has no recorded views or use.";
  }

  if (recommendation === "restore") {
    return "Archived skill has usage history.";
  }

  if (recommendation === "review") {
    return `Skill failure rate is high (${Math.round((1 - (successRate ?? 0)) * 100)}%).`;
  }

  return "Skill usage is healthy.";
}

function priorityForRecommendation(recommendation: SkillCuratorRecommendation): number {
  if (recommendation === "review") return 0;
  if (recommendation === "restore") return 1;
  if (recommendation === "archive") return 2;
  return 3;
}
