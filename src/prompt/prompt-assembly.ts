import type { ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryProviderContext } from "../contracts/memory.js";
import type { PromptBudgetReport, PromptLayerName, PromptLayerReport } from "../contracts/prompt.js";
import type { ModelProfile, ProviderMessage } from "../contracts/provider.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { LoadedSkill, SkillCatalogEntry, SkillDefinition, SkillResourceEntry } from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import { compileSkillWorkflowPlan, renderSkillWorkflowPlan } from "../skills/skill-workflow-planner.js";
import { packetizeToolExecution, packetizeToolResult, renderToolResultPacket } from "../tools/tool-result-packet.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { PromptCache } from "./prompt-cache.js";

export type ProviderPromptAssembly = {
  messages: ProviderMessage[];
  budget: PromptBudgetReport;
};

export type ProviderPromptInput = {
  model?: ModelProfile;
  cache?: PromptCache;
  sessionHistory?: Array<Pick<ProviderMessage, "role" | "content">>;
  soul?: string;
  frozenMemory?: {
    user?: string;
    memory?: string;
  };
  skillsIndex?: SkillCatalogEntry[];
  userText: string;
  routedText: string;
  selectedSkill: LoadedSkill | SkillDefinition | undefined;
  selectedSkillInstructions: string | undefined;
  attachments?: ChannelAttachment[];
  selectedSkillSetup?: {
    skillDirectory?: string;
    requiredEnvironmentVariables: Array<{ name: string; present: boolean }>;
    requiredCredentialFiles: Array<{ path: string; present: boolean; resolvedPath?: string }>;
    configFields: Array<{
      key: string;
      description?: string;
      required?: boolean;
      value?: unknown;
      source: "config" | "default" | "missing";
    }>;
  };
  selectedSkillResources?: SkillResourceEntry[];
  intent: IntentRoute;
  securityDecision: SecurityDecision;
  toolExecutions: ToolExecutionRecord[];
  context: ContextExpansionResult | undefined;
  projectContext: ProjectContextSnapshot | undefined;
  memoryContext: MemoryProviderContext | undefined;
  providerTools?: OpenAICompatibleToolSchema[];
  fallbackText: string;
};

export type ProviderContinuationPromptInput = ProviderPromptInput & {
  providerExecution: ProviderExecutionResult | undefined;
  toolPlans: ToolCallPlan[];
};

export function assembleProviderPrompt(input: ProviderPromptInput): ProviderPromptAssembly {
  const contextWindowTokens = input.model?.contextWindowTokens ?? 128_000;
  const budgetTarget = Math.max(4_000, Math.floor(contextWindowTokens * 0.65));
  const layers = applyCache(input.cache, fitLayersToBudget(buildBaseLayers(input), budgetTarget));
  const messages = renderBaseMessages(layers);
  const budget = buildBudgetReport({
    model: input.model?.id ?? "unconfigured",
    contextWindowTokens,
    targetTokens: budgetTarget,
    layers
  });

  return {
    messages,
    budget
  };
}

