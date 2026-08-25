import type { ProviderExecutionSummary } from "../contracts/provider.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type ConversationCapabilityContext = {
  toolsets: ToolsetName[];
  connectors: NonNullable<ToolDefinition["connector"]>[];
};

export type ConversationContinuationState = {
  id: string;
  status: "open" | "satisfied" | "cancelled" | "superseded";
  userRequest: string;
  promisedAction?: string;
  lastProgress?: string;
  updatedAt: string;
  source: "heuristic" | "explicit";
  capabilityContext?: ConversationCapabilityContext;
};

type ToolExecutionSummary = {
  tool?: {
    name?: string;
    toolsets?: readonly ToolsetName[];
    connector?: ToolDefinition["connector"];
  };
  result?: { ok?: boolean };
};

const CONTINUITY_TOOLSETS = new Set<ToolsetName>(["browser"]);
const MAX_CONTINUITY_TOOLSETS = 4;
const MAX_CONTINUITY_CONNECTORS = 8;

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
  return /^(?:ok|okay|yes|go on|continue|do that|carry on|retry|try again)$/u.test(text) ||
    /^(?:let'?s do (?:it|this)|please continue|why not try again)(?:\b|$)/u.test(text) ||
    /^(?:أعد المحاولة|حاول مرة أخرى)$/u.test(text);
}

export function blockedConnectorContinuationState(input: {
  userText: string;
  connectorId: string;
  reasonCodes: readonly string[];
  updatedAt?: string;
}): ConversationContinuationState | undefined {
  const userRequest = sanitizeStateText(input.userText);
  const connectorId = safeConnectorId(input.connectorId);
  if (userRequest === undefined || connectorId === undefined) return undefined;
  const promisedAction = `retry the governed transfer to ${connectorId} after the connector blocker is resolved`;
  const reasonCodes = input.reasonCodes
    .filter((reason) => /^[a-z0-9_-]{1,64}$/u.test(reason))
    .slice(0, 8);
  return {
    id: continuationId(userRequest, promisedAction),
    status: "open",
    userRequest,
    promisedAction,
    ...(reasonCodes.length === 0 ? {} : {
      lastProgress: `Blocked by: ${reasonCodes.join(", ")}.`
    }),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    source: "explicit",
    capabilityContext: {
      toolsets: ["browser"],
      connectors: [{ kind: "mcp", id: connectorId }]
    }
  };
}

