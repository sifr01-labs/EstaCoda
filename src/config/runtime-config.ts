import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserBackendKind } from "../contracts/browser.js";
import type {
  AuxiliaryProviderConfig,
  CredentialPoolEntry,
  CredentialRotationStrategy,
  ModelProfile,
  ProviderEndpoint,
  ProviderId
} from "../contracts/provider.js";
import { CredentialPool, CredentialPoolRegistry } from "../providers/credential-pool.js";
import { inferModelProfile } from "../providers/model-catalog.js";
import { createOpenAICompatibleProvider, type FetchLike as ProviderFetchLike } from "../providers/openai-compatible-provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";

export type EstaCodaConfig = {
  model?: {
    provider?: ProviderId;
    id?: string;
    contextWindowTokens?: number;
  };
  providers?: Record<string, {
    kind?: "openai-compatible" | "catalog";
    baseUrl?: string;
    apiKeyEnv?: string;
    models?: string[];
    enableNetwork?: boolean;
    headers?: Record<string, string>;
  }>;
  credentialPools?: Record<string, {
    strategy?: CredentialRotationStrategy;
    entries?: CredentialPoolEntry[];
  }>;
  auxiliaryProviders?: AuxiliaryProviderConfig;
  web?: {
    enableNetwork?: boolean;
    maxContentChars?: number;
  };
  browser?: {
    backend?: BrowserBackendKind;
    cdpUrl?: string;
    launchCommand?: string;
    autoLaunch?: boolean;
  };
  skills?: {
    externalDirs?: string[];
    config?: Record<string, Record<string, unknown>>;
  };
  channels?: {
    telegram?: TelegramChannelConfig;
  };
};

export type TelegramChannelConfig = {
  enabled?: boolean;
  botTokenEnv?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  pollTimeoutSeconds?: number;
  maxAttachmentBytes?: number;
  pairing?: {
    code?: string;
    createdAt?: string;
    expiresAt?: string;
  };
};

export type LoadedRuntimeConfig = {
  config: EstaCodaConfig;
  sources: string[];
  model: ModelProfile;
  providerRegistry: ProviderRegistry;
  credentialPools: CredentialPoolRegistry;
  auxiliaryProviders?: AuxiliaryProviderConfig;
  web: {
    enableNetwork: boolean;
    maxContentChars?: number;
  };
  browser: {
    backend: BrowserBackendKind;
    cdpUrl?: string;
    launchCommand?: string;
    autoLaunch: boolean;
  };
  skills: {
    externalDirs: string[];
    config: Record<string, Record<string, unknown>>;
  };
  channels: {
    telegram: TelegramChannelConfig & {
      ready: boolean;
      missing?: string[];
    };
  };
};

export type ProviderSetupInput = {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  enableNetwork?: boolean;
  scope?: "user" | "project";
  credentialPoolStrategy?: CredentialRotationStrategy;
};

export type WebSetupInput = {
  enableNetwork?: boolean;
  maxContentChars?: number;
  scope?: "user" | "project";
};

export type BrowserSetupInput = {
  backend?: BrowserBackendKind;
  cdpUrl?: string;
  launchCommand?: string;
  autoLaunch?: boolean;
  scope?: "user" | "project";
};

export type TelegramSetupInput = {
  botTokenEnv?: string;
  botToken?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  pollTimeoutSeconds?: number;
  enabled?: boolean;
  scope?: "user" | "project";
};

export type TelegramPairingInput = {
  code?: string;
  ttlMinutes?: number;
  scope?: "user" | "project";
};

export async function loadRuntimeConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  providerFetch?: ProviderFetchLike;
}): Promise<LoadedRuntimeConfig> {
  const sources = [
    options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json"),
    options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
  ];
  const loaded = await Promise.all(sources.map((path) => readConfig(path)));
  const config = mergeConfig(...loaded.map((entry) => entry.config));
  const model = inferModelProfile({
    provider: config.model?.provider ?? "unconfigured",
    model: config.model?.id ?? "unconfigured",
    contextWindowTokens: config.model?.contextWindowTokens
  });
  const providerRegistry = buildProviderRegistry(config, {
    fetch: options.providerFetch
  });
  const credentialPools = buildCredentialPools(config);
  const telegram = config.channels?.telegram ?? {};
  const telegramMissing = telegram.enabled === true && telegram.botTokenEnv !== undefined && process.env[telegram.botTokenEnv] === undefined
    ? [telegram.botTokenEnv]
    : [];

  return {
    config,
    sources: loaded.filter((entry) => entry.loaded).map((entry) => entry.path),
    model,
    providerRegistry,
    credentialPools,
    auxiliaryProviders: config.auxiliaryProviders,
    web: {
      enableNetwork: config.web?.enableNetwork ?? false,
      maxContentChars: config.web?.maxContentChars
    },
    browser: {
      backend: config.browser?.backend ?? "unconfigured",
      cdpUrl: config.browser?.cdpUrl,
      launchCommand: config.browser?.launchCommand,
      autoLaunch: config.browser?.autoLaunch ?? false
    },
    skills: {
      externalDirs: expandConfiguredPaths(config.skills?.externalDirs ?? [], options.homeDir),
      config: normalizeSkillConfig(config.skills?.config)
    },
    channels: {
      telegram: {
        ...telegram,
        ready: telegram.enabled === true && telegram.botTokenEnv !== undefined && telegramMissing.length === 0,
        missing: telegramMissing.length === 0 ? undefined : telegramMissing
      }
    }
  };
}