export function assembleProviderContinuationPrompt(input: ProviderContinuationPromptInput): ProviderPromptAssembly {
  const contextWindowTokens = input.model?.contextWindowTokens ?? 128_000;
  const budgetTarget = Math.max(4_000, Math.floor(contextWindowTokens * 0.65));
  const baseLayers = applyCache(input.cache, fitLayersToBudget(buildBaseLayers(input), Math.floor(budgetTarget * 0.85)));
  const baseMessages = renderBaseMessages(baseLayers);
  const baseBudget = buildBudgetReport({
    model: input.model?.id ?? "unconfigured",
    contextWindowTokens,
    targetTokens: budgetTarget,
    layers: baseLayers
  });
  const executedPlans = input.toolPlans.filter((plan) => plan.status === "executed");
  const unresolvedPlans = input.toolPlans.filter((plan) =>
    plan.status === "invalid" || plan.status === "unavailable" || plan.status === "blocked"
  );
  const toolResults = executedPlans
    .map((plan) => [
      `Tool: ${plan.tool}`,
      `Call id: ${plan.id}`,
      renderToolResultPacket(packetizeToolResult({
        tool: plan.tool,
        result: plan.result,
        maxChars: 1_800
      }))
    ].join("\n"))
    .join("\n\n");
  const toolPlanFeedback = unresolvedPlans
    .map((plan) => [
      `Tool call failed: ${plan.tool || "unknown"}`,
      `Call id: ${plan.id}`,
      `Status: ${plan.status}`,
      `Error: ${plan.error ?? "No error details were provided."}`,
      "Use the available tool schemas and try again if another tool call is needed."
    ].join("\n"))
    .join("\n\n");
  const continuationContent = [
    unresolvedPlans.length > 0
      ? "EstaCoda could not execute one or more requested tool calls. Use the feedback below to correct the tool call or choose an available tool."
      : "EstaCoda executed the requested tools. Use these results to produce the final answer now.",
    "Do not ask the user to run these tools again.",
    "",
    `Executed tool results:\n${toolResults || "No executed tool results were available."}`,
    "",
    `Tool call feedback:\n${toolPlanFeedback || "No tool-call errors were recorded."}`
  ].join("\n");
  const continuationLayer = layer({
    name: "provider-continuation",
    content: continuationContent,
    cacheable: false,
    truncated: false,
    protectedLayer: true,
    priority: 0
  });
  const fittedLayers = applyCache(input.cache, fitLayersToBudget([
    ...baseLayers,
    continuationLayer
  ], budgetTarget));
  const messages: ProviderMessage[] = [
    ...baseMessages,
    {
      role: "assistant",
      content: input.providerExecution?.response?.content.trim().length
        ? input.providerExecution.response.content
        : "I requested tools and am waiting for EstaCoda to provide their results."
    },
    {
      role: "user",
      content: continuationContent
    }
  ];
  const budget = buildBudgetReport({
    model: input.model?.id ?? "unconfigured",
    contextWindowTokens,
    targetTokens: budgetTarget,
    layers: fittedLayers
  });

  return {
    messages,
    budget: mergeBudgetWarnings(budget, baseBudget)
  };
}

type InternalPromptLayer = PromptLayerReport & {
  content: string;
};