export function continuesConversationCommitment(
  userText: string,
  previous: ConversationContinuationState | undefined
): boolean {
  if (previous?.status !== "open" || isCancellation(userText)) return false;
  if (isAcknowledgementContinuation(userText) || hasDeicticContinuationReference(userText)) return true;
  return !isExplicitNewRequest(userText);
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
  const continuation = previous !== undefined && continuesConversationCommitment(input.userText, previous);
  const continuedState = continuation ? previous : undefined;
  const explicitNewRequest = !continuation && isExplicitNewRequest(input.userText);
  const baseRequest = continuedState?.userRequest ?? userRequest;
  const capabilityContext = mergeCapabilityContexts(
    continuedState?.capabilityContext,
    capabilityContextFromExecutions(input.toolExecutions)
  );

  if (promisedAction !== undefined) {
    return {
      id: continuedState?.id ?? continuationId(baseRequest, promisedAction),
      status: "open",
      userRequest: baseRequest,
      promisedAction,
      lastProgress: summarizeProgress(input),
      updatedAt: now,
      source: "heuristic",
      ...(capabilityContext === undefined ? {} : { capabilityContext })
    };
  }

  if (continuedState !== undefined) {
    if (hasSubstantiveAnswer(input.agentText) && (input.toolExecutions?.length ?? 0) === 0) {
      return {
        ...continuedState,
        status: "satisfied",
        lastProgress: summarizeProgress(input) ?? "Assistant provided a substantive answer.",
        updatedAt: now,
        ...(capabilityContext === undefined ? {} : { capabilityContext })
      };
    }

    if (hasSubstantiveAnswer(input.agentText) && input.providerExecution?.status !== "failed") {
      return {
        ...continuedState,
        status: "satisfied",
        lastProgress: summarizeProgress(input) ?? "Assistant provided a substantive answer.",
        updatedAt: now,
        ...(capabilityContext === undefined ? {} : { capabilityContext })
      };
    }

    return {
      ...continuedState,
      lastProgress: summarizeProgress(input) ?? continuedState.lastProgress,
      updatedAt: now,
      ...(capabilityContext === undefined ? {} : { capabilityContext })
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
  const capabilityContext = sanitizeCapabilityContext(value.capabilityContext);

  return {
    id,
    status,
    userRequest,
    ...(sanitizeStateText(value.promisedAction) === undefined ? {} : { promisedAction: sanitizeStateText(value.promisedAction) }),
    ...(sanitizeStateText(value.lastProgress) === undefined ? {} : { lastProgress: sanitizeStateText(value.lastProgress) }),
    updatedAt,
    source,
    ...(capabilityContext === undefined ? {} : { capabilityContext })
  };
}

function isCancellation(userText: string): boolean {
  return /^(stop|never mind|nevermind|new topic|cancel|drop it)$/iu.test(normalizeUserText(userText));
}

function hasDeicticContinuationReference(userText: string): boolean {
  const text = normalizeUserText(userText);
  const action = /\b(?:click|press|open|select|scroll|switch|type|enter|fill|use|inspect|check|continue|finish|complete|update|add|create|set\s+up)\b/iu;
  const reference = /\b(?:it|that|this|there|those|them|the same|shown|above|previous|existing)\b/iu;
  const arabicAction = /(?:انقر|اضغط|افتح|اختر|مرر|بد[ّ]?ل|اكتب|أدخل|استخدم|تابع|أكمل)/u;
  const arabicReference = /(?:هذا|هذه|ذلك|تلك|هناك|الموضح|المعروض|السابق)/u;
  return (action.test(text) && reference.test(text)) ||
    (arabicAction.test(text) && arabicReference.test(text));
}

export function isExplicitNewRequest(userText: string): boolean {
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

function capabilityContextFromExecutions(
  executions: readonly ToolExecutionSummary[] | undefined
): ConversationCapabilityContext | undefined {
  const toolsets = new Set<ToolsetName>();
  const connectors = new Map<string, NonNullable<ToolDefinition["connector"]>>();
  for (const execution of executions ?? []) {
    if (execution.result?.ok !== true) continue;
    for (const toolset of execution.tool?.toolsets ?? []) {
      if (CONTINUITY_TOOLSETS.has(toolset)) toolsets.add(toolset);
    }
    const connector = execution.tool?.connector;
    if (connector !== undefined) connectors.set(`${connector.kind}:${connector.id}`, connector);
  }
  return boundedCapabilityContext({
    toolsets: [...toolsets],
    connectors: [...connectors.values()]
  });
}

function mergeCapabilityContexts(
  previous: ConversationCapabilityContext | undefined,
  current: ConversationCapabilityContext | undefined
): ConversationCapabilityContext | undefined {
  return boundedCapabilityContext({
    toolsets: [...(previous?.toolsets ?? []), ...(current?.toolsets ?? [])],
    connectors: [...(previous?.connectors ?? []), ...(current?.connectors ?? [])]
  });
}

function sanitizeCapabilityContext(value: unknown): ConversationCapabilityContext | undefined {
  if (!isRecord(value)) return undefined;
  const toolsets = Array.isArray(value.toolsets)
    ? value.toolsets.flatMap((entry) => {
        const toolset = safeToolset(entry);
        return toolset === undefined ? [] : [toolset];
      })
    : [];
  const connectors = Array.isArray(value.connectors)
    ? value.connectors.flatMap((entry) => {
        if (!isRecord(entry) || entry.kind !== "mcp") return [];
        const id = safeConnectorId(entry.id);
        return id === undefined ? [] : [{ kind: "mcp" as const, id }];
      })
    : [];
  return boundedCapabilityContext({ toolsets, connectors });
}

function boundedCapabilityContext(input: ConversationCapabilityContext): ConversationCapabilityContext | undefined {
  const toolsets = [...new Set(input.toolsets.filter((entry) => CONTINUITY_TOOLSETS.has(entry)))]
    .slice(0, MAX_CONTINUITY_TOOLSETS);
  const connectors = [...new Map(input.connectors
    .filter((entry) => safeConnectorId(entry.id) !== undefined)
    .map((entry) => [`${entry.kind}:${entry.id}`, entry] as const)).values()]
    .slice(0, MAX_CONTINUITY_CONNECTORS);
  if (toolsets.length === 0 && connectors.length === 0) return undefined;
  return { toolsets, connectors };
}

function safeToolset(value: unknown): ToolsetName | undefined {
  return typeof value === "string" && CONTINUITY_TOOLSETS.has(value) ? value : undefined;
}

function safeConnectorId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(value)
    ? value
    : undefined;
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
