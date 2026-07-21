import type {
  ProviderMessage,
  ProviderRequest,
  ProviderRouteRole,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { ProviderUsageContext } from "../contracts/provider-usage.js";
import type {
  ProviderSpendDenialReason,
  ProviderSpendRequest
} from "../contracts/provider-spend.js";
import { estimateMessagesTokensRough, estimateTextTokensRough } from "../prompt/token-estimator.js";
import { providerPricingSnapshot, providerUsageRequestKey } from "./provider-usage-ledger.js";

export type ProviderSpendPreparation = {
  request: ProviderSpendRequest;
  pricingAvailable: boolean;
  safelyBounded: boolean;
};

/** Builds the immutable exposure envelope before a provider adapter may be invoked. */
export function prepareProviderSpend(input: {
  profileId: string;
  request: ProviderRequest;
  route: ResolvedModelRoute;
  routeIndex: number;
  routeRole: ProviderRouteRole;
  providerAttemptIndex: number;
  usage: ProviderUsageContext;
}): ProviderSpendPreparation {
  const pricing = providerPricingSnapshot(input.route.provider, input.route.id, input.route);
  const estimatedInputTokens = estimateProviderRequestInputTokens(input.request);
  const outputBound = providerOutputBound(input.request, input.route);
  const inputRate = pricing.inputPerMillionTokens;
  const outputRate = pricing.outputPerMillionTokens;
  const reasoningRate = pricing.reasoningPerMillionTokens ?? outputRate;
  const reasoningPossible = input.route.profile.supportsReasoning === true ||
    pricing.reasoningPerMillionTokens !== undefined;
  const pricingAvailable = validRate(inputRate) && validRate(outputRate) &&
    (!reasoningPossible || validRate(reasoningRate));
  const safelyBounded = estimatedInputTokens !== undefined && outputBound !== undefined;
  const maximumEstimatedCostUsd = pricingAvailable && safelyBounded
    ? maximumEstimatedProviderCost({
        estimatedInputTokens,
        maximumOutputTokens: outputBound,
        maximumReasoningTokens: reasoningPossible ? outputBound : 0,
        inputRate,
        outputRate,
        reasoningRate: reasoningPossible ? reasoningRate : undefined,
        cacheReadRate: pricing.cacheReadPerMillionTokens,
        cacheWriteRate: pricing.cacheWritePerMillionTokens
      })
    : 0;

  return {
    pricingAvailable,
    safelyBounded,
    request: {
      requestKey: providerUsageRequestKey(input.usage.requestKey, input.providerAttemptIndex),
      profileId: input.profileId,
      ...(input.usage.executionSessionId === undefined
        ? {}
        : { executionSessionId: input.usage.executionSessionId }),
      ...(input.usage.sessionBudgetScopeId === undefined
        ? {}
        : { sessionBudgetScopeId: input.usage.sessionBudgetScopeId }),
      ...(input.usage.visibleTurnId === undefined ? {} : { visibleTurnId: input.usage.visibleTurnId }),
      ...(input.usage.taskId === undefined ? {} : {
        taskId: input.usage.taskId,
        rootTaskId: input.usage.rootTaskId,
        planRevisionId: input.usage.planRevisionId,
        stepId: input.usage.stepId,
        attemptId: input.usage.attemptId
      }),
      sourceKind: input.usage.sourceKind,
      ...(input.usage.auxiliaryKind === undefined ? {} : { auxiliaryKind: input.usage.auxiliaryKind }),
      provider: input.route.provider,
      model: input.route.id,
      routeRole: input.usage.routeRole ?? input.routeRole,
      routeIndex: input.usage.routeIndex ?? input.routeIndex,
      providerAttemptIndex: input.providerAttemptIndex,
      pricing,
      estimatedInputTokens: estimatedInputTokens ?? 0,
      boundedMaximumOutputTokens: outputBound ?? 0,
      ...(reasoningPossible && outputBound !== undefined
        ? { boundedMaximumReasoningTokens: outputBound }
        : {}),
      maximumEstimatedCostUsd
    }
  };
}

export function providerSpendDenialMessage(reason: ProviderSpendDenialReason): string {
  switch (reason) {
    case "SESSION_LIMIT_EXHAUSTED":
      return "This logical session has reached its estimated provider spending limit. No provider request was sent.";
    case "TASK_LIMIT_EXHAUSTED":
      return "This Task tree has reached its estimated provider spending limit. No provider request was sent.";
    case "SESSION_CAPACITY_RESERVED":
      return "This logical session's remaining provider spending capacity is reserved by work already in progress. No provider request was sent.";
    case "TASK_CAPACITY_RESERVED":
      return "This Task tree's remaining provider spending capacity is reserved by work already in progress. No provider request was sent.";
    case "PRICING_UNAVAILABLE":
      return "The selected model has no verifiable pricing, so the configured estimated provider spending limit cannot be enforced. No provider request was sent.";
    case "REQUEST_CANNOT_BE_SAFELY_BOUNDED":
      return "This provider request has no safe output bound, so its configured estimated spending limit cannot be enforced. No provider request was sent.";
    case "SPEND_CONTROLLER_UNAVAILABLE":
      return "Provider spending authorization is temporarily unavailable. No provider request was sent.";
  }
}

function estimateProviderRequestInputTokens(request: ProviderRequest): number | undefined {
  try {
    const messages = request.messages.map(tokenEstimateMessage);
    const roughTokens = estimateMessagesTokensRough(messages);
    const structured = JSON.stringify({
      tools: request.tools ?? [],
      responseFormat: request.responseFormat ?? null
    });
    const structuredTokens = estimateTextTokensRough(structured);
    const conservativeBytes = request.messages.reduce((total, message) => {
      if (Array.isArray(message.content) && message.content.some((part) =>
        typeof part !== "object" || part === null || !("type" in part) ||
        (part as { type?: unknown }).type !== "text"
      )) {
        throw new Error("Provider media input has no deterministic token bound.");
      }
      return total + Buffer.byteLength(JSON.stringify({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        providerReplayEcho: message.providerReplayEcho
      }), "utf8") + 32;
    }, Buffer.byteLength(structured, "utf8") + 64);
    const total = Math.max(roughTokens + structuredTokens, conservativeBytes);
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

function tokenEstimateMessage(message: ProviderMessage) {
  const content = typeof message.content === "string" ? message.content : "";
  const parts = Array.isArray(message.content)
    ? message.content.map((part: unknown) => {
        if (typeof part === "object" && part !== null && "type" in part &&
            (part as { type?: unknown }).type === "text" && "text" in part &&
            typeof (part as { text?: unknown }).text === "string") {
          return { type: "text" as const, text: (part as { text: string }).text };
        }
        return { type: "image_url" as const };
      })
    : undefined;
  return {
    role: message.role,
    content,
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.providerReplayEcho === undefined ? {} : { providerReplayEcho: message.providerReplayEcho }),
    ...(parts === undefined ? {} : { parts })
  };
}

function providerOutputBound(request: ProviderRequest, route: ResolvedModelRoute): number | undefined {
  for (const candidate of [request.maxTokens, route.maxTokens, route.contextWindowTokens, route.profile.contextWindowTokens]) {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

function maximumEstimatedProviderCost(input: {
  estimatedInputTokens: number;
  maximumOutputTokens: number;
  maximumReasoningTokens: number;
  inputRate: number;
  outputRate: number;
  reasoningRate?: number;
  cacheReadRate?: number;
  cacheWriteRate?: number;
}): number {
  const maximumInputRate = Math.max(
    input.inputRate,
    input.cacheReadRate ?? input.inputRate,
    input.cacheWriteRate ?? input.inputRate
  );
  return input.estimatedInputTokens / 1_000_000 * maximumInputRate +
    input.maximumOutputTokens / 1_000_000 * input.outputRate +
    input.maximumReasoningTokens / 1_000_000 * (input.reasoningRate ?? input.outputRate);
}

function validRate(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
