import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderFinishReason,
  ProviderReasoningMetadata,
  ProviderUsage
} from "../contracts/provider.js";
import { classifyHttpError } from "./openai-compatible-provider.js";
import {
  extractInlineReasoning,
  mergeReasoningParts,
  reasoningMetadataFromReasoning
} from "./provider-reasoning.js";

export type OpenAIResponsesProviderOptions = {
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

export function createOpenAIResponsesProvider(options: OpenAIResponsesProviderOptions): ProviderAdapter {
  const models = (options.models ?? []).map((entry) =>
    typeof entry === "string"
      ? inferModelProfile({ provider: options.id, model: entry })
      : entry
  );

  return {
    id: options.id,
    name: options.name ?? `${options.id} Responses`,
    endpoint: options.endpoint,
    executable: true,
    health(endpointOverride?: ProviderEndpoint) {
      const effectiveEndpoint = endpointOverride ?? options.endpoint;
      if (effectiveEndpoint.apiKey?.kind === "env" && process.env[effectiveEndpoint.apiKey.name] === undefined) {
        return {
          available: false,
          reason: `Missing ${effectiveEndpoint.apiKey.name}`
        };
      }
      return { available: true };
    },
    listModels() {
      return models;
    },
    async complete(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): Promise<ProviderResponse> {
      const effectiveEndpoint = completionOptions?.endpoint ?? options.endpoint;
      const health = await this.health(completionOptions?.endpoint);
      const preparedRequest = buildResponsesRequest(effectiveEndpoint, request, completionOptions?.credential?.value, options.id);

      if (!health.available && completionOptions?.credential?.value === undefined) {
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
        return executeResponsesRequest({
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
        content: "Network inference is not enabled in this runtime yet. The Responses API request was prepared.",
        model: request.model,
        provider: options.id,
        errorClass: "unsupported",
        raw: preparedRequest
      };
    },
    async *stream(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent> {
      yield {
        kind: "error",
        provider: options.id,
        model: request.model,
        response: {
          ok: false,
          content: "Streaming is not yet supported for the Responses API.",
          model: request.model,
          provider: options.id,
          errorClass: "unsupported"
        }
      };
    }
  };
}

function inferModelProfile(input: { provider: ProviderId; model: string }): ModelProfile {
  return {
    id: input.model,
    provider: input.provider,
    contextWindowTokens: 128_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false
  };
}

export function buildResponsesRequest(
  endpoint: ProviderEndpoint,
  request: ProviderRequest,
  credentialOverride?: string,
  provider: ProviderId = "openai-responses"
): {
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

  const { instructions, input } = extractInstructionsAndInput(request.messages);
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

  const body: Record<string, unknown> = {
    model: request.model,
    instructions,
    input,
    store: false
  };

  const maxTokens = normalizeProviderMaxTokens(request.maxTokens);
  if (maxTokens !== undefined) {
    body.max_output_tokens = maxTokens;
  }

  if (hasTools) {
    body.tools = request.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
  }

  return {
    url: `${endpoint.baseUrl.replace(/\/$/, "")}/responses`,
    headers: {
      "content-type": "application/json",
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      ...(endpoint.headers ?? {})
    },
    body
  };
}

function normalizeProviderMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function extractInstructionsAndInput(messages: ProviderRequest["messages"]): {
  instructions?: string;
  input: unknown;
} {
  const nonSystemMessages: Array<{ role: string; content: unknown }> = [];
  let instructions: string | undefined;

  for (const message of messages) {
    if (message.role === "system") {
      if (instructions === undefined) {
        instructions = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      } else {
        nonSystemMessages.push({ role: "developer", content: message.content });
      }
      continue;
    }

    if (message.role === "tool") {
      nonSystemMessages.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      });
      continue;
    }

    nonSystemMessages.push({
      role: message.role,
      content: message.content
    });
  }

  return {
    instructions,
    input: nonSystemMessages
  };
}

export async function executeResponsesRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildResponsesRequest>;
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
    return parseResponsesPayload({
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

export function parseResponsesPayload(input: {
  provider: ProviderId;
  model: string;
  payload: unknown;
}): ProviderResponse {
  const payload = input.payload as {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: Array<{
      type?: string;
      role?: string;
      content?: Array<{
        type?: string;
        text?: string;
        reasoning?: string;
        thinking?: string;
      }> | string;
      text?: string;
      reasoning?: string;
      summary?: Array<{ text?: string }>;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      reasoning_tokens?: number;
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
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
      errorClass: classifyProviderError(payload.error.type ?? payload.error.code) as import("../contracts/provider.js").ProviderErrorClass,
      raw: input.payload
    };
  }

  if (payload.status === "failed") {
    return {
      ok: false,
      content: "Response generation failed.",
      model: input.model,
      provider: input.provider,
      errorClass: "server",
      finishReason: normalizeResponsesFinishReason(payload.status, payload.incomplete_details?.reason, false, false),
      incompleteReason: payload.incomplete_details?.reason,
      raw: input.payload
    };
  }

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let sawReasoningShape = false;
  const functionCalls: Array<{
    call_id?: string;
    name?: string;
    arguments?: string;
  }> = [];

  for (const item of payload.output ?? []) {
    if (item.type === "message") {
      const itemContent = item.content;
      if (typeof itemContent === "string") {
        const extracted = extractInlineReasoning(itemContent);
        if (extracted.visible.length > 0) {
          contentParts.push(extracted.visible);
        }
        if (extracted.reasoning !== undefined) {
          reasoningParts.push(extracted.reasoning);
          sawReasoningShape = true;
        }
      } else if (Array.isArray(itemContent)) {
        for (const part of itemContent) {
          if (part.type === "output_text" && part.text) {
            const extracted = extractInlineReasoning(part.text);
            if (extracted.visible.length > 0) {
              contentParts.push(extracted.visible);
            }
            if (extracted.reasoning !== undefined) {
              reasoningParts.push(extracted.reasoning);
              sawReasoningShape = true;
            }
          }
          if ((part.type === "reasoning" || part.type === "thinking") && (part.reasoning ?? part.thinking ?? part.text) !== undefined) {
            reasoningParts.push(part.reasoning ?? part.thinking ?? part.text ?? "");
            sawReasoningShape = true;
          }
        }
      }
    }

    if (item.type === "reasoning") {
      sawReasoningShape = true;
      if (item.reasoning !== undefined || item.text !== undefined) {
        reasoningParts.push(item.reasoning ?? item.text ?? "");
      }
    }

    if (item.type === "function_call") {
      functionCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments
      });
    }
  }

  const content = contentParts.join("");
  const reasoning = mergeReasoningParts(reasoningParts);
  const reasoningMetadata = reasoning === undefined
    ? (sawReasoningShape ? emptyResponsesReasoningMetadata() : undefined)
    : reasoningMetadataFromReasoning(reasoning, "responses_reasoning");
  const finishReason = normalizeResponsesFinishReason(
    payload.status,
    payload.incomplete_details?.reason,
    content.length > 0,
    functionCalls.length > 0
  );

  if (content.length === 0 && functionCalls.length === 0 && payload.status !== "in_progress") {
    return {
      ok: false,
      content: "Provider response did not include assistant content.",
      model: input.model,
      provider: input.provider,
      errorClass: payload.status === "incomplete" ? "unknown" : "unknown",
      finishReason,
      incompleteReason: payload.incomplete_details?.reason,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoningMetadata === undefined ? {} : { reasoningMetadata }),
      raw: input.payload
    };
  }

  return {
    ok: true,
    content,
    model: input.model,
    provider: input.provider,
    finishReason,
    incompleteReason: payload.incomplete_details?.reason,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoningMetadata === undefined ? {} : { reasoningMetadata }),
    usage: normalizeResponsesUsage(payload.usage),
    raw: input.payload
  };
}

function normalizeResponsesFinishReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasText: boolean,
  hasFunctionCalls: boolean
): ProviderFinishReason {
  if (status === "incomplete") {
    return incompleteReason === "max_output_tokens" ? "length" : "incomplete";
  }

  if (status === "completed") {
    if (hasFunctionCalls) {
      return "tool_calls";
    }
    if (hasText) {
      return "stop";
    }
    return "unknown";
  }

  return "unknown";
}

function normalizeResponsesUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
} | undefined): ProviderUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }

  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;

  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

function emptyResponsesReasoningMetadata(): ProviderReasoningMetadata {
  return {
    present: true,
    chars: 0,
    format: "responses_reasoning"
  };
}

export function extractResponsesToolCalls(payload: unknown): Array<{
  index?: number;
  id?: string;
  name?: string;
  argumentsText?: string;
  raw?: unknown;
}> {
  const typed = payload as {
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };

  return (typed.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((item, index) => ({
      index,
      id: item.call_id,
      name: item.name,
      argumentsText: item.arguments,
      raw: item
    }));
}

function classifyProviderError(code: string | undefined): string {
  if (code === undefined) return "unknown";
  if (/auth|key|permission|forbidden|unauthorized/i.test(code)) return "auth";
  if (/rate/i.test(code)) return "rate-limit";
  if (/quota|credit|billing/i.test(code)) return "quota";
  if (/model|not_found|unavailable/i.test(code)) return "model-unavailable";
  if (/timeout/i.test(code)) return "timeout";
  return "unknown";
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

async function safeErrorText(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? JSON.stringify(payload);
  } catch {
    return response.text();
  }
}
