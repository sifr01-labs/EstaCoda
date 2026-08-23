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
import { estimateProviderImageInputTokens } from "./provider-image-token-estimator.js";
import { resolveProviderOutputTokenBound } from "./provider-output-limit.js";
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
  const inputEstimate = estimateProviderRequestInputTokens(input.request, input.route, input.usage);
  const estimatedInputTokens = inputEstimate?.tokens;
  const outputBound = resolveProviderOutputTokenBound(input.request, input.route);
  const inputRate = pricing.inputPerMillionTokens;
  const outputRate = pricing.outputPerMillionTokens;
  const reasoningRate = pricing.reasoningPerMillionTokens ?? outputRate;
  const reasoningPossible = input.route.profile.supportsReasoning === true ||
    pricing.reasoningPerMillionTokens !== undefined;
  const pricingAvailable = validRate(inputRate) && validRate(outputRate) &&
    (!reasoningPossible || validRate(reasoningRate));
  const inputExposureBounded = estimatedInputTokens !== undefined || (
    pricingAvailable && maximumInputRate(pricing) === 0
  );
  const outputExposureBounded = outputBound !== undefined || (
    pricingAvailable && outputRate === 0 && (!reasoningPossible || reasoningRate === 0)
  );
  const safelyBounded = inputExposureBounded && outputExposureBounded;
  const maximumEstimatedCostUsd = pricingAvailable && safelyBounded
    ? maximumEstimatedProviderCost({
        estimatedInputTokens: estimatedInputTokens ?? 0,
        maximumOutputTokens: outputBound ?? 0,
        maximumReasoningTokens: reasoningPossible ? outputBound ?? 0 : 0,
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
      ...(inputEstimate?.imageTokens === undefined ? {} : {
        estimatedImageInputTokens: inputEstimate.imageTokens,
        imageTokenEstimator: inputEstimate.imageTokenEstimator
      }),
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

type ProviderInputTokenEstimate = {
  tokens: number;
  imageTokens?: number;
  imageTokenEstimator?: string;
};

function estimateProviderRequestInputTokens(
  request: ProviderRequest,
  route: ResolvedModelRoute,
  usage: ProviderUsageContext
): ProviderInputTokenEstimate | undefined {
  try {
    const imageCount = countProviderImageParts(request.messages);
    const imageInputs = usage.imageInputs ?? [];
    if (imageCount !== imageInputs.length) return undefined;
    const imageEstimate = imageCount === 0
      ? undefined
      : estimateProviderImageInputTokens({
          provider: route.provider,
          model: route.id,
          images: imageInputs
        });
    if (imageCount > 0 && imageEstimate === undefined) return undefined;

    const messages = request.messages.map((message) => tokenEstimateMessage(message, imageCount === 0));
    const roughTokens = estimateMessagesTokensRough(messages);
    const structured = JSON.stringify({
      tools: request.tools ?? [],
      responseFormat: request.responseFormat ?? null
    });
    const structuredTokens = estimateTextTokensRough(structured);
    const conservativeBytes = request.messages.reduce((total, message) => {
      return total + Buffer.byteLength(JSON.stringify({
        role: message.role,
        content: boundedProviderContent(message.content),
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        providerReplayEcho: message.providerReplayEcho
      }), "utf8") + 32;
    }, Buffer.byteLength(structured, "utf8") + 64);
    const textTokens = Math.max(roughTokens + structuredTokens, conservativeBytes);
    const total = textTokens + (imageEstimate?.tokens ?? 0);
    return Number.isSafeInteger(total) && total >= 0
      ? {
          tokens: total,
          ...(imageEstimate === undefined ? {} : {
            imageTokens: imageEstimate.tokens,
            imageTokenEstimator: imageEstimate.estimator
          })
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function tokenEstimateMessage(message: ProviderMessage, includeImagePlaceholders: boolean) {
  const content = typeof message.content === "string" ? message.content : "";
  const parts: Array<{ type: "text"; text: string } | { type: "image_url" }> | undefined =
    Array.isArray(message.content)
    ? message.content.reduce<Array<{ type: "text"; text: string } | { type: "image_url" }>>((result, part: unknown) => {
        if (typeof part === "object" && part !== null && "type" in part &&
            (part as { type?: unknown }).type === "text" && "text" in part &&
            typeof (part as { text?: unknown }).text === "string") {
          result.push({ type: "text", text: (part as { text: string }).text });
        } else if (includeImagePlaceholders) {
          result.push({ type: "image_url" });
        }
        return result;
      }, [])
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

function countProviderImageParts(messages: readonly ProviderMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isProviderContentPart(part)) throw new Error("Provider content part is invalid.");
      if (part.type === "image_url") count += 1;
    }
  }
  return count;
}

function boundedProviderContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isProviderContentPart(part)) throw new Error("Provider content part is invalid.");
    return part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url" };
  });
}

function isProviderContentPart(part: unknown): part is
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } } {
  if (typeof part !== "object" || part === null || !("type" in part)) return false;
  const candidate = part as {
    type?: unknown;
    text?: unknown;
    image_url?: { url?: unknown };
  };
  return candidate.type === "text"
    ? typeof candidate.text === "string"
    : candidate.type === "image_url" && typeof candidate.image_url?.url === "string";
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

function maximumInputRate(pricing: {
  inputPerMillionTokens?: number;
  cacheReadPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
}): number | undefined {
  const input = pricing.inputPerMillionTokens;
  if (!validRate(input)) return undefined;
  return Math.max(
    input,
    pricing.cacheReadPerMillionTokens ?? input,
    pricing.cacheWritePerMillionTokens ?? input
  );
}

function validRate(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
