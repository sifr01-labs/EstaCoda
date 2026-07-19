import type { ProviderMessage, ProviderReplayEcho, ProviderStructuredToolCall } from "../contracts/provider.js";
import { DELEGATE_TASK_MAX_RESULT_CHARS } from "../contracts/delegation.js";
import type { SessionMessage } from "../contracts/session.js";

type ProviderToolCallTurnMetadata = {
  kind: "provider-tool-call-turn";
  nativeReplaySafe: boolean;
  providerToolCalls: unknown;
  providerReplayEcho?: unknown;
  provider?: unknown;
  model?: unknown;
  routeRole?: unknown;
  attemptedRouteIndex?: unknown;
};

export type NativeHistoryBuilderOptions = {
  targetProviderFamily?: ProviderReplayEcho["providerFamily"];
  targetApiMode?: ProviderReplayEcho["apiMode"];
  mergeAdjacentUsers?: boolean;
  replayEchoContext?: ProviderReplayEchoContext;
  activeRouteIdentity?: ProviderReplayEchoRouteIdentity;
};

export type ProviderReplayEchoRouteIdentity = {
  provider?: string;
  model?: string;
  routeRole?: string;
  attemptedRouteIndex?: number;
};

export type ProviderReplayEchoContext =
  | {
      kind: "historical";
      requiresReasoningEcho: boolean;
    }
  | {
      kind: "active-continuation";
      activeToolCallIds: ReadonlySet<string>;
      requiresReasoningEcho: boolean;
    }
  | {
      kind: "strip";
    };

export type NativeHistoryBuilderStats = {
  nativeToolTurns: number;
  nativeToolResults: number;
  historicalToolResultsLabeled: number;
  mutableStateToolResultsLabeled: number;
  injectedMissingResults: number;
  droppedToolMessages: number;
  skippedUnsafeTurns: number;
  skippedMalformedTurns: number;
  preservedProviderReplayEcho: number;
  placeholderProviderReplayEcho: number;
  strippedProviderReplayEcho: number;
  mergedUserMessages: number;
};

export type NativeHistoryBuilderResult = {
  messages: ProviderMessage[];
  stats: NativeHistoryBuilderStats;
};

const MISSING_TOOL_RESULT_CONTENT = "[Tool result unavailable]";

export function buildNativeHistoryMessages(
  sessionMessages: ReadonlyArray<SessionMessage>,
  options: NativeHistoryBuilderOptions = {}
): NativeHistoryBuilderResult {
  const stats: NativeHistoryBuilderStats = {
    nativeToolTurns: 0,
    nativeToolResults: 0,
    historicalToolResultsLabeled: 0,
    mutableStateToolResultsLabeled: 0,
    injectedMissingResults: 0,
    droppedToolMessages: 0,
    skippedUnsafeTurns: 0,
    skippedMalformedTurns: 0,
    preservedProviderReplayEcho: 0,
    placeholderProviderReplayEcho: 0,
    strippedProviderReplayEcho: 0,
    mergedUserMessages: 0
  };
  const messages: ProviderMessage[] = [];

  for (let index = 0; index < sessionMessages.length; index += 1) {
    const sessionMessage = sessionMessages[index]!;
    const toolCallMetadata = providerToolCallTurnMetadata(sessionMessage.metadata);

    if (sessionMessage.role === "agent" && toolCallMetadata !== undefined) {
      const result = buildToolCallTurnMessages(sessionMessages, index, toolCallMetadata, options, stats);
      index = result.nextIndex - 1;
      for (const providerMessage of result.messages) {
        pushProviderMessage(messages, providerMessage, options, stats);
      }
      continue;
    }

    if (sessionMessage.role === "tool") {
      stats.droppedToolMessages += 1;
      continue;
    }

    pushProviderMessage(messages, mapOrdinarySessionMessage(sessionMessage), options, stats);
  }

  return { messages, stats };
}

