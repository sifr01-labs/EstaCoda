import type { ProviderExecutionSummary } from "../contracts/provider.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type ConversationContinuationState = {
  id: string;
  status: "open" | "satisfied" | "cancelled" | "superseded";
  userRequest: string;
  promisedAction?: string;
  lastProgress?: string;
  updatedAt: string;
  source: "heuristic" | "explicit";
};

type ToolExecutionSummary = {
  tool?: { name?: string };
  result?: { ok?: boolean };
};

export function detectPromisedAction(agentText: string): string | undefined {
  const text = singleLine(agentText);
  const patterns = [
    /\bLet me\s+([^.!?\n]{4,180})/iu,
    /\bI['’]?ll\s+([^.!?\n]{4,180})/iu,
    /\bI will\s+([^.!?\n]{4,180})/iu,
    /\bI['’]?m going to\s+([^.!?\n]{4,180})/iu,
    /\bNext I['’]?ll\s+([^.!?\n]{4,180})/iu,
    /\bI['’]?ll dig into\s+([^.!?\n]{4,180})/iu
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const action = sanitizeStateText(match?.[1]);
    if (action !== undefined) {
      return action;
    }
  }

  return undefined;
}

export function isAcknowledgementContinuation(userText: string): boolean {
  const text = normalizeUserText(userText);
  return /^(ok|okay|yes|go on|continue|do that|carry on)$/u.test(text);
}

export function updateConversationContinuationState(input: {
  previous?: ConversationContinuationState;
  userText: string;
  agentText?: string;
  toolExecutions?: readonly ToolExecutionSummary[];
  providerExecution?: ProviderExecutionSummary;
}): ConversationContinuationState | undefined {
  const now = new Date().toISOString();
  const previous = sanitizeConversationContinuationState(input.previous);
  const userRequest = sanitizeStateText(input.userText) ?? "";

  if (isCancellation(input.userText)) {
    return previous === undefined
      ? undefined
      : {
          ...previous,
          status: "cancelled",
          updatedAt: now,
          lastProgress: "User cancelled the open commitment."
        };
  }

  const promisedAction = detectPromisedAction(input.agentText ?? "");
  const continuation = isAcknowledgementContinuation(input.userText) && previous?.status === "open";
  const explicitNewRequest = !continuation && isExplicitNewRequest(input.userText);
  const baseRequest = continuation ? previous.userRequest : userRequest;

  if (promisedAction !== undefined) {
    return {
      id: continuation ? previous.id : continuationId(baseRequest, promisedAction),
      status: "open",
      userRequest: baseRequest,
      promisedAction,
      lastProgress: summarizeProgress(input),
      updatedAt: now,
      source: "heuristic"
    };
  }

  if (continuation) {
    if (hasSubstantiveAnswer(input.agentText) && (input.toolExecutions?.length ?? 0) === 0) {
      return {
        ...previous,
        status: "satisfied",
        lastProgress: summarizeProgress(input) ?? "Assistant provided a substantive answer.",
        updatedAt: now
      };
    }

    if (hasSubstantiveAnswer(input.agentText) && input.providerExecution?.status !== "failed") {
      return {
        ...previous,
        status: "satisfied",
        lastProgress: summarizeProgress(input) ?? "Assistant provided a substantive answer.",
        updatedAt: now
      };
    }

    return {
      ...previous,
      lastProgress: summarizeProgress(input) ?? previous.lastProgress,
      updatedAt: now
    };
  }

  if (explicitNewRequest) {
    return previous?.status === "open"
      ? {
          ...previous,
          status: "superseded",
          updatedAt: now,
          lastProgress: "Superseded by a newer explicit user request."
        }
      : undefined;
  }

  return previous?.status === "open" ? previous : undefined;
}

export function renderConversationContinuationPrompt(state: ConversationContinuationState | undefined): string | undefined {
  const sanitized = sanitizeConversationContinuationState(state);
  if (sanitized?.status !== "open") {
    return undefined;
  }

  return [
    "Conversation continuation:",
    "The user's latest message appears to acknowledge continuation. Continue the open commitment unless the current user message explicitly changes direction.",
    "This historical conversation context is subordinate to the latest user message.",
    `Open commitment: ${sanitized.promisedAction ?? sanitized.userRequest}`,
    sanitized.lastProgress === undefined ? undefined : `Last progress: ${sanitized.lastProgress}`
  ].filter((line) => line !== undefined).join("\n");
}

export function sanitizeConversationContinuationState(value: unknown): ConversationContinuationState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = value.status === "open" || value.status === "satisfied" || value.status === "cancelled" || value.status === "superseded"
    ? value.status
    : undefined;
  const source = value.source === "heuristic" || value.source === "explicit" ? value.source : undefined;
  const id = safeToken(value.id);
  const userRequest = sanitizeStateText(value.userRequest);
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.length <= 64 ? value.updatedAt : undefined;
  if (status === undefined || source === undefined || id === undefined || userRequest === undefined || updatedAt === undefined) {
    return undefined;
  }

  return {
    id,
    status,
    userRequest,
    ...(sanitizeStateText(value.promisedAction) === undefined ? {} : { promisedAction: sanitizeStateText(value.promisedAction) }),
    ...(sanitizeStateText(value.lastProgress) === undefined ? {} : { lastProgress: sanitizeStateText(value.lastProgress) }),
    updatedAt,
    source
  };
}

function isCancellation(userText: string): boolean {
  return /^(stop|never mind|nevermind|new topic|cancel|drop it)$/iu.test(normalizeUserText(userText));
}

function isExplicitNewRequest(userText: string): boolean {
  const text = normalizeUserText(userText);
  if (text.length < 8 || isAcknowledgementContinuation(text) || isCancellation(text)) {
    return false;
  }

  return /[?]$/u.test(text) ||
    /^(can you|please|review|implement|fix|write|create|show|explain|summarize|search|look up|run|commit|update|change|add|remove|tell me)\b/iu.test(text);
}

function hasSubstantiveAnswer(agentText: string | undefined): boolean {
  const text = singleLine(agentText ?? "");
  if (text.length < 80) {
    return false;
  }

  return detectPromisedAction(text) === undefined;
}

function summarizeProgress(input: {
  agentText?: string;
  toolExecutions?: readonly ToolExecutionSummary[];
  providerExecution?: ProviderExecutionSummary;
}): string | undefined {
  const tools = (input.toolExecutions ?? [])
    .map((execution) => execution.tool?.name)
    .filter((tool): tool is string => typeof tool === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(tool));
  if (tools.length > 0) {
    return sanitizeStateText(`Tools used: ${[...new Set(tools)].slice(0, 4).join(", ")}`);
  }

  if (input.providerExecution?.status === "failed") {
    return "Provider failed before completing the open commitment.";
  }

  const text = sanitizeStateText(input.agentText);
  return text === undefined ? undefined : truncate(text, 180);
}

function sanitizeStateText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const redacted = redactSensitiveText(singleLine(value)).replace(/[\[\]{}<>`]/gu, "");
  const trimmed = redacted.trim();
  return trimmed.length === 0 ? undefined : truncate(trimmed, 240);
}

function normalizeUserText(value: string): string {
  return singleLine(value).trim().toLowerCase();
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function continuationId(userRequest: string, promisedAction: string): string {
  return `continuation-${hashString(`${userRequest}\n${promisedAction}`).slice(0, 12)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
