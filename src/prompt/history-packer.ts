import type { SessionMessage } from "../contracts/session.js";
import { estimateMessageTokensRough, estimateMessagesTokensRough } from "./token-estimator.js";

export const DEFAULT_HISTORY_CONTEXT_WINDOW = 128_000;
export const HISTORY_BUDGET_RATIO = 0.12;
export const HISTORY_BUDGET_MIN = 6_000;
export const HISTORY_BUDGET_MAX = 24_000;

type PackableSessionMessage = {
  id?: string;
  sessionId?: string;
  role: SessionMessage["role"];
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type PackedHistoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata?: Record<string, unknown>;
};

export type PackedHistory = {
  messages: PackedHistoryMessage[];
  summary?: string;
  sourceMessageCount: number;
  summarizedMessageCount: number;
  protectedMessageCount: number;
  protectedToolPairCount: number;
  estimatedTokens: number;
};

export type HistoryPackerOptions = {
  maxProtectedMessages?: number;
  maxSummaryChars?: number;
  maxMessageChars?: number;
  maxEstimatedTokens?: number;
};

type InternalPackedHistoryMessage = PackedHistoryMessage & {
  pinned: boolean;
};

export function deriveSessionHistoryBudget(
  contextWindowTokens: number | undefined,
): number {
  const contextWindow =
    contextWindowTokens !== undefined && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_HISTORY_CONTEXT_WINDOW;

  return Math.min(
    HISTORY_BUDGET_MAX,
    Math.max(HISTORY_BUDGET_MIN, Math.floor(contextWindow * HISTORY_BUDGET_RATIO)),
  );
}

export function packSessionHistory(
  messages: PackableSessionMessage[],
  options: HistoryPackerOptions = {}
): PackedHistory {
  const maxProtectedMessages = options.maxProtectedMessages ?? 6;
  const maxSummaryChars = options.maxSummaryChars ?? 1_400;
  const maxMessageChars = options.maxMessageChars ?? 900;
  const maxEstimatedTokens = options.maxEstimatedTokens ?? deriveSessionHistoryBudget(undefined);
  const conversational = messages.filter((message) =>
    message.role === "user" || message.role === "agent" || message.role === "tool"
  );
  const semanticSummary = latestSemanticCompressionSummary(messages);
  const protectedStart = findProtectedStart(conversational, maxProtectedMessages);
  const pinnedIndexes = pinnedConversationalIndexes(conversational, protectedStart);
  const older = conversational.slice(0, protectedStart);
  const recent = conversational.slice(protectedStart);
  const summary = summarizeOlderTurns(older, maxSummaryChars);
  let packedMessages: InternalPackedHistoryMessage[] = [
    ...(semanticSummary === undefined
      ? []
      : [{
          role: "system" as const,
          content: truncate(semanticSummary.content, maxSummaryChars * 2),
          pinned: false
        }]),
    ...(summary === undefined
      ? []
      : [{
          role: "system" as const,
          content: summary,
          pinned: false
        }]),
    ...recent.map((message, index) => ({
      role: message.role === "agent" ? "assistant" as const : message.role,
      content: truncate(message.content, maxMessageChars),
      metadata: message.metadata,
      pinned: pinnedIndexes.has(protectedStart + index)
    }))
  ];
  packedMessages = trimToTokenBudget(packedMessages, maxEstimatedTokens);

  return {
    messages: packedMessages.map(({ pinned: _pinned, ...message }) => message),
    summary,
    sourceMessageCount: conversational.length,
    summarizedMessageCount: older.length,
    protectedMessageCount: recent.length,
    protectedToolPairCount: countProtectedToolPairs(recent),
    estimatedTokens: estimateTokens(packedMessages)
  };
}

function latestSemanticCompressionSummary(messages: PackableSessionMessage[]): PackableSessionMessage | undefined {
  return [...messages].reverse().find((message) =>
    message.role === "system" && message.metadata?.semanticCompression === true
  );
}

function summarizeOlderTurns(messages: PackableSessionMessage[], maxChars: number): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const agentMessages = messages.filter((message) => message.role === "agent");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const notableUserTurns = userMessages
    .slice(-4)
    .map((message) => `- user: ${truncate(message.content, 220)}`);
  const notableAgentTurns = agentMessages
    .slice(-3)
    .map((message) => `- agent: ${truncate(message.content, 220)}`);
  const notableToolTurns = toolMessages
    .slice(-3)
    .map((message) => `- tool: ${truncate(message.content, 220)}`);
  const summary = [
    `Session summary of ${messages.length} older turn(s):`,
    ...notableUserTurns,
    ...notableAgentTurns,
    ...notableToolTurns
  ].join("\n");

  return truncate(summary, maxChars);
}

function findProtectedStart(messages: PackableSessionMessage[], maxProtectedMessages: number): number {
  let start = Math.max(0, messages.length - maxProtectedMessages);

  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }

  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex !== undefined && latestUserIndex < start) {
    start = latestUserIndex;
  }

  return start;
}

function pinnedConversationalIndexes(messages: PackableSessionMessage[], protectedStart: number): Set<number> {
  const pinned = new Set<number>();
  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex !== undefined) {
    pinned.add(latestUserIndex);
    const adjacent = messages[latestUserIndex + 1];
    if (adjacent?.role === "agent") {
      pinned.add(latestUserIndex + 1);
    }
  }

  const tailPinStart = latestUserIndex ?? protectedStart;
  for (let index = Math.max(protectedStart, tailPinStart); index < messages.length; index += 1) {
    if (messages[index]?.role !== "tool") {
      pinned.add(index);
    }
  }

  return pinned;
}

function findLatestUserIndex(messages: PackableSessionMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return undefined;
}

function countProtectedToolPairs(messages: PackableSessionMessage[]): number {
  let pairs = 0;

  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool" && messages[index - 1]?.role === "agent") {
      pairs += 1;
    }
  }

  return pairs;
}

function trimToTokenBudget(messages: InternalPackedHistoryMessage[], maxEstimatedTokens: number): InternalPackedHistoryMessage[] {
  const trimmed = [...messages];

  while (estimateTokens(trimmed) > maxEstimatedTokens && trimmed.length > 1) {
    const summaryCount = trimmed.filter((message) => message.role === "system").length;
    const candidates = trimmed
      .map((message, index) => ({
        index,
        tokens: estimateMessageTokensRough(message),
        importance: messageImportance(message, summaryCount),
        role: message.role,
        pinned: message.pinned
      }))
      .filter((candidate) =>
        !candidate.pinned &&
        !(candidate.role === "system" && summaryCount <= 1)
      );

    if (candidates.length === 0) {
      break;
    }

    candidates.sort((left, right) => left.importance - right.importance || right.tokens - left.tokens);
    trimmed.splice(candidates[0].index, 1);
  }

  return trimmed;
}

function messageImportance(message: PackedHistoryMessage, summaryCount: number): number {
  if (message.role === "tool") return 1;
  if (message.role === "system" && summaryCount > 1) return 2;
  if (message.role === "user" || message.role === "assistant") return 3;
  return 4;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function estimateTokens(messages: PackedHistoryMessage[]): number {
  return estimateMessagesTokensRough(messages.map((message) => ({
    role: message.role,
    content: message.content,
    metadata: message.metadata
  })));
}
