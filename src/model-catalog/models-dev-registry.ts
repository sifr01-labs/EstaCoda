import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProfile, ProviderId } from "../contracts/provider.js";

export type ModelModality = "text" | "image" | "pdf" | "audio" | "video";
export type ModelStatus = "" | "alpha" | "beta" | "deprecated";

export type ModelInfo = {
  id: string;
  name: string;
  family: string;
  providerId: string;
  reasoning: boolean;
  toolCall: boolean;
  attachment: boolean;
  temperature: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  inputModalities: ModelModality[];
  outputModalities: ModelModality[];
  contextWindow: number;
  maxInput?: number;
  maxOutput: number;
  costInput?: number;
  costOutput?: number;
  costReasoning?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costInputAudio?: number;
  costOutputAudio?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  lastUpdated?: string;
  status: ModelStatus;
  interleaved: boolean | { field: string };
};

export type ProviderInfo = {
  id: string;
  name: string;
  npmPackage?: string;
  baseUrl?: string;
  envVars: string[];
  documentationUrl?: string;
  logoUrl?: string;
};

export type ModelsDevSnapshot = {
  providers: ProviderInfo[];
  models: ModelInfo[];
  fetchedAt: string;
  source: "bundled" | "disk" | "remote" | "empty";
};

export type ModelsDevRegistryOptions = {
  homeDir?: string;
  cachePath?: string;
  bundledSnapshotPath?: string;
  allowNetwork?: boolean;
  refreshTtlMs?: number;
  fetchTimeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

export type FetchLike = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type CostEstimate = {
  amountUsd: number;
  status: "estimated" | "unknown_pricing";
  breakdown: {
    inputUsd: number;
    outputUsd: number;
    reasoningUsd: number;
    cacheReadUsd: number;
    cacheWriteUsd: number;
    inputAudioUsd: number;
    outputAudioUsd: number;
  };
};

const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_REFRESH_TTL_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

let memoryCache: ModelsDevSnapshot | undefined;
let memoryCacheLoadedAt = 0;
let backgroundRefresh: Promise<ModelsDevSnapshot | undefined> | undefined;

export async function resolveModelsDevSnapshot(options: ModelsDevRegistryOptions = {}): Promise<ModelsDevSnapshot> {
  const now = getNow(options);
  const refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  const allowNetwork = options.allowNetwork ?? false;

  if (memoryCache !== undefined && now.getTime() - memoryCacheLoadedAt < refreshTtlMs) {
    return memoryCache;
  }

  const [disk, bundled] = await Promise.all([
    loadDiskSnapshot(options),
    loadBundledSnapshot(options)
  ]);
  const local = newestSnapshot([disk, bundled]);

  if (local !== undefined) {
    setMemoryCache(local, now);

    if (allowNetwork && isSnapshotStale(local, now, refreshTtlMs)) {
      void refreshModelsDevSnapshot(options);
    }

    return local;
  }

  if (allowNetwork) {
    const remote = await fetchRemoteSnapshot(options);

    if (remote !== undefined) {
      setMemoryCache(remote, now);
      return remote;
    }
  }

  const empty: ModelsDevSnapshot = {
    providers: [],
    models: [],
    fetchedAt: now.toISOString(),
    source: "empty"
  };
  setMemoryCache(empty, now);

  return empty;
}

export async function refreshModelsDevSnapshot(options: ModelsDevRegistryOptions = {}): Promise<ModelsDevSnapshot | undefined> {
  if (backgroundRefresh !== undefined) {
    return backgroundRefresh;
  }

  backgroundRefresh = fetchRemoteSnapshot(options)
    .then((snapshot) => {
      if (snapshot !== undefined) {
        setMemoryCache(snapshot, getNow(options));
      }

      return snapshot;
    })
    .finally(() => {
      backgroundRefresh = undefined;
    });

  return backgroundRefresh;
}

export async function findModel(modelId: string, options: ModelsDevRegistryOptions = {}): Promise<ModelInfo | undefined> {
  const snapshot = await resolveModelsDevSnapshot(options);
  const normalized = normalizeLookupKey(modelId);

  return snapshot.models.find((model) =>
    normalizeLookupKey(model.id) === normalized ||
    normalizeLookupKey(model.name) === normalized
  );
}

export async function findProvider(providerId: string, options: ModelsDevRegistryOptions = {}): Promise<ProviderInfo | undefined> {
  const snapshot = await resolveModelsDevSnapshot(options);
  const normalized = normalizeLookupKey(providerId);

  return snapshot.providers.find((provider) =>
    normalizeLookupKey(provider.id) === normalized ||
    normalizeLookupKey(provider.name) === normalized
  );
}

export async function listModelsByProvider(providerId: string, options: ModelsDevRegistryOptions = {}): Promise<ModelInfo[]> {
  const snapshot = await resolveModelsDevSnapshot(options);
  const normalized = normalizeProviderIdForEstaCoda(providerId);

  return snapshot.models.filter((model) =>
    normalizeProviderIdForEstaCoda(model.providerId) === normalized
  );
}

export async function listUsableModels(options: ModelsDevRegistryOptions & {
  includeAlpha?: boolean;
  includeBeta?: boolean;
  includeDeprecated?: boolean;
} = {}): Promise<ModelInfo[]> {
  const snapshot = await resolveModelsDevSnapshot(options);

  return snapshot.models.filter((model) => shouldIncludeModelStatus(model.status, options));
}

export function modelsDevSnapshotToProfiles(snapshot: ModelsDevSnapshot, options: {
  includeAlpha?: boolean;
  includeBeta?: boolean;
  includeDeprecated?: boolean;
} = {}): ModelProfile[] {
  return snapshot.models
    .filter((model) => shouldIncludeModelStatus(model.status, options))
    .map(modelInfoToProfile);
}

export function modelInfoToProfile(model: ModelInfo): ModelProfile {
  return {
    id: model.id,
    provider: normalizeProviderIdForEstaCoda(model.providerId),
    contextWindowTokens: model.contextWindow,
    status: profileStatus(model.status),
    supportsTools: model.toolCall,
    supportsVision: model.inputModalities.includes("image"),
    supportsStructuredOutput: model.structuredOutput,
    supportsReasoning: model.reasoning,
    supportsStreaming: true,
    freeOrOpenWeights: model.openWeights,
    cost: {
      inputPerMillionTokens: model.costInput,
      outputPerMillionTokens: model.costOutput
    }
  };
}

export function estimateCost(model: ModelInfo, usage: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
}): CostEstimate {
  const inputUsd = costFor(usage.inputTokens, model.costInput);
  const outputUsd = costFor(usage.outputTokens, model.costOutput);
  const reasoningUsd = costFor(usage.reasoningTokens, model.costReasoning);
  const cacheReadUsd = costFor(usage.cacheReadTokens, model.costCacheRead);
  const cacheWriteUsd = costFor(usage.cacheWriteTokens, model.costCacheWrite);
  const inputAudioUsd = costFor(usage.inputAudioTokens, model.costInputAudio);
  const outputAudioUsd = costFor(usage.outputAudioTokens, model.costOutputAudio);
  const amountUsd = inputUsd + outputUsd + reasoningUsd + cacheReadUsd + cacheWriteUsd + inputAudioUsd + outputAudioUsd;
  const hasKnownPricing = [
    model.costInput,
    model.costOutput,
    model.costReasoning,
    model.costCacheRead,
    model.costCacheWrite,
    model.costInputAudio,
    model.costOutputAudio
  ].some((value) => typeof value === "number");

  return {
    amountUsd,
    status: hasKnownPricing ? "estimated" : "unknown_pricing",
    breakdown: {
      inputUsd,
      outputUsd,
      reasoningUsd,
      cacheReadUsd,
      cacheWriteUsd,
      inputAudioUsd,
      outputAudioUsd
    }
  };
}

