import type { StartupDashboardViewModel } from "../../../contracts/view-model.js";
import type { StartupDashboardState } from "./operatorConsoleState.js";

export type StartupRuntimeMapperInput = {
  readonly viewModel: StartupDashboardViewModel;
  readonly contextWindow?: number;
};

export function mapStartupDashboardViewModelToOperatorConsoleState(
  input: StartupRuntimeMapperInput
): StartupDashboardState {
  const viewModel = input.viewModel;
  return {
    productName: viewModel.agentName,
    orgName: "⟡ SIFR01 ⟡",
    tagline: firstNonEmpty(viewModel.taglines) ?? "sovereign agentic infrastructure",
    version: viewModel.version,
    sessionId: formatStartupSessionId(viewModel.sessionId ?? "pending"),
    session: {
      model: `${viewModel.model.id} ${readinessSymbol(viewModel.providerReadiness)}`,
      modelRoute: readinessModelRoute(viewModel.providerReadiness),
      context: contextWindowText(input.contextWindow),
      workspace: workspaceStateText(viewModel),
      security: viewModel.securityMode,
      autonomy: viewModel.skillAutonomy ?? "manual",
    },
    updateStatus: versionStatusText(viewModel.versionStatus),
    commands: startupCommands(viewModel),
    tips: [
      "Paste large context as attachments.",
      "Use /model to switch routes.",
      "Approvals appear inline when an action needs permission.",
    ],
  };
}

function startupCommands(
  viewModel: StartupDashboardViewModel
): StartupDashboardState["commands"] {
  if (viewModel.availableCommands.length > 0) {
    return viewModel.availableCommands.map((command) => ({
      command: command.name,
      description: command.description,
    }));
  }
  return [
    { command: "/tools", description: "inspect tools" },
    { command: "/skills", description: "loaded skills" },
    { command: "/model", description: "switch primary model" },
    { command: "/status", description: "runtime state" },
    { command: "/compact", description: "compact session context" },
  ];
}

function versionStatusText(status: StartupDashboardViewModel["versionStatus"]): string {
  switch (status) {
    case "up-to-date":
      return "Up to date.";
    case "update-available":
      return "Update available.";
    case "unknown":
    case undefined:
      return "Unknown.";
  }
}

function readinessSymbol(readiness: StartupDashboardViewModel["providerReadiness"]): string {
  switch (readiness) {
    case "ready":
      return "●";
    case "degraded":
      return "◐";
    case "missing-config":
    case "unknown":
      return "○";
  }
}

function readinessModelRoute(
  readiness: StartupDashboardViewModel["providerReadiness"]
): NonNullable<StartupDashboardState["session"]["modelRoute"]> {
  switch (readiness) {
    case "ready":
      return "primary";
    case "degraded":
      return "fallback";
    case "missing-config":
    case "unknown":
      return "failed";
  }
}

function workspaceStateText(viewModel: StartupDashboardViewModel): string {
  if (viewModel.workspaceDirectory !== undefined && viewModel.workspaceDirectory.trim().length > 0) {
    return viewModel.workspaceDirectory;
  }
  if (viewModel.workspaceVerification !== "unknown") return viewModel.workspaceVerification;
  return viewModel.workspaceTrust;
}

function contextWindowText(contextWindow: number | undefined): string {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return "0";
  return `0 / ${formatCompactCount(contextWindow)}`;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${trimTrailingZero((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  return String(Math.floor(value));
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function firstNonEmpty(values: readonly string[]): string | undefined {
  return values.find((value) => value.trim().length > 0);
}

function formatStartupSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}