export function mergeConfig(...configs: EstaCodaConfig[]): EstaCodaConfig {
  return configs.reduce<EstaCodaConfig>((merged, config) => ({
    model: {
      ...(merged.model ?? {}),
      ...(config.model ?? {})
    },
    providers: {
      ...(merged.providers ?? {}),
      ...(config.providers ?? {})
    },
    credentialPools: {
      ...(merged.credentialPools ?? {}),
      ...(config.credentialPools ?? {})
    },
    auxiliaryProviders: {
      ...(merged.auxiliaryProviders ?? {}),
      ...(config.auxiliaryProviders ?? {})
    },
    web: {
      ...(merged.web ?? {}),
      ...(config.web ?? {})
    },
    browser: {
      ...(merged.browser ?? {}),
      ...(config.browser ?? {})
    },
    skills: {
      ...(merged.skills ?? {}),
      externalDirs: config.skills?.externalDirs ?? merged.skills?.externalDirs,
      config: {
        ...(merged.skills?.config ?? {}),
        ...(config.skills?.config ?? {})
      }
    },
    channels: {
      ...(merged.channels ?? {}),
      ...(config.channels ?? {}),
      telegram: {
        ...(merged.channels?.telegram ?? {}),
        ...(config.channels?.telegram ?? {})
      }
    }
  }), {});
}

function normalizeSkillConfig(value: unknown): Record<string, Record<string, unknown>> {
  if (value === undefined || typeof value !== "object" || value === null) {
    return {};
  }

  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [skillName, entry] of Object.entries(value)) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      normalized[skillName] = { ...entry };
    }
  }
  return normalized;
}

export function buildProviderRegistry(config: EstaCodaConfig, options: {
  fetch?: ProviderFetchLike;
} = {}): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    const providerId = provider as ProviderId;
    const models = providerConfig.models ?? [];

    if ((providerConfig.kind ?? "openai-compatible") === "openai-compatible") {
      registry.register(createOpenAICompatibleProvider({
        id: providerId,
        endpoint: {
          baseUrl: providerConfig.baseUrl ?? defaultBaseUrl(providerId),
          apiKey: providerConfig.apiKeyEnv === undefined
            ? { kind: "none" }
            : { kind: "env", name: providerConfig.apiKeyEnv },
          headers: providerConfig.headers
        } satisfies ProviderEndpoint,
        models,
        enableNetwork: providerConfig.enableNetwork ?? false,
        fetch: options.fetch
      }));
    }
  }

  return registry;
}

export function buildCredentialPools(config: EstaCodaConfig): CredentialPoolRegistry {
  const registry = new CredentialPoolRegistry();

  for (const [provider, poolConfig] of Object.entries(config.credentialPools ?? {})) {
    registry.register(new CredentialPool({
      provider: provider as ProviderId,
      strategy: poolConfig.strategy,
      entries: poolConfig.entries ?? []
    }));
  }

  return registry;
}

