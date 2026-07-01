import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";

export function collectMissingProfileEnv(config: LoadedRuntimeConfig): string[] {
  const envVars = new Set<string>();
  if (config.primaryModelRoute.apiKeyEnv !== undefined) {
    envVars.add(config.primaryModelRoute.apiKeyEnv);
  }
  for (const route of config.modelFallbackRoutes) {
    if (route.apiKeyEnv !== undefined) {
      envVars.add(route.apiKeyEnv);
    }
  }
  for (const missing of config.channels.telegram.missing ?? []) {
    envVars.add(missing);
  }
  return [...envVars].filter((envVar) => process.env[envVar] === undefined).sort();
}
