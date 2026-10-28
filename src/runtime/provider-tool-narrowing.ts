import type { CapabilitySelectionDiagnostics, CapabilityOmissionReason } from "../contracts/runtime-event.js";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import type { MCPServerSnapshot } from "../mcp/mcp-tools.js";
import { CAPABILITY_RECOVERY_TOOLS } from "../tools/capability-tools.js";
import { explicitInspectionTools, requiredRequestTools } from "./request-requirements.js";
import {
  budgetProviderTools,
  type OpenAICompatibleToolSchema,
  type ProviderToolSchemaCatalog
} from "../tools/tool-schema.js";
import {
  CORE_WORKING_TOOLS,
  isToolExplicitlyProhibited,
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
const API_INTEGRATION_SKILL_NAME = "api-integration";
const API_INTEGRATION_NON_CONNECTOR_TOOL_NAMES = new Set([
  "browser.status",
  "browser.snapshot",
  "browser.find",
  "browser.click",
  "browser.type",
  "browser.fill_protected_form",
  "browser.select",
  "browser.extract",
  "browser.scroll",
  "browser.press",
  "browser.back",
  "browser.tabs",
  "browser.switch_tab",
  "browser.download",
  "browser.vision",
  "browser.dialog",
  "browser.navigate"
]);

export type ProviderToolExpansionCandidate = {
  toolName: string;
  source: "active-browser";
  schema: OpenAICompatibleToolSchema;
};

export type ProviderToolSelection = {
  initialTools: OpenAICompatibleToolSchema[];
  expansionCandidates: ProviderToolExpansionCandidate[];
  namedConnectorIds: string[];
  policy?: string;
  budgetOmittedTools?: string[];
  stagedTools?: string[];
  capabilityRouting?: import("../contracts/routing.js").CapabilityRoutingDecision;
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
  /** Host-owned Step prerequisites, never parsed from message metadata. */
  requiredTools?: readonly string[];
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
  /** Host-owned Step prerequisites, never parsed from message metadata. */
  requiredTools?: readonly string[];
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
  const exactRequestTools = new Set([...(input.requiredTools ?? []), ...requiredRequestTools(input.intent.requestRequirements), ...explicitInspectionTools(input.userText ?? "")]);
  const policyRiskClasses = new Set(policy.allowedRiskClasses);
  const routedToolsets = new Set<ToolsetName>([
    ...input.intent.suggestedToolsets,
    ...continuityToolsets,
    ...(input.selectedSkill?.requiredToolsets ?? []),
    // Literature discovery is web-first. Scripts and other optional execution
    // toolsets are not needed merely to read papers or deliver a report.
    ...(input.selectedSkill?.routing?.labels?.includes("research.discovery") ? [] : input.selectedSkill?.optionalToolsets ?? [])
  ]);
  const attachedToolsets = new Set(attachmentToolsets(input.attachments));
  const apiIntegrationProfile = input.selectedSkill?.name === API_INTEGRATION_SKILL_NAME;
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
  const recoveryNames = new Set<string>(CAPABILITY_RECOVERY_TOOLS);
  const initialTools: OpenAICompatibleToolSchema[] = [];
  const expansionCandidates: ProviderToolExpansionCandidate[] = [];

  for (const entry of input.catalog.entries) {
    if (isToolExplicitlyProhibited(entry.tool, input.userText ?? "")) continue;
    const selected = (() => {
      if (entry.tool.name === "config.provider.execution_status") return true;
      if (CORE_WORKING_TOOLS.has(entry.tool.name)) return true;
      if (entry.tool.name === "plan") return includePlan;
      if (entry.tool.connector !== undefined) {
        return namedConnectors.has(connectorKey(entry.tool.connector));
      }
      if (exactRequestTools.has(entry.tool.name)) return true;
      if (actionable && RECOVERY_TOOL_NAMES.has(entry.tool.name)) return true;
      if (
        entry.tool.toolsets.some((toolset) => attachedToolsets.has(toolset)) &&
        (entry.tool.riskClass === "read-only-local" || entry.tool.riskClass === "read-only-network")
      ) return true;
      if (apiIntegrationProfile) {
        return API_INTEGRATION_NON_CONNECTOR_TOOL_NAMES.has(entry.tool.name);
      }
      if (entry.tool.toolsets.some((toolset) => routedToolsets.has(toolset))) return true;
      return policyRiskClasses.has(entry.tool.riskClass) &&
        entry.tool.toolsets.some((toolset) => policyToolsets.has(toolset));
    })();
    if (!selected) continue;
    if (
      actionable &&
      (apiIntegrationProfile || continuityToolsets.has("browser")) &&
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

  // A selected shell must include the controls needed to observe/stop a yielded
  // command. Catalog membership still enforces capability availability; every
  // invocation retains its own authorization and hardline checks.
  const processCompanions = new Set<string>();
  if (initialTools.some(schema => schema.function.name === "terminal_run" || schema.function.name === "process_start")) {
    for (const entry of input.catalog.entries) {
      if (!["process.start", "process.list", "process.logs", "process.stop"].includes(entry.tool.name) || isToolExplicitlyProhibited(entry.tool, input.userText ?? "")) continue;
      processCompanions.add(entry.schema.function.name);
      if (!initialTools.includes(entry.schema)) initialTools.push(entry.schema);
    }
    if (processCompanions.size > 0 && initialTools.some(schema => schema.function.name === "terminal_run")) processCompanions.add("terminal_run");
  }
  // Reserve discovery first, then the core working set before optional routing.
  initialTools.sort((a, b) => {
    const rank = (name: string) => recoveryNames.has(name) ? 2 : CORE_WORKING_TOOLS.has(name) ? 1 : 0;
    return rank(input.catalog.aliases.get(b.function.name) ?? b.function.name) - rank(input.catalog.aliases.get(a.function.name) ?? a.function.name);
  });
  const budget = budgetProviderTools({
    tools: initialTools,
    priorityNames: new Set([...processCompanions, ...input.catalog.entries.filter((entry) => entry.tool.name === "config.provider.execution_status" || exactRequestTools.has(entry.tool.name) || CORE_WORKING_TOOLS.has(entry.tool.name)).map((entry) => entry.schema.function.name)])
  });
  return {
    initialTools: budget.tools,
    policy: policy.name,
    budgetOmittedTools: budget.omitted,
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


/** Metadata-only diagnostics. No descriptions, schemas, paths or routing text. */
export function describeCapabilitySelection(input: {
  catalog: ProviderToolSchemaCatalog;
  exposedTools: readonly OpenAICompatibleToolSchema[];
  selection: Pick<ProviderToolSelection, "policy" | "budgetOmittedTools" | "expansionCandidates" | "capabilityRouting">;
  requirements?: IntentRoute["requestRequirements"];
  providerSupportsTools?: boolean;
}): CapabilitySelectionDiagnostics {
  const exposed = new Set(input.exposedTools.map((schema) => input.catalog.aliases.get(schema.function.name) ?? schema.function.name));
  const budgetOmitted = new Set((input.selection.budgetOmittedTools ?? []).map((name) => input.catalog.aliases.get(name) ?? name));
  const evidenceRequired = new Set(input.selection.expansionCandidates.map((candidate) => candidate.toolName));
  const reasons = new Map<string, CapabilityOmissionReason>();
  const omissionCounts: Record<CapabilityOmissionReason, number> = {
    not_selected: 0, schema_budget: 0, temporarily_unavailable: 0,
    provider_schema_restricted: 0, evidence_required: 0, not_in_session: 0
  };
  for (const tool of input.catalog.inventory) {
    if (exposed.has(tool.name)) continue;
    const reason: CapabilityOmissionReason = tool.availability === "temporarily_unavailable" ? "temporarily_unavailable"
      : !tool.schemaEligible || input.providerSupportsTools === false ? "provider_schema_restricted"
      : budgetOmitted.has(tool.name) ? "schema_budget"
      : evidenceRequired.has(tool.name) ? "evidence_required" : "not_selected";
    reasons.set(tool.name, reason);
    omissionCounts[reason]++;
  }
  // Requirements are finite runtime-owned IDs. Missing/forbidden IDs have the
  // same reason; never consult an unrestricted registry to distinguish them.
  const requestedOmissions = requiredRequestTools(input.requirements).filter((name) => !exposed.has(name))
    .map((tool) => ({ tool, reason: reasons.get(tool) ?? "not_in_session" as const }));
  const requested = new Set(requestedOmissions.map((entry) => entry.tool));
  const omissions = [...reasons].sort(([a], [b]) => Number(requested.has(b)) - Number(requested.has(a)))
    .slice(0, 32).map(([tool, reason]) => ({ tool: diagnosticToolId(tool), reason }));
  return {
    policy: input.selection.policy ?? "session-default",
    routing: input.selection.capabilityRouting,
    catalogCount: input.catalog.inventory.length,
    availableCount: input.catalog.inventory.filter((tool) => tool.availability === "available").length,
    schemaEligibleCount: input.catalog.entries.length,
    selectedCount: input.exposedTools.length,
    omissionCounts, omissions, omittedDetailsCount: Math.max(0, reasons.size - omissions.length), requestedOmissions
  };
}

function diagnosticToolId(name: string): string {
  return /^[a-zA-Z0-9_.:-]{1,128}$/u.test(name) ? name : "[redacted-tool-id]";
}