export function normalizeProviderIdForEstaCoda(providerId: string): ProviderId {
  const normalized = providerId.trim().toLowerCase();

  switch (normalized) {
    case "moonshot":
    case "moonshotai":
    case "moonshot-ai":
      return "kimi";
    case "ollama":
      return "local";
    default:
      return normalized as ProviderId;
  }
}

export function resetModelsDevRegistryForTest(): void {
  memoryCache = undefined;
  memoryCacheLoadedAt = 0;
  backgroundRefresh = undefined;
}

async function loadBundledSnapshot(options: ModelsDevRegistryOptions): Promise<ModelsDevSnapshot | undefined> {
  const snapshotPath = options.bundledSnapshotPath ?? defaultBundledSnapshotPath();

  try {
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    return normalizeModelsDevApi(parsed, {
      fetchedAt: inferFetchedAt(parsed) ?? new Date(0).toISOString(),
      source: "bundled"
    });
  } catch {
    return undefined;
  }
}

async function loadDiskSnapshot(options: ModelsDevRegistryOptions): Promise<ModelsDevSnapshot | undefined> {
  try {
    const path = getCachePath(options);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    return normalizeModelsDevApi(parsed, {
      fetchedAt: inferFetchedAt(parsed) ?? new Date(0).toISOString(),
      source: "disk"
    });
  } catch {
    return undefined;
  }
}

