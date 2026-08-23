import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
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

export type ProviderToolContinuityContext = {
  userRequest?: string;
  toolsets?: readonly ToolsetName[];
  connectors?: readonly NonNullable<ToolDefinition["connector"]>[];
  activeBrowser?: boolean;
};

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
}): OpenAICompatibleToolSchema[] {
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

  return input.catalog.entries
    .filter((entry) => {
      if (entry.tool.name === "plan") return includePlan;
      if (entry.tool.connector !== undefined) {
        return namedConnectors.size > 0
          ? namedConnectors.has(connectorKey(entry.tool.connector))
          : entry.tool.toolsets.some((toolset) => routedToolsets.has(toolset));
      }
      if (entry.tool.toolsets.some((toolset) => routedToolsets.has(toolset))) return true;
      if (
        entry.tool.toolsets.some((toolset) => attachedToolsets.has(toolset)) &&
        (entry.tool.riskClass === "read-only-local" || entry.tool.riskClass === "read-only-network")
      ) return true;
      return policyRiskClasses.has(entry.tool.riskClass) &&
        entry.tool.toolsets.some((toolset) => policyToolsets.has(toolset));
    })
    .map((entry) => entry.schema);
}

function selectNamedConnectors(input: {
  catalog: ProviderToolSchemaCatalog;
  userText?: string;
  continuity?: ProviderToolContinuityContext;
}): Set<string> {
  const normalizedUserText = normalizeConnectorSearchText(input.userText ?? "");
  const normalizedContinuationText = normalizeConnectorSearchText(input.continuity?.userRequest ?? "");
  const currentRequestIsActionable = isActionableToolRequest(input.userText ?? "");
  const continuedConnectorKeys = new Set((input.continuity?.connectors ?? []).map(connectorKey));
  const identities = new Map<string, { key: string; phrase: string; sourceId: string }>();
  const ambiguousKeys = new Set<string>();
  for (const entry of input.catalog.entries) {
    const connector = entry.tool.connector;
    if (connector === undefined) continue;
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
    matchesActiveBrowserContinuation(input.userText ?? "")
  ) {
    selected.add("browser");
  }
  return selected;
}

function matchesActiveBrowserContinuation(userText: string): boolean {
  const normalized = userText.normalize("NFKC").toLocaleLowerCase("en-US");
  const action = /\b(?:click|press|open|select|scroll|switch|type|enter|fill|inspect|show|use)\b/iu;
  const surface = /\b(?:it|that|this|there|shown|above|page|screen|site|portal|app|button|link|tab|form)\b/iu;
  const arabicAction = /(?:انقر|اضغط|افتح|اختر|مرر|بد[ّ]?ل|اكتب|أدخل|افحص|استخدم)/u;
  const arabicSurface = /(?:هذا|هذه|ذلك|تلك|هناك|الموضح|المعروض|صفحة|شاشة|موقع|بوابة|تطبيق|زر|رابط|تبويب|نموذج)/u;
  return (action.test(normalized) && surface.test(normalized)) ||
    (arabicAction.test(normalized) && arabicSurface.test(normalized));
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
