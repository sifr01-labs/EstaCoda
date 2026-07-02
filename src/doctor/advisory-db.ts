export type SecurityAdvisorySeverity = "low" | "moderate" | "high" | "critical";

export type SecurityAdvisory = {
  readonly id: string;
  readonly packageName: string;
  readonly affectedVersions: string;
  readonly severity: SecurityAdvisorySeverity;
  readonly title: string;
  readonly titleAr?: string;
  readonly recommendation: string;
  readonly recommendationAr?: string;
};

export const BUNDLED_SECURITY_ADVISORIES: readonly SecurityAdvisory[] = [];