function buildBaseLayers(input: ProviderPromptInput): InternalPromptLayer[] {
  const toolSummary = input.toolExecutions.length === 0
    ? "No tools were executed before this response."
    : input.toolExecutions
        .map((execution) => renderToolResultPacket(packetizeToolExecution({
          execution,
          maxChars: 1_400
        })))
        .join("\n\n");
  const artifactSummary = renderArtifactSummary(artifactsFromExecutions(input.toolExecutions));
  const contextBlocks = input.context?.blocks
    .filter((block) => block.content.length > 0)
    .map((block) => `Source: ${block.source}\n${truncate(block.content, 2_000)}`)
    .join("\n\n") ?? "No explicit context references were loaded.";
  const projectContext = input.projectContext?.files.length === 0 || input.projectContext === undefined
    ? "No project context files were loaded."
    : input.projectContext.files
        .map((file) => `Source: ${file.source}\n${truncate(file.content, 1_500)}`)
        .join("\n\n");
  const memoryContext = input.memoryContext?.text.trim().length
    ? truncate(input.memoryContext.text, 5_000)
    : "No memory provider context was loaded.";
  const skillInstructions = input.selectedSkillInstructions === undefined
    ? "No skill instruction body was loaded."
    : truncate(input.selectedSkillInstructions, 4_000);
  const skillSetup = renderSkillSetup(input.selectedSkillSetup);
  const skillResources = renderSkillResources(input.selectedSkillResources);
  const skillWorkflowPlan = input.selectedSkill === undefined
    ? "No skill workflow plan was selected."
    : renderSkillWorkflowPlan(compileSkillWorkflowPlan(input.selectedSkill));
  const toolMenu = input.providerTools === undefined || input.providerTools.length === 0
    ? "No native provider tools were exposed for this route."
    : input.providerTools
        .map((tool) => `${tool.function.name}: ${tool.function.description}`)
        .join("\n");
  const attachmentManifest = renderChannelAttachments(input.attachments);
  const identity = input.soul?.trim().length
    ? input.soul.trim()
    : defaultIdentity();

  return [
    layer({
      name: "identity",
      cacheable: true,
      protectedLayer: true,
      priority: 0,
      content: identity
    }),
    layer({
      name: "frozen-memory",
      cacheable: true,
      priority: 2,
      content: renderFrozenMemory(input.frozenMemory)
    }),
    layer({
      name: "skills-index",
      cacheable: true,
      protectedLayer: true,
      priority: 1,
      content: renderSkillsIndex(input.skillsIndex)
    }),
    layer({
      name: "session-history",
      cacheable: false,
      priority: 4,
      content: renderSessionHistory(input.sessionHistory)
    }),
    layer({
      name: "user-message",
      cacheable: false,
      protectedLayer: true,
      priority: 0,
      content: [
        `User message:\n${input.userText}`,
        "",
        `Expanded/routed message:\n${input.routedText}`
      ].join("\n")
    }),
    layer({
      name: "channel-attachments",
      cacheable: false,
      protectedLayer: true,
      priority: 1,
      content: `Channel attachments:\n${attachmentManifest}`
    }),
    layer({
      name: "intent",
      cacheable: false,
      protectedLayer: true,
      priority: 1,
      content: [
        `Intent labels: ${input.intent.labels.join(", ")}`,
        `Intent confidence: ${Math.round(input.intent.confidence * 100)}%`,
        `Suggested toolsets: ${input.intent.suggestedToolsets.join(", ") || "none"}`,
        `Selected skill: ${input.selectedSkill?.name ?? "none"}`,
        `Security decision: ${input.securityDecision}`
      ].join("\n")
    }),
    layer({
      name: "skill",
      cacheable: input.selectedSkillInstructions !== undefined,
      protectedLayer: true,
      priority: 2,
      content: [
        `Skill instructions:\n${skillInstructions}`,
        "",
        `Skill workflow plan:\n${skillWorkflowPlan}`
      ].join("\n"),
      truncated: input.selectedSkillInstructions !== undefined && input.selectedSkillInstructions.length > skillInstructions.length
    }),
    layer({
      name: "skill-setup",
      cacheable: false,
      priority: 3,
      content: `Skill setup:\n${skillSetup}`
    }),
    layer({
      name: "skill-resources",
      cacheable: true,
      priority: 3,
      content: `Skill resources:\n${skillResources}`
    }),
    layer({
      name: "context-references",
      cacheable: false,
      priority: 5,
      content: `Context references:\n${contextBlocks}`,
      truncated: input.context?.blocks.some((block) => block.status === "truncated") ?? false
    }),
    layer({
      name: "project-context",
      cacheable: true,
      priority: 4,
      content: `Project context:\n${projectContext}`,
      truncated: input.projectContext?.files.some((file) => file.status === "truncated") ?? false
    }),
    layer({
      name: "memory",
      cacheable: false,
      priority: 3,
      content: `Memory provider context:\n${memoryContext}`,
      truncated: input.memoryContext?.text !== undefined && input.memoryContext.text.length > memoryContext.length
    }),
    layer({
      name: "native-tools",
      cacheable: true,
      protectedLayer: true,
      priority: 1,
      content: `Available native tool names:\n${toolMenu}`
    }),
    layer({
      name: "tool-results",
      cacheable: false,
      priority: 6,
      content: `Tool results:\n${toolSummary}`,
      truncated: input.toolExecutions.some((execution) => {
        const result = execution.result?.content;
        return result !== undefined && result.length > execution.tool.maxResultSizeChars;
      })
    }),
    layer({
      name: "artifacts",
      cacheable: false,
      priority: 3,
      content: `Artifacts:\n${artifactSummary}`
    }),
    layer({
      name: "fallback",
      cacheable: false,
      priority: 7,
      content: `Deterministic fallback response if model cannot improve it:\n${input.fallbackText}`
    })
  ];
}

