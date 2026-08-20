import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";
import type {
  OpenAICompatibleToolSchema,
  ProviderToolSchemaCatalog
} from "../tools/tool-schema.js";

/** Matches the deterministic router's minimum primary-skill score. */
export const PROVIDER_TOOL_NARROWING_MIN_CONFIDENCE = 0.7;

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
}): OpenAICompatibleToolSchema[] {
  const namedConnectors = selectNamedConnectors(input);
  if (
    input.intent.confidence < PROVIDER_TOOL_NARROWING_MIN_CONFIDENCE &&
    namedConnectors.size === 0
  ) {
    return input.catalog.tools;
  }

  const includedToolsets = new Set<ToolsetName>([
    "core",
    ...input.intent.suggestedToolsets,
    ...(input.selectedSkill?.requiredToolsets ?? []),
    ...(input.selectedSkill?.optionalToolsets ?? []),
    ...attachmentToolsets(input.attachments)
  ]);
  const includedTools = new Set<string>(["plan"]);

  return input.catalog.entries
    .filter((entry) =>
      includedTools.has(entry.tool.name) ||
      (entry.tool.connector !== undefined && namedConnectors.size > 0
        ? namedConnectors.has(connectorKey(entry.tool.connector))
        : entry.tool.toolsets.some((toolset) => includedToolsets.has(toolset)))
    )
    .map((entry) => entry.schema);
}

function selectNamedConnectors(input: {
  catalog: ProviderToolSchemaCatalog;
  userText?: string;
}): Set<string> {
  if ((input.userText?.trim().length ?? 0) === 0) return new Set();

  const normalizedUserText = normalizeConnectorSearchText(input.userText ?? "");
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
    if (currentTurnReference === "positive") {
      matched.add(identity.key);
    }
  }
  return matched;
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
