export type ProviderId =
  | "openai-compatible"
  | "local"
  | "deepseek"
  | "kimi"
  | "minimax"
  | "google"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "nous"
  | "unconfigured"
  | (string & {});

export type ModelProfile = {
  id: string;
  provider: ProviderId;
  contextWindowTokens: number;
  status?: "stable" | "alpha" | "beta" | "deprecated" | "unknown";
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  supportsReasoning?: boolean;
  supportsStreaming?: boolean;
  freeOrOpenWeights?: boolean;
  cost?: {
    inputPerMillionTokens?: number;
    outputPerMillionTokens?: number;
  };
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
};

export type ProviderCredentialSource =
  | {
      kind: "env";
      name: string;
    }
  | {
      kind: "literal";
      value: string;
    }
  | {
      kind: "none";
    };

export type ProviderEndpoint = {
  baseUrl: string;
  apiKey?: ProviderCredentialSource;
  headers?: Record<string, string>;
};

export type ProviderUxKind =
  | "hosted"
  | "local"
  | "custom-openai-compatible"
  | "openrouter"
  | "aggregator";

export type ProviderSetupMode =
  | "api-key"
  | "base-url"
  | "api-key-and-base-url"
  | "none";

export type ProviderHealth = {
  available: boolean;
  reason?: string;
};

export type ProviderMessageContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

export type ProviderMessageContent = string | ProviderMessageContentPart[];

export type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  // Intentionally loose at the boundary because providers can accept
  // heterogeneous multimodal payloads and the runtime still has some
  // string-oriented paths that are being hardened incrementally.
  content: any;
  name?: string;
};

export type ProviderRequest = {
  provider?: ProviderId;
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: unknown[];
  responseFormat?: unknown;
};

export type ResolvedModelRoute = {
  provider: ProviderId;
  id: string;
  profile: ModelProfile;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  apiMode?: ProviderApiMode;
  authMethod?: ProviderAuthMethod;
};

export type AuxiliaryModelProvider = ProviderId | "auto" | "main";

export type AuxiliaryModelSlotConfig = {
  provider?: AuxiliaryModelProvider;
  id?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
  extraBody?: Record<string, unknown>;
  fallbackToMain?: boolean;
  enabled?: boolean;
};

export type AuxiliaryModelSlotInput = AuxiliaryModelSlotConfig | string;

export type AuxiliaryModelTask =
  | "vision"
  | "compression"
  | "assessor"
  | "web_extract"
  | "session_search"
  | "mcp"
  | "memory_flush"
  | "delegation"
  | "skills_library"
  | "title_generation"
  | "curator"
  | "memory_compaction"
  | "profile_context";

export type AuxiliaryModelConfig = {
  default?: AuxiliaryModelSlotInput;
} & Partial<Record<AuxiliaryModelTask, AuxiliaryModelSlotInput>>;

export type ResolvedAuxiliaryRoute = {
  task: AuxiliaryModelTask;
  route: ResolvedModelRoute | undefined;
  source: "main" | "auto-main" | "auto-configured" | "explicit" | "custom" | "disabled";
  fallbackToMain: boolean;
  timeoutMs?: number;
  maxConcurrency?: number;
  diagnostics: string[];
};

export type ProviderCompletionOptions = {
  credential?: {
    id: string;
    value?: string;
  };
  endpoint?: ProviderEndpoint;
  signal?: AbortSignal;
};

export type ProviderResponse = {
  ok: boolean;
  content: string;
  model: string;
  provider: ProviderId;
  errorClass?: ProviderErrorClass;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
};

export type ProviderStreamEvent =
  | {
      kind: "start";
      provider: ProviderId;
      model: string;
    }
  | {
      kind: "token";
      provider: ProviderId;
      model: string;
      text: string;
    }
  | {
      kind: "tool-call";
      provider: ProviderId;
      model: string;
      index?: number;
      id?: string;
      name?: string;
      argumentsText?: string;
      raw?: unknown;
    }
  | {
      kind: "done";
      provider: ProviderId;
      model: string;
      response: ProviderResponse;
    }
  | {
      kind: "error";
      provider: ProviderId;
      model: string;
      response: ProviderResponse;
    };

export type ProviderErrorClass =
  | "auth"
  | "rate-limit"
  | "quota"
  | "network"
  | "server"
  | "timeout"
  | "incomplete-stream"
  | "model-unavailable"
  | "unsupported"
  | "missing-route"
  | "unknown";

export type ProviderRoutePreferences = {
  requireTools?: boolean;
  requireVision?: boolean;
  requireStructuredOutput?: boolean;
  requireReasoning?: boolean;
  preferFreeOrOpenWeights?: boolean;
  maxCostInputPerMillionTokens?: number;
  providerOrder?: ProviderId[];
  providerAllowlist?: ProviderId[];
  providerBlocklist?: ProviderId[];
};

export type ProviderAdapter = {
  id: ProviderId;
  name: string;
  endpoint?: ProviderEndpoint;
  executable?: boolean;
  health(endpointOverride?: ProviderEndpoint): Promise<ProviderHealth> | ProviderHealth;
  listModels(): Promise<ModelProfile[]> | ModelProfile[];
  complete(request: ProviderRequest, options?: ProviderCompletionOptions): Promise<ProviderResponse>;
  stream?(request: ProviderRequest, options?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent>;
};

export type ProviderAuthMethod =
  | "none"
  | "api_key"
  | "oauth_device"
  | "oauth_device_pkce"
  | "oauth_pkce_poll"
  | "oauth_external";

export type ProviderApiMode =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "custom_openai_compatible";
