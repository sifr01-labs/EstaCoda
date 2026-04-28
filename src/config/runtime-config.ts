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
import type { MCPServerTransport } from "../mcp/mcp-client.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { normalizeSecurityApprovalMode } from "../security/security-policy-factory.js";
import type { SecurityApprovalMode, SecurityAssessorConfig } from "../contracts/security.js";

export type MCPServerTrust = "conservative" | "read-only-network" | "read-only-local";

export type MCPServerToolsConfig = {
  include?: string[];
  exclude?: string[];
  resources?: boolean;
  prompts?: boolean;
  prefix?: string | boolean;
};

export type MCPServerConfig = {
  enabled?: boolean;
  transport?: MCPServerTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: MCPServerToolsConfig;
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  exposePrompts?: boolean;
  toolPrefix?: string | boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  trust?: MCPServerTrust;
  toolRiskClass?: ToolRiskClass;
  resourceReadRiskClass?: ToolRiskClass;
  promptGetRiskClass?: ToolRiskClass;
};

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
  mcpServers?: Record<string, MCPServerConfig>;
  mcp_servers?: Record<string, MCPServerConfig>;
  skills?: {
    externalDirs?: string[];
    autonomy?: SkillAutonomy;
    config?: Record<string, Record<string, unknown>>;
  };
  security?: {
    approvalMode?: SecurityApprovalMode | "manual" | "smart" | "off";
    assessor?: SecurityAssessorConfig;
    approvals?: {
      mode?: SecurityApprovalMode | "manual" | "smart" | "off";
    };
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
  groupSessionsPerUser?: boolean;
  threadSessionsPerUser?: boolean;
  sessionResetPolicy?: "none" | "idle" | "daily" | "both";
  sessionIdleResetMinutes?: number;
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
  mcp: {
    servers: Record<string, MCPServerConfig>;
  };
  skills: {
    externalDirs: string[];
    autonomy: SkillAutonomy;
    config: Record<string, Record<string, unknown>>;
  };
  security: {
    approvalMode: SecurityApprovalMode;
    assessor: {
      enabled: boolean;
      provider?: ProviderId;
      model?: string;
      timeoutMs: number;
    };
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

export type MCPSetupInput = {
  name: string;
  enabled?: boolean;
  transport?: MCPServerTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: MCPServerToolsConfig;
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  exposePrompts?: boolean;
  toolPrefix?: string | boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  trust?: MCPServerTrust;
  toolRiskClass?: ToolRiskClass;
  resourceReadRiskClass?: ToolRiskClass;
  promptGetRiskClass?: ToolRiskClass;
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

export type SecuritySetupInput = {
  mode?: SecurityApprovalMode | "manual" | "smart" | "off";
  assessorEnabled?: boolean;
  assessorProvider?: ProviderId;
  assessorModel?: string;
  assessorTimeoutMs?: number;
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
    mcp: {
      servers: normalizeMcpServers(config.mcpServers ?? config.mcp_servers, options.homeDir)
    },
    skills: {
      externalDirs: expandConfiguredPaths(config.skills?.externalDirs ?? [], options.homeDir),
      autonomy: config.skills?.autonomy ?? "suggest",
      config: normalizeSkillConfig(config.skills?.config)
    },
    security: {
      approvalMode: normalizeSecurityApprovalMode(config.security?.approvalMode ?? config.security?.approvals?.mode),
      assessor: {
        enabled: config.security?.assessor?.enabled === true,
        provider: config.security?.assessor?.provider,
        model: config.security?.assessor?.model,
        timeoutMs: config.security?.assessor?.timeoutMs ?? 8_000
      }
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
    mcpServers: {
      ...(merged.mcpServers ?? {}),
      ...(merged.mcp_servers ?? {}),
      ...(config.mcpServers ?? {}),
      ...(config.mcp_servers ?? {})
    },
    skills: {
      ...(merged.skills ?? {}),
      externalDirs: config.skills?.externalDirs ?? merged.skills?.externalDirs,
      autonomy: config.skills?.autonomy ?? merged.skills?.autonomy,
      config: {
        ...(merged.skills?.config ?? {}),
        ...(config.skills?.config ?? {})
      }
    },
    security: {
      ...(merged.security ?? {}),
      approvalMode: config.security?.approvalMode ?? merged.security?.approvalMode,
      assessor: {
        ...(merged.security?.assessor ?? {}),
        ...(config.security?.assessor ?? {})
      },
      approvals: {
        ...(merged.security?.approvals ?? {}),
        ...(config.security?.approvals ?? {})
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

function normalizeMcpServers(
  value: unknown,
  homeDir?: string
): Record<string, MCPServerConfig> {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const toolConfig = typeof record.tools === "object" && record.tools !== null && !Array.isArray(record.tools)
      ? record.tools as Record<string, unknown>
      : undefined;
    normalized[name] = {
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      transport: record.transport === "http" || record.transport === "stdio" ? record.transport : undefined,
      command: typeof record.command === "string" ? record.command : undefined,
      args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : undefined,
      cwd: typeof record.cwd === "string" ? expandConfiguredPath(record.cwd, homeDir) : undefined,
      env: typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)
        ? Object.fromEntries(Object.entries(record.env).filter(([, envValue]) => typeof envValue === "string") as Array<[string, string]>)
        : undefined,
      url: typeof record.url === "string" ? record.url : undefined,
      headers: typeof record.headers === "object" && record.headers !== null && !Array.isArray(record.headers)
        ? Object.fromEntries(Object.entries(record.headers).filter(([, headerValue]) => typeof headerValue === "string") as Array<[string, string]>)
        : undefined,
      tools: toolConfig === undefined ? undefined : {
        include: Array.isArray(toolConfig.include) ? toolConfig.include.filter((item): item is string => typeof item === "string") : undefined,
        exclude: Array.isArray(toolConfig.exclude) ? toolConfig.exclude.filter((item): item is string => typeof item === "string") : undefined,
        resources: typeof toolConfig.resources === "boolean" ? toolConfig.resources : undefined,
        prompts: typeof toolConfig.prompts === "boolean" ? toolConfig.prompts : undefined,
        prefix: typeof toolConfig.prefix === "string" || typeof toolConfig.prefix === "boolean" ? toolConfig.prefix : undefined
      },
      includeTools: Array.isArray(record.includeTools)
        ? record.includeTools.filter((item): item is string => typeof item === "string")
        : (toolConfig !== undefined && Array.isArray(toolConfig.include)
            ? toolConfig.include.filter((item): item is string => typeof item === "string")
            : undefined),
      excludeTools: Array.isArray(record.excludeTools)
        ? record.excludeTools.filter((item): item is string => typeof item === "string")
        : (toolConfig !== undefined && Array.isArray(toolConfig.exclude)
            ? toolConfig.exclude.filter((item): item is string => typeof item === "string")
            : undefined),
      exposeResources: typeof record.exposeResources === "boolean"
        ? record.exposeResources
        : (toolConfig !== undefined && typeof toolConfig.resources === "boolean" ? toolConfig.resources : undefined),
      exposePrompts: typeof record.exposePrompts === "boolean"
        ? record.exposePrompts
        : (toolConfig !== undefined && typeof toolConfig.prompts === "boolean" ? toolConfig.prompts : undefined),
      toolPrefix: typeof record.toolPrefix === "string" || typeof record.toolPrefix === "boolean"
        ? record.toolPrefix
        : (toolConfig !== undefined && (typeof toolConfig.prefix === "string" || typeof toolConfig.prefix === "boolean") ? toolConfig.prefix : undefined),
      timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
      connectTimeoutMs: typeof record.connectTimeoutMs === "number" ? record.connectTimeoutMs : undefined,
      trust: record.trust === "conservative" || record.trust === "read-only-network" || record.trust === "read-only-local"
        ? record.trust
        : undefined,
      toolRiskClass: isToolRiskClass(record.toolRiskClass) ? record.toolRiskClass : undefined,
      resourceReadRiskClass: isToolRiskClass(record.resourceReadRiskClass) ? record.resourceReadRiskClass : undefined,
      promptGetRiskClass: isToolRiskClass(record.promptGetRiskClass) ? record.promptGetRiskClass : undefined
    };
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

export async function setupMcpConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: MCPSetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const serverName = options.input.name.trim();
  const servers = normalizeMcpServers(existing.config.mcpServers ?? existing.config.mcp_servers, options.homeDir);
  servers[serverName] = {
    enabled: options.input.enabled ?? true,
    transport: options.input.transport ?? "stdio",
    command: options.input.command,
    args: options.input.args,
    cwd: options.input.cwd === undefined ? undefined : expandConfiguredPath(options.input.cwd, options.homeDir),
    env: options.input.env,
    url: options.input.url,
    headers: options.input.headers,
    tools: {
      include: options.input.includeTools ?? options.input.tools?.include,
      exclude: options.input.excludeTools ?? options.input.tools?.exclude,
      resources: options.input.exposeResources ?? options.input.tools?.resources,
      prompts: options.input.exposePrompts ?? options.input.tools?.prompts,
      prefix: options.input.toolPrefix ?? options.input.tools?.prefix
    },
    includeTools: options.input.includeTools,
    excludeTools: options.input.excludeTools,
    exposeResources: options.input.exposeResources,
    exposePrompts: options.input.exposePrompts,
    toolPrefix: options.input.toolPrefix,
    timeoutMs: options.input.timeoutMs,
    connectTimeoutMs: options.input.connectTimeoutMs,
    trust: options.input.trust,
    toolRiskClass: options.input.toolRiskClass,
    resourceReadRiskClass: options.input.resourceReadRiskClass,
    promptGetRiskClass: options.input.promptGetRiskClass
  };
  const config = mergeConfig(existing.config, {
    mcpServers: servers
  });
  delete config.mcp_servers;

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

export async function setupSecurityConfig(options: {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  input: SecuritySetupInput;
}): Promise<{
  path: string;
  config: EstaCodaConfig;
}> {
  const targetPath = options.input.scope === "project"
    ? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")
    : options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");
  const existing = await readConfig(targetPath);
  const assessorPatch = options.input.assessorEnabled !== undefined ||
    options.input.assessorProvider !== undefined ||
    options.input.assessorModel !== undefined ||
    options.input.assessorTimeoutMs !== undefined
    ? {
      enabled: options.input.assessorEnabled,
      provider: options.input.assessorProvider,
      model: options.input.assessorModel,
      timeoutMs: options.input.assessorTimeoutMs
    }
    : undefined;
  const config = mergeConfig(existing.config, {
    security: {
      approvalMode: normalizeSecurityApprovalMode(options.input.mode),
      assessor: assessorPatch
    }
  });

  await saveRuntimeConfig(targetPath, config);
  return {
    path: targetPath,
    config
  };
}

function isToolRiskClass(value: unknown): value is ToolRiskClass {
  return value === "read-only-local" ||
    value === "read-only-network" ||
    value === "workspace-write" ||
    value === "external-side-effect" ||
    value === "credential-access" ||
    value === "destructive-local" ||
    value === "shared-state-mutation" ||
    value === "spend-money" ||
    value === "sandbox-escape";
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