function renderChannelAttachments(attachments: ChannelAttachment[] | undefined): string {
  if (attachments === undefined || attachments.length === 0) {
    return "No channel attachments were supplied with this turn.";
  }

  return attachments.map((attachment) => {
    const suggestedTools = attachment.status !== undefined && attachment.status !== "ready"
      ? []
      : suggestedToolsForAttachment(attachment);
    const parts = [
      `id=${attachment.id}`,
      `kind=${attachment.kind}`,
      attachment.status === undefined ? undefined : `status=${attachment.status}`,
      attachment.originalName ?? attachment.name,
      attachment.mimeType === undefined ? undefined : `mime=${attachment.mimeType}`,
      attachment.bytes === undefined ? undefined : `bytes=${attachment.bytes}`,
      attachment.localPath === undefined && attachment.path === undefined ? undefined : `local_ref=${attachment.localPath ?? attachment.path}`,
      attachment.remoteUrl === undefined && attachment.url === undefined ? undefined : `remote_ref=${attachment.remoteUrl ?? attachment.url}`,
      attachment.failureCode === undefined ? undefined : `failure=${attachment.failureCode}`,
      attachment.failureMessage === undefined ? undefined : `note=${attachment.failureMessage}`,
      suggestedTools.length === 0 ? undefined : `suggested_tools=${suggestedTools.join(", ")}`
    ].filter((value) => value !== undefined && value !== "");
    return `- ${parts.join(" · ")}`;
  }).join("\n");
}

function suggestedToolsForAttachment(attachment: ChannelAttachment): string[] {
  if (attachment.kind === "image") {
    return ["vision.analyze", "media.inspect"];
  }

  if (attachment.kind === "document") {
    return ["document.probe"];
  }

  if (attachment.kind === "video") {
    return ["media.inspect", "media.extract-frame"];
  }

  if (attachment.kind === "audio" || attachment.kind === "voice") {
    return ["media.inspect"];
  }

  return ["document.probe"];
}

function renderSkillResources(resources: SkillResourceEntry[] | undefined): string {
  if (resources === undefined || resources.length === 0) {
    return "No additional skill-local references, templates, scripts, or assets were indexed.";
  }

  const grouped = new Map<string, SkillResourceEntry[]>();
  for (const resource of resources) {
    const bucket = grouped.get(resource.kind) ?? [];
    bucket.push(resource);
    grouped.set(resource.kind, bucket);
  }

  const sections = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, entries]) => [
      `${kind}:`,
      ...entries.map((entry) => {
        const labels = [
          entry.path,
          entry.bytes === undefined ? undefined : `${entry.bytes} bytes`,
          entry.declared === true ? "declared" : undefined
        ].filter((value) => value !== undefined);
        return `- ${labels.join(" · ")}`;
      })
    ].join("\n"));

  return [
    ...sections,
    "",
    "Resource handling:",
    "- references: load targeted background files with skill.view when the workflow needs specific context.",
    "- templates: load the template with skill.view, adapt it, then write the finished output with file.write or file.replace.",
    "- scripts: inspect the script with skill.view before running it through terminal.run or execute_code under normal sandbox rules.",
    "- assets: use skill.view for metadata, then route the file through media/document/browser tools if content inspection is needed.",
    "",
    "Load only the file you need with the skill.view tool using the selected skill name and a specific path."
  ].join("\n");
}

