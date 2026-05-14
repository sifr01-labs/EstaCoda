import type {
  AuxiliaryModelTask,
  ProviderId,
  ProviderSetupMode,
  ProviderUxKind,
  ResolvedAuxiliaryRoute
} from "../contracts/provider.js";
import type { CatalogProvider, SelectableModel } from "../providers/model-selection-catalog.js";
import { routeKey } from "../providers/model-selection-catalog.js";
import type {
  ModelCatalogReport,
  ModelRouteDiagnostic,
  ModelSetupReview
} from "../reports/model-reports.js";
import type { ProviderModelSelectionResult } from "../providers/provider-model-selection-flow.js";

export type CapabilityBadge = {
  kind: "tools" | "vision" | "structured" | "reasoning" | "streaming" | "open-weights";
  enabled: boolean;
};

export type EndpointReadiness = {
  ready: boolean;
  baseUrl?: string;
  warning?: string;
};

export type CredentialReadiness = {
  ready: boolean;
  envVar?: string;
  warning?: string;
};

export type ModelRow = {
  routeKey: string;
  provider: ProviderId;
  id: string;
  label: string;
  capabilityBadges: CapabilityBadge[];
  endpointReadiness: EndpointReadiness;
  credentialReadiness: CredentialReadiness;
  status: "ready" | "warning" | "blocked" | "unavailable";
};

export type ProviderRow = {
  provider: ProviderId;
  name: string;
  uxKind: ProviderUxKind;
  setupMode: ProviderSetupMode;
  executable: boolean;
  catalogOnly: boolean;
  configured: boolean;
  modelCount: number;
  readiness: EndpointReadiness & CredentialReadiness;
};

export type PrimaryRouteSummary = {
  route: ModelRow;
  fallbackSummaries: FallbackRouteSummary[];
};

export type FallbackRouteSummary = {
  route: ModelRow;
  order: number;
};

export type AuxiliaryRouteSummary = {
  task: AuxiliaryModelTask;
  route: ModelRow | undefined;
  source: ResolvedAuxiliaryRoute["source"];
  fallbackToMain: boolean;
};

export type SetupReviewSummary = {
  route: ModelRow;
  providerKind: ProviderUxKind;
  endpointVisible: string;
  credentialVisible: string;
  warnings: string[];
};

export type PickerSuccessSummary = {
  provider: ProviderId;
  model: string;
  contextWindowTokens: number;
  baseUrl?: string;
  envVarName?: string;
  credentialStored: boolean;
  credentialSkipped: boolean;
  configPath: string;
};

function capabilityBadgesFromProfile(
  profile: SelectableModel["profile"]
): CapabilityBadge[] {
  return [
    { kind: "tools", enabled: profile.supportsTools },
    { kind: "vision", enabled: profile.supportsVision },
    { kind: "structured", enabled: profile.supportsStructuredOutput },
    { kind: "reasoning", enabled: profile.supportsReasoning ?? false },
    { kind: "streaming", enabled: profile.supportsStreaming ?? false },
    { kind: "open-weights", enabled: profile.freeOrOpenWeights ?? false }
  ];
}

function modelRowStatusFromSelectable(selectable: SelectableModel): ModelRow["status"] {
  if (!selectable.executable) return "blocked";
  if (!selectable.credentialReady || !selectable.endpointReady || selectable.warnings.length > 0) {
    return "warning";
  }
  return "ready";
}

function modelRowStatusFromDiagnostic(diagnostic: ModelRouteDiagnostic): ModelRow["status"] {
  if (!diagnostic.executable || diagnostic.errors.length > 0) return "blocked";
  if (!diagnostic.credentialReady || !diagnostic.endpointReady || diagnostic.warnings.length > 0) {
    return "warning";
  }
  return "ready";
}

function diagnosticToModelRow(diagnostic: ModelRouteDiagnostic): ModelRow {
  const route = diagnostic.route;
  return {
    routeKey: routeKey(route.provider, route.id, route.baseUrl),
    provider: route.provider,
    id: route.id,
    label: `${route.provider}/${route.id}`,
    capabilityBadges: capabilityBadgesFromProfile(route.profile),
    endpointReadiness: {
      ready: diagnostic.endpointReady,
      baseUrl: route.baseUrl,
      warning: diagnostic.endpointReady ? undefined : "Endpoint not ready"
    },
    credentialReadiness: {
      ready: diagnostic.credentialReady,
      envVar: route.apiKeyEnv,
      warning: diagnostic.credentialReady ? undefined : "Credential not ready"
    },
    status: modelRowStatusFromDiagnostic(diagnostic)
  };
}

