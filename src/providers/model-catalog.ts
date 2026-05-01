import type { ModelProfile, ProviderId } from "../contracts/provider.js";
import {
  listModelsByProvider,
  modelInfoToProfile,
  modelsDevSnapshotToProfiles,
  normalizeProviderIdForEstaCoda,
  resolveModelsDevSnapshot,
  type ModelsDevRegistryOptions
} from "../model-catalog/models-dev-registry.js";

export const fallbackKnownModelProfiles: readonly ModelProfile[] = [
  model("deepseek", "deepseek-chat", 64000, { tools: true, structured: true, open: false, status: "stable" }),
  model("deepseek", "deepseek-reasoner", 64000, { tools: true, structured: true, reasoning: true, open: false, status: "stable" }),
  model("kimi", "kimi-k2.5", 262144, { tools: true, vision: true, structured: true, reasoning: true, open: false, status: "stable" }),
  model("kimi", "kimi-k2-turbo-preview", 131072, { tools: true, structured: true, reasoning: true, open: false, status: "beta" }),
  model("openai", "gpt-4.1", 1047576, { tools: true, vision: true, structured: true, status: "stable" }),
  model("openai", "gpt-4.1-mini", 1047576, { tools: true, vision: true, structured: true, status: "stable" }),
  model("openai", "gpt-4o", 128000, { tools: true, vision: true, structured: true, status: "stable" }),
  model("openrouter", "openrouter/auto", 128000, { tools: true, vision: true, structured: true, status: "stable" }),
  model("openrouter", "qwen/qwen3.6-plus", 256000, { tools: true, vision: true, structured: true, reasoning: true, status: "stable" }),
  model("google", "gemini-2.5-pro", 1048576, { tools: true, vision: true, structured: true, reasoning: true, status: "stable" }),
  model("google", "gemini-2.5-flash", 1048576, { tools: true, vision: true, structured: true, reasoning: true, status: "stable" }),
  model("anthropic", "claude-sonnet-4.5", 200000, { tools: true, vision: true, status: "stable" }),
  model("anthropic", "claude-opus-4.1", 200000, { tools: true, vision: true, reasoning: true, status: "stable" }),
  model("local", "ollama/auto", 8192, { open: true, status: "stable" }),
  model("local", "llama.cpp/auto", 8192, { open: true, status: "stable" }),
  model("nous", "hermes-4", 128000, { tools: true, structured: true, reasoning: true, open: true, status: "stable" }),
  model("unconfigured", "unconfigured", 0, {})
];

export const knownModelProfiles = fallbackKnownModelProfiles;

export function inferModelProfile(input: {
  provider?: ProviderId;
  model: string;
  contextWindowTokens?: number;
}): ModelProfile {
  const provider = input.provider === undefined ? inferProviderFromModel(input.model) : normalizeProviderIdForEstaCoda(input.provider);
  const exact = fallbackKnownModelProfiles.find((candidate) =>
    candidate.provider === provider && candidate.id === input.model
  );

  if (exact !== undefined) {
    return {
      ...exact,
      contextWindowTokens: input.contextWindowTokens ?? exact.contextWindowTokens
    };
  }

  return {
    id: input.model,
    provider,
    contextWindowTokens: input.contextWindowTokens ?? inferContextWindow(input.model),
    status: "unknown",
    supportsTools: inferTools(input.model, provider),
    supportsVision: inferVision(input.model),
    supportsStructuredOutput: inferStructuredOutput(input.model, provider),
    supportsReasoning: inferReasoning(input.model),
    supportsStreaming: true,
    freeOrOpenWeights: provider === "local" || /llama|qwen|mistral|mixtral|hermes|deepseek-r1/i.test(input.model)
  };
}

export function inferProviderFromModel(modelId: string): ProviderId {
  const normalized = modelId.toLowerCase();

  if (normalized.startsWith("openai/") || normalized.startsWith("gpt-")) return "openai";
  if (normalized.startsWith("anthropic/") || normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("google/") || normalized.startsWith("gemini-")) return "google";
  if (normalized.startsWith("deepseek/") || normalized.startsWith("deepseek-")) return "deepseek";
  if (normalized.startsWith("moonshot/") || normalized.startsWith("moonshotai/") || normalized.startsWith("moonshot-ai/") || normalized.startsWith("kimi-")) return "kimi";
  if (normalized.startsWith("nous/") || normalized.includes("hermes")) return "nous";
  if (normalized.startsWith("ollama/") || normalized.startsWith("llama.cpp/") || normalized.startsWith("local/")) return "local";
  if (normalized.includes("/")) return "openrouter";

  return "openai-compatible";
}

export async function resolveModelProfilesFromCatalog(options: ModelsDevRegistryOptions = {}): Promise<ModelProfile[]> {
  const snapshot = await resolveModelsDevSnapshot(options);

  return uniqueModels([
    ...fallbackKnownModelProfiles.filter(isDefaultRoutableModel),
    ...modelsDevSnapshotToProfiles(snapshot)
  ]);
}

