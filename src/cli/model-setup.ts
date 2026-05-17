import { join } from "node:path";
import {
  loadRuntimeConfig,
  setupProviderConfig,
  readConfig,
  type EstaCodaConfig,
  type ProviderSetupInput
} from "../config/runtime-config.js";
import type { ProviderId } from "../contracts/provider.js";
import type { FetchLike } from "../providers/openai-compatible-provider.js";
import type { CliOptions, CliCommandResult } from "./cli.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";

export type OpenAIModelProbe = {
  ok: boolean;
  baseUrl: string;
  models: string[];
  message: string;
};

export async function probeOpenAIModels(baseUrl: string, fetchLike?: FetchLike): Promise<OpenAIModelProbe> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const url = `${normalizedBaseUrl}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = fetchLike === undefined
      ? await globalThis.fetch(url, {
          method: "GET",
          headers: {},
          signal: controller.signal
        })
      : await fetchLike(url, {
          method: "GET",
          headers: {},
          body: "",
          signal: controller.signal
        });
    const json = await response.json();
    const models = extractOpenAIModelIds(json);

    if (!response.ok) {
      return {
        ok: false,
        baseUrl: normalizedBaseUrl,
        models,
        message: response.statusText || `HTTP ${response.status}`
      };
    }

    return {
      ok: true,
      baseUrl: normalizedBaseUrl,
      models,
      message: models.length === 0
        ? "endpoint responded, but no models were listed"
        : `endpoint ready; ${models.length} model(s) visible`
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: normalizedBaseUrl,
      models: [],
      message: error instanceof Error ? error.message : "endpoint did not respond"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAIModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown; model?: unknown; id?: unknown }>;
  };

  if (Array.isArray(record.data)) {
    return uniqueStrings(record.data.map((entry) => typeof entry.id === "string" ? entry.id : ""));
  }

  if (Array.isArray(record.models)) {
    return uniqueStrings(record.models.map((entry) => {
      if (typeof entry.id === "string") return entry.id;
      if (typeof entry.model === "string") return entry.model;
      if (typeof entry.name === "string") return entry.name;
      return "";
    }));
  }

  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

export function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

export function validateProviderIdSyntax(providerId: string): { ok: true } | { ok: false; message: string } {
  if (!/^[a-zA-Z0-9._-]+$/.test(providerId)) {
    return { ok: false, message: `Provider ID "${providerId}" contains invalid characters. Use only letters, numbers, hyphens, underscores, and dots.` };
  }
  if (providerId.length > 64) {
    return { ok: false, message: `Provider ID "${providerId}" is too long (max 64 characters).` };
  }
  return { ok: true };
}

export function validateCustomProviderId(config: EstaCodaConfig, providerId: ProviderId, baseUrl: string): { ok: true } | { ok: false; message: string } {
  const existing = config.providers?.[providerId];
  if (existing !== undefined && existing.baseUrl !== undefined && existing.baseUrl !== baseUrl) {
    return {
      ok: false,
      message: `Provider "${providerId}" already exists with a different base URL (${existing.baseUrl}). Use a different --provider-id or remove the existing provider first.`
    };
  }
  return { ok: true };
}

export type ModelSetupLocalArgs = {
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
  scope?: "user" | "project";
};

export type ModelSetupCustomArgs = {
  baseUrl?: string;
  providerId?: string;
  model?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  scope?: "user" | "project";
};

export function parseModelSetupLocalArgs(args: string[]): ModelSetupLocalArgs {
  const parsed: ModelSetupLocalArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--base-url") {
      parsed.baseUrl = next;
      i += 1;
    } else if (arg === "--model") {
      parsed.model = next;
      i += 1;
    } else if (arg === "--context-window") {
      parsed.contextWindow = Number(next);
      i += 1;
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
    }
  }
  return parsed;
}

export function parseModelSetupCustomArgs(args: string[]): ModelSetupCustomArgs {
  const parsed: ModelSetupCustomArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--base-url") {
      parsed.baseUrl = next;
      i += 1;
    } else if (arg === "--provider-id") {
      parsed.providerId = next;
      i += 1;
    } else if (arg === "--model") {
      parsed.model = next;
      i += 1;
    } else if (arg === "--api-key-env") {
      parsed.apiKeyEnv = next;
      i += 1;
    } else if (arg === "--context-window") {
      parsed.contextWindow = Number(next);
      i += 1;
    } else if (arg === "--project") {
      parsed.scope = "project";
    } else if (arg === "--user") {
      parsed.scope = "user";
    }
  }
  return parsed;
}

export async function runModelSetupLocal(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const parsed = parseModelSetupLocalArgs(args);
  const baseUrl = parsed.baseUrl ?? "http://localhost:11434/v1";

  try {
    new URL(baseUrl);
  } catch {
    return {
      handled: true,
      exitCode: 1,
      output: `Error: invalid base URL "${baseUrl}"`
    };
  }

  const probe = await probeOpenAIModels(baseUrl, options.providerFetch);
  let selectedModel: string;
  let warnings: string[] = [];

  if (parsed.model !== undefined) {
    selectedModel = parsed.model;
    if (probe.ok && !probe.models.includes(selectedModel)) {
      warnings.push(`Warning: "${selectedModel}" was not found in the discovered models.`);
    }
  } else if (probe.ok && probe.models.length === 1) {
    selectedModel = probe.models[0];
  } else if (probe.ok && probe.models.length > 1) {
    return {
      handled: true,
      exitCode: 1,
      output: [
        `Discovered ${probe.models.length} models at ${baseUrl}:`,
        ...probe.models.map((m) => `  ${m}`),
        "",
        `Run again with --model <id> to select one.`
      ].join("\n")
    };
  } else {
    return {
      handled: true,
      exitCode: 1,
      output: [
        `Could not discover models at ${baseUrl}: ${probe.message}`,
        "",
        `Run again with --model <id> to set a model manually.`
      ].join("\n")
    };
  }

  const setupInput: ProviderSetupInput = {
    provider: "local",
    model: selectedModel,
    models: probe.models,
    baseUrl,
    enableNetwork: true,
    scope: parsed.scope,
    requiresCredential: false,
    contextWindowTokens: parsed.contextWindow
  };

  const setupResult = await setupProviderConfig({
    ...options,
    input: setupInput
  });

  const lines: string[] = [
    "Configured local OpenAI-compatible provider.",
    `Base URL: ${baseUrl}`,
    `Model: ${selectedModel}`,
    "API key: none",
    `Config: ${setupResult.path}`
  ];

  if (parsed.contextWindow !== undefined && !Number.isNaN(parsed.contextWindow)) {
    lines.push(`Context window: ${parsed.contextWindow} tokens`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  lines.push("");
  lines.push(`Endpoint check: ${probe.ok ? "ready" : "blocked"} (${probe.message})`);
  lines.push(`Discovered models: ${probe.models.length === 0 ? "none" : probe.models.join(", ")}`);

  if (probe.ok) {
    lines.push("");
    lines.push("Next: run estacoda local test, then estacoda.");
  } else {
    lines.push("");
    lines.push("Next: start your local OpenAI-compatible server, then run estacoda local test.");
  }

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

export async function runModelSetupCustom(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const parsed = parseModelSetupCustomArgs(args);

  if (parsed.baseUrl === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Error: --base-url is required for custom endpoint setup.\n\nUsage: estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]"
    };
  }

  const baseUrl = parsed.baseUrl;

  try {
    new URL(baseUrl);
  } catch {
    return {
      handled: true,
      exitCode: 1,
      output: `Error: invalid base URL "${baseUrl}"`
    };
  }

  let providerId = parsed.providerId;
  if (providerId === undefined) {
    providerId = `custom-${shortHash(baseUrl)}`;
  }

  const syntaxValidation = validateProviderIdSyntax(providerId);
  if (!syntaxValidation.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: `Error: ${syntaxValidation.message}`
    };
  }

  const profileId = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const targetPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;

  const existing = await readConfig(targetPath);
  const conflict = validateCustomProviderId(existing.config, providerId as ProviderId, baseUrl);
  if (!conflict.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: `Error: ${conflict.message}`
    };
  }

  const probe = await probeOpenAIModels(baseUrl, options.providerFetch);
  let selectedModel: string;
  let warnings: string[] = [];

  if (parsed.model !== undefined) {
    selectedModel = parsed.model;
    if (probe.ok && !probe.models.includes(selectedModel)) {
      warnings.push(`Warning: "${selectedModel}" was not found in the discovered models at the endpoint.`);
    }
  } else if (probe.ok && probe.models.length === 1) {
    selectedModel = probe.models[0];
  } else if (probe.ok && probe.models.length > 1) {
    return {
      handled: true,
      exitCode: 1,
      output: [
        `Discovered ${probe.models.length} models at ${baseUrl}:`,
        ...probe.models.map((m) => `  ${m}`),
        "",
        `Run again with --model <id> to select one.`
      ].join("\n")
    };
  } else {
    return {
      handled: true,
      exitCode: 1,
      output: [
        `Could not discover models at ${baseUrl}: ${probe.message}`,
        "",
        `Run again with --model <id> to set a model manually.`
      ].join("\n")
    };
  }

  const lines: string[] = [
    `Custom endpoint: ${baseUrl}`,
    `Provider ID: ${providerId}`,
    `Model: ${selectedModel}`
  ];

  if (parsed.apiKeyEnv !== undefined) {
    lines.push(`API key env: ${parsed.apiKeyEnv}`);
  }

  if (parsed.contextWindow !== undefined && !Number.isNaN(parsed.contextWindow)) {
    lines.push(`Context window: ${parsed.contextWindow} tokens`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  lines.push("");
  lines.push("Saving configuration...");

  const setupInput: ProviderSetupInput = {
    provider: providerId as ProviderId,
    model: selectedModel,
    models: probe.models,
    baseUrl,
    apiKeyEnv: parsed.apiKeyEnv,
    enableNetwork: true,
    scope: parsed.scope,
    requiresCredential: parsed.apiKeyEnv !== undefined,
    contextWindowTokens: parsed.contextWindow
  };

  const setupResult = await setupProviderConfig({
    ...options,
    input: setupInput
  });

  lines.push(`Config: ${setupResult.path}`);
  lines.push("");
  lines.push(`Endpoint check: ${probe.ok ? "ready" : "blocked"} (${probe.message})`);
  lines.push(`Discovered models: ${probe.models.length === 0 ? "none" : probe.models.join(", ")}`);

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}