export async function saveRuntimeConfig(path: string, config: EstaCodaConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function setupProviderConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: ProviderSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  envExport?: string;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const requiresCredential = options.input.provider !== "local" || options.input.apiKeyEnv !== undefined || options.input.apiKey !== undefined;
  const envName = requiresCredential ? options.input.apiKeyEnv ?? defaultEnvKey(options.input.provider) : undefined;
  const envExport = options.input.apiKey === undefined
    ? undefined
    : `export ${envName ?? defaultEnvKey(options.input.provider)}=${shellQuote(options.input.apiKey)}`;
  const providerConfig = {
    kind: "openai-compatible" as const,
    baseUrl: options.input.baseUrl ?? defaultBaseUrl(options.input.provider),
    apiKeyEnv: envName,
    models: [options.input.model],
    enableNetwork: options.input.enableNetwork ?? true
  };
  const config = mergeConfig(existing.config, {
    model: {
      provider: options.input.provider,
      id: options.input.model
    },
    providers: {
      [options.input.provider]: providerConfig
    },
    credentialPools: envName === undefined
      ? {}
      : {
          [options.input.provider]: {
            strategy: options.input.credentialPoolStrategy ?? "fill_first",
            entries: [
              {
                id: `${options.input.provider}-${envName}`,
                source: { kind: "env", name: envName },
                priority: 1
              }
            ]
          }
        }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    envExport
  };
}

export async function setupWebConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: WebSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const config = mergeConfig(existing.config, {
    web: {
      enableNetwork: options.input.enableNetwork ?? true,
      maxContentChars: options.input.maxContentChars
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupBrowserConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: BrowserSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const config = mergeConfig(existing.config, {
    browser: {
      backend: options.input.backend ?? "local-cdp",
      cdpUrl: options.input.cdpUrl,
      launchCommand: options.input.launchCommand,
      autoLaunch: options.input.autoLaunch ?? false
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config
  };
}

export async function setupTelegramConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: TelegramSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  envExport?: string;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const envName = options.input.botTokenEnv ?? "ESTACODA_TELEGRAM_BOT_TOKEN";
  const envExport = options.input.botToken === undefined
    ? undefined
    : `export ${envName}=${shellQuote(options.input.botToken)}`;
  const config = mergeConfig(existing.config, {
    channels: {
      telegram: {
        enabled: options.input.enabled ?? true,
        botTokenEnv: envName,
        defaultChatId: options.input.defaultChatId,
        allowedUserIds: options.input.allowedUserIds,
        allowedChatIds: options.input.allowedChatIds,
        pollTimeoutSeconds: options.input.pollTimeoutSeconds
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    envExport
  };
}

export async function createTelegramPairingCode(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input?: TelegramPairingInput;
  now?: () => Date;
  code?: () => string;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
  code: string;
  expiresAt: string;
}> {
  const input = options.input ?? {};
  const targetPath = input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 10;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const code = input.code ?? options.code?.() ?? randomPairingCode();
  const config = mergeConfig(existing.config, {
    channels: {
      telegram: {
        ...(existing.config.channels?.telegram ?? {}),
        pairing: {
          code,
          createdAt: now.toISOString(),
          expiresAt
        }
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    path: targetPath,
    config,
    code,
    expiresAt
  };
}

export async function consumeTelegramPairingCode(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  code: string;
  userId: string;
  chatId: string;
  now?: () => Date;
}): Promise<{
  paired: boolean;
  reason?: "missing" | "expired" | "mismatch";
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const pairing = existing.config.channels?.telegram?.pairing;
  const now = options.now?.() ?? new Date();

  if (pairing?.code === undefined) {
    return {
      paired: false,
      reason: "missing",
      path: targetPath,
      config: existing.config
    };
  }

  if (pairing.expiresAt !== undefined && new Date(pairing.expiresAt).getTime() < now.getTime()) {
    return {
      paired: false,
      reason: "expired",
      path: targetPath,
      config: existing.config
    };
  }

  if (normalizePairingCode(pairing.code) !== normalizePairingCode(options.code)) {
    return {
      paired: false,
      reason: "mismatch",
      path: targetPath,
      config: existing.config
    };
  }

  const telegram = existing.config.channels?.telegram ?? {};
  const config = mergeConfig(existing.config, {
    channels: {
      telegram: {
        ...telegram,
        allowedUserIds: uniqueStrings([...(telegram.allowedUserIds ?? []), options.userId]),
        allowedChatIds: uniqueStrings([...(telegram.allowedChatIds ?? []), options.chatId]),
        pairing: {}
      }
    }
  });

  await saveRuntimeConfig(targetPath, config);

  return {
    paired: true,
    path: targetPath,
    config
  };
}

async function readConfig(path: string): Promise<{ path: string; loaded: boolean; config: EstaCodaConfig }> {
  try {
    return {
      path,
      loaded: true,
      config: JSON.parse(await readFile(path, "utf8")) as EstaCodaConfig
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        path,
        loaded: false,
        config: {}
      };
    }

    throw error;
  }
}

function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "kimi":
      return "https://api.moonshot.ai/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "local":
      return "http://localhost:11434/v1";
    default:
      return "https://example.invalid/v1";
  }
}

export function defaultEnvKey(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "kimi":
      return "KIMI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return "OPENAI_COMPATIBLE_API_KEY";
  }
}

function expandConfiguredPaths(paths: string[], homeDir?: string): string[] {
  return [...new Set(
    paths
      .map((path) => expandConfiguredPath(path, homeDir))
      .filter((path) => path.length > 0)
  )];
}

function expandConfiguredPath(path: string, homeDir?: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const envExpanded = trimmed.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => process.env[name] ?? match);

  if (envExpanded === "~") {
    return homeDir ?? process.env.HOME ?? envExpanded;
  }

  if (envExpanded.startsWith("~/")) {
    const base = homeDir ?? process.env.HOME;
    return base === undefined ? envExpanded : join(base, envExpanded.slice(2));
  }

  return envExpanded;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function randomPairingCode(): string {
  const value = Math.floor(Math.random() * 1_000_000);

  return value.toString().padStart(6, "0");
}

function normalizePairingCode(code: string): string {
  return code.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
