import type { ProviderReplayEcho, ProviderStructuredToolCall } from "../contracts/provider.js";

export const CHARS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 1_600;
export const MESSAGE_FRAMING_TOKEN_ESTIMATE = 10;

export type TokenEstimateMessage = {
  role: string;
  content: string;
  toolCalls?: ProviderStructuredToolCall[];
  toolCallId?: string;
  providerReplayEcho?: ProviderReplayEcho;
  metadata?: Record<string, unknown>;
  parts?: Array<
    | { type: "text"; text: string }
    | { type: "image_url" | "input_image" | "image" }
  >;
};

export function estimateTextTokensRough(value: string): number {
  return estimateChars(value.length);
}

export function estimateMessageTokensRough(message: TokenEstimateMessage): number {
  const textChars = message.content.length + estimateStructuredFieldChars(message) + (message.parts ?? []).reduce((sum, part) => {
    return part.type === "text" ? sum + part.text.length : sum;
  }, 0);
  const imageCount = (message.parts ?? []).filter((part) => isImagePartType(part.type)).length +
    countImageLikeMetadata(message.metadata);

  return MESSAGE_FRAMING_TOKEN_ESTIMATE +
    estimateChars(textChars) +
    imageCount * IMAGE_TOKEN_ESTIMATE;
}

export function estimateMessagesTokensRough(messages: readonly TokenEstimateMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokensRough(message), 0);
}

export function countImageLikeMetadata(metadata: Record<string, unknown> | undefined): number {
  if (metadata === undefined) {
    return 0;
  }

  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.toLowerCase();
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && isImageCountKey(normalizedKey)) {
      count += Math.trunc(value);
      continue;
    }
    if (Array.isArray(value) && isAttachmentCollectionKey(normalizedKey)) {
      count += value.filter(isReadyImageAttachmentMetadata).length;
      continue;
    }
    if (Array.isArray(value) && isImageCollectionKey(normalizedKey)) {
      count += value.length;
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      count += countImageLikeMetadata(value as Record<string, unknown>);
    }
  }
  return count;
}

function isImagePartType(type: string): boolean {
  return type === "image_url" || type === "input_image" || type === "image";
}

function estimateStructuredFieldChars(message: TokenEstimateMessage): number {
  let chars = 0;

  if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      chars += estimateStructuredToolCallChars(toolCall);
    }

    if (isValidProviderReplayEcho(message.providerReplayEcho)) {
      chars += message.providerReplayEcho.value.length;
    }
  }

  if (message.role === "tool" && typeof message.toolCallId === "string") {
    chars += message.toolCallId.length;
  }

  return chars;
}

function estimateStructuredToolCallChars(toolCall: ProviderStructuredToolCall): number {
  return toolCall.id.length + toolCall.name.length + toolCall.argumentsText.length;
}

function isValidProviderReplayEcho(value: unknown): value is ProviderReplayEcho {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const provenance = providerReplayEchoProvenance(record.provenance);
  return record.field === "reasoning_content" &&
    typeof record.value === "string" &&
    isProviderReplayEchoFamily(record.providerFamily) &&
    record.apiMode === "openai_chat_completions" &&
    typeof record.chars === "number" &&
    record.chars === record.value.length &&
    provenance !== false &&
    (provenance !== "protocol-placeholder" || (record.value === " " && record.chars === 1));
}

function isProviderReplayEchoFamily(value: unknown): value is ProviderReplayEcho["providerFamily"] {
  return value === "deepseek" || value === "kimi" || value === "mimo";
}

function providerReplayEchoProvenance(value: unknown): ProviderReplayEcho["provenance"] | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  return value === "provider" || value === "protocol-placeholder" ? value : false;
}

function isReadyImageAttachmentMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : undefined;
  if (status !== undefined && status !== "ready") {
    return false;
  }

  const kind = typeof record.kind === "string" ? record.kind.toLowerCase() : undefined;
  const mimeType = typeof record.mimeType === "string"
    ? record.mimeType
    : typeof record.mime === "string"
      ? record.mime
      : undefined;

  return kind === "image" || mimeType?.toLowerCase().startsWith("image/") === true;
}

function estimateChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function isImageCountKey(key: string): boolean {
  return key === "imagecount" ||
    key === "image_count" ||
    key === "images" ||
    key === "imageattachments" ||
    key === "image_attachments";
}

function isAttachmentCollectionKey(key: string): boolean {
  return key === "attachments";
}

function isImageCollectionKey(key: string): boolean {
  return key === "images" ||
    key === "imageurls" ||
    key === "image_urls" ||
    key === "imageattachments" ||
    key === "image_attachments";
}