function renderSkillSetup(input: ProviderPromptInput["selectedSkillSetup"]): string {
  if (input === undefined) {
    return "No selected skill setup was loaded.";
  }

  const envLines = input.requiredEnvironmentVariables.length === 0
    ? ["No required environment variables declared."]
    : input.requiredEnvironmentVariables.map((entry) => `- ${entry.name}: ${entry.present ? "present" : "missing"}`);
  const configLines = input.configFields.length === 0
    ? ["No skill config fields declared."]
    : input.configFields.map((field) => {
      const labels = [
        field.key,
        field.source,
        field.required === true ? "required" : undefined,
        field.description,
        field.value === undefined ? undefined : `value=${JSON.stringify(field.value)}`
      ].filter((value) => value !== undefined);
      return `- ${labels.join(" · ")}`;
    });

  const credentialLines = input.requiredCredentialFiles.length === 0
    ? ["No required credential files declared."]
    : input.requiredCredentialFiles.map((entry) =>
        entry.present === true && typeof entry.resolvedPath === "string"
          ? `- ${entry.path}: present at ${entry.resolvedPath}`
          : `- ${entry.path}: ${entry.present ? "present" : "missing"}`
      );
  const runtimeLines = input.skillDirectory === undefined
    ? ["No selected skill directory was available."]
    : [
        `- skill_dir=${input.skillDirectory}`,
        "- Use skill_dir as the base path for skill-local references, templates, scripts, and assets when calling terminal.run or execute_code.",
        "- Credential files marked present above are available at their exact resolved paths; use them by path if the skill workflow needs them, and never print their contents."
      ];

  return [
    "Runtime:",
    ...runtimeLines,
    "",
    "Environment:",
    ...envLines,
    "",
    "Credential files:",
    ...credentialLines,
    "",
    "Config:",
    ...configLines
  ].join("\n");
}

function renderBaseMessages(layers: InternalPromptLayer[]): ProviderMessage[] {
  const identity = layers.find((candidate) => candidate.name === "identity");
  const cachedSystemLayers = layers.filter((candidate) =>
    candidate.name !== "identity" &&
    candidate.cacheable &&
    candidate.name !== "skill"
  );
  const ephemeralLayers = layers.filter((candidate) =>
    candidate.name !== "identity" &&
    !cachedSystemLayers.some((cached) => cached.name === candidate.name)
  );

  return [
    {
      role: "system",
      content: [
        "§ CACHED IDENTITY",
        identity?.content ?? "",
        "",
        "§ CACHED SYSTEM CONTEXT",
        ...cachedSystemLayers.map((candidate) => candidate.content)
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "§ EPHEMERAL REQUEST CONTEXT",
        ...ephemeralLayers.map((candidate) => candidate.content)
      ].join("\n\n")
    }
  ];
}

function layer(input: {
  name: PromptLayerName;
  content: string;
  cacheable: boolean;
  truncated?: boolean;
  compressed?: boolean;
  protectedLayer?: boolean;
  priority?: number;
}): InternalPromptLayer {
  return {
    name: input.name,
    content: input.content,
    chars: input.content.length,
    estimatedTokens: estimateTokens(input.content),
    cacheable: input.cacheable,
    truncated: input.truncated ?? false,
    compressed: input.compressed ?? false,
    protected: input.protectedLayer ?? false,
    priority: input.priority ?? 5,
    cacheKey: input.cacheable ? cacheKey(input.name, input.content) : undefined,
    cacheStatus: input.cacheable ? "miss" : "uncacheable"
  };
}

function applyCache(cache: PromptCache | undefined, layers: InternalPromptLayer[]): InternalPromptLayer[] {
  return layers.map((candidate) => {
    if (!candidate.cacheable || candidate.cacheKey === undefined) {
      return {
        ...candidate,
        cacheStatus: "uncacheable"
      };
    }

    return {
      ...candidate,
      cacheStatus: cache?.check({
        key: candidate.cacheKey,
        chars: candidate.chars,
        estimatedTokens: candidate.estimatedTokens
      }) ?? "miss"
    };
  });
}