export async function resolveModelProfileFromCatalog(input: {
  provider?: ProviderId;
  model: string;
  contextWindowTokens?: number;
} & ModelsDevRegistryOptions): Promise<ModelProfile> {
  const provider = input.provider === undefined ? inferProviderFromModel(input.model) : normalizeProviderIdForEstaCoda(input.provider);
  const profiles = await resolveModelProfilesFromCatalog(input);
  const exact = profiles.find((candidate) => candidate.provider === provider && candidate.id === input.model);

  if (exact !== undefined) {
    return {
      ...exact,
      contextWindowTokens: input.contextWindowTokens ?? exact.contextWindowTokens
    };
  }

  return inferModelProfile(input);
}

export async function resolveProviderModelsFromCatalog(input: {
  provider: ProviderId;
  models?: string[];
} & ModelsDevRegistryOptions): Promise<ModelProfile[]> {
  const provider = normalizeProviderIdForEstaCoda(input.provider);

  if (input.models !== undefined && input.models.length > 0) {
    const profiles = await resolveModelProfilesFromCatalog(input);

    return input.models.map((modelId) =>
      profiles.find((candidate) => candidate.provider === provider && candidate.id === modelId) ??
      inferModelProfile({ provider, model: modelId })
    );
  }

  const modelInfo = await listModelsByProvider(provider, input);
  const catalogModels = modelInfo
    .filter((model) => model.status !== "deprecated" && model.status !== "alpha" && model.status !== "beta")
    .map(modelInfoToProfile);
  const fallbackModels = fallbackKnownModelProfiles.filter((model) => model.provider === provider && isDefaultRoutableModel(model));

  return uniqueModels([
    ...fallbackModels,
    ...catalogModels
  ]);
}

export function enrichModelProfiles(input: {
  models: string[] | ModelProfile[];
  provider: ProviderId;
  catalogProfiles?: readonly ModelProfile[];
}): ModelProfile[] {
  const provider = normalizeProviderIdForEstaCoda(input.provider);

  return input.models.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }

    return input.catalogProfiles?.find((candidate) => candidate.provider === provider && candidate.id === entry) ??
      inferModelProfile({ provider, model: entry });
  });
}

function model(
  provider: ProviderId,
  id: string,
  contextWindowTokens: number,
  capabilities: {
    tools?: boolean;
    vision?: boolean;
    structured?: boolean;
    reasoning?: boolean;
    open?: boolean;
    status?: ModelProfile["status"];
  }
): ModelProfile {
  return {
    id,
    provider,
    contextWindowTokens,
    status: capabilities.status,
    supportsTools: capabilities.tools ?? false,
    supportsVision: capabilities.vision ?? false,
    supportsStructuredOutput: capabilities.structured ?? false,
    supportsReasoning: capabilities.reasoning ?? false,
    supportsStreaming: true,
    freeOrOpenWeights: capabilities.open ?? false
  };
}

function uniqueModels(models: readonly ModelProfile[]): ModelProfile[] {
  const seen = new Map<string, ModelProfile>();

  for (const model of models) {
    seen.set(`${model.provider}:${model.id}`, {
      ...(seen.get(`${model.provider}:${model.id}`) ?? {}),
      ...model
    });
  }

  return [...seen.values()];
}

function isDefaultRoutableModel(model: ModelProfile): boolean {
  return model.status !== "deprecated" && model.status !== "alpha" && model.status !== "beta";
}

function inferContextWindow(modelId: string): number {
  const normalized = modelId.toLowerCase();

  if (normalized.includes("1m") || normalized.includes("gpt-4.1") || normalized.includes("gemini")) return 1048576;
  if (normalized.includes("kimi")) return 262144;
  if (normalized.includes("claude")) return 200000;
  if (normalized.includes("gpt-4o") || normalized.includes("openrouter")) return 128000;
  if (normalized.includes("deepseek")) return 64000;
  if (normalized.includes("llama") || normalized.includes("ollama")) return 8192;

  return 128000;
}

function inferTools(modelId: string, provider: ProviderId): boolean {
  return provider !== "local" || /tool|function|hermes|qwen|llama-3\.1|llama-3\.2|llama-3\.3/i.test(modelId);
}

function inferVision(modelId: string): boolean {
  return /vision|vl|gpt-4o|gemini|claude|llava|kimi-k2(\.5)?/i.test(modelId);
}

function inferStructuredOutput(modelId: string, provider: ProviderId): boolean {
  return provider !== "local" || /json|tool|function|hermes|qwen/i.test(modelId);
}

function inferReasoning(modelId: string): boolean {
  return /reason|thinking|r1|o1|o3|o4|k2|gemini-2\.5|opus/i.test(modelId);
}
