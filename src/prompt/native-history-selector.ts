import type { ProviderReplayEcho, ProviderStructuredToolCall } from "../contracts/provider.js";
import type { SessionMessage } from "../contracts/session.js";
import { estimateMessageTokensRough } from "./token-estimator.js";

export type NativeHistoryUnit =
  | {
      kind: "message";
      message: SessionMessage;
      estimatedTokens: number;
    }
  | {
      kind: "tool-group";
      messages: SessionMessage[];
      estimatedTokens: number;
    };

export type NativeHistoryBudget = {
  maxTokens: number;
  reservedTokens?: number;
};

export type NativeHistoryOptions = Record<string, never>;

export type NativeHistorySelection = {
  selectedUnits: NativeHistoryUnit[];
  unselectedUnits: NativeHistoryUnit[];
  stats: {
    selectedMessages: number;
    unselectedMessages: number;
    selectedToolGroups: number;
    unselectedToolGroups: number;
    estimatedTokens: number;
  };
};

export function selectNativeHistoryWindow(
  messages: SessionMessage[],
  budget: NativeHistoryBudget,
  _options: NativeHistoryOptions = {}
): NativeHistorySelection {
  const units = buildNativeHistoryUnits(messages);
  const availableTokens = Math.max(0, budget.maxTokens - (budget.reservedTokens ?? 0));
  let selectedTokenTotal = 0;
  let selectedStart = units.length;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (selectedTokenTotal + unit.estimatedTokens > availableTokens) {
      break;
    }
    selectedTokenTotal += unit.estimatedTokens;
    selectedStart = index;
  }

  const selectedUnits = units.slice(selectedStart);
  const unselectedUnits = units.slice(0, selectedStart);

  return {
    selectedUnits,
    unselectedUnits,
    stats: {
      selectedMessages: countUnitMessages(selectedUnits),
      unselectedMessages: countUnitMessages(unselectedUnits),
      selectedToolGroups: selectedUnits.filter((unit) => unit.kind === "tool-group").length,
      unselectedToolGroups: unselectedUnits.filter((unit) => unit.kind === "tool-group").length,
      estimatedTokens: selectedTokenTotal
    }
  };
}

function buildNativeHistoryUnits(messages: SessionMessage[]): NativeHistoryUnit[] {
  const units: NativeHistoryUnit[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const toolCallIds = providerToolCallIds(message);

    if (toolCallIds !== undefined) {
      const groupMessages = [message];
      let scanIndex = index + 1;
      while (scanIndex < messages.length) {
        const candidate = messages[scanIndex]!;
        if (candidate.role !== "tool") {
          break;
        }
        const toolCallId = toolCallIdFromMetadata(candidate.metadata);
        if (toolCallId === undefined || !toolCallIds.has(toolCallId)) {
          break;
        }
        groupMessages.push(candidate);
        scanIndex += 1;
      }
      units.push({
        kind: "tool-group",
        messages: groupMessages,
        estimatedTokens: estimateSessionMessages(groupMessages)
      });
      index = scanIndex - 1;
      continue;
    }

    units.push({
      kind: "message",
      message,
      estimatedTokens: estimateSessionMessages([message])
    });
  }

  return units;
}

function providerToolCallIds(message: SessionMessage): Set<string> | undefined {
  if (message.role !== "agent" || message.metadata?.kind !== "provider-tool-call-turn") {
    return undefined;
  }

  const ids = new Set<string>();
  const calls = message.metadata.providerToolCalls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (call !== null && typeof call === "object") {
        const id = (call as Record<string, unknown>).id;
        if (typeof id === "string" && id.length > 0) {
          ids.add(id);
        }
      }
    }
  }

  return ids;
}

function toolCallIdFromMetadata(metadata: SessionMessage["metadata"]): string | undefined {
  const value = metadata?.tool_call_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function estimateSessionMessages(messages: SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateSessionMessage(message), 0);
}

function estimateSessionMessage(message: SessionMessage): number {
  if (message.role === "agent" && message.metadata?.kind === "provider-tool-call-turn") {
    return estimateMessageTokensRough({
      role: "assistant",
      content: message.content,
      toolCalls: providerToolCalls(message.metadata.providerToolCalls),
      providerReplayEcho: providerReplayEcho(message.metadata.providerReplayEcho),
      metadata: message.metadata
    });
  }

  return estimateMessageTokensRough({
    role: message.role === "agent" ? "assistant" : message.role,
    content: message.content,
    toolCallId: message.role === "tool" ? toolCallIdFromMetadata(message.metadata) : undefined,
    metadata: message.metadata
  });
}

function providerToolCalls(value: unknown): ProviderStructuredToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const calls: ProviderStructuredToolCall[] = [];
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
    calls.push({
      id: record.id,
      name: record.name,
      argumentsText: record.argumentsText
    });
  }

  return calls;
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

function countUnitMessages(units: NativeHistoryUnit[]): number {
  return units.reduce((sum, unit) => sum + (unit.kind === "message" ? 1 : unit.messages.length), 0);
}
