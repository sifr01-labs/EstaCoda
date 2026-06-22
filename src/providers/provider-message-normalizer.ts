import type { ProviderMessage } from "../contracts/provider.js";
import { stripInlineReasoning } from "./provider-reasoning.js";

export type ProviderMessageNormalization = {
  messages: ProviderMessage[];
  warnings: string[];
  repairs: string[];
};

export type ProviderMessageNormalizationOptions = {
  ensureSystemMessage?: boolean;
};

const UNSAFE_PROVIDER_BOUND_MESSAGE_FIELDS = new Set([
  "finishReason",
  "finish_reason",
  "incompleteReason",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "reasoningMetadata",
  "metadata",
  "runtimeMetadata",
  "providerLoopRuntimeMetadata",
  "attemptedRouteIndex",
  "routeRole",
  "usage",
  "raw"
]);

export function normalizeProviderMessagesStrict(
  messages: ProviderMessage[],
  options: ProviderMessageNormalizationOptions = {}
): ProviderMessageNormalization {
  const warnings: string[] = [];
  const repairs: string[] = [];
  const normalized: Array<Omit<ProviderMessage, "content"> & { content: unknown }> = [];
  let systemContent: unknown;
  let activeToolCallIds: Set<string> | undefined;

  for (const originalMessage of messages) {
    const message = sanitizeProviderBoundMessage(originalMessage);
    const content = normalizeContent(message.content, {
      allowEmptyString: hasAssistantToolCalls(message)
    });

    if (message.role === "system") {
      systemContent = mergeNormalizedContent(systemContent, content);
      if (normalized.length > 0) {
        repairs.push("moved-system-message-to-front");
      }
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (message.role === "tool" && !isValidNativeToolResult(message, previous, activeToolCallIds)) {
      normalized.push({
        role: "user",
        content: `Tool result received without a preceding assistant tool call:\n${stringifyNormalizedContent(content)}`,
        name: message.name
      });
      warnings.push(previous === undefined ? "orphan-tool-message" : "tool-message-without-assistant-before-it");
      repairs.push("converted-invalid-tool-to-user-message");
      activeToolCallIds = undefined;
      continue;
    }

    if (
      previous !== undefined &&
      previous.role === message.role &&
      message.role !== "tool" &&
      !hasStructuredMessageFields(previous) &&
      !hasStructuredMessageFields(message) &&
      typeof previous.content === "string" &&
      typeof content === "string"
    ) {
      previous.content = `${previous.content}\n\n${content}`;
      repairs.push(`merged-adjacent-${message.role}-messages`);
      continue;
    }

    normalized.push({
      ...message,
      content
    });
    activeToolCallIds = activeToolCallIdsAfterMessage(message, activeToolCallIds);
  }

  if (systemContent !== undefined) {
    normalized.unshift({
      role: "system",
      content: systemContent
    });
  } else if (options.ensureSystemMessage === true) {
    normalized.unshift({
      role: "system",
      content: "[empty]"
    });
    repairs.push("inserted-empty-system-message");
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];

    if (previous === undefined || current === undefined) {
      continue;
    }

    if (previous.role === current.role && current.role !== "tool") {
      warnings.push(`adjacent-${current.role}-messages`);
    }

    if (current.role === "tool" && previous.role !== "assistant" && previous.role !== "tool") {
      warnings.push("tool-message-without-assistant-before-it");
    }
  }

  return {
    messages: normalized as ProviderMessage[],
    warnings: [...new Set(warnings)],
    repairs: [...new Set(repairs)]
  };
}

export function sanitizeProviderBoundMessage(message: ProviderMessage): ProviderMessage {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message as unknown as Record<string, unknown>)) {
    if (UNSAFE_PROVIDER_BOUND_MESSAGE_FIELDS.has(key)) {
      continue;
    }

    sanitized[key] = key === "content" ? sanitizeProviderBoundContent(value) : value;
  }

  const toolCalls = sanitizeStructuredToolCalls(sanitized.toolCalls);
  if (sanitized.role === "assistant" && toolCalls !== undefined) {
    sanitized.toolCalls = toolCalls;
  } else {
    delete sanitized.toolCalls;
  }

  const toolCallId = typeof sanitized.toolCallId === "string" && sanitized.toolCallId.length > 0
    ? sanitized.toolCallId
    : undefined;
  if (sanitized.role === "tool" && toolCallId !== undefined) {
    sanitized.toolCallId = toolCallId;
  } else {
    delete sanitized.toolCallId;
  }

  const providerReplayEcho = sanitizeProviderReplayEcho(sanitized.providerReplayEcho);
  if (sanitized.role === "assistant" && toolCalls !== undefined && providerReplayEcho !== undefined) {
    sanitized.providerReplayEcho = providerReplayEcho;
  } else {
    delete sanitized.providerReplayEcho;
  }

  if (!("content" in sanitized)) {
    sanitized.content = "[empty]";
  }

  return sanitized as ProviderMessage;
}

