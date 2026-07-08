import type {
  ModelProfile,
  ProviderAdapter,
  ProviderCompletionOptions,
  ProviderEndpoint,
  ProviderErrorClass,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderFinishReason,
  ProviderReasoningMetadata,
  ProviderUsage
} from "../contracts/provider.js";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS as DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_STALE_TIMEOUT_MS as DEFAULT_STALE_TIMEOUT_MS
} from "../contracts/provider.js";
import { classifyHttpError } from "./openai-compatible-provider.js";
import {
  extractInlineReasoning,
  mergeReasoningParts,
  reasoningMetadataFromReasoning
} from "./provider-reasoning.js";
import { createTimeoutSignal } from "../utils/timeout-signal.js";

export type OpenAIResponsesProviderOptions = {
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

      if (isCodexResponsesBackend(effectiveEndpoint, options.id)) {
        const stream = this.stream?.({ ...request, stream: true }, completionOptions);
        if (stream === undefined) {
          return {
            ok: false,
            content: "Streaming is not available for this provider.",
            model: request.model,
            provider: options.id,
            errorClass: "unsupported",
            raw: preparedRequest
          };
        }
        return collectResponsesStream({
          provider: options.id,
          model: request.model,
          stream
        });
      }

      if (options.enableNetwork === true) {
        return executeResponsesRequest({
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
        content: "Network inference is not enabled in this runtime yet. The Responses API request was prepared.",
        model: request.model,
        provider: options.id,
        errorClass: "unsupported",
        raw: preparedRequest
      };
    },
    async *stream(request: ProviderRequest, completionOptions?: ProviderCompletionOptions): AsyncIterable<ProviderStreamEvent> {
      const effectiveEndpoint = completionOptions?.endpoint ?? options.endpoint;
      const health = await this.health(completionOptions?.endpoint);
      const preparedRequest = buildResponsesRequest(
        effectiveEndpoint,
        { ...request, stream: true },
        completionOptions?.credential?.value,
        options.id
      );

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
            content: "Network inference is not enabled in this runtime yet. The Responses API streaming request was prepared.",
            model: request.model,
            provider: options.id,
            errorClass: "unsupported",
            raw: preparedRequest
          }
        };
        return;
      }

      yield* streamResponsesRequest({
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

async function collectResponsesStream(input: {
  provider: ProviderId;
  model: string;
  stream: AsyncIterable<ProviderStreamEvent>;
}): Promise<ProviderResponse> {
  let content = "";
  let finalResponse: ProviderResponse | undefined;
  let sawTransportDone = false;
  const toolCallFragments = new Map<string, {
    index?: number;
    id?: string;
    name?: string;
    argumentsText?: string;
    raw?: unknown;
  }>();

  for await (const event of input.stream) {
    if (event.kind === "token") {
      content += event.text;
      continue;
    }

    if (event.kind === "tool-call") {
      mergeResponsesToolCallFragment(toolCallFragments, event);
      continue;
    }

    if (event.kind === "done") {
      finalResponse = event.response;
      continue;
    }

    if (event.kind === "error") {
      return event.response;
    }

    if (event.kind === "transport-done") {
      sawTransportDone = true;
    }
  }

  if (finalResponse !== undefined) {
    return withCollectedResponsesToolCalls(
      finalResponse.content.length === 0 && content.length > 0
        ? {
            ...finalResponse,
            content
          }
        : finalResponse,
      toolCallFragments
    );
  }

  if (sawTransportDone && content.length > 0) {
    return withCollectedResponsesToolCalls({
      ok: true,
      content,
      model: input.model,
      provider: input.provider,
      finishReason: "unknown"
    }, toolCallFragments);
  }

  return {
    ok: false,
    content: content.length === 0
      ? "Provider stream ended before a done or error event."
      : `Provider stream ended before completion after partial output:\n${content}`,
    ...(content.length === 0 ? {} : { partialContent: content }),
    model: input.model,
    provider: input.provider,
    errorClass: "incomplete-stream"
  };
}

function isCodexResponsesBackend(endpoint: ProviderEndpoint, provider: ProviderId): boolean {
  if (provider !== "codex") {
    return false;
  }

  try {
    const url = new URL(endpoint.baseUrl);
    return url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.pathname.replace(/\/$/, "") === "/backend-api/codex" &&
      url.search.length === 0 &&
      url.hash.length === 0;
  } catch {
    return endpoint.baseUrl.replace(/\/$/, "") === "https://chatgpt.com/backend-api/codex";
  }
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

  const isCodexBackend = isCodexResponsesBackend(endpoint, provider);
  const { instructions, input } = extractInstructionsAndInput(request.messages, {
    codexBackend: isCodexBackend
  });
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

  const body: Record<string, unknown> = {
    model: request.model,
    instructions,
    input,
    store: false
  };

  if (request.stream === true) {
    body.stream = true;
  }

  const maxTokens = normalizeProviderMaxTokens(request.maxTokens);
  if (maxTokens !== undefined && !isCodexBackend) {
    body.max_output_tokens = maxTokens;
  }

  if (hasTools) {
    body.tools = isCodexBackend
      ? convertCodexResponsesTools(request.tools)
      : request.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
  }

  return {
    url: `${endpoint.baseUrl.replace(/\/$/, "")}/responses`,
    headers: {
      "content-type": "application/json",
      ...(isCodexBackend ? buildCodexResponsesHeaders(apiKey) : {}),
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

function buildCodexResponsesHeaders(accessToken: string | undefined): Record<string, string> {
  const accountId = codexAccountIdFromJwt(accessToken);
  return {
    "User-Agent": "codex_cli_rs/0.0.0 (EstaCoda)",
    originator: "codex_cli_rs",
    ...(accountId === undefined ? {} : { "ChatGPT-Account-ID": accountId })
  };
}

function codexAccountIdFromJwt(accessToken: string | undefined): string | undefined {
  if (accessToken === undefined) {
    return undefined;
  }

  const [, payloadSegment] = accessToken.split(".");
  if (payloadSegment === undefined || payloadSegment.length === 0) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: {
        chatgpt_account_id?: unknown;
      };
    };
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

function convertCodexResponsesTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  return tools.map((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
      return tool;
    }

    const record = tool as Record<string, unknown>;
    const fn = record.function;
    if (record.type !== "function" || fn === null || typeof fn !== "object" || Array.isArray(fn)) {
      return tool;
    }

    const converted: Record<string, unknown> = {
      ...record,
      ...(fn as Record<string, unknown>),
      type: "function"
    };
    delete converted.function;
    return converted;
  });
}

function extractInstructionsAndInput(
  messages: ProviderRequest["messages"],
  options: { codexBackend?: boolean } = {}
): {
  instructions?: string;
  input: unknown;
} {
  const nonSystemMessages: unknown[] = [];
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

    if (options.codexBackend === true && message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      const content = stringifyResponsesContent(message.content);
      if (content.trim().length > 0) {
        nonSystemMessages.push({
          role: "assistant",
          content: responsesMessageContent(message)
        });
      }

      for (const toolCall of message.toolCalls) {
        if (
          typeof toolCall.id === "string" &&
          toolCall.id.length > 0 &&
          typeof toolCall.name === "string" &&
          toolCall.name.length > 0 &&
          typeof toolCall.argumentsText === "string"
        ) {
          nonSystemMessages.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.argumentsText
          });
        }
      }
      continue;
    }

    if (message.role === "tool") {
      if (options.codexBackend === true && typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
        nonSystemMessages.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: stringifyResponsesContent(message.content)
        });
        continue;
      }

      nonSystemMessages.push({
        role: "user",
        content: stringifyResponsesContent(message.content)
      });
      continue;
    }

    nonSystemMessages.push({
      role: message.role,
      content: responsesMessageContent(message)
    });
  }

  return {
    instructions,
    input: nonSystemMessages
  };
}

