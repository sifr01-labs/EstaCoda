import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderFinishReason,
  ProviderReasoningFormat,
  ProviderReasoningMetadata,
  ProviderUsage
} from "../contracts/provider.js";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS as DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STALE_TIMEOUT_MS as DEFAULT_STALE_TIMEOUT_MS
} from "../contracts/provider.js";
import { inferModelProfile } from "./model-catalog.js";
import { normalizeProviderMessagesStrict } from "./provider-message-normalizer.js";
import {
  getProviderMetadata,
  resolveChatMaxTokenParam,
  type ProviderMetadata
} from "./provider-metadata.js";
import {
  extractInlineReasoning,
  extractReasoningFromContentList,
  mergeReasoningParts,
  reasoningMetadataFromReasoning,
  StreamingReasoningFilter,
  type ProviderContentListPart
} from "./provider-reasoning.js";
import { createTimeoutSignal } from "../utils/timeout-signal.js";

export type OpenAICompatibleProviderOptions = {
  id: ProviderId;
  name?: string;
  endpoint: ProviderEndpoint;
  models?: string[] | ModelProfile[];
  enableNetwork?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
  staleTimeoutMs?: number;
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
    health(endpointOverride?: ProviderEndpoint) {
      const effectiveEndpoint = endpointOverride ?? options.endpoint;
      if (effectiveEndpoint.apiKey?.kind === "env" && process.env[effectiveEndpoint.apiKey.name] === undefined) {
        return {
          available: false,
          reason: `Missing ${effectiveEndpoint.apiKey.name}`
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
      const effectiveEndpoint = completionOptions?.endpoint ?? options.endpoint;
      const health = await this.health(completionOptions?.endpoint);
      const preparedRequest = buildOpenAICompatibleRequest(effectiveEndpoint, request, completionOptions?.credential?.value, options.id);

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
        return executeOpenAICompatibleRequest({
          provider: options.id,
          model: request.model,
          preparedRequest,
          fetch: options.fetch ?? globalThis.fetch,
          timeoutMs: completionOptions?.timeoutMs ?? options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          staleTimeoutMs: completionOptions?.staleTimeoutMs ?? options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
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
      const effectiveEndpoint = completionOptions?.endpoint ?? options.endpoint;
      const health = await this.health(completionOptions?.endpoint);
      const preparedRequest = buildOpenAICompatibleRequest(effectiveEndpoint, {
        ...request,
        stream: true
      }, completionOptions?.credential?.value, options.id);

      if (!health.available && completionOptions?.credential?.value === undefined) {
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
        timeoutMs: completionOptions?.timeoutMs ?? options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        staleTimeoutMs: completionOptions?.staleTimeoutMs ?? options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
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
  const maxTokens = normalizeProviderMaxTokens(normalized.maxTokens);
  const maxTokenParam = resolveChatMaxTokenParam(provider);
  const messages = serializeOpenAICompatibleChatMessages(normalized.messages, provider);

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
      messages,
      temperature: normalized.temperature,
      stream: normalized.stream,
      ...(shouldRequestStreamingUsage(provider, normalized) ? { stream_options: { include_usage: true } } : {}),
      tools: normalized.tools,
      response_format: normalized.responseFormat,
      ...(maxTokens === undefined ? {} : { [maxTokenParam]: maxTokens })
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
    temperature: normalizeTemperature(request.temperature, provider, request.model),
    tools: supportsTools ? request.tools : undefined,
    responseFormat: supportsResponseFormat ? request.responseFormat : undefined
  };

  return normalized;
}

function shouldRequestStreamingUsage(provider: ProviderId, request: ProviderRequest): boolean {
  return request.stream === true && getProviderMetadata(provider).apiMode === "openai_chat_completions";
}

type OpenAICompatibleChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: ProviderMessage["content"] | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
};

function serializeOpenAICompatibleChatMessages(
  messages: ProviderMessage[],
  provider: ProviderId
): OpenAICompatibleChatMessage[] {
  const metadata = getProviderMetadata(provider);
  const supportsNativeToolHistory = metadata.apiMode === "openai_chat_completions" &&
    metadata.supportsNativeToolHistory === true;
  const serialized: OpenAICompatibleChatMessage[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (hasNativeAssistantToolCalls(message)) {
      const group = serializeNativeToolCallGroup(messages, index, supportsNativeToolHistory, metadata);
      serialized.push(...group.messages);
      index += group.consumedMessages;
      continue;
    }

    if (message.role === "tool") {
      serialized.push(toolMessageFallbackMessage(message));
      index += 1;
      continue;
    }

    serialized.push(ordinaryChatMessage(message));
    index += 1;
  }

  return serialized;
}

function serializeNativeToolCallGroup(
  messages: ProviderMessage[],
  assistantIndex: number,
  supportsNativeToolHistory: boolean,
  metadata: ProviderMetadata
): { messages: OpenAICompatibleChatMessage[]; consumedMessages: number } {
  const assistant = messages[assistantIndex]!;
  const toolMessages: ProviderMessage[] = [];
  let cursor = assistantIndex + 1;

  while (cursor < messages.length && messages[cursor]?.role === "tool") {
    toolMessages.push(messages[cursor]!);
    cursor += 1;
  }

  if (
    supportsNativeToolHistory &&
    hasNativeAssistantToolCalls(assistant) &&
    isCompleteNativeToolCallGroup(assistant, toolMessages)
  ) {
    const assistantMessage = serializeNativeAssistantToolCallMessage(assistant, metadata);
    if (assistantMessage !== undefined) {
      return {
        consumedMessages: 1 + toolMessages.length,
        messages: [
          assistantMessage,
          ...toolMessages.map(serializeNativeToolResultMessage)
        ]
      };
    }
  }

  return {
    consumedMessages: 1 + toolMessages.length,
    messages: [
      nativeToolCallFallbackMessage(assistant as ProviderMessage & { role: "assistant" }),
      ...toolMessages.map(toolMessageFallbackMessage)
    ]
  };
}

function isCompleteNativeToolCallGroup(
  assistant: ProviderMessage & { role: "assistant"; toolCalls: NonNullable<ProviderMessage["toolCalls"]> },
  toolMessages: ProviderMessage[]
): boolean {
  if (!assistant.toolCalls.every(isSerializableToolCall)) {
    return false;
  }

  const requiredIds = new Set(assistant.toolCalls.map((toolCall) => toolCall.id));
  const matchedIds = new Set<string>();

  for (const toolMessage of toolMessages) {
    if (
      toolMessage.role !== "tool" ||
      typeof toolMessage.toolCallId !== "string" ||
      !requiredIds.has(toolMessage.toolCallId) ||
      matchedIds.has(toolMessage.toolCallId) ||
      serializeToolMessageContent(toolMessage.content) === undefined
    ) {
      return false;
    }
    matchedIds.add(toolMessage.toolCallId);
  }

  return matchedIds.size === requiredIds.size;
}

function serializeNativeToolResultMessage(message: ProviderMessage): OpenAICompatibleChatMessage {
  return compactObject({
    role: "tool",
    content: serializeToolMessageContent(message.content),
    tool_call_id: message.toolCallId
  }) as OpenAICompatibleChatMessage;
}

function serializeNativeAssistantToolCallMessage(
  message: ProviderMessage & { role: "assistant"; toolCalls: NonNullable<ProviderMessage["toolCalls"]> },
  metadata: ProviderMetadata
): OpenAICompatibleChatMessage | undefined {
  if (!message.toolCalls.every(isSerializableToolCall)) {
    return undefined;
  }

  const echo = providerReasoningEchoForMessage(message, metadata);
  if (echo.ok === false) {
    return undefined;
  }

  return compactObject({
    role: "assistant",
    content: assistantToolCallContent(message.content),
    tool_calls: message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsText
      }
    })),
    ...(echo.value === undefined ? {} : { reasoning_content: echo.value })
  }) as OpenAICompatibleChatMessage;
}