function normalizeContent(content: unknown, options: { allowEmptyString?: boolean } = {}): unknown {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length === 0 && options.allowEmptyString === true) {
      return "";
    }
    return trimmed.length === 0 ? "[empty]" : trimmed;
  }

  if (Array.isArray(content)) {
    return content.length === 0 ? "[empty]" : content;
  }

  return "[empty]";
}

function sanitizeProviderBoundContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripInlineReasoning(content);
  }

  if (Array.isArray(content)) {
    const parts = content
      .map(sanitizeProviderBoundContentPart)
      .filter((part) => part !== undefined);
    return parts.length === 0 ? "[empty]" : parts;
  }

  return content;
}

function hasStructuredMessageFields(message: Pick<ProviderMessage, "role" | "toolCalls" | "toolCallId" | "providerReplayEcho">): boolean {
  return hasAssistantToolCalls(message) || message.toolCallId !== undefined || message.providerReplayEcho !== undefined;
}

function hasAssistantToolCalls(message: Pick<ProviderMessage, "role" | "toolCalls">): boolean {
  return message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

function isValidNativeToolResult(
  message: Pick<ProviderMessage, "role" | "toolCallId">,
  previous: Pick<ProviderMessage, "role" | "toolCalls" | "toolCallId"> | undefined,
  activeToolCallIds: Set<string> | undefined
): boolean {
  if (message.role !== "tool" || message.toolCallId === undefined) {
    return false;
  }

  if (previous?.role === "assistant" && hasAssistantToolCalls(previous)) {
    return previous.toolCalls!.some((toolCall) => toolCall.id === message.toolCallId);
  }

  return previous?.role === "tool" && activeToolCallIds?.has(message.toolCallId) === true;
}

function activeToolCallIdsAfterMessage(
  message: Pick<ProviderMessage, "role" | "toolCalls" | "toolCallId">,
  current: Set<string> | undefined
): Set<string> | undefined {
  if (hasAssistantToolCalls(message)) {
    return new Set(message.toolCalls!.map((toolCall) => toolCall.id));
  }

  if (message.role === "tool" && current?.has(message.toolCallId ?? "") === true) {
    return current;
  }

  return undefined;
}

function sanitizeStructuredToolCalls(value: unknown): ProviderMessage["toolCalls"] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const toolCalls: NonNullable<ProviderMessage["toolCalls"]> = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object") {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      typeof record.argumentsText !== "string"
    ) {
      return undefined;
    }
    if (ids.has(record.id)) {
      return undefined;
    }
    ids.add(record.id);
    toolCalls.push({
      id: record.id,
      name: record.name,
      argumentsText: record.argumentsText
    });
  }

  return toolCalls;
}

function sanitizeProviderReplayEcho(value: unknown): ProviderMessage["providerReplayEcho"] | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provenance = providerReplayEchoProvenance(record.provenance);
  if (
    record.field !== "reasoning_content" ||
    typeof record.value !== "string" ||
    !isProviderReplayEchoFamily(record.providerFamily) ||
    record.apiMode !== "openai_chat_completions" ||
    typeof record.chars !== "number" ||
    record.chars !== record.value.length ||
    provenance === false ||
    (provenance === "protocol-placeholder" && (record.value !== " " || record.chars !== 1))
  ) {
    return undefined;
  }
  return {
    field: "reasoning_content",
    value: record.value,
    providerFamily: record.providerFamily,
    apiMode: "openai_chat_completions",
    chars: record.chars,
    ...(provenance === undefined ? {} : { provenance })
  };
}

function isProviderReplayEchoFamily(value: unknown): value is NonNullable<ProviderMessage["providerReplayEcho"]>["providerFamily"] {
  return value === "deepseek" || value === "kimi" || value === "mimo";
}

function providerReplayEchoProvenance(value: unknown): NonNullable<ProviderMessage["providerReplayEcho"]>["provenance"] | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  return value === "provider" || value === "protocol-placeholder" ? value : false;
}

function sanitizeProviderBoundContentPart(part: unknown): unknown | undefined {
  if (typeof part !== "object" || part === null) {
    return part;
  }

  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  if (type === "thinking" || type === "reasoning" || type === "reasoning_content") {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (UNSAFE_PROVIDER_BOUND_MESSAGE_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = key === "text" && typeof value === "string"
      ? stripInlineReasoning(value)
      : value;
  }

  return sanitized;
}

function mergeNormalizedContent(left: unknown, right: unknown): unknown {
  if (left === undefined) {
    return right;
  }

  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n\n${right}`;
  }

  return stringifyNormalizedContent(left) + "\n\n" + stringifyNormalizedContent(right);
}

function stringifyNormalizedContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }

        if (typeof part === "object" && part !== null && "type" in part) {
          return `[${String((part as { type?: unknown }).type ?? "content")}]`;
        }

        return "[content]";
      })
      .join("\n");
  }

  return String(content);
}