function fitLayersToBudget(layers: InternalPromptLayer[], targetTokens: number): InternalPromptLayer[] {
  let fitted = layers.map((candidate) => ({ ...candidate }));
  let total = sumTokens(fitted);

  if (total <= targetTokens) {
    return fitted;
  }

  for (const layerToCompress of [...fitted]
    .filter((candidate) => !candidate.protected)
    .sort((left, right) => right.priority - left.priority || right.estimatedTokens - left.estimatedTokens)) {
    if (total <= targetTokens) {
      break;
    }

    const current = fitted.find((candidate) => candidate.name === layerToCompress.name);
    if (current === undefined) {
      continue;
    }

    const neededReduction = total - targetTokens;
    const targetChars = Math.max(400, current.chars - neededReduction * 4);
    const compressed = compressLayer(current, targetChars);

    fitted = fitted.map((candidate) => candidate.name === current.name ? compressed : candidate);
    total = sumTokens(fitted);
  }

  return fitted;
}

function compressLayer(layerToCompress: InternalPromptLayer, targetChars: number): InternalPromptLayer {
  if (layerToCompress.content.length <= targetChars) {
    return layerToCompress;
  }

  const headChars = Math.max(180, Math.floor(targetChars * 0.62));
  const tailChars = Math.max(120, targetChars - headChars - 180);
  const omittedChars = Math.max(0, layerToCompress.content.length - headChars - tailChars);
  const content = [
    layerToCompress.content.slice(0, headChars).trimEnd(),
    "",
    `[compressed ${omittedChars} chars from ${layerToCompress.name}; preserved head and tail]`,
    "",
    layerToCompress.content.slice(-tailChars).trimStart()
  ].join("\n");

  return {
    ...layerToCompress,
    content,
    chars: content.length,
    estimatedTokens: estimateTokens(content),
    compressed: true,
    truncated: true
  };
}

function sumTokens(layers: InternalPromptLayer[]): number {
  return layers.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0);
}

function buildBudgetReport(input: {
  model: string;
  contextWindowTokens: number;
  targetTokens: number;
  layers: Array<PromptLayerReport | InternalPromptLayer>;
}): PromptBudgetReport {
  const estimatedTokens = input.layers.reduce((sum, layer) => sum + layer.estimatedTokens, 0);
  const remainingTokens = Math.max(0, input.targetTokens - estimatedTokens);
  const warnings = [
    estimatedTokens > input.targetTokens
      ? `Prompt estimate ${estimatedTokens} tokens exceeds target ${input.targetTokens}.`
      : undefined,
    estimatedTokens > input.contextWindowTokens
      ? `Prompt estimate ${estimatedTokens} tokens exceeds model context ${input.contextWindowTokens}.`
      : undefined
  ].filter((warning) => warning !== undefined);

  return {
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    targetTokens: input.targetTokens,
    estimatedTokens,
    remainingTokens,
    layers: input.layers.map(({ name, chars, estimatedTokens, cacheable, truncated, compressed, protected: protectedLayer, priority, cacheKey, cacheStatus }) => ({
      name,
      chars,
      estimatedTokens,
      cacheable,
      truncated,
      compressed,
      protected: protectedLayer,
      priority,
      cacheKey,
      cacheStatus: cacheStatus ?? (cacheable ? "miss" : "uncacheable")
    })),
    compressedLayers: input.layers
      .filter((layer) => layer.compressed)
      .map((layer) => layer.name),
    cache: {
      hits: input.layers.filter((layer) => layer.cacheStatus === "hit").length,
      misses: input.layers.filter((layer) => layer.cacheStatus === "miss").length,
      uncacheable: input.layers.filter((layer) => layer.cacheStatus === "uncacheable").length
    },
    warnings
  };
}

