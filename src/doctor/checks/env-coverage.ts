import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";

const ENV_REFERENCE_KEYS = new Set(["apiKeyEnv", "api_key_env", "botTokenEnv", "passwordEnv"]);

export function collectMissingProfileEnv(config: LoadedRuntimeConfig): string[] {
  const envVars = collectProfileEnvReferences(config);
  return [...envVars].filter((envVar) => process.env[envVar] === undefined).sort();
}

export function collectProfileEnvReferences(config: LoadedRuntimeConfig): Set<string> {
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
  collectEnvReferences(config.config, envVars);
  return envVars;
}

function collectEnvReferences(value: unknown, envVars: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnvReferences(item, envVars);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && ENV_REFERENCE_KEYS.has(key)) {
      addIfEnvName(envVars, child);
      continue;
    }
    collectEnvReferences(child, envVars);
  }
}

function addIfEnvName(envVars: Set<string>, value: string): void {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    envVars.add(value);
  }
}
