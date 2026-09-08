import { Buffer } from "node:buffer";
import type { ProviderMessage, ProviderRequest } from "../contracts/provider.js";
import type { ProviderRequestAccounting } from "../contracts/prompt.js";
import { estimateMessagesTokensRough, estimateTextTokensRough, type TokenEstimateMessage } from "./token-estimator.js";

export function estimateProviderRequestAccounting(
  request: Pick<ProviderRequest, "messages" | "tools">,
  outputReservationTokens: number
): ProviderRequestAccounting {
  const tools = request.tools ?? [];
  const serializedSchemas = tools.length === 0 ? "" : JSON.stringify(tools);
  const estimatedMessageTokens = estimateMessagesTokensRough(
    request.messages.map(providerMessageForTokenEstimate)
  );
  const estimatedSchemaTokens = estimateTextTokensRough(serializedSchemas);
  const normalizedOutputReservation = normalizeTokenCount(outputReservationTokens);
  const estimatedInputTokens = estimatedMessageTokens + estimatedSchemaTokens;

  return {
    selectedToolCount: tools.length,
    serializedSchemaBytes: Buffer.byteLength(serializedSchemas, "utf8"),
    estimatedSchemaTokens,
    estimatedMessageTokens,
    estimatedInputTokens,
    outputReservationTokens: normalizedOutputReservation,
    totalEstimatedRequestTokens: estimatedInputTokens + normalizedOutputReservation
  };
}

function providerMessageForTokenEstimate(message: ProviderMessage): TokenEstimateMessage {
  if (Array.isArray(message.content)) {
    return {
      role: message.role,
      content: "",
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      providerReplayEcho: message.providerReplayEcho,
      parts: message.content.flatMap((part): NonNullable<TokenEstimateMessage["parts"]> => {
        if (part?.type === "text" && typeof part.text === "string") {
          return [{ type: "text", text: part.text }];
        }
        if (part?.type === "image_url") {
          return [{ type: "image_url" }];
        }
        return [];
      })
    };
  }

  return {
    role: message.role,
    content: stringifyMessageContent(message.content),
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    providerReplayEcho: message.providerReplayEcho
  };
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined || content === null) {
    return "";
  }
  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : String(content);
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
