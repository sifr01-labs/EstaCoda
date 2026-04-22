import type { SessionMessage } from "../contracts/session.js";

export type PackedHistoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

export function packSessionHistory(
  messages: SessionMessage[],
  options: HistoryPackerOptions = {}
): PackedHistory {
  const maxProtectedMessages = options.maxProtectedMessages ?? 6;
  const maxSummaryChars = options.maxSummaryChars ?? 1_400;
  const maxMessageChars = options.maxMessageChars ?? 900;
  const maxEstimatedTokens = options.maxEstimatedTokens ?? 6_000;
  const conversational = messages.filter((message) =>
    message.role === "user" || message.role === "agent" || message.role === "tool"
  );
  const protectedStart = findProtectedStart(conversational, maxProtectedMessages);
  const older = conversational.slice(0, protectedStart);
  const recent = conversational.slice(protectedStart);
  const summary = summarizeOlderTurns(older, maxSummaryChars);
  let packedMessages: PackedHistoryMessage[] = [
    ...(summary === undefined
      ? []
      : [{
          role: "system" as const,
          content: summary
        }]),
    ...recent.map((message) => ({
      role: message.role === "agent" ? "assistant" as const : message.role,
      content: truncate(message.content, maxMessageChars)
    }))
  ];
  packedMessages = trimToTokenBudget(packedMessages, maxEstimatedTokens);

  return {
    messages: packedMessages,
    summary,
    sourceMessageCount: conversational.length,
    summarizedMessageCount: older.length,
    protectedMessageCount: recent.length,
    protectedToolPairCount: countProtectedToolPairs(recent),
    estimatedTokens: estimateTokens(packedMessages.map((message) => message.content).join("\n"))
  };
}

function summarizeOlderTurns(messages: SessionMessage[], maxChars: number): string | undefined {
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

function findProtectedStart(messages: SessionMessage[], maxProtectedMessages: number): number {
  let start = Math.max(0, messages.length - maxProtectedMessages);

  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }

  return start;
}

function countProtectedToolPairs(messages: SessionMessage[]): number {
  let pairs = 0;

  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool" && messages[index - 1]?.role === "agent") {
      pairs += 1;
    }
  }

  return pairs;
}

function trimToTokenBudget(messages: PackedHistoryMessage[], maxEstimatedTokens: number): PackedHistoryMessage[] {
  let trimmed = [...messages];

  while (estimateTokens(trimmed.map((message) => message.content).join("\n")) > maxEstimatedTokens && trimmed.length > 1) {
    const removableIndex = trimmed.findIndex((message) => message.role !== "tool");
    if (removableIndex === -1) {
      break;
    }
    trimmed.splice(removableIndex, 1);
  }

  return trimmed;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
