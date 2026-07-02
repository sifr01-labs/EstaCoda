export type LiveToolDiagnostic = {
  status: "ready" | "blocked";
  lines: string[];
  warnings: string[];
};

export type DoctorLocale = "en" | "ar";

export type DoctorCheckSeverity = "healthy" | "info" | "warning" | "blocked";

export type DoctorVerdictStatus = "ready" | "warning" | "blocked";

export type DoctorCheck = {
  readonly id: string;
  readonly label: string;
  readonly severity: DoctorCheckSeverity;
  readonly summary?: string;
};

export type DoctorSection = {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly DoctorCheck[];
};

export type DoctorProviderRouteStatus = "ready" | "warning" | "blocked" | "disabled";

export type DoctorProviderRoute = {
  readonly id: string;
  readonly kind: "primary" | "fallback" | "auxiliary";
  readonly label: string;
  readonly provider?: string;
  readonly model?: string;
  readonly status: DoctorProviderRouteStatus;
  readonly summary: string;
  readonly details: readonly string[];
};

export type DoctorAction = {
  readonly id: string;
  readonly severity: Exclude<DoctorCheckSeverity, "healthy">;
  readonly title: string;
  readonly detailLines?: readonly string[];
  readonly command?: string;
  readonly commandLabel?: string;
};

export type DoctorVerdict = {
  readonly status: DoctorVerdictStatus;
  readonly title: string;
  readonly blockedCount: number;
  readonly warningCount: number;
  readonly healthyCount: number;
};

export type DoctorReport = {
  readonly locale: DoctorLocale;
  readonly profile: string;
  readonly workspace: string;
  readonly home: string;
  readonly model: string;
  readonly configSources: readonly string[];
  readonly sections: readonly DoctorSection[];
  readonly providerRoutes: readonly DoctorProviderRoute[];
  readonly verdict: DoctorVerdict;
  readonly actions: readonly DoctorAction[];
  readonly notes: readonly string[];
};
