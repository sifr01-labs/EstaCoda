import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { ModelRouteDiagnostic, ModelStatusReport } from "../reports/model-reports.js";
import { resolveAllAuxiliaryRoutes } from "../providers/auxiliary-model-resolver.js";

export async function produceModelStatusReport(config: LoadedRuntimeConfig): Promise<ModelStatusReport> {
  const primary = produceModelRouteDiagnostic(config.primaryModelRoute, config);
  const fallbacks = config.modelFallbackRoutes.map((r) => produceModelRouteDiagnostic(r, config));
  const auxiliaryRoutes = await resolveAllAuxiliaryRoutes(config.auxiliaryModels, {
    mainRoute: config.primaryModelRoute,
    providerRegistry: config.providerRegistry
  });
  const auxiliary: Record<string, ModelRouteDiagnostic> = {};
  for (const route of auxiliaryRoutes) {
    if (route.route) {
      auxiliary[route.task] = produceModelRouteDiagnostic(route.route, config);
    } else {
      auxiliary[route.task] = {
        route: {
          provider: "unconfigured",
          id: "unconfigured",
          profile: {
            id: "unconfigured",
            provider: "unconfigured",
            contextWindowTokens: 0,
            supportsTools: false,
            supportsVision: false,
            supportsStructuredOutput: false
          }
        },
        executable: false,
        catalogOnly: true,
        credentialReady: false,
        endpointReady: false,
        errors: route.diagnostics,
        warnings: route.diagnostics
      };
    }
  }

  const warnings: string[] = [];
  if (!primary.executable) {
    warnings.push(`Primary route ${primary.route.provider}/${primary.route.id} is not executable.`);
  }
  if (!primary.credentialReady) {
    warnings.push(`Primary route credential not ready.`);
  }
  if (!primary.endpointReady) {
    warnings.push(`Primary route endpoint not ready.`);
  }

  return {
    primary,
    fallbacks,
    auxiliary,
    overallReady: primary.executable && primary.credentialReady && primary.endpointReady,
    warnings
  };
}

function produceModelRouteDiagnostic(route: ResolvedModelRoute, config: LoadedRuntimeConfig): ModelRouteDiagnostic {
  const adapter = config.providerRegistry.get(route.provider);
  const executable = adapter !== undefined && adapter.executable !== false;
  const catalogOnly = !executable;
  const credentialReady = isCredentialReady(route, config);
  const endpointReady = isEndpointReady(route.baseUrl);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!executable && route.provider !== "unconfigured") {
    errors.push(`Provider ${route.provider} is not executable.`);
    warnings.push(`Provider ${route.provider} is catalog-only.`);
  }
  if (!credentialReady && route.provider !== "unconfigured") {
    warnings.push(`Credential not ready for ${route.provider}/${route.id}.`);
  }
  if (!endpointReady && route.baseUrl !== undefined) {
    warnings.push(`Endpoint not ready for ${route.provider}/${route.id}.`);
  }

  return {
    route,
    executable,
    catalogOnly,
    credentialReady,
    endpointReady,
    errors,
    warnings
  };
}

function isCredentialReady(route: ResolvedModelRoute, _config: LoadedRuntimeConfig): boolean {
  if (route.provider === "local" && route.apiKeyEnv === undefined) return true;
  if (route.apiKeyEnv !== undefined) return process.env[route.apiKeyEnv] !== undefined;
  return false;
}

function isEndpointReady(baseUrl?: string): boolean {
  if (baseUrl === undefined) return false;
  try {
    new URL(baseUrl);
    return true;
  } catch {
    return false;
  }
}