function providerReasoningEchoForMessage(
  message: Pick<ProviderMessage, "providerReplayEcho" | "toolCalls" | "role">,
  metadata: ProviderMetadata
): { ok: true; value?: string } | { ok: false } {
  const requiresEcho = metadata.requiresReasoningEcho === true ||
    metadata.reasoningEchoRequiredForToolCalls === true;
  if (!requiresEcho) {
    return { ok: true };
  }

  if (
    metadata.reasoningEchoField !== "reasoning_content" ||
    metadata.reasoningEchoProviderFamily === undefined
  ) {
    return { ok: false };
  }

  const echo = message.providerReplayEcho;
  if (
    message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0 &&
    echo?.field === "reasoning_content" &&
    echo.providerFamily === metadata.reasoningEchoProviderFamily &&
    echo.apiMode === "openai_chat_completions"
  ) {
    return { ok: true, value: echo.value };
  }

  if (metadata.allowReasoningEchoPlaceholder === true) {
    return { ok: true, value: " " };
  }

  return { ok: false };
}

function hasNativeAssistantToolCalls(
  message: ProviderMessage
): message is ProviderMessage & { role: "assistant"; toolCalls: NonNullable<ProviderMessage["toolCalls"]> } {
  return message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0;
}

function isSerializableToolCall(toolCall: NonNullable<ProviderMessage["toolCalls"]>[number]): boolean {
  return typeof toolCall.id === "string" &&
    toolCall.id.length > 0 &&
    typeof toolCall.name === "string" &&
    toolCall.name.length > 0 &&
    typeof toolCall.argumentsText === "string";
}

