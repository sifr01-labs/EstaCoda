import { readFile } from "node:fs/promises";

export type ConfigHygieneDiagnostic = {
  readonly warnings: readonly string[];
  readonly staleRootKeys: readonly string[];
  readonly missingSections: readonly string[];
  readonly circularFallbacks: readonly string[];
};

const STALE_ROOT_KEYS = ["provider", "baseUrl", "base_url"] as const;
const REQUIRED_ROOT_SECTIONS = ["model", "providers", "security", "skills", "ui"] as const;

export async function diagnoseConfigHygiene(configPath: string): Promise<ConfigHygieneDiagnostic> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || error instanceof SyntaxError) {
      return emptyDiagnostic();
    }
    throw error;
  }

  if (!isRecord(parsed)) {
    return {
      ...emptyDiagnostic(),
      warnings: [`Profile config should be a JSON object: ${configPath}`]
    };
  }

  const staleRootKeys = STALE_ROOT_KEYS.filter((key) => key in parsed);
  const missingSections = REQUIRED_ROOT_SECTIONS.filter((key) => !(key in parsed));
  const circularFallbacks = findCircularFallbacks(parsed);
  const warnings: string[] = [];

  if (staleRootKeys.length > 0) {
    warnings.push(`Profile config has stale root keys: ${staleRootKeys.join(", ")}`);
  }
  if (missingSections.length > 0) {
    warnings.push(`Profile config is missing recommended sections: ${missingSections.join(", ")}`);
  }
  if (circularFallbacks.length > 0) {
    warnings.push(`Profile config fallback repeats the primary model route: ${circularFallbacks.join(", ")}`);
  }

  return {
    warnings,
    staleRootKeys,
    missingSections,
    circularFallbacks
  };
}

function findCircularFallbacks(config: Record<string, unknown>): string[] {
  const model = config.model;
  if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
    return [];
  }
  const provider = model.provider;
  const id = model.id;

  const fallbacks = Array.isArray(model.fallbacks) ? model.fallbacks : [];
  return fallbacks
    .filter(isRecord)
    .filter((fallback) => fallback.provider === provider && fallback.id === id)
    .map((fallback) => routeLabel(fallback, provider, id));
}

function routeLabel(route: Record<string, unknown>, provider: string, id: string): string {
  const baseUrl = typeof route.baseUrl === "string"
    ? route.baseUrl
    : typeof route.base_url === "string"
      ? route.base_url
      : undefined;
  return baseUrl === undefined ? `${provider}/${id}` : `${provider}/${id} (${baseUrl})`;
}

function emptyDiagnostic(): ConfigHygieneDiagnostic {
  return {
    warnings: [],
    staleRootKeys: [],
    missingSections: [],
    circularFallbacks: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