function mergeBudgetWarnings(primary: PromptBudgetReport, secondary: PromptBudgetReport): PromptBudgetReport {
  return {
    ...primary,
    warnings: [...new Set([...secondary.warnings, ...primary.warnings])]
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function defaultIdentity(): string {
  return [
    "You are EstaCoda, a proactive autonomous agent.",
    "Describe yourself as an agent, never as an assistant, AI assistant, or code assistant.",
    "Be proactive, concise, and capability-first. If the workspace is trusted, proceed with normal local work instead of asking unnecessary permission questions.",
    "Use the routed intent, selected skill, loaded context, and tool results below to answer the user.",
    "If native tools are available, call only the provided tool names. EstaCoda will map provider-safe tool names back to internal tools.",
    "If a tool already prepared the next step, explain what you are doing next rather than asking the user to repeat instructions."
  ].join("\n");
}

function renderFrozenMemory(memory: ProviderPromptInput["frozenMemory"]): string {
  const user = memory?.user?.trim();
  const project = memory?.memory?.trim();

  if (!user && !project) {
    return "Frozen memory snapshot: no USER.md or MEMORY.md content loaded for this session.";
  }

  return [
    "Frozen memory snapshot:",
    user ? `§ USER.md\n${truncate(user, 2_000)}` : undefined,
    project ? `§ MEMORY.md\n${truncate(project, 3_000)}` : undefined
  ].filter((line) => line !== undefined).join("\n\n");
}

function renderSkillsIndex(skills: SkillCatalogEntry[] | undefined): string {
  if (skills === undefined || skills.length === 0) {
    return "Skills index: no skills loaded.";
  }

  const grouped = new Map<string, SkillCatalogEntry[]>();
  for (const skill of skills) {
    const category = skill.category || "general";
    grouped.set(category, [...(grouped.get(category) ?? []), skill]);
  }

  return [
    "Compact skills index:",
    ...[...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, entries]) =>
        `${category}: ${entries
          .slice(0, 8)
          .map((skill) => `${skill.name} (${skill.requiredToolsets.join(",") || "no-tools"})`)
          .join(", ")}`
      )
  ].join("\n");
}

function cacheKey(name: PromptLayerName, content: string): string {
  return `${name}:${hashString(content)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function renderSessionHistory(messages: Array<Pick<ProviderMessage, "role" | "content">> | undefined): string {
  if (messages === undefined || messages.length === 0) {
    return "Session history: no prior turns loaded.";
  }

  return [
    "Session history:",
    ...messages.slice(-8).map((message) => `${message.role}: ${truncate(message.content, 900)}`)
  ].join("\n");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function renderArtifactSummary(artifacts: ArtifactRecord[]): string {
  if (artifacts.length === 0) {
    return "No artifacts have been recorded yet.";
  }

  return artifacts
    .map((artifact) => [
      `- ${artifact.path}`,
      `  id: ${artifact.id}`,
      `  kind: ${artifact.kind}`,
      `  size: ${formatBytes(artifact.bytes)}`,
      artifact.mimeType === undefined ? undefined : `  mime: ${artifact.mimeType}`,
      artifact.summary === undefined ? undefined : `  summary: ${artifact.summary}`
    ].filter((line) => line !== undefined).join("\n"))
    .join("\n");
}

function artifactsFromExecutions(executions: ToolExecutionRecord[]): ArtifactRecord[] {
  const seen = new Set<string>();
  const artifacts: ArtifactRecord[] = [];

  for (const execution of executions) {
    const artifact = artifactFromExecution(execution);
    if (artifact === undefined || seen.has(artifact.id)) {
      continue;
    }

    seen.add(artifact.id);
    artifacts.push(artifact);
  }

  return artifacts;
}

function artifactFromExecution(execution: ToolExecutionRecord): ArtifactRecord | undefined {
  const metadata = execution.result?.metadata;

  if (!isArtifactRecord(metadata)) {
    return undefined;
  }

  return metadata;
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ArtifactRecord>;
  return typeof candidate.id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.bytes === "number" &&
    typeof candidate.createdAt === "string";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  }

  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(bytes >= 10_000 ? 0 : 1)} KB`;
  }

  return `${bytes} B`;
}
