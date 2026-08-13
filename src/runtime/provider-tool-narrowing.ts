import type { ChannelAttachment } from "../contracts/channel.js";
import type { ExecutionPlan } from "../contracts/execution-plan.js";
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
 * tool, and callers keep the returned inventory fixed for the complete turn.
 */
export function narrowProviderToolsForTurn(input: {
  catalog: ProviderToolSchemaCatalog;
  intent: IntentRoute;
  selectedSkill?: LoadedSkill | SkillDefinition;
  attachments?: readonly ChannelAttachment[];
  resumedExecutionPlan?: ExecutionPlan;
}): OpenAICompatibleToolSchema[] {
  if (input.intent.confidence < PROVIDER_TOOL_NARROWING_MIN_CONFIDENCE) {
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
  addExecutionPlanTools(includedTools, input.resumedExecutionPlan, input.catalog);

  return input.catalog.entries
    .filter((entry) =>
      includedTools.has(entry.tool.name) ||
      entry.tool.toolsets.some((toolset) => includedToolsets.has(toolset))
    )
    .map((entry) => entry.schema);
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

function addExecutionPlanTools(
  includedTools: Set<string>,
  plan: ExecutionPlan | undefined,
  catalog: ProviderToolSchemaCatalog
): void {
  if (plan === undefined) return;

  for (const item of plan.items) {
    for (const evidence of item.evidence ?? []) includedTools.add(evidence.tool);
  }

  const searchablePlanText = [
    plan.objective,
    ...plan.items.map((item) => item.content)
  ].join("\n");
  for (const entry of catalog.entries) {
    if (referencesCanonicalTool(searchablePlanText, entry.tool.name)) includedTools.add(entry.tool.name);
  }
}

function referencesCanonicalTool(text: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}($|[^A-Za-z0-9_.:-])`, "u").test(text);
}