function buildToolCallTurnMessages(
  sessionMessages: ReadonlyArray<SessionMessage>,
  index: number,
  metadata: ProviderToolCallTurnMetadata,
  options: NativeHistoryBuilderOptions,
  stats: NativeHistoryBuilderStats
): { messages: ProviderMessage[]; nextIndex: number } {
  const toolResults = collectFollowingToolResults(sessionMessages, index + 1);
  const nextIndex = index + 1 + toolResults.length;

  if (metadata.nativeReplaySafe !== true) {
    stats.skippedUnsafeTurns += 1;
    return { messages: [], nextIndex };
  }

  const toolCalls = parseProviderToolCalls(metadata.providerToolCalls);
  if (toolCalls === undefined) {
    stats.skippedMalformedTurns += 1;
    return { messages: [], nextIndex };
  }

  const expectedIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  const toolNameById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall.name]));
  const matchingToolResults = toolResults.filter((message) => expectedIds.has(toolCallIdFromMetadata(message.metadata)));
  const matchingIds = new Set(matchingToolResults.map((message) => toolCallIdFromMetadata(message.metadata)));
  const missingIds = toolCalls.map((toolCall) => toolCall.id).filter((id) => !matchingIds.has(id));
  const canInjectMissingStubs = missingIds.length > 0 &&
    (matchingToolResults.length > 0 || sessionMessages[nextIndex] !== undefined);

  if (missingIds.length > 0 && !canInjectMissingStubs) {
    stats.skippedMalformedTurns += 1;
    return { messages: [], nextIndex };
  }

  stats.droppedToolMessages += toolResults.length - matchingToolResults.length;

  const assistant: ProviderMessage = {
    role: "assistant",
    content: sessionMessages[index]?.content ?? "",
    toolCalls
  };
  applyProviderReplayEcho(assistant, metadata, toolCalls, missingIds, options, stats);

  const providerMessages: ProviderMessage[] = [assistant];
  for (const toolCall of toolCalls) {
    const resultsForCall = matchingToolResults.filter((message) => toolCallIdFromMetadata(message.metadata) === toolCall.id);
    if (resultsForCall.length === 0) {
      providerMessages.push({
        role: "tool",
        content: labelHistoricalToolResultContent(sessionMessages[index]!, MISSING_TOOL_RESULT_CONTENT, toolNameById.get(toolCall.id), stats),
        toolCallId: toolCall.id
      });
      stats.injectedMissingResults += 1;
      continue;
    }

    for (const result of resultsForCall) {
      const toolName = toolNameFromMetadata(result.metadata) ?? toolNameById.get(toolCall.id);
      providerMessages.push({
        role: "tool",
        content: labelHistoricalToolResultContent(result, result.content, toolName, stats),
        toolCallId: toolCall.id
      });
      stats.nativeToolResults += 1;
    }
  }

  stats.nativeToolTurns += 1;
  return { messages: providerMessages, nextIndex };
}

function collectFollowingToolResults(
  sessionMessages: ReadonlyArray<SessionMessage>,
  startIndex: number
): SessionMessage[] {
  const toolResults: SessionMessage[] = [];
  for (let index = startIndex; index < sessionMessages.length; index += 1) {
    const message = sessionMessages[index]!;
    if (message.role !== "tool") {
      break;
    }
    toolResults.push(message);
  }
  return toolResults;
}

function pushProviderMessage(
  messages: ProviderMessage[],
  message: ProviderMessage,
  options: NativeHistoryBuilderOptions,
  stats: NativeHistoryBuilderStats
): void {
  const previous = messages.at(-1);
  if (
    options.mergeAdjacentUsers === true &&
    previous?.role === "user" &&
    message.role === "user"
  ) {
    previous.content = [stringifyProviderContent(previous.content), stringifyProviderContent(message.content)]
      .filter((content) => content.length > 0)
      .join("\n\n");
    stats.mergedUserMessages += 1;
    return;
  }

  messages.push(message);
}

function mapOrdinarySessionMessage(message: SessionMessage): ProviderMessage {
  switch (message.role) {
    case "agent":
      return { role: "assistant", content: safeSessionContent(message) };
    case "system":
    case "user":
      return { role: message.role, content: safeSessionContent(message) };
    case "tool":
      return { role: "tool", content: safeSessionContent(message) };
  }
}

function safeSessionContent(message: SessionMessage): string {
  if (message.metadata?.providerReplayEcho !== undefined) {
    return "";
  }
  return message.content;
}

function labelHistoricalToolResultContent(
  message: SessionMessage,
  content: string,
  toolName: string | undefined,
  stats: NativeHistoryBuilderStats
): string {
  const prefix = historicalToolResultPrefix(message, toolName);
  stats.historicalToolResultsLabeled += 1;
  if (isMutableStateToolName(toolName)) {
    stats.mutableStateToolResultsLabeled += 1;
  }
  const rendered = `${prefix}\n${content}`;
  return toolName === "delegate_task"
    ? truncateNativeDelegationResult(rendered)
    : rendered;
}

function truncateNativeDelegationResult(content: string): string {
  if (content.length <= DELEGATE_TASK_MAX_RESULT_CHARS) {
    return content;
  }
  const marker = `\n... (${content.length} chars total, truncated)`;
  return `${content.slice(0, DELEGATE_TASK_MAX_RESULT_CHARS - marker.length)}${marker}`;
}

function historicalToolResultPrefix(message: SessionMessage, toolName: string | undefined): string {
  const createdAt = message.createdAt || "unknown time";
  const renderedToolName = toolName?.trim() || "unknown tool result";
  if (isMutableStateToolName(toolName)) {
    return `[Historical tool result from ${createdAt} via ${renderedToolName}. This may describe stale mutable filesystem/config/skill/process state. Verify with a current tool before asserting current state.]`;
  }
  return `[Historical tool result from ${createdAt} via ${renderedToolName}; reference only.]`;
}