function responsesMessageContent(message: ProviderRequest["messages"][number]): unknown {
  if (!Array.isArray(message.content)) {
    return message.content;
  }

  return message.content.map((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }

    const record = part as {
      type?: unknown;
      text?: unknown;
      image_url?: { url?: unknown };
    };

    if (record.type === "text" && typeof record.text === "string") {
      return {
        type: "input_text",
        text: record.text
      };
    }

    if (record.type === "image_url" && typeof record.image_url?.url === "string") {
      return {
        type: "input_image",
        image_url: record.image_url.url
      };
    }

    return part;
  });
}

function stringifyResponsesContent(content: unknown): string {
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "");
}

export async function executeResponsesRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildResponsesRequest>;
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
      errorClass: timeout.classify(error) ?? "network"
    };
  } finally {
    timeout.cleanup();
  }
}

async function* streamResponsesRequest(input: {
  provider: ProviderId;
  model: string;
  preparedRequest: ReturnType<typeof buildResponsesRequest>;
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
      const parsed = parseResponsesPayload({
        provider: input.provider,
        model: input.model,
        payload
      });

      if (parsed.ok) {
        for (const toolCall of extractResponsesToolCalls(payload)) {
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
    let finalResponse: ProviderResponse | undefined;
    let sawTransportDone = false;
    let sawToolCall = false;
    let usage: ProviderUsage | undefined;
    const reasoningParts: string[] = [];
    const argumentDeltaKeys = new Set<string>();

    for await (const event of parseResponsesStream(response.body, input.provider, input.model, timeout.markProgress)) {
      if (event.kind === "token") {
        content += event.text;
        yield event;
        continue;
      }

      if (event.kind === "reasoning-delta") {
        reasoningParts.push(event.text);
        continue;
      }

      if (event.kind === "usage") {
        usage = event.usage ?? usage;
        continue;
      }

      if (event.kind === "tool-call") {
        sawToolCall = true;
        const key = responsesToolCallKey(event);
        if (event.argumentsText !== undefined && event.argumentsText.length > 0) {
          argumentDeltaKeys.add(key);
        }
        yield event;
        continue;
      }

      if (event.kind === "tool-call-done") {
        sawToolCall = true;
        const key = responsesToolCallKey(event);
        yield {
          kind: "tool-call",
          provider: event.provider,
          model: event.model,
          index: event.index,
          id: event.id,
          name: event.name,
          ...(argumentDeltaKeys.has(key) ? {} : { argumentsText: event.argumentsText }),
          raw: event.raw
        };
        continue;
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

      if (event.kind === "error") {
        yield event;
        return;
      }

      if (event.kind === "transport-done") {
        sawTransportDone = true;
      }
    }

    const reasoning = mergeReasoningParts([
      ...reasoningParts,
      finalResponse?.reasoning
    ]);
    const reasoningMetadata = reasoning === undefined
      ? finalResponse?.reasoningMetadata
      : reasoningMetadataFromReasoning(reasoning, "responses_reasoning");

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
          raw: sawToolCall
            ? stripResponsesFunctionCallOutput(finalResponse.raw)
            : finalResponse.raw,
          ...(usage === undefined ? {} : { usage }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(reasoningMetadata === undefined ? {} : { reasoningMetadata })
        }
      };
      return;
    }

    if (sawTransportDone && (content.length > 0 || reasoning !== undefined || sawToolCall)) {
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

    yield {
      kind: "error",
      provider: input.provider,
      model: input.model,
      response: {
        ok: false,
        content: content.length === 0
          ? "Provider stream ended before a done or error event."
          : `Provider stream ended before completion after partial output:\n${content}`,
        ...(content.length === 0 ? {} : { partialContent: content }),
        model: input.model,
        provider: input.provider,
        errorClass: "incomplete-stream"
      }
    };
  } catch (error) {
    yield {
      kind: "error",
      provider: input.provider,
      model: input.model,
      response: {
        ok: false,
        content: error instanceof Error ? error.message : "Network request failed.",
        model: input.model,
        provider: input.provider,
        errorClass: timeout.classify(error) ?? "network"
      }
    };
  } finally {
    timeout.cleanup();
  }
}

type ResponsesParsedStreamEvent =
  | ProviderStreamEvent
  | {
      kind: "reasoning-delta";
      provider: ProviderId;
      model: string;
      text: string;
    }
  | {
      kind: "usage";
      provider: ProviderId;
      model: string;
      usage?: ProviderUsage;
    }
  | {
      kind: "tool-call-done";
      provider: ProviderId;
      model: string;
      index?: number;
      id?: string;
      name?: string;
      argumentsText?: string;
      raw?: unknown;
    };

async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  provider: ProviderId,
  model: string,
  markProgress: () => void
): AsyncIterable<ResponsesParsedStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      markProgress();
      buffer += decoder.decode(value, { stream: true });
      const normalized = buffer.replace(/\r\n/g, "\n");
      const events = normalized.split("\n\n");
      buffer = events.pop() ?? "";
      for (const block of events) {
        yield* parseResponsesSseBlock(block, provider, model);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      yield* parseResponsesSseBlock(buffer.replace(/\r\n/g, "\n"), provider, model);
    }

    yield {
      kind: "transport-done",
      provider,
      model
    };
  } finally {
    reader.releaseLock();
  }
}

