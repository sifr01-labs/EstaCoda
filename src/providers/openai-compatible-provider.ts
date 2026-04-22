import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent
} from "../contracts/provider.js";
import { inferModelProfile } from "./model-catalog.js";
import { normalizeProviderMessagesStrict } from "./provider-message-normalizer.js";

export type OpenAICompatibleProviderOptions = {
  id: ProviderId;
  name?: string;
  endpoint: ProviderEndpoint;
  models?: string[] | ModelProfile[];
  enableNetwork?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): ProviderAdapter {
  const models = (options.models ?? []).map((entry) =>
    typeof entry === "string" ? inferModelProfile({ provider: options.id, model: entry }) : entry
  );

  return {
    id: options.id,
    name: options.name ?? `${options.id} OpenAI-compatible`,
    endpoint: options.endpoint,
    health() {
      if (options.endpoint.apiKey?.kind === "env" && process.env[options.endpoint.apiKey.name] === undefined) {
        return {
          available: false,
          reason: `Missing ${options.endpoint.apiKey.name}`
        };
      }

      return {
        available: true
      };
    },
    listModels() {
      return models;
    },
    async complete(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): Promise<ProviderResponse> {
      const health = await this.health();
      const preparedRequest = buildOpenAICompatibleRequest(options.endpoint, request, completionOptions?.credential?.value, options.id);

      if (!health.available) {
        return {
          ok: false,
          content: health.reason ?? "Provider is not available.",
          model: request.model,
          provider: options.id,
          errorClass: "auth",
          raw: preparedRequest
        };
      }

      if (options.enableNetwork === true) {
        return executeOpenAICompatibleRequest({
          provider: options.id,
          model: request.model,
          preparedRequest,
          fetch: options.fetch ?? globalThis.fetch,
          timeoutMs: options.timeoutMs ?? 60_000,
          signal: completionOptions?.signal
        });
      }

      return {
        ok: false,
        content: "Network inference is not enabled in this runtime yet. The OpenAI-compatible request was prepared.",
        model: request.model,
        provider: options.id,
        errorClass: "unsupported",
        raw: preparedRequest
      };
    },
    async *stream(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent> {
      const health = await this.health();
      const preparedRequest = buildOpenAICompatibleRequest(options.endpoint, {
        ...request,
        stream: true
      }, completionOptions?.credential?.value, options.id);

      if (!health.available) {
        yield {
          kind: "error",
          provider: options.id,
          model: request.model,
          response: {
            ok: false,
            content: health.reason ?? "Provider is not available.",
            model: request.model,
            provider: options.id,
            errorClass: "auth",
            raw: preparedRequest
          }
        };
        return;
      }

      if (options.enableNetwork !== true) {
        yield {
          kind: "error",
          provider: options.id,
          model: request.model,
          response: {
            ok: false,
            content: "Network inference is not enabled in this runtime yet. The OpenAI-compatible streaming request was prepared.",
            model: request.model,
            provider: options.id,
            errorClass: "unsupported",
            raw: preparedRequest
          }
        };
        return;
      }

      yield* streamOpenAICompatibleRequest({
        provider: options.id,
        model: request.model,
        preparedRequest,
        fetch: options.fetch ?? globalThis.fetch,
        timeoutMs: options.timeoutMs ?? 60_000,
        signal: completionOptions?.signal
      });
    }
  };
}

export function buildOpenAICompatibleRequest(endpoint: ProviderEndpoint, request: ProviderRequest): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};
export function buildOpenAICompatibleRequest(endpoint: ProviderEndpoint, request: ProviderRequest, credentialOverride: string | undefined): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};
export function buildOpenAICompatibleRequest(endpoint: ProviderEndpoint, request: ProviderRequest, credentialOverride: string | undefined, provider: ProviderId): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};
export function buildOpenAICompatibleRequest(endpoint: ProviderEndpoint, request: ProviderRequest, credentialOverride?: string, provider: ProviderId = "openai-compatible"): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const apiKey = credentialOverride ??
    (endpoint.apiKey?.kind === "literal"
      ? endpoint.apiKey.value
      : endpoint.apiKey?.kind === "env"
        ? process.env[endpoint.apiKey.name]
        : undefined);

  const normalized = normalizeOpenAICompatibleRequest(request, provider);

  return {
    url: `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      ...providerHeaders(provider),
      ...(endpoint.headers ?? {})
    },
    body: compactObject({
      model: normalized.model,
      messages: normalized.messages,
      temperature: normalized.temperature,
      max_tokens: normalized.maxTokens,
      stream: normalized.stream,
      tools: normalized.tools,
      response_format: normalized.responseFormat
    })
  };
}

export function normalizeOpenAICompatibleRequest(request: ProviderRequest, provider: ProviderId): ProviderRequest {
  const messages = normalizeProviderMessagesStrict(request.messages).messages;
  const supportsTools = provider !== "local" || modelLikelySupportsLocalTools(request.model);
  const supportsResponseFormat = provider !== "local";
  const normalized: ProviderRequest = {
    ...request,
    messages,
    temperature: normalizeTemperature(request.temperature, provider),
    tools: supportsTools ? request.tools : undefined,
    responseFormat: supportsResponseFormat ? request.responseFormat : undefined
  };

  return normalized;
}

export async function executeOpenAICompatibleRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildOpenAICompatibleRequest>;
  fetch: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProviderResponse> {
  const { signal, cleanup } = createTimeoutSignal(input.timeoutMs, input.signal);

  try {
    const response = await input.fetch(input.preparedRequest.url, {
      method: "POST",
      headers: input.preparedRequest.headers,
      body: JSON.stringify(input.preparedRequest.body),
      signal
    });

    if (!response.ok) {
      return {
        ok: false,
        content: await safeErrorText(response),
        model: input.model,
        provider: input.provider,
        errorClass: classifyHttpError(response.status),
        raw: {
          status: response.status,
          statusText: response.statusText
        }
      };
    }

    const payload = await response.json();
    return parseOpenAICompatibleResponse({
      provider: input.provider,
      model: input.model,
      payload
    });
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : "Network request failed.",
      model: input.model,
      provider: input.provider,
      errorClass: isAbortError(error) ? "timeout" : "network"
    };
  } finally {
    cleanup();
  }
}

export async function* streamOpenAICompatibleRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildOpenAICompatibleRequest>;
  fetch: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal;
}): AsyncIterable<ProviderStreamEvent> {
  const { signal, cleanup } = createTimeoutSignal(input.timeoutMs, input.signal);

  yield {
    kind: "start",
    provider: input.provider,
    model: input.model
  };

  try {
    const response = await input.fetch(input.preparedRequest.url, {
      method: "POST",
      headers: input.preparedRequest.headers,
      body: JSON.stringify(input.preparedRequest.body),
      signal
    });

    if (!response.ok) {
      yield {
        kind: "error",
        provider: input.provider,
        model: input.model,
        response: {
          ok: false,
          content: await safeErrorText(response),
          model: input.model,
          provider: input.provider,
          errorClass: classifyHttpError(response.status),
          raw: {
            status: response.status,
            statusText: response.statusText
          }
        }
      };
      return;
    }

    if (response.body === undefined || response.body === null) {
      const parsed = parseOpenAICompatibleResponse({
        provider: input.provider,
        model: input.model,
        payload: await response.json()
      });

      if (parsed.ok) {
        yield {
          kind: "token",
          provider: input.provider,
          model: input.model,
          text: parsed.content
        };
        yield {
          kind: "done",
          provider: input.provider,
          model: input.model,
          response: parsed
        };
      } else {
        yield {
          kind: "error",
          provider: input.provider,
          model: input.model,
          response: parsed
        };
      }

      return;
    }

    let content = "";
    let usage: ProviderResponse["usage"] | undefined;

    for await (const event of parseOpenAICompatibleStream(response.body, input.provider, input.model)) {
      if (event.kind === "token") {
        content += event.text;
      }

      if (event.kind === "error") {
        yield event;
        return;
      }

      if (event.kind === "done") {
        usage = event.response.usage;
        continue;
      }

      yield event;
    }

    yield {
      kind: "done",
      provider: input.provider,
      model: input.model,
      response: {
        ok: true,
        content,
        model: input.model,
        provider: input.provider,
        usage
      }
    };
  } catch (error) {
    yield {
      kind: "error",
      provider: input.provider,
      model: input.model,
      response: {
        ok: false,
        content: error instanceof Error ? error.message : "Network streaming request failed.",
        model: input.model,
        provider: input.provider,
        errorClass: isAbortError(error) ? "timeout" : "network"
      }
    };
  } finally {
    cleanup();
  }
}

export function parseOpenAICompatibleResponse(input: {
  provider: ProviderId;
  model: string;
  payload: unknown;
}): ProviderResponse {
  const payload = input.payload as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
      text?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    error?: {
      message?: string;
      type?: string;
      code?: string;
    };
  };

  if (payload.error !== undefined) {
    return {
      ok: false,
      content: payload.error.message ?? "Provider returned an error.",
      model: input.model,
      provider: input.provider,
      errorClass: classifyProviderError(payload.error.type ?? payload.error.code),
      raw: input.payload
    };
  }

  const firstChoice = payload.choices?.[0];
  const content = normalizeContent(firstChoice?.message?.content) ?? firstChoice?.text;

  if (content === undefined) {
    return {
      ok: false,
      content: "Provider response did not include assistant content.",
      model: input.model,
      provider: input.provider,
      errorClass: "unknown",
      raw: input.payload
    };
  }

  return {
    ok: true,
    content,
    model: input.model,
    provider: input.provider,
    usage: {
      inputTokens: payload.usage?.prompt_tokens,
      outputTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens
    },
    raw: input.payload
  };
}

export function classifyHttpError(status: number) {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 409 || status === 404) return "model-unavailable";
  if (status === 429) return "rate-limit";
  if (status === 402) return "quota";
  if (status >= 500) return "server";
  return "unknown";
}

function classifyProviderError(code: string | undefined) {
  if (code === undefined) return "unknown";
  if (/auth|key|permission|forbidden|unauthorized/i.test(code)) return "auth";
  if (/rate/i.test(code)) return "rate-limit";
  if (/quota|credit|billing/i.test(code)) return "quota";
  if (/model|not_found|unavailable/i.test(code)) return "model-unavailable";
  if (/timeout/i.test(code)) return "timeout";
  return "unknown";
}

function normalizeTemperature(temperature: number | undefined, provider: ProviderId): number | undefined {
  if (temperature === undefined) {
    return undefined;
  }

  if (provider === "kimi") {
    return 1;
  }

  if (provider === "local") {
    return clamp(temperature, 0, 2);
  }

  return temperature;
}

function providerHeaders(provider: ProviderId): Record<string, string> {
  if (provider === "openrouter") {
    return {
      "HTTP-Referer": "https://kemetresearch.com",
      "X-Title": "EstaCoda"
    };
  }

  return {};
}

function modelLikelySupportsLocalTools(model: string): boolean {
  return /tool|function|hermes|qwen|llama-3\.1|llama-3\.2|llama-3\.3/i.test(model);
}

function createTimeoutSignal(timeoutMs: number, parentSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

  if (parentSignal?.aborted === true) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function* parseOpenAICompatibleStream(
  body: ReadableStream<Uint8Array>,
  provider: ProviderId,
  model: string
): AsyncIterable<ProviderStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const read = await reader.read();

    if (read.done) {
      break;
    }

    buffer += decoder.decode(read.value, {
      stream: true
    });

    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0 || !trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice("data:".length).trim();

      if (data === "[DONE]") {
        return;
      }

      for (const event of parseOpenAICompatibleStreamChunk(data, provider, model)) {
        yield event;
      }
    }
  }

  if (buffer.trim().startsWith("data:")) {
    const data = buffer.trim().slice("data:".length).trim();

    if (data !== "[DONE]") {
      for (const event of parseOpenAICompatibleStreamChunk(data, provider, model)) {
        yield event;
      }
    }
  }
}

function parseOpenAICompatibleStreamChunk(data: string, provider: ProviderId, model: string): ProviderStreamEvent[] {
  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      error?: {
        message?: string;
        type?: string;
        code?: string;
      };
    };

    if (payload.error !== undefined) {
      return [{
        kind: "error",
        provider,
        model,
        response: {
          ok: false,
          content: payload.error.message ?? "Provider returned a streaming error.",
          model,
          provider,
          errorClass: classifyProviderError(payload.error.type ?? payload.error.code),
          raw: payload
        }
      }];
    }

    const events: ProviderStreamEvent[] = [];

    for (const choice of payload.choices ?? []) {
      if (choice.delta?.content !== undefined && choice.delta.content.length > 0) {
        events.push({
          kind: "token",
          provider,
          model,
          text: choice.delta.content
        });
      }

      for (const toolCall of choice.delta?.tool_calls ?? []) {
        events.push({
          kind: "tool-call",
          provider,
          model,
          index: toolCall.index,
          id: toolCall.id,
          name: toolCall.function?.name,
          argumentsText: toolCall.function?.arguments,
          raw: toolCall
        });
      }
    }

    if (payload.usage !== undefined) {
      events.push({
        kind: "done",
        provider,
        model,
        response: {
          ok: true,
          content: "",
          model,
          provider,
          usage: {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens
          },
          raw: payload
        }
      });
    }

    return events;
  } catch {
    return [];
  }
}

async function safeErrorText(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? JSON.stringify(payload);
  } catch {
    return response.text();
  }
}

function normalizeContent(content: string | Array<{ type?: string; text?: string }> | undefined): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text)
      .filter((part): part is string => part !== undefined)
      .join("\n");
  }

  return undefined;
}