function toolNameFromMetadata(metadata: SessionMessage["metadata"]): string | undefined {
  const candidates = [
    metadata?.tool_call_name,
    metadata?.toolName,
    metadata?.tool,
    metadata?.name
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
}

function isMutableStateToolName(name: string | undefined): boolean {
  if (name === undefined) {
    return false;
  }
  const normalized = name.toLowerCase();
  return [
    "skill.list",
    "terminal.inspect",
    "shell",
    "bash",
    "filesystem",
    "file",
    "files.",
    "git",
    "process",
    "config",
    "service",
    "network"
  ].some((needle) => normalized === needle || normalized.startsWith(`${needle}.`) || normalized.includes(needle));
}

function stringifyProviderContent(content: ProviderMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return "";
}

function providerToolCallTurnMetadata(metadata: SessionMessage["metadata"]): ProviderToolCallTurnMetadata | undefined {
  if (metadata?.kind !== "provider-tool-call-turn") {
    return undefined;
  }
  return {
    kind: "provider-tool-call-turn",
    nativeReplaySafe: metadata.nativeReplaySafe === true,
    providerToolCalls: metadata.providerToolCalls,
    providerReplayEcho: metadata.providerReplayEcho,
    provider: metadata.provider,
    model: metadata.model,
    routeRole: metadata.routeRole,
    attemptedRouteIndex: metadata.attemptedRouteIndex
  };
}

function parseProviderToolCalls(value: unknown): ProviderStructuredToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const toolCalls: ProviderStructuredToolCall[] = [];
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

function providerReplayEcho(value: unknown): ProviderReplayEcho | undefined {
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

function isProviderReplayEchoFamily(value: unknown): value is ProviderReplayEcho["providerFamily"] {
  return value === "deepseek" || value === "kimi" || value === "mimo";
}

function providerReplayEchoProvenance(value: unknown): ProviderReplayEcho["provenance"] | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  return value === "provider" || value === "protocol-placeholder" ? value : false;
}

function applyProviderReplayEcho(
  assistant: ProviderMessage,
  metadata: ProviderToolCallTurnMetadata,
  toolCalls: ProviderStructuredToolCall[],
  missingIds: string[],
  options: NativeHistoryBuilderOptions,
  stats: NativeHistoryBuilderStats
): void {
  const rawEchoExists = metadata.providerReplayEcho !== undefined;
  const echo = providerReplayEcho(metadata.providerReplayEcho);
  const context = options.replayEchoContext ?? { kind: "strip" as const };

  if (
    context.kind === "active-continuation" &&
    echo !== undefined &&
    isProviderOriginatedEcho(echo) &&
    echoMatchesTarget(echo, options) &&
    routeIdentityMatchesTarget(metadata, options.activeRouteIdentity) &&
    missingIds.length === 0 &&
    toolCallIdsExactlyMatch(toolCalls, context.activeToolCallIds)
  ) {
    assistant.providerReplayEcho = echo;
    stats.preservedProviderReplayEcho += 1;
    return;
  }

  if (rawEchoExists) {
    stats.strippedProviderReplayEcho += 1;
  }

  if (context.kind !== "strip" && context.requiresReasoningEcho === true) {
    const placeholder = providerReplayEchoPlaceholder(options);
    if (placeholder !== undefined) {
      assistant.providerReplayEcho = placeholder;
      stats.placeholderProviderReplayEcho += 1;
    }
  }
}

function isProviderOriginatedEcho(echo: ProviderReplayEcho): boolean {
  return echo.provenance === undefined || echo.provenance === "provider";
}

function routeIdentityMatchesTarget(
  metadata: ProviderToolCallTurnMetadata,
  activeRouteIdentity: ProviderReplayEchoRouteIdentity | undefined
): boolean {
  if (activeRouteIdentity === undefined) {
    return true;
  }

  return identityFieldMatches(metadata.provider, activeRouteIdentity.provider) &&
    identityFieldMatches(metadata.model, activeRouteIdentity.model) &&
    identityFieldMatches(metadata.routeRole, activeRouteIdentity.routeRole) &&
    identityFieldMatches(metadata.attemptedRouteIndex, activeRouteIdentity.attemptedRouteIndex);
}

function identityFieldMatches(persisted: unknown, active: string | number | undefined): boolean {
  if (persisted === undefined || active === undefined) {
    return true;
  }
  return persisted === active;
}

function providerReplayEchoPlaceholder(options: NativeHistoryBuilderOptions): ProviderReplayEcho | undefined {
  if (
    options.targetProviderFamily === undefined ||
    options.targetApiMode !== "openai_chat_completions"
  ) {
    return undefined;
  }
  return {
    field: "reasoning_content",
    value: " ",
    providerFamily: options.targetProviderFamily,
    apiMode: "openai_chat_completions",
    chars: 1,
    provenance: "protocol-placeholder"
  };
}

function toolCallIdsExactlyMatch(
  toolCalls: ProviderStructuredToolCall[],
  activeToolCallIds: ReadonlySet<string>
): boolean {
  if (toolCalls.length !== activeToolCallIds.size) {
    return false;
  }
  return toolCalls.every((toolCall) => activeToolCallIds.has(toolCall.id));
}

function echoMatchesTarget(echo: ProviderReplayEcho, options: NativeHistoryBuilderOptions): boolean {
  return options.targetProviderFamily === echo.providerFamily &&
    options.targetApiMode === echo.apiMode;
}

function toolCallIdFromMetadata(metadata: SessionMessage["metadata"]): string {
  const value = metadata?.tool_call_id;
  return typeof value === "string" ? value : "";
}