function* parseResponsesSseBlock(
  block: string,
  provider: ProviderId,
  model: string
): Iterable<ResponsesParsedStreamEvent> {
  const dataLines = block
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return;
  }

  const data = dataLines.join("\n").trim();
  if (data.length === 0) {
    return;
  }
  if (data === "[DONE]") {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  yield* parseResponsesStreamPayload(payload, provider, model);
}

function* parseResponsesStreamPayload(
  payload: unknown,
  provider: ProviderId,
  model: string
): Iterable<ResponsesParsedStreamEvent> {
  const typed = payload as {
    type?: string;
    delta?: unknown;
    text?: unknown;
    output_text?: unknown;
    response?: unknown;
    item?: unknown;
    output_index?: unknown;
    item_id?: unknown;
    output_item_id?: unknown;
    call_id?: unknown;
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    usage?: unknown;
    error?: {
      message?: string;
      type?: string;
      code?: string;
    };
  };
  const type = typeof typed.type === "string" ? typed.type : "";

  if (type === "response.output_text.delta") {
    const text = firstString(typed.delta, typed.text, typed.output_text);
    if (text !== undefined && text.length > 0) {
      yield {
        kind: "token",
        provider,
        model,
        text
      };
    }
    return;
  }

  if (type.includes("reasoning") && type.endsWith(".delta")) {
    const text = firstString(typed.delta, typed.text);
    if (text !== undefined && text.length > 0) {
      yield {
        kind: "reasoning-delta",
        provider,
        model,
        text
      };
    }
    return;
  }

  if (type === "response.function_call_arguments.delta") {
    const argumentsText = firstString(typed.delta, typed.arguments);
    if (argumentsText !== undefined && argumentsText.length > 0) {
      yield {
        kind: "tool-call",
        provider,
        model,
        index: firstNumber(typed.output_index),
        id: firstString(typed.call_id, typed.id, typed.item_id, typed.output_item_id),
        name: firstString(typed.name),
        argumentsText,
        raw: payload
      };
    }
    return;
  }

  if (type === "response.output_item.done") {
    const item = typed.item as {
      type?: string;
      call_id?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    } | undefined;
    if (item?.type === "function_call") {
      yield {
        kind: "tool-call-done",
        provider,
        model,
        index: firstNumber(typed.output_index),
        id: firstString(item.call_id, item.id, typed.call_id, typed.id, typed.item_id, typed.output_item_id),
        name: firstString(item.name, typed.name),
        argumentsText: firstString(item.arguments, typed.arguments),
        raw: item
      };
    }
    return;
  }

  if (type === "response.completed" || type === "response.incomplete") {
    const responsePayload = typed.response ?? payload;
    const parsed = parseResponsesPayload({
      provider,
      model,
      payload: responsePayload,
      isStreamingCompletion: true
    });
    yield {
      kind: parsed.ok ? "done" : "error",
      provider,
      model,
      response: parsed
    };
    return;
  }

  if (type === "response.failed" || type === "error") {
    const responsePayload = typed.response ?? payload;
    const parsed = parseResponsesPayload({
      provider,
      model,
      payload: responsePayload
    });
    yield {
      kind: "error",
      provider,
      model,
      response: parsed.ok
        ? {
            ok: false,
            content: "Provider stream failed.",
            model,
            provider,
            errorClass: "server",
            raw: responsePayload
          }
        : parsed
    };
    return;
  }

  if (typed.usage !== undefined) {
    yield {
      kind: "usage",
      provider,
      model,
      usage: normalizeResponsesUsage(typed.usage as {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        reasoning_tokens?: number;
        output_tokens_details?: { reasoning_tokens?: number };
      })
    };
  }
}