async function fetchRemoteSnapshot(options: ModelsDevRegistryOptions): Promise<ModelsDevSnapshot | undefined> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`models.dev fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetchImpl(MODELS_DEV_URL, {
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return undefined;
    }

    const data = await response.json();
    const snapshot = normalizeModelsDevApi(data, {
      fetchedAt: getNow(options).toISOString(),
      source: "remote"
    });

    await saveDiskSnapshot(snapshot, options);

    return snapshot;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveDiskSnapshot(snapshot: ModelsDevSnapshot, options: ModelsDevRegistryOptions): Promise<void> {
  try {
    const path = getCachePath(options);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort cache write only.
  }
}

function normalizeModelsDevApi(data: unknown, metadata: Pick<ModelsDevSnapshot, "fetchedAt" | "source">): ModelsDevSnapshot {
  if (!isRecord(data)) {
    return {
      providers: [],
      models: [],
      fetchedAt: metadata.fetchedAt,
      source: metadata.source
    };
  }

  const arrayShape = normalizeArrayShape(data, metadata);

  if (arrayShape.providers.length > 0 || arrayShape.models.length > 0) {
    return arrayShape;
  }

  return normalizeProviderKeyedShape(data, metadata);
}

function normalizeArrayShape(data: Record<string, unknown>, metadata: Pick<ModelsDevSnapshot, "fetchedAt" | "source">): ModelsDevSnapshot {
  const providers = (Array.isArray(data.providers) ? data.providers : [])
    .filter(isRecord)
    .map((provider) => normalizeProvider(provider));
  const models = (Array.isArray(data.models) ? data.models : [])
    .filter(isRecord)
    .map((model) => normalizeModel(model));

  return {
    providers: dedupeProviders(providers),
    models: dedupeModels(models),
    fetchedAt: metadata.fetchedAt,
    source: metadata.source
  };
}

function normalizeProviderKeyedShape(data: Record<string, unknown>, metadata: Pick<ModelsDevSnapshot, "fetchedAt" | "source">): ModelsDevSnapshot {
  const providers: ProviderInfo[] = [];
  const models: ModelInfo[] = [];

  for (const [providerId, providerRaw] of Object.entries(data)) {
    if (!isRecord(providerRaw)) {
      continue;
    }

    const provider = normalizeProvider(providerRaw, providerId);
    providers.push(provider);

    if (Array.isArray(providerRaw.models)) {
      for (const rawModel of providerRaw.models) {
        if (isRecord(rawModel)) {
          models.push(normalizeModel(rawModel, provider.id));
        }
      }
    } else if (isRecord(providerRaw.models)) {
      for (const [modelId, rawModel] of Object.entries(providerRaw.models)) {
        if (isRecord(rawModel)) {
          models.push(normalizeModel(rawModel, provider.id, modelId));
        }
      }
    }
  }

  return {
    providers: dedupeProviders(providers),
    models: dedupeModels(models),
    fetchedAt: metadata.fetchedAt,
    source: metadata.source
  };
}

function normalizeProvider(raw: Record<string, unknown>, fallbackId?: string): ProviderInfo {
  const id = stringValue(raw.id) ?? fallbackId ?? "";

  return {
    id,
    name: stringValue(raw.name) ?? id,
    npmPackage: stringValue(raw.npm_package) ?? stringValue(raw.npmPackage) ?? stringValue(raw.npm),
    baseUrl: stringValue(raw.base_url) ?? stringValue(raw.baseUrl) ?? stringValue(raw.api),
    envVars: stringArray(raw.env_vars) ?? stringArray(raw.envVars) ?? stringArray(raw.env) ?? [],
    documentationUrl: stringValue(raw.documentation_url) ?? stringValue(raw.documentationUrl) ?? stringValue(raw.doc),
    logoUrl: stringValue(raw.logo_url) ?? stringValue(raw.logoUrl)
  };
}

function normalizeModel(raw: Record<string, unknown>, fallbackProviderId?: string, fallbackModelId?: string): ModelInfo {
  const cost = isRecord(raw.cost) ? raw.cost : {};
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const id = stringValue(raw.id) ?? fallbackModelId ?? "";
  const providerId = stringValue(raw.provider_id) ??
    stringValue(raw.providerId) ??
    fallbackProviderId ??
    inferProviderIdFromModelId(id);

  return {
    id,
    name: stringValue(raw.name) ?? id,
    family: stringValue(raw.family) ?? inferFamily(id),
    providerId,
    reasoning: booleanValue(raw.reasoning, false),
    toolCall: booleanValue(raw.tool_call, booleanValue(raw.toolCall, false)),
    attachment: booleanValue(raw.attachment, false),
    temperature: booleanValue(raw.temperature, true),
    structuredOutput: booleanValue(raw.structured_output, booleanValue(raw.structuredOutput, false)),
    openWeights: booleanValue(raw.open_weights, booleanValue(raw.openWeights, false)),
    inputModalities: normalizeModalities(raw.input_modalities, raw.inputModalities, modalities.input),
    outputModalities: normalizeModalities(raw.output_modalities, raw.outputModalities, modalities.output),
    contextWindow: numberValue(raw.context_window) ?? numberValue(raw.contextWindow) ?? numberValue(limit.context) ?? 0,
    maxInput: numberValue(raw.max_input) ?? numberValue(raw.maxInput) ?? numberValue(limit.input),
    maxOutput: numberValue(raw.max_output) ?? numberValue(raw.maxOutput) ?? numberValue(limit.output) ?? 0,
    costInput: numberValue(raw.cost_input) ?? numberValue(raw.costInput) ?? numberValue(cost.input),
    costOutput: numberValue(raw.cost_output) ?? numberValue(raw.costOutput) ?? numberValue(cost.output),
    costReasoning: numberValue(raw.cost_reasoning) ?? numberValue(raw.costReasoning) ?? numberValue(cost.reasoning),
    costCacheRead: numberValue(raw.cost_cache_read) ?? numberValue(raw.costCacheRead) ?? numberValue(cost.cache_read),
    costCacheWrite: numberValue(raw.cost_cache_write) ?? numberValue(raw.costCacheWrite) ?? numberValue(cost.cache_write),
    costInputAudio: numberValue(raw.cost_input_audio) ?? numberValue(raw.costInputAudio) ?? numberValue(cost.input_audio),
    costOutputAudio: numberValue(raw.cost_output_audio) ?? numberValue(raw.costOutputAudio) ?? numberValue(cost.output_audio),
    knowledgeCutoff: stringValue(raw.knowledge_cutoff) ?? stringValue(raw.knowledgeCutoff) ?? stringValue(raw.knowledge),
    releaseDate: stringValue(raw.release_date) ?? stringValue(raw.releaseDate),
    lastUpdated: stringValue(raw.last_updated) ?? stringValue(raw.lastUpdated),
    status: normalizeStatus(raw.status),
    interleaved: normalizeInterleaved(raw.interleaved)
  };
}

function shouldIncludeModelStatus(status: ModelStatus, options: {
  includeAlpha?: boolean;
  includeBeta?: boolean;
  includeDeprecated?: boolean;
}): boolean {
  if (status === "deprecated" && options.includeDeprecated !== true) return false;
  if (status === "alpha" && options.includeAlpha !== true) return false;
  if (status === "beta" && options.includeBeta !== true) return false;
  return true;
}

function profileStatus(status: ModelStatus): ModelProfile["status"] {
  if (status === "") return "unknown";
  return status;
}

function normalizeModalities(...values: unknown[]): ModelModality[] {
  for (const value of values) {
    const array = stringArray(value);

    if (array !== undefined) {
      return array.filter(isModelModality);
    }
  }

  return [];
}

function normalizeStatus(value: unknown): ModelStatus {
  if (value === "alpha" || value === "beta" || value === "deprecated") {
    return value;
  }

  return "";
}

function normalizeInterleaved(value: unknown): boolean | { field: string } {
  if (typeof value === "boolean") return value;

  if (isRecord(value)) {
    const field = stringValue(value.field);

    if (field !== undefined) {
      return { field };
    }
  }

  return false;
}

function dedupeProviders(providers: ProviderInfo[]): ProviderInfo[] {
  const seen = new Map<string, ProviderInfo>();

  for (const provider of providers) {
    if (provider.id.length === 0) continue;
    seen.set(provider.id, {
      ...(seen.get(provider.id) ?? {}),
      ...provider
    });
  }

  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Map<string, ModelInfo>();

  for (const model of models) {
    if (model.id.length === 0) continue;
    const key = `${normalizeProviderIdForEstaCoda(model.providerId)}:${model.id}`;
    seen.set(key, {
      ...(seen.get(key) ?? {}),
      ...model,
      providerId: normalizeProviderIdForEstaCoda(model.providerId)
    });
  }

  return [...seen.values()].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) ||
    left.id.localeCompare(right.id)
  );
}

function newestSnapshot(snapshots: Array<ModelsDevSnapshot | undefined>): ModelsDevSnapshot | undefined {
  return snapshots
    .filter((snapshot): snapshot is ModelsDevSnapshot => snapshot !== undefined)
    .sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt))[0];
}

function isSnapshotStale(snapshot: ModelsDevSnapshot, now: Date, ttlMs: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);

  return !Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > ttlMs;
}

function setMemoryCache(snapshot: ModelsDevSnapshot, now: Date): void {
  memoryCache = snapshot;
  memoryCacheLoadedAt = now.getTime();
}

function getCachePath(options: ModelsDevRegistryOptions): string {
  return options.cachePath ?? join(options.homeDir ?? process.env.HOME ?? process.cwd(), ".estacoda", "models_dev_cache.json");
}

function defaultBundledSnapshotPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/models_dev_snapshot.json");
}

function getNow(options: ModelsDevRegistryOptions): Date {
  return options.now?.() ?? new Date();
}

function inferFetchedAt(data: unknown): string | undefined {
  return isRecord(data) ? stringValue(data.fetchedAt) ?? stringValue(data.fetched_at) : undefined;
}

function inferProviderIdFromModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");

  if (slashIndex > 0) return modelId.slice(0, slashIndex);
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("kimi-")) return "kimi";
  if (modelId.startsWith("grok-")) return "xai";
  return "openai-compatible";
}

function inferFamily(modelId: string): string {
  const normalized = modelId.toLowerCase();

  if (normalized.includes("gpt")) return "gpt";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("deepseek")) return "deepseek";
  if (normalized.includes("kimi")) return "kimi";
  if (normalized.includes("qwen")) return "qwen";
  if (normalized.includes("llama")) return "llama";
  if (normalized.includes("mistral")) return "mistral";
  if (normalized.includes("hermes")) return "hermes";
  return "";
}

function costFor(tokens: number | undefined, costPerMillion: number | undefined): number {
  return tokens === undefined || costPerMillion === undefined ? 0 : (tokens / 1_000_000) * costPerMillion;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/_/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => item !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelModality(value: string): value is ModelModality {
  return value === "text" ||
    value === "image" ||
    value === "pdf" ||
    value === "audio" ||
    value === "video";
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}