function assistantToolCallContent(content: ProviderMessage["content"]): ProviderMessage["content"] | null {
  if (typeof content === "string" && content.trim().length === 0) {
    return null;
  }
  return content;
}

function ordinaryChatMessage(message: ProviderMessage): OpenAICompatibleChatMessage {
  return compactObject({
    role: message.role,
    content: message.content,
    name: message.name
  }) as OpenAICompatibleChatMessage;
}

function nativeToolCallFallbackMessage(
  message: ProviderMessage & { role: "assistant" }
): OpenAICompatibleChatMessage {
  return compactObject({
    role: "assistant",
    content: hasVisibleMessageContent(message.content)
      ? message.content
      : "[Native tool-call history unavailable]"
  }) as OpenAICompatibleChatMessage;
}

function toolMessageFallbackMessage(message: ProviderMessage): OpenAICompatibleChatMessage {
  return {
    role: "user",
    content: `Tool result received without serialized assistant tool call:\n${serializeToolMessageContent(message.content)}`
  };
}

function serializeToolMessageContent(content: ProviderMessage["content"]): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

function hasVisibleMessageContent(content: ProviderMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content !== undefined && content !== null;
}

export async function executeOpenAICompatibleRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildOpenAICompatibleRequest>;
  fetch: FetchLike;
  timeoutMs: number;
  staleTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProviderResponse> {
  const timeout = createTimeoutSignal({
    timeoutMs: input.timeoutMs,
    staleTimeoutMs: input.staleTimeoutMs,
    timeoutMessage: formatProviderTotalTimeout(input.timeoutMs),
    staleTimeoutMessage: formatProviderStaleTimeout(input.staleTimeoutMs),
    parentSignal: input.signal
  });

  try {
    const response = await input.fetch(input.preparedRequest.url, {
      method: "POST",
      headers: input.preparedRequest.headers,
      body: JSON.stringify(input.preparedRequest.body),
      signal: timeout.signal
    });
    timeout.disableStale();

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
      errorClass: timeout.classify(error) ?? "network"
    };
  } finally {
    timeout.cleanup();
  }
}

export async function* streamOpenAICompatibleRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildOpenAICompatibleRequest>;
  fetch: FetchLike;
  timeoutMs: number;
  staleTimeoutMs: number;
  signal?: AbortSignal;
}): AsyncIterable<ProviderStreamEvent> {
  const timeout = createTimeoutSignal({
    timeoutMs: input.timeoutMs,
    staleTimeoutMs: input.staleTimeoutMs,
    timeoutMessage: formatProviderTotalTimeout(input.timeoutMs),
    staleTimeoutMessage: formatProviderStaleTimeout(input.staleTimeoutMs),
    parentSignal: input.signal
  });

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
      signal: timeout.signal
    });
    timeout.markProgress();

    if (!response.ok) {
      timeout.disableStale();
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
      timeout.disableStale();
      const payload = await response.json();
      const parsed = parseOpenAICompatibleResponse({
        provider: input.provider,
        model: input.model,
        payload
      });
      const toolCalls = extractOpenAICompatibleToolCalls(payload);

      if (parsed.ok) {
        for (const toolCall of toolCalls) {
          yield {
            kind: "tool-call",
            provider: input.provider,
            model: input.model,
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.name,
            argumentsText: toolCall.argumentsText,
            raw: toolCall.raw
          };
        }
        if (parsed.content.length > 0) {
          yield {
            kind: "token",
            provider: input.provider,
            model: input.model,
            text: parsed.content
          };
        }
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
    let finalResponse: ProviderResponse | undefined;
    let sawTransportDone = false;
    let sawToolCall = false;
    const reasoningFilter = new StreamingReasoningFilter();
    const reasoningParts: string[] = [];
    const reasoningFormats: ProviderReasoningFormat[] = [];

    for await (const event of parseOpenAICompatibleStream(response.body, input.provider, input.model, timeout.markProgress)) {
      if (event.kind === "token") {
        const visibleText = reasoningFilter.push(event.text);
        if (visibleText.length === 0) {
          continue;
        }
        content += visibleText;
        yield {
          ...event,
          text: visibleText
        };
        continue;
      }

      if (event.kind === "reasoning-delta") {
        reasoningParts.push(event.text);
        reasoningFormats.push(event.format);
        continue;
      }

      if (event.kind === "tool-call") {
        sawToolCall = true;
      }

      if (event.kind === "error") {
        yield event;
        return;
      }

      if (event.kind === "done") {
        usage = event.response.usage ?? usage;
        finalResponse = finalResponse === undefined
          ? event.response
          : {
              ...finalResponse,
              ...event.response,
              content: event.response.content.length > 0 ? event.response.content : finalResponse.content,
              finishReason: event.response.finishReason ?? finalResponse.finishReason,
              usage: event.response.usage ?? finalResponse.usage,
              raw: event.response.raw ?? finalResponse.raw
            };
        continue;
      }

      if (event.kind === "transport-done") {
        sawTransportDone = true;
        continue;
      }

      yield event;
    }

    const finalVisibleText = reasoningFilter.finish();
    if (finalVisibleText.length > 0) {
      content += finalVisibleText;
      yield {
        kind: "token",
        provider: input.provider,
        model: input.model,
        text: finalVisibleText
      };
    }
    const reasoning = mergeReasoningParts([
      ...reasoningParts,
      reasoningFilter.reasoning(),
      finalResponse?.reasoning
    ]);
    const reasoningMetadata = reasoningMetadataForParts([
      ...reasoningFormats,
      reasoningFilter.reasoning() === undefined ? undefined : "think_block",
      finalResponse?.reasoningMetadata?.format
    ], reasoning, finalResponse?.reasoningMetadata);

    if (finalResponse !== undefined) {
      yield {
        kind: "done",
        provider: input.provider,
        model: input.model,
        response: {
          ...finalResponse,
          content: finalResponse.content.length === 0 && content.length > 0
            ? content
            : finalResponse.content,
          ...(usage === undefined ? {} : { usage }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(reasoningMetadata === undefined ? {} : { reasoningMetadata })
        }
      };
      return;
    }

    if (sawTransportDone && !sawToolCall && (content.length > 0 || reasoning !== undefined)) {
      yield {
        kind: "done",
        provider: input.provider,
        model: input.model,
        response: {
          ok: true,
          content,
          model: input.model,
          provider: input.provider,
          finishReason: "unknown",
          ...(usage === undefined ? {} : { usage }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(reasoningMetadata === undefined ? {} : { reasoningMetadata })
        }
      };
      return;
    }

    if (sawTransportDone && content.length === 0 && !sawToolCall) {
      const fallback = await executeOpenAICompatibleRequest({
        provider: input.provider,
        model: input.model,
        preparedRequest: {
          ...input.preparedRequest,
          body: {
            ...input.preparedRequest.body,
            stream: false
          }
        },
        fetch: input.fetch,
        timeoutMs: input.timeoutMs,
        staleTimeoutMs: input.staleTimeoutMs,
        signal: input.signal
      });

      if (fallback.ok) {
        for (const toolCall of extractOpenAICompatibleToolCalls(fallback.raw)) {
          yield {
            kind: "tool-call",
            provider: input.provider,
            model: input.model,
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.name,
            argumentsText: toolCall.argumentsText,
            raw: toolCall.raw
          };
        }

        if (fallback.content.length > 0) {
          yield {
            kind: "token",
            provider: input.provider,
            model: input.model,
            text: fallback.content
          };
        }

        yield {
          kind: "done",
          provider: input.provider,
          model: input.model,
          response: fallback
        };
        return;
      }

      yield {
        kind: "error",
        provider: input.provider,
        model: input.model,
        response: fallback
      };
      return;
    }

    if (sawTransportDone) {
      yield {
        kind: "transport-done",
        provider: input.provider,
        model: input.model
      };
    }
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
        errorClass: timeout.classify(error) ?? "network"
      }
    };
  } finally {
    timeout.cleanup();
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
        content?: string | ProviderContentListPart[];
        reasoning?: string;
        reasoning_content?: string;
        reasoning_details?: unknown;
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      text?: string;
      finish_reason?: unknown;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      completion_tokens_details?: {
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
      errorClass: classifyProviderError(payload.error.type ?? payload.error.code),
      raw: input.payload
    };
  }

  const firstChoice = payload.choices?.[0];
  const message = firstChoice?.message;
  const contentExtraction = extractOpenAICompatibleContent(message?.content, firstChoice?.text);
  const reasoning = mergeReasoningParts([
    message?.reasoning,
    message?.reasoning_content,
    contentExtraction.reasoning
  ]);
  const reasoningMetadata = reasoningMetadataForParts([
    message?.reasoning === undefined ? undefined : "reasoning",
    message?.reasoning_content === undefined ? undefined : "reasoning_content",
    contentExtraction.reasoningMetadata?.format,
    message?.reasoning_details === undefined ? undefined : "reasoning_details"
  ], reasoning, message?.reasoning_details === undefined
    ? contentExtraction.reasoningMetadata
    : metadataFromReasoningDetails(message.reasoning_details, contentExtraction.reasoningMetadata));
  const content = contentExtraction.visible;
  const hasToolCalls = (message?.tool_calls?.length ?? 0) > 0;
  const finishReason = normalizeChatFinishReason(firstChoice?.finish_reason);

  if (content === undefined && !hasToolCalls && reasoning === undefined && reasoningMetadata?.present !== true) {
    return {
      ok: false,
      content: "Provider response did not include assistant content.",
      model: input.model,
      provider: input.provider,
      errorClass: "unknown",
      finishReason,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoningMetadata === undefined ? {} : { reasoningMetadata }),
      raw: input.payload
    };
  }

  return {
    ok: true,
    content: content ?? "",
    model: input.model,
    provider: input.provider,
    finishReason,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoningMetadata === undefined ? {} : { reasoningMetadata }),
    usage: normalizeOpenAICompatibleUsage(payload.usage),
    raw: input.payload
  };
}

