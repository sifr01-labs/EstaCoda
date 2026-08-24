import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import type { MCPServerSnapshot } from "../mcp/mcp-tools.js";
import type {
  OpenAICompatibleToolSchema,
  ProviderToolSchemaCatalog
} from "../tools/tool-schema.js";
import {
  isActionableToolRequest,
  selectToolSelectionPolicy,
  shouldIncludePlan
} from "./tool-selection-policies.js";

const CONTINUITY_TOOLSETS = new Set<ToolsetName>(["browser"]);
const RECOVERY_TOOL_NAMES = new Set([
  "browser.status",
  "config.mcp.status",
  "config.provider.status",
  "config.provider.execution_status"
]);
const EVIDENCE_GATED_TOOL_NAMES = new Set(["browser.vision"]);

export type ProviderToolExpansionCandidate = {
  toolName: string;
  source: "active-browser";
  schema: OpenAICompatibleToolSchema;
};

export type ProviderToolSelection = {
  initialTools: OpenAICompatibleToolSchema[];
  expansionCandidates: ProviderToolExpansionCandidate[];
  namedConnectorIds: string[];
};

export type ProviderToolContinuityContext = {
  userRequest?: string;
  toolsets?: readonly ToolsetName[];
  connectors?: readonly NonNullable<ToolDefinition["connector"]>[];
  activeBrowser?: boolean;
};

