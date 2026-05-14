import type {
  AuxiliaryRouteSummary,
  FallbackRouteSummary,
  ModelRow,
  PrimaryRouteSummary,
  ProviderRow,
  SetupReviewSummary
} from "./model-view-models.js";
import type { ModelRefreshReport } from "../reports/model-reports.js";

export function renderModelList(rows: ModelRow[], options?: { verbose?: boolean }): string {
  if (rows.length === 0) {
    return "No models found.";
  }
  const lines: string[] = [];
  if (options?.verbose) {
    lines.push("Model catalog:");
  }
  for (const row of rows) {
    const badges = row.capabilityBadges
      .filter((b) => b.enabled)
      .map((b) => b.kind)
      .join(", ");
    const badgeStr = badges ? ` [${badges}]` : "";
    const readiness = row.status === "ready" ? "" : ` (${row.status})`;
    lines.push(`  ${row.label}${badgeStr}${readiness}`);
  }
  return lines.join("\n");
}

export function renderProviderList(rows: ProviderRow[]): string {
  if (rows.length === 0) {
    return "No providers found.";
  }
  const lines = ["Providers:"];
  for (const row of rows) {
    const status = row.executable ? "executable" : "catalog-only";
    const readiness = row.readiness.ready ? "" : " (not ready)";
    lines.push(`  ${row.provider} - ${row.name} (${status})${readiness}`);
  }
  return lines.join("\n");
}

export function renderPrimaryRouteSummary(summary: PrimaryRouteSummary): string {
  const route = summary.route;
  const lines = [
    `Primary route: ${route.label}`,
    `Status: ${route.status}`,
    `Endpoint: ${route.endpointReadiness.ready ? "ready" : "not ready"}`,
    `Credential: ${route.credentialReadiness.ready ? "ready" : "not ready"}`,
    `Fallbacks: ${summary.fallbackSummaries.length}`
  ];
  return lines.join("\n");
}

export function renderFallbackRouteSummaries(summaries: FallbackRouteSummary[]): string {
  if (summaries.length === 0) {
    return "No fallback routes configured.";
  }
  const lines = ["Fallback routes:"];
  for (const summary of summaries) {
    const route = summary.route;
    lines.push(`  ${summary.order}. ${route.label} (${route.status})`);
  }
  return lines.join("\n");
}

export function renderAuxiliaryRouteSummaries(summaries: AuxiliaryRouteSummary[]): string {
  if (summaries.length === 0) {
    return "No auxiliary routes configured.";
  }
  const lines = ["Auxiliary routes:"];
  for (const summary of summaries) {
    const routeLabel = summary.route ? summary.route.label : "fallback to main";
    lines.push(`  ${summary.task}: ${routeLabel} (source: ${summary.source})`);
  }
  return lines.join("\n");
}

export function renderSetupReview(summary: SetupReviewSummary): string {
  const lines = [
    `Setup review for ${summary.route.label}`,
    `Provider kind: ${summary.providerKind}`,
    `Endpoint: ${summary.endpointVisible}`,
    `Credential: ${summary.credentialVisible}`
  ];
  if (summary.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of summary.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines.join("\n");
}

export function renderModelSearchResults(query: string, rows: ModelRow[]): string {
  if (rows.length === 0) {
    return `No models matched "${query}".`;
  }
  const lines: string[] = [`Search results for "${query}":`];
  for (const row of rows) {
    const badges = row.capabilityBadges
      .filter((b) => b.enabled)
      .map((b) => b.kind)
      .join(", ");
    const badgeStr = badges ? ` [${badges}]` : "";
    const readiness = row.status === "ready" ? "" : ` (${row.status})`;
    lines.push(`  ${row.label}${badgeStr}${readiness}`);
  }
  return lines.join("\n");
}

export function renderRefreshReport(report: ModelRefreshReport): string {
  const lines = [
    "Catalog refresh complete",
    `Source: ${report.sourceDomain}`,
    `Cache: ${report.cachePath}`,
    `Timestamp: ${report.snapshotTimestamp}`,
    `Models: ${report.modelsCount}`,
    `Providers: ${report.providersCount}`,
    `Changed: ${report.cacheChanged ? "yes" : "no"}`
  ];
  return lines.join("\n");
}

export function renderModelPickerSuccess(summary: import("./model-view-models.js").PickerSuccessSummary): string {
  const lines = [
    `Model switched: ${summary.model}`,
    `Provider: ${summary.provider}`,
    `Context: ${summary.contextWindowTokens.toLocaleString()} tokens`
  ];
  if (summary.baseUrl !== undefined) {
    lines.push(`Endpoint: ${summary.baseUrl}`);
  }
  if (summary.envVarName !== undefined) {
    if (summary.credentialStored) {
      lines.push(`Credential: stored as ${summary.envVarName}`);
    } else if (summary.credentialSkipped) {
      lines.push(`Credential: expects ${summary.envVarName} to be set externally`);
    } else {
      lines.push(`Credential: uses ${summary.envVarName}`);
    }
  }
  lines.push("Saved as preferred model.");
  lines.push(`Config: ${summary.configPath}`);
  return lines.join("\n");
}

export function renderModelPickerCancellation(): string {
  return "No changes were made.";
}