function normalizeChatFinishReason(value: unknown): ProviderFinishReason {
  switch (value) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

function normalizeOpenAICompatibleUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
} | undefined): ProviderUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }

  return {
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens })
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

function normalizeTemperature(temperature: number | undefined, provider: ProviderId, model: string): number | undefined {
  if (temperature === undefined) {
    return undefined;
  }

  if (provider === "kimi") {
    return 1;
  }

  if (looksReasoningModel(model)) {
    return undefined;
  }

  if (provider === "local") {
    return clamp(temperature, 0, 2);
  }

  return clamp(temperature, 0, 2);
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

function looksReasoningModel(model: string): boolean {
  return /reasoner|reasoning|thinking|r1|o1|o3|o4/i.test(model);
}

function formatProviderTotalTimeout(timeoutMs: number): string {
  return `Provider request timed out after ${formatDuration(timeoutMs)}.`;
}

function formatProviderStaleTimeout(timeoutMs: number): string {
  return `No response from provider for ${formatDuration(timeoutMs)}.`;
}

function formatDuration(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (timeoutMs % 1_000 === 0) {
    const seconds = timeoutMs / 1_000;
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${timeoutMs}ms`;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function normalizeProviderMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type OpenAICompatibleParsedStreamEvent = ProviderStreamEvent | {
  kind: "reasoning-delta";
  provider: ProviderId;
  model: string;
  text: string;
  format: Extract<ProviderReasoningFormat, "reasoning" | "reasoning_content">;
};

async function* parseOpenAICompatibleStream(
  body: ReadableStream<Uint8Array>,
  provider: ProviderId,
  model: string,
  onProgress?: () => void
): AsyncIterable<OpenAICompatibleParsedStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const read = await reader.read();

    if (read.done) {
      break;
    }
    if (read.value.byteLength > 0) {
      onProgress?.();
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
        yield {
          kind: "transport-done",
          provider,
          model
        };
        return;
      }

      for (const event of parseOpenAICompatibleStreamChunk(data, provider, model)) {
        yield event;
      }
    }
  }

  if (buffer.trim().startsWith("data:")) {
    const data = buffer.trim().slice("data:".length).trim();

    if (data === "[DONE]") {
      yield {
        kind: "transport-done",
        provider,
        model
      };
    } else {
      for (const event of parseOpenAICompatibleStreamChunk(data, provider, model)) {
        yield event;
      }
    }
  }
}

function parseOpenAICompatibleStreamChunk(data: string, provider: ProviderId, model: string): OpenAICompatibleParsedStreamEvent[] {
  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{
        finish_reason?: unknown;
        delta?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
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
        completion_tokens_details?: {
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

    const events: OpenAICompatibleParsedStreamEvent[] = [];
    const finishReason = (payload.choices ?? [])
      .map((choice) => choice.finish_reason)
      .find((value) => value !== undefined && value !== null);

    for (const choice of payload.choices ?? []) {
      for (const reasoningDelta of [
        { text: choice.delta?.reasoning, format: "reasoning" as const },
        { text: choice.delta?.reasoning_content, format: "reasoning_content" as const }
      ]) {
        if (reasoningDelta.text != null && reasoningDelta.text.length > 0) {
          events.push({
            kind: "reasoning-delta",
            provider,
            model,
            text: reasoningDelta.text,
            format: reasoningDelta.format
          });
        }
      }

      if (choice.delta?.content != null && choice.delta.content.length > 0) {
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

    if (payload.usage !== undefined || finishReason !== undefined) {
      events.push({
        kind: "done",
        provider,
        model,
        response: {
          ok: true,
          content: "",
          model,
          provider,
          ...(finishReason === undefined ? {} : { finishReason: normalizeChatFinishReason(finishReason) }),
          usage: normalizeOpenAICompatibleUsage(payload.usage),
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

type ReasoningContentExtraction = {
  visible?: string;
  reasoning?: string;
  reasoningMetadata?: ProviderReasoningMetadata;
};

function extractOpenAICompatibleContent(
  content: string | ProviderContentListPart[] | undefined,
  fallbackText: string | undefined
): ReasoningContentExtraction {
  const contentValue = content ?? fallbackText;
  if (typeof contentValue === "string") {
    const extracted = extractInlineReasoning(contentValue);
    return {
      visible: extracted.visible,
      reasoning: extracted.reasoning,
      reasoningMetadata: extracted.reasoningMetadata
    };
  }

  if (Array.isArray(contentValue)) {
    const extracted = extractReasoningFromContentList(contentValue);
    const inline = extractInlineReasoning(extracted.visible);
    const reasoning = mergeReasoningParts([extracted.reasoning, inline.reasoning]);
    return {
      visible: inline.visible,
      reasoning,
      reasoningMetadata: reasoningMetadataForParts([
        extracted.reasoningMetadata?.format,
        inline.reasoningMetadata?.format
      ], reasoning, extracted.reasoningMetadata ?? inline.reasoningMetadata)
    };
  }

  return {};
}

function reasoningMetadataForParts(
  formats: Array<ProviderReasoningFormat | undefined>,
  reasoning: string | undefined,
  fallback: ProviderReasoningMetadata | undefined
): ProviderReasoningMetadata | undefined {
  const presentFormats = formats.filter((format): format is ProviderReasoningFormat => format !== undefined);
  if (reasoning !== undefined) {
    return reasoningMetadataFromReasoning(reasoning, mergeReasoningFormat(presentFormats));
  }
  return fallback;
}

function metadataFromReasoningDetails(
  reasoningDetails: unknown,
  fallback: ProviderReasoningMetadata | undefined
): ProviderReasoningMetadata {
  return {
    present: true,
    chars: boundedJsonLength(reasoningDetails),
    format: fallback === undefined ? "reasoning_details" : "mixed"
  };
}

function mergeReasoningFormat(formats: ProviderReasoningFormat[]): ProviderReasoningFormat {
  const unique = new Set(formats);
  if (unique.size === 0) {
    return "unknown";
  }
  if (unique.size === 1) {
    return formats[0] ?? "unknown";
  }
  return "mixed";
}

function boundedJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.slice(0, 20_000).length ?? 0;
  } catch {
    return 0;
  }
}

function extractOpenAICompatibleToolCalls(payload: unknown): Array<{
  index?: number;
  id?: string;
  name?: string;
  argumentsText?: string;
  raw?: unknown;
}> {
  const typed = payload as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
    }>;
  };

  return (typed.choices?.[0]?.message?.tool_calls ?? []).map((toolCall, index) => ({
    index,
    id: toolCall.id,
    name: toolCall.function?.name,
    argumentsText: toolCall.function?.arguments,
    raw: toolCall
  }));
}