export function toModelRow(selectable: SelectableModel): ModelRow {
  return {
    routeKey: selectable.routeKey,
    provider: selectable.provider,
    id: selectable.id,
    label: `${selectable.provider}/${selectable.id}`,
    capabilityBadges: capabilityBadgesFromProfile(selectable.profile),
    endpointReadiness: {
      ready: selectable.endpointReady,
      baseUrl: selectable.baseUrl,
      warning: selectable.endpointReady ? undefined : "Endpoint not ready"
    },
    credentialReadiness: {
      ready: selectable.credentialReady,
      warning: selectable.credentialReady ? undefined : "Credential not ready"
    },
    status: modelRowStatusFromSelectable(selectable)
  };
}

export function toProviderRow(provider: CatalogProvider): ProviderRow {
  const ready = provider.endpointReady && provider.credentialReady;
  return {
    provider: provider.id,
    name: provider.name,
    uxKind: provider.uxKind,
    setupMode: provider.setupMode,
    executable: provider.executable,
    catalogOnly: provider.catalogOnly,
    configured: provider.configured,
    modelCount: provider.modelsCount,
    readiness: {
      ready,
      baseUrl: undefined,
      envVar: undefined,
      warning: ready ? undefined : "Provider not fully ready"
    }
  };
}

export function toPrimaryRouteSummary(report: ModelCatalogReport): PrimaryRouteSummary {
  return {
    route: diagnosticToModelRow(report.primaryRoute),
    fallbackSummaries: report.fallbackRoutes.map((fb, i) => ({
      route: diagnosticToModelRow(fb),
      order: i + 1
    }))
  };
}

export function toFallbackRouteSummaries(report: ModelCatalogReport): FallbackRouteSummary[] {
  return report.fallbackRoutes.map((fb, i) => ({
    route: diagnosticToModelRow(fb),
    order: i + 1
  }));
}

export function toAuxiliaryRouteSummaries(report: ModelCatalogReport): AuxiliaryRouteSummary[] {
  return report.auxiliaryRoutes.map((aux) => ({
    task: aux.task,
    route: diagnosticToModelRow(aux.diagnostic),
    source: aux.source,
    fallbackToMain: aux.fallbackToMain
  }));
}

export function toSetupReviewSummary(review: ModelSetupReview): SetupReviewSummary {
  const route = review.route;
  const row: ModelRow = {
    routeKey: routeKey(route.provider, route.id, route.baseUrl),
    provider: route.provider,
    id: route.id,
    label: `${route.provider}/${route.id}`,
    capabilityBadges: capabilityBadgesFromProfile(route.profile),
    endpointReadiness: {
      ready: true,
      baseUrl: route.baseUrl,
      warning: undefined
    },
    credentialReadiness: {
      ready: review.credentialVisible,
      envVar: route.apiKeyEnv,
      warning: review.credentialVisible ? undefined : "Credential not ready"
    },
    status: "ready"
  };

  return {
    route: row,
    providerKind: review.providerKind,
    endpointVisible: review.endpointVisible ? review.endpointUrl : "Not disclosed",
    credentialVisible: review.credentialVisible
      ? (route.apiKeyEnv ? `env:${route.apiKeyEnv}` : "Configured")
      : "Not configured",
    warnings: review.warnings
  };
}

export function toPickerSuccessSummary(
  result: ProviderModelSelectionResult,
  configPath: string,
  options: {
    credentialStored: boolean;
    credentialSkipped: boolean;
    envVarName?: string;
  }
): PickerSuccessSummary {
  return {
    provider: result.provider,
    model: result.model,
    contextWindowTokens: result.profile.contextWindowTokens ?? 0,
    baseUrl: result.baseUrl,
    envVarName: options.envVarName,
    credentialStored: options.credentialStored,
    credentialSkipped: options.credentialSkipped,
    configPath
  };
}