/** Returns only connectors explicitly named in an actionable current request. */
export function namedConnectorIdsForRequest(input: {
  tools: readonly ToolDefinition[];
  configuredConnectors?: readonly Pick<MCPServerSnapshot, "name">[];
  userText: string;
}): string[] {
  if (!isActionableToolRequest(input.userText)) return [];
  const normalizedUserText = normalizeConnectorSearchText(input.userText);
  const identities = new Map<string, { key: string; phrase: string; sourceId: string; id: string }>();
  const ambiguousKeys = new Set<string>();
  const connectors: NonNullable<ToolDefinition["connector"]>[] = [
    ...input.tools.flatMap((tool) => tool.connector === undefined ? [] : [tool.connector]),
    ...(input.configuredConnectors ?? []).map((connector) => ({ kind: "mcp" as const, id: connector.name }))
  ];
  for (const connector of connectors) {
    const key = connectorKey(connector);
    const phrase = normalizeConnectorText(connector.id);
    const sourceId = connector.id.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (!isDistinctiveConnectorPhrase(phrase)) continue;
    const existing = identities.get(key);
    if (existing !== undefined && existing.sourceId !== sourceId) ambiguousKeys.add(key);
    identities.set(key, { key, phrase, sourceId, id: connector.id });
  }
  return [...identities.values()]
    .filter((identity) =>
      !ambiguousKeys.has(identity.key) &&
      connectorReferenceState(normalizedUserText, identity.phrase) === "positive"
    )
    .map((identity) => identity.id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Narrows an already availability-filtered foreground catalog. It never adds a
 * tool that is absent from the catalog.
 */
export function narrowProviderToolsForTurn(input: {
  catalog: ProviderToolSchemaCatalog;
  intent: IntentRoute;
  userText?: string;
  selectedSkill?: LoadedSkill | SkillDefinition;
  attachments?: readonly ChannelAttachment[];
  continuity?: ProviderToolContinuityContext;
  configuredConnectors?: readonly MCPServerSnapshot[];
}): OpenAICompatibleToolSchema[] {
  return selectProviderToolsForTurn(input).initialTools;
}

export function selectProviderToolsForTurn(input: {
  catalog: ProviderToolSchemaCatalog;
  intent: IntentRoute;
  userText?: string;
  selectedSkill?: LoadedSkill | SkillDefinition;
  attachments?: readonly ChannelAttachment[];
  continuity?: ProviderToolContinuityContext;
  configuredConnectors?: readonly MCPServerSnapshot[];
}): ProviderToolSelection {
  const namedConnectors = selectNamedConnectors(input);
  const continuityToolsets = selectContinuityToolsets(input);
  const policy = selectToolSelectionPolicy({
    intent: input.intent,
    userText: input.userText,
    namedConnectorOperation: namedConnectors.size > 0,
    selectedSkill: input.selectedSkill !== undefined,
    readyAttachments: (input.attachments ?? []).some((attachment) => (attachment.status ?? "ready") === "ready")
  });
  const policyToolsets = new Set(policy.toolsets);
  const policyRiskClasses = new Set(policy.allowedRiskClasses);
  const routedToolsets = new Set<ToolsetName>([
    ...input.intent.suggestedToolsets,
    ...continuityToolsets,
    ...(input.selectedSkill?.requiredToolsets ?? []),
    ...(input.selectedSkill?.optionalToolsets ?? [])
  ]);
  const attachedToolsets = new Set(attachmentToolsets(input.attachments));
  const includePlan = shouldIncludePlan({
    policy,
    userText: input.userText,
    selectedSkillPlaybookSteps: input.selectedSkill?.playbook.length
  });
  const actionable = isActionableToolRequest(input.userText ?? "") && (
    policy.name !== "conversation" ||
    input.selectedSkill !== undefined ||
    (input.attachments ?? []).some((attachment) => (attachment.status ?? "ready") === "ready")
  );
  const initialTools: OpenAICompatibleToolSchema[] = [];
  const expansionCandidates: ProviderToolExpansionCandidate[] = [];

  for (const entry of input.catalog.entries) {
    const selected = (() => {
      if (entry.tool.name === "plan") return includePlan;
      if (entry.tool.connector !== undefined) {
        return namedConnectors.has(connectorKey(entry.tool.connector));
      }
      if (actionable && RECOVERY_TOOL_NAMES.has(entry.tool.name)) return true;
      if (entry.tool.toolsets.some((toolset) => routedToolsets.has(toolset))) return true;
      if (
        entry.tool.toolsets.some((toolset) => attachedToolsets.has(toolset)) &&
        (entry.tool.riskClass === "read-only-local" || entry.tool.riskClass === "read-only-network")
      ) return true;
      return policyRiskClasses.has(entry.tool.riskClass) &&
        entry.tool.toolsets.some((toolset) => policyToolsets.has(toolset));
    })();
    if (!selected) continue;
    if (
      actionable &&
      continuityToolsets.has("browser") &&
      EVIDENCE_GATED_TOOL_NAMES.has(entry.tool.name)
    ) {
      expansionCandidates.push({
        toolName: entry.tool.name,
        source: "active-browser",
        schema: entry.schema
      });
      continue;
    }
    initialTools.push(entry.schema);
  }

  return {
    initialTools,
    expansionCandidates,
    namedConnectorIds: [...namedConnectors]
      .map((key) => input.configuredConnectors?.find((connector) => connectorKey({ kind: "mcp", id: connector.name }) === key)?.name ??
        input.catalog.entries.find((entry) => entry.tool.connector !== undefined && connectorKey(entry.tool.connector) === key)?.tool.connector?.id)
      .filter((id): id is string => id !== undefined)
      .sort((left, right) => left.localeCompare(right))
  };
}

function selectNamedConnectors(input: {
  catalog: ProviderToolSchemaCatalog;
  userText?: string;
  continuity?: ProviderToolContinuityContext;
  configuredConnectors?: readonly MCPServerSnapshot[];
}): Set<string> {
  const normalizedUserText = normalizeConnectorSearchText(input.userText ?? "");
  const normalizedContinuationText = normalizeConnectorSearchText(input.continuity?.userRequest ?? "");
  const currentRequestIsActionable = isActionableToolRequest(input.userText ?? "");
  const continuedConnectorKeys = new Set((input.continuity?.connectors ?? []).map(connectorKey));
  const identities = new Map<string, { key: string; phrase: string; sourceId: string }>();
  const ambiguousKeys = new Set<string>();
  const connectors: NonNullable<ToolDefinition["connector"]>[] = [
    ...input.catalog.entries.flatMap((entry) => entry.tool.connector === undefined ? [] : [entry.tool.connector]),
    ...(input.configuredConnectors ?? []).map((connector) => ({ kind: "mcp" as const, id: connector.name }))
  ];
  for (const connector of connectors) {
    const key = connectorKey(connector);
    const phrase = normalizeConnectorText(connector.id);
    const sourceId = connector.id.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (!isDistinctiveConnectorPhrase(phrase)) continue;
    const existing = identities.get(key);
    if (existing !== undefined && existing.sourceId !== sourceId) {
      ambiguousKeys.add(key);
    }
    identities.set(key, { key, phrase, sourceId });
  }

  const matched = new Set<string>();
  for (const identity of identities.values()) {
    if (ambiguousKeys.has(identity.key)) continue;
    const currentTurnReference = connectorReferenceState(normalizedUserText, identity.phrase);
    if (currentTurnReference === "positive" && currentRequestIsActionable) {
      matched.add(identity.key);
      continue;
    }
    if (currentTurnReference === "negative") continue;
    if (currentRequestIsActionable && (
      connectorReferenceState(normalizedContinuationText, identity.phrase) === "positive" ||
      continuedConnectorKeys.has(identity.key)
    )) {
      matched.add(identity.key);
    }
  }
  return matched;
}

function selectContinuityToolsets(input: {
  userText?: string;
  continuity?: ProviderToolContinuityContext;
}): Set<ToolsetName> {
  const selected = new Set((input.continuity?.toolsets ?? [])
    .filter((toolset) => CONTINUITY_TOOLSETS.has(toolset)));
  if (
    input.continuity?.activeBrowser === true &&
    isActionableToolRequest(input.userText ?? "")
  ) {
    selected.add("browser");
  }
  return selected;
}

function connectorKey(connector: NonNullable<ProviderToolSchemaCatalog["entries"][number]["tool"]["connector"]>): string {
  return `${connector.kind}:${normalizeConnectorText(connector.id)}`;
}

function normalizeConnectorText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizeConnectorSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    // Do not mistake a segment inside mcp.server.tool or a hostname for a
    // human reference to the configured connector.
    .replace(/(?<=[\p{L}\p{N}])[.:](?=[\p{L}\p{N}])/gu, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

const WEAK_CONNECTOR_PHRASES = new Set([
  "api",
  "app",
  "browser",
  "connector",
  "local",
  "mcp",
  "server",
  "tool",
  "web"
]);

function isDistinctiveConnectorPhrase(phrase: string): boolean {
  return phrase.length >= 4 && !WEAK_CONNECTOR_PHRASES.has(phrase);
}

function connectorReferenceState(text: string, phrase: string): "positive" | "negative" | "absent" {
  const haystack = ` ${text} `;
  const needle = ` ${phrase} `;
  let offset = haystack.indexOf(needle);
  let foundNegatedReference = false;
  while (offset >= 0) {
    const prefix = haystack.slice(Math.max(0, offset - 64), offset);
    if (!isNegatedConnectorPrefix(prefix)) return "positive";
    foundNegatedReference = true;
    offset = haystack.indexOf(needle, offset + needle.length);
  }
  return foundNegatedReference ? "negative" : "absent";
}

function isNegatedConnectorPrefix(prefix: string): boolean {
  return /(?:\b(?:not|without|except|avoid)(?:\s+the)?|\b(?:do not|don t|dont|never)(?:\s+(?:use|connect to|route to))?(?:\s+the)?|(?:لا تستخدم|بدون|تجنب))\s*$/u.test(prefix);
}

function attachmentToolsets(attachments: readonly ChannelAttachment[] | undefined): ToolsetName[] {
  const toolsets = new Set<ToolsetName>();
  for (const attachment of attachments ?? []) {
    if ((attachment.status ?? "ready") !== "ready") continue;
    switch (attachment.kind) {
      case "link":
        toolsets.add("web");
        break;
      case "image":
      case "audio":
      case "video":
      case "voice":
        toolsets.add("media");
        toolsets.add("files");
        break;
      case "document":
      case "file":
      case "unknown":
        toolsets.add("files");
        toolsets.add("media");
        break;
    }
  }
  return [...toolsets];
}
