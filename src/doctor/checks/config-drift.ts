import { readFile } from "node:fs/promises";
import { planConfigMigrations, type ConfigMigrationId } from "../../config/migrations.js";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import { collectProfileEnvReferences } from "./env-coverage.js";

export type ConfigDriftStatus = "ready" | "warning" | "blocked";

export type ConfigDriftStaleRootKey = {
  readonly key: string;
  readonly target: string;
  readonly migrationId?: ConfigMigrationId;
};

export type ConfigDriftEnvGhost = {
  readonly key: string;
  readonly reason: string;
};

export type ConfigDriftDiagnostic = {
  readonly status: ConfigDriftStatus;
  readonly staleRootKeys: readonly ConfigDriftStaleRootKey[];
  readonly envGhosts: readonly ConfigDriftEnvGhost[];
  readonly pendingMigrations: readonly ConfigMigrationId[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
};

export type ConfigDriftInput = {
  readonly configPath: string;
  readonly envPath: string;
  readonly loadedConfig?: LoadedRuntimeConfig;
};

const STALE_ROOT_KEY_TARGETS: Record<string, string> = {
  provider: "model.provider",
  baseUrl: "providers.<provider>.baseUrl",
  base_url: "providers.<provider>.baseUrl"
};

const ENV_REFERENCE_KEYS = new Set([
  "apiKeyEnv",
  "api_key_env",
  "botTokenEnv",
  "passwordEnv"
]);

const KNOWN_CREDENTIAL_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "DEEPSEEK_API_KEY",
  "DISCORD_BOT_TOKEN",
  "ELEVENLABS_API_KEY",
  "FAL_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "KIMI_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "XAI_API_KEY"
]);

export async function diagnoseConfigDrift(input: ConfigDriftInput): Promise<ConfigDriftDiagnostic> {
  const parsed = await readOptionalJson(input.configPath);
  if (parsed.kind === "missing") return emptyDiagnostic();
  if (parsed.kind === "malformed") {
    return {
      status: "blocked",
      staleRootKeys: [],
      envGhosts: [],
      pendingMigrations: [],
      warnings: [`Config drift could not be planned because config JSON is invalid: ${parsed.message}`],
      notes: []
    };
  }
  if (!isRecord(parsed.value)) return emptyDiagnostic();
  const configRecord = parsed.value;

  const migrationPlans = planConfigMigrations(configRecord);
  const migrationIds = new Set(migrationPlans.map((plan) => plan.id));
  const staleRootKeys = Object.entries(STALE_ROOT_KEY_TARGETS)
    .filter(([key]) => key in configRecord)
    .map(([key, target]): ConfigDriftStaleRootKey => ({
      key,
      target: key === "baseUrl" || key === "base_url" ? resolveBaseUrlTarget(configRecord) : target,
      migrationId: migrationIds.has("move-stale-root-model-provider") ? "move-stale-root-model-provider" : undefined
    }));
  const envGhosts = await collectEnvGhosts({
    envPath: input.envPath,
    config: configRecord,
    loadedConfig: input.loadedConfig
  });
  const warnings = [
    ...staleRootKeys.map((item) => `Config contains stale root-level key: ${item.key} -> ${item.target}`),
    ...envGhosts.map((item) => `Profile .env contains unreferenced credential key: ${item.key}`)
  ];

  return {
    status: warnings.length > 0 ? "warning" : "ready",
    staleRootKeys,
    envGhosts,
    pendingMigrations: [...migrationIds],
    warnings,
    notes: []
  };
}

async function collectEnvGhosts(input: {
  readonly envPath: string;
  readonly config: Record<string, unknown>;
  readonly loadedConfig?: LoadedRuntimeConfig;
}): Promise<ConfigDriftEnvGhost[]> {
  const savedKeys = await readDotEnvKeys(input.envPath);
  if (savedKeys.length === 0) return [];
  const referencedKeys = input.loadedConfig === undefined
    ? collectRawEnvReferences(input.config)
    : collectProfileEnvReferences(input.loadedConfig);

  return savedKeys
    .filter((key) => isKnownCredentialEnvKey(key))
    .filter((key) => !referencedKeys.has(key))
    .sort()
    .map((key) => ({
      key,
      reason: "saved profile .env key is not referenced by the selected profile config"
    }));
}

async function readOptionalJson(path: string): Promise<
  | { readonly kind: "loaded"; readonly value: unknown }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly message: string }
> {
  try {
    return { kind: "loaded", value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "malformed", message: error.message };
    throw error;
  }
}

async function readDotEnvKeys(path: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match !== null) {
      keys.add(match[1]!);
    }
  }
  return [...keys];
}

function collectRawEnvReferences(value: unknown, envVars = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRawEnvReferences(item, envVars);
    }
    return envVars;
  }
  if (!isRecord(value)) return envVars;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && ENV_REFERENCE_KEYS.has(key) && isEnvName(child)) {
      envVars.add(child);
      continue;
    }
    collectRawEnvReferences(child, envVars);
  }
  return envVars;
}

function resolveBaseUrlTarget(config: Record<string, unknown>): string {
  return typeof config.provider === "string"
    ? `providers.${config.provider}.baseUrl`
    : STALE_ROOT_KEY_TARGETS.baseUrl;
}

function isKnownCredentialEnvKey(key: string): boolean {
  return KNOWN_CREDENTIAL_ENV_KEYS.has(key) || /(?:^|_)(?:API_KEY|TOKEN|PASSWORD|SECRET)$/u.test(key);
}

function isEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function emptyDiagnostic(): ConfigDriftDiagnostic {
  return {
    status: "ready",
    staleRootKeys: [],
    envGhosts: [],
    pendingMigrations: [],
    warnings: [],
    notes: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