export function parseResponsesPayload(input: {
  provider: ProviderId;
  model: string;
  payload: unknown;
  isStreamingCompletion?: boolean;
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

  if (payload.error != null) {
    return {
      ok: false,
      content: payload.error.message ?? "Provider returned an error.",
      model: input.model,
      provider: input.provider,
      errorClass: classifyProviderError(payload.error.type ?? payload.error.code),
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
  const hasReasoningOnlySignal = reasoning !== undefined || reasoningMetadata?.present === true;

  const allowEmptyStreamingCompletion = input.isStreamingCompletion === true && payload.status === "completed";
  if (
    content.length === 0 &&
    functionCalls.length === 0 &&
    payload.status !== "in_progress" &&
    !hasReasoningOnlySignal &&
    !allowEmptyStreamingCompletion
  ) {
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

function responsesToolCallKey(input: {
  index?: number;
  id?: string;
  name?: string;
}): string {
  if (input.index !== undefined) {
    return `index:${input.index}`;
  }
  if (input.id !== undefined) {
    return `id:${input.id}`;
  }
  if (input.name !== undefined) {
    return `name:${input.name}`;
  }
  return "anonymous";
}

function mergeResponsesToolCallFragment(
  fragments: Map<string, {
    index?: number;
    id?: string;
    name?: string;
    argumentsText?: string;
    raw?: unknown;
  }>,
  event: Extract<ProviderStreamEvent, { kind: "tool-call" }>
): void {
  const key = responsesToolCallKey(event);
  const current = fragments.get(key);
  if (current === undefined) {
    fragments.set(key, {
      index: event.index,
      id: event.id,
      name: event.name,
      argumentsText: event.argumentsText ?? "",
      raw: event.raw
    });
    return;
  }

  fragments.set(key, {
    index: current.index ?? event.index,
    id: current.id ?? event.id,
    name: current.name ?? event.name,
    argumentsText: `${current.argumentsText ?? ""}${event.argumentsText ?? ""}`,
    raw: event.raw ?? current.raw
  });
}

function withCollectedResponsesToolCalls(
  response: ProviderResponse,
  toolCallFragments: Map<string, {
    index?: number;
    id?: string;
    name?: string;
    argumentsText?: string;
    raw?: unknown;
  }>
): ProviderResponse {
  if (toolCallFragments.size === 0) {
    return response;
  }

  const output = [...toolCallFragments.values()].map((toolCall) => ({
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.argumentsText ?? ""
  }));
  const raw = response.raw;

  if (raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const typed = raw as { output?: unknown[] };
    const preservedOutput = (typed.output ?? [])
      .filter((item) => !isResponsesFunctionCallOutputItem(item));
    return {
      ...response,
      raw: {
        ...typed,
        output: [
          ...preservedOutput,
          ...output
        ]
      }
    };
  }

  return {
    ...response,
    raw: { output }
  };
}

function stripResponsesFunctionCallOutput(raw: unknown): unknown {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const typed = raw as { output?: unknown[] };
  if (typed.output === undefined) {
    return raw;
  }

  return {
    ...typed,
    output: typed.output.filter((item) => !isResponsesFunctionCallOutputItem(item))
  };
}

function isResponsesFunctionCallOutputItem(item: unknown): boolean {
  return item !== null &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "function_call";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
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

function classifyProviderError(code: string | undefined): ProviderErrorClass {
  if (code === undefined) return "unknown";
  if (/auth|key|permission|forbidden|unauthorized/i.test(code)) return "auth";
  if (/rate/i.test(code)) return "rate-limit";
  if (/quota|credit|billing/i.test(code)) return "quota";
  if (/model|not_found|unavailable/i.test(code)) return "model-unavailable";
  if (/timeout/i.test(code)) return "timeout";
  return "unknown";
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

async function safeErrorText(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? JSON.stringify(payload);
  } catch {
    return response.text();
  }
}
