import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import type { ModelProfile, ProviderEndpoint, ResolvedModelRoute } from "../../contracts/provider.js";
import { isOAuthAuthMethod } from "../../providers/oauth/oauth-types.js";
import { resolveAllAuxiliaryRoutes } from "../../providers/auxiliary-model-resolver.js";
import { getProviderMetadata } from "../../providers/provider-metadata.js";
import type { DoctorProviderRoute } from "../types.js";
import type { OAuthStatusDiagnostic } from "./oauth-status.js";

export type ProviderChainDiagnostic = {
  readonly status: "ready" | "warning";
  readonly routes: readonly DoctorProviderRoute[];
  readonly warnings: readonly string[];
  readonly unavailableCount: number;
};

export async function diagnoseProviderChain(
  config: LoadedRuntimeConfig | undefined,
  options: { readonly oauthStatus?: OAuthStatusDiagnostic } = {}
): Promise<ProviderChainDiagnostic> {
  if (config === undefined) {
    return {
      status: "ready",
      routes: [],
      warnings: [],
      unavailableCount: 0
    };
  }

  const providerModels = await config.providerRegistry.listModels();
  const routes: DoctorProviderRoute[] = [];
  routes.push(await describeRoute({
    kind: "primary",
    label: "primary",
    route: config.primaryModelRoute,
    config,
    providerModels,
    oauthStatus: options.oauthStatus
  }));

  for (const [index, route] of config.modelFallbackRoutes.entries()) {
    routes.push(await describeRoute({
      kind: "fallback",
      label: `fallback ${index + 1}`,
      route,
      config,
      providerModels,
      oauthStatus: options.oauthStatus
    }));
  }

  if (config.config.auxiliaryModels !== undefined) {
    const auxiliaryRoutes = await resolveAllAuxiliaryRoutes(config.config.auxiliaryModels, {
      mainRoute: config.primaryModelRoute,
      providerRegistry: config.providerRegistry
    });
    for (const auxiliaryRoute of auxiliaryRoutes) {
      if (auxiliaryRoute.source === "disabled") {
        routes.push({
          id: `auxiliary:${auxiliaryRoute.task}`,
          kind: "auxiliary",
          label: auxiliaryRoute.task,
          status: "disabled",
          summary: "disabled",
          details: auxiliaryRoute.diagnostics
        });
        continue;
      }
      if (auxiliaryRoute.route === undefined) {
        routes.push({
          id: `auxiliary:${auxiliaryRoute.task}`,
          kind: "auxiliary",
          label: auxiliaryRoute.task,
          status: auxiliaryRoute.fallbackToMain ? "warning" : "blocked",
          summary: auxiliaryRoute.fallbackToMain ? "falling back to main" : "unavailable",
          details: auxiliaryRoute.diagnostics
        });
        continue;
      }
      routes.push(await describeRoute({
        kind: "auxiliary",
        label: auxiliaryRoute.task,
        route: auxiliaryRoute.route,
        config,
        providerModels,
        oauthStatus: options.oauthStatus,
        extraDetails: auxiliaryRoute.diagnostics
      }));
    }
  }

  const unavailableRoutes = routes.filter((route) => route.status === "blocked" || route.status === "warning");
  const warnings = unavailableRoutes
    .filter((route) => route.kind !== "primary" || route.summary.includes("OAuth"))
    .map((route) => `Provider route ${route.label} is unavailable: ${route.summary}`);

  return {
    status: unavailableRoutes.length > 0 ? "warning" : "ready",
    routes,
    warnings,
    unavailableCount: unavailableRoutes.length
  };
}

async function describeRoute(input: {
  readonly kind: DoctorProviderRoute["kind"];
  readonly label: string;
  readonly route: ResolvedModelRoute;
  readonly config: LoadedRuntimeConfig;
  readonly providerModels: readonly ModelProfile[];
  readonly oauthStatus?: OAuthStatusDiagnostic;
  readonly extraDetails?: readonly string[];
}): Promise<DoctorProviderRoute> {
  const route = input.route;
  const details: string[] = [...(input.extraDetails ?? [])];
  const issues: string[] = [];

  if (route.provider === "unconfigured" || route.id === "unconfigured") {
    issues.push("provider setup incomplete");
  }

  const provider = input.config.providerRegistry.get(route.provider);
  if (provider === undefined) {
    issues.push("provider adapter missing");
  } else if (provider.executable === false) {
    issues.push("provider is not executable");
  } else {
    const health = await provider.health(endpointForRoute(route));
    if (!health.available) {
      issues.push(humanHealthIssue(health.reason));
    }
  }

  if (!input.providerModels.some((model) => model.provider === route.provider && model.id === route.id)) {
    issues.push("model is not registered");
  }

  const providerConfig = input.config.config.providers?.[route.provider];
  const metadata = getProviderMetadata(route.provider);
  const authMethod = route.authMethod ?? providerConfig?.authMethod ?? metadata.defaultAuthMethod;
  if (!metadata.authMethods.includes(authMethod)) {
    issues.push(`unsupported authMethod ${authMethod}`);
  } else if (authMethod === "api_key" && route.provider !== "local" && route.provider !== "unconfigured") {
    if (route.apiKeyEnv === undefined) {
      issues.push("missing apiKeyEnv");
    } else if (process.env[route.apiKeyEnv] === undefined) {
      issues.push(`missing env var ${route.apiKeyEnv}`);
    }
  } else if (isOAuthAuthMethod(authMethod) && route.provider !== "unconfigured") {
    const oauthProvider = input.oauthStatus?.providerStatuses.find((providerStatus) =>
      providerStatus.providerId === route.provider
    );
    if (oauthProvider === undefined) {
      issues.push(`missing OAuth credentials for ${route.provider}`);
    } else if (oauthProvider.status === "expired") {
      issues.push(`OAuth credentials expired for ${route.provider}`);
    }
  }

  if (route.provider !== "local" && route.provider !== "unconfigured" && providerConfig?.enableNetwork !== true) {
    issues.push("network inference disabled");
  }

  const status = issues.length === 0
    ? "ready"
    : input.kind === "primary"
      ? "blocked"
      : "warning";
  return {
    id: `${input.kind}:${input.label}`,
    kind: input.kind,
    label: input.label,
    provider: route.provider,
    model: route.id,
    status,
    summary: issues.length === 0 ? "ready" : [...new Set(issues)].join("; "),
    details
  };
}

function endpointForRoute(route: ResolvedModelRoute): ProviderEndpoint | undefined {
  if (route.baseUrl === undefined) return undefined;
  return {
    baseUrl: route.baseUrl,
    ...(route.authMethod === "api_key" && route.apiKeyEnv !== undefined
      ? { apiKey: { kind: "env" as const, name: route.apiKeyEnv } }
      : {})
  };
}

function humanHealthIssue(reason: string | undefined): string {
  if (reason === undefined) return "provider health check failed";
  const missingEnv = /Missing\s+([A-Z0-9_]+)/u.exec(reason)?.[1];
  return missingEnv === undefined ? reason : `missing env var ${missingEnv}`;
}
