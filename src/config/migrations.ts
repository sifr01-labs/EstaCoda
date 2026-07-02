import type { EstaCodaConfig } from "./runtime-config.js";

export type ConfigMigrationId = "move-stale-root-model-provider";

export type ConfigMigrationPlan = {
  readonly id: ConfigMigrationId;
  readonly description: string;
  readonly sourceKeys: readonly string[];
};

export type ConfigMigration = ConfigMigrationPlan & {
  readonly apply: (config: EstaCodaConfig) => EstaCodaConfig;
};

const STALE_ROOT_MODEL_PROVIDER_MIGRATION: ConfigMigration = {
  id: "move-stale-root-model-provider",
  description: "Move legacy root-level provider/base URL values into the model/provider sections.",
  sourceKeys: ["provider", "baseUrl", "base_url"],
  apply: (config) => migrateRootModelProvider(config)
};

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  STALE_ROOT_MODEL_PROVIDER_MIGRATION
];

export function planConfigMigrations(config: unknown): readonly ConfigMigrationPlan[] {
  if (!isRecord(config)) return [];
  return CONFIG_MIGRATIONS
    .filter((migration) => migration.sourceKeys.some((key) => key in config))
    .map(({ id, description, sourceKeys }) => ({ id, description, sourceKeys }));
}

export function applyConfigMigration(config: EstaCodaConfig, migrationId: ConfigMigrationId): EstaCodaConfig {
  const migration = CONFIG_MIGRATIONS.find((candidate) => candidate.id === migrationId);
  if (migration === undefined) {
    throw new Error(`Unknown config migration: ${migrationId}`);
  }
  return migration.apply(config);
}

function migrateRootModelProvider(config: EstaCodaConfig): EstaCodaConfig {
  if (!isRecord(config)) return config;
  const rawConfig = config as Record<string, unknown>;
  const model = isRecord(config.model) ? { ...config.model } : {};
  const providers = isRecord(config.providers) ? { ...config.providers } : {};
  const provider = typeof rawConfig.provider === "string" ? rawConfig.provider : undefined;
  const baseUrl = typeof rawConfig.baseUrl === "string"
    ? rawConfig.baseUrl
    : typeof rawConfig.base_url === "string"
      ? rawConfig.base_url
      : undefined;
  const next: Record<string, unknown> = { ...config };

  if (provider !== undefined && typeof model.provider !== "string") {
    model.provider = provider;
  }
  if (provider !== undefined && baseUrl !== undefined) {
    const providerConfig = isRecord(providers[provider]) ? { ...providers[provider] } : {};
    if (typeof providerConfig.baseUrl !== "string") {
      providerConfig.baseUrl = baseUrl;
    }
    providers[provider] = providerConfig;
  }

  next.model = model;
  next.providers = providers;
  delete next.provider;
  delete next.baseUrl;
  delete next.base_url;
  return next as EstaCodaConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
