import { createHash, randomUUID } from "node:crypto";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";

const RUNTIME_TOOL_CALL_ID_HEX_CHARS = 24;

/**
 * Creates an invocation-local namespace. It is never persisted or shown to the
 * provider; only opaque IDs derived from it cross runtime boundaries.
 */
export function createProviderToolCallNamespace(): string {
  return randomUUID();
}

/**
 * Runtime tool-call identity intentionally excludes provider IDs, tool names,
 * arguments, and raw provider payloads. The provider's identifier is protocol
 * input, not an authoritative persistence or evidence key.
 */
export function runtimeProviderToolCallId(input: {
  namespace: string;
  providerIteration: number;
  callOrdinal: number;
}): string {
  if (input.namespace.length === 0 || input.namespace.length > 128) {
    throw new Error("Provider tool-call namespace must be non-empty and bounded.");
  }
  if (!Number.isSafeInteger(input.providerIteration) || input.providerIteration < 0) {
    throw new Error("Provider tool-call iteration must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.callOrdinal) || input.callOrdinal < 0) {
    throw new Error("Provider tool-call ordinal must be a non-negative safe integer.");
  }

  const digest = createHash("sha256")
    .update(input.namespace)
    .update("\0")
    .update(String(input.providerIteration))
    .update("\0")
    .update(String(input.callOrdinal))
    .digest("hex")
    .slice(0, RUNTIME_TOOL_CALL_ID_HEX_CHARS);
  return `tool-call-${digest}`;
}

export function namespaceProviderToolCalls(input: {
  execution: ProviderExecutionResult;
  namespace: string;
  providerIteration: number;
}): ProviderExecutionResult {
  if (input.execution.toolCalls.length === 0) return input.execution;
  return {
    ...input.execution,
    toolCalls: input.execution.toolCalls.map((toolCall, callOrdinal) => ({
      ...toolCall,
      id: runtimeProviderToolCallId({
        namespace: input.namespace,
        providerIteration: input.providerIteration,
        callOrdinal
      })
    }))
  };
}
