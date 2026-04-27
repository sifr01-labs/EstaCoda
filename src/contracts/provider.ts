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
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: unknown[];
  responseFormat?: unknown;
};

export type ProviderCompletionOptions = {
  credential?: {
    id: string;
    value?: string;
  };
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
  | "model-unavailable"
  | "unsupported"
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

export type ProviderRoute = {
  primary: ModelProfile;
  fallbacks: ModelProfile[];
  reason: string;
};

export type AuxiliaryProviderTask =
  | "main"
  | "vision"
  | "compression"
  | "web_extract"
  | "session_search"
  | "skills_hub"
  | "mcp"
  | "memory_flush"
  | "delegation";

export type AuxiliaryProviderConfig = Partial<Record<AuxiliaryProviderTask, ProviderRoutePreferences>>;

export type AuxiliaryProviderRoute = {
  task: AuxiliaryProviderTask;
  route?: ProviderRoute;
  preferences: ProviderRoutePreferences;
};

export type ProviderAdapter = {
  id: ProviderId;
  name: string;
  endpoint?: ProviderEndpoint;
  health(): Promise<ProviderHealth> | ProviderHealth;
  listModels(): Promise<ModelProfile[]> | ModelProfile[];
  complete(request: ProviderRequest, options?: ProviderCompletionOptions): Promise<ProviderResponse>;
  stream?(request: ProviderRequest, options?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent>;
};

export type CredentialPoolEntry = {
  id: string;
  source: ProviderCredentialSource;
  priority?: number;
  cooldownUntil?: string;
  failureCount?: number;
  usageCount?: number;
};

export type CredentialRotationStrategy =
  | "fill_first"
  | "round_robin"
  | "least_used"
  | "random";

export type CredentialPoolSnapshot = {
  provider: ProviderId;
  strategy: CredentialRotationStrategy;
  entries: Array<{
    id: string;
    priority: number;
    available: boolean;
    cooldownUntil?: string;
    failureCount: number;
    usageCount: number;
  }>;
};
