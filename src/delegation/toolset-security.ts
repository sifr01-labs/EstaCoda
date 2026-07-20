import type { DelegationConfig, DelegateRole } from "../contracts/delegation.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export type ChildToolStripReason =
  | "not-parent-visible"
  | "blocked-exact-name"
  | "blocked-prefix"
  | "disallowed-risk-class"
  | "excluded-toolset"
  | "outside-requested-allowed-tools"
  | "outside-requested-allowed-toolsets"
  | "unknown-unclassified-mcp-like-tool"
  | "leaf-delegation-disabled"
  | "spawn-depth-exceeded";

export type ChildToolDiagnostic = {
  name: string;
  reasons: ChildToolStripReason[];
  toolsets?: ToolsetName[];
  riskClass?: string;
};

export type ChildToolAccessRequest = {
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  role: DelegateRole;
  depth: number;
};

export type ChildToolAccessResult = {
  effectiveAllowedTools: string[];
  effectiveAllowedToolsets: ToolsetName[];
  strippedTools: ChildToolDiagnostic[];
  blockedTools: ChildToolDiagnostic[];
  rejectedRequestedTools: ChildToolDiagnostic[];
  rejectedRequestedToolsets: Array<{
    name: ToolsetName;
    reasons: ChildToolStripReason[];
  }>;
};

export type ResolveChildToolAccessInput = {
  parentVisibleTools: readonly ToolDefinition[];
  childCandidateTools: readonly ToolDefinition[];
  config: DelegationConfig;
  request: ChildToolAccessRequest;
};

export type ResolveTaskStepToolAccessInput = {
  parentVisibleTools: readonly ToolDefinition[];
  childCandidateTools: readonly ToolDefinition[];
  allowedToolsets: readonly ToolsetName[];
  allowedTools?: readonly string[];
  allowDelegation?: boolean;
};

/**
 * A durable Task Step has already been narrowed by its persisted authority policy.
 * Keep the parent's visibility boundary, but do not apply delegation's read-only
 * defaults a second time. The Task security policy still gates every execution.
 */
export function resolveTaskStepToolAccess(input: ResolveTaskStepToolAccessInput): ChildToolAccessResult {
  const parentByName = new Map(input.parentVisibleTools.map((tool) => [tool.name, tool]));
  const requestedTools = normalizeNames(input.allowedTools);
  const requestedToolsets = normalizeToolsets(input.allowedToolsets);
  const hasRequestedTools = requestedTools.size > 0;
  const allowed: ToolDefinition[] = [];
  const strippedTools: ChildToolDiagnostic[] = [];

  for (const candidate of input.childCandidateTools) {
    const parent = parentByName.get(candidate.name);
    const tool = parent ?? candidate;
    const reasons: ChildToolStripReason[] = [];
    if (parent === undefined) reasons.push("not-parent-visible");
    if (tool.name === "delegate_task" && input.allowDelegation !== true) reasons.push("leaf-delegation-disabled");
    if (hasRequestedTools && !requestedTools.has(tool.name)) reasons.push("outside-requested-allowed-tools");
    if (!tool.toolsets.some((toolset) => requestedToolsets.has(toolset))) {
      reasons.push("outside-requested-allowed-toolsets");
    }
    if (reasons.length === 0) allowed.push(tool);
    else strippedTools.push(diagnostic(tool, uniqueReasons(reasons)));
  }

  const childNames = new Set(input.childCandidateTools.map((tool) => tool.name));
  const rejectedRequestedTools = [...requestedTools]
    .filter((name) => !childNames.has(name) || !parentByName.has(name))
    .sort()
    .map((name) => ({ name, reasons: ["not-parent-visible" as const] }));
  const childToolsets = new Set(input.childCandidateTools.flatMap((tool) => tool.toolsets));
  const parentToolsets = new Set(input.parentVisibleTools.flatMap((tool) => tool.toolsets));
  const rejectedRequestedToolsets = [...requestedToolsets]
    .filter((name) => !childToolsets.has(name) || !parentToolsets.has(name))
    .sort()
    .map((name) => ({ name, reasons: ["not-parent-visible" as const] }));

  return {
    effectiveAllowedTools: allowed.map((tool) => tool.name),
    effectiveAllowedToolsets: sortedToolsets(new Set(allowed.flatMap((tool) => tool.toolsets))),
    strippedTools,
    blockedTools: strippedTools.filter((entry) => entry.reasons.includes("leaf-delegation-disabled")),
    rejectedRequestedTools,
    rejectedRequestedToolsets
  };
}

export function resolveChildToolAccess(input: ResolveChildToolAccessInput): ChildToolAccessResult {
  const parentByName = new Map(input.parentVisibleTools.map((tool) => [tool.name, tool]));
  const explicitAllowedTools = normalizeNames(input.request.allowedTools);
  const explicitAllowedToolsets = normalizeToolsets(input.request.allowedToolsets);
  const hasExplicitAllowedTools = explicitAllowedTools.size > 0;
  const hasExplicitAllowedToolsets = explicitAllowedToolsets.size > 0;
  const allowedTools: ToolDefinition[] = [];
  const strippedTools: ChildToolDiagnostic[] = [];

  for (const candidate of input.childCandidateTools) {
    const parentTool = parentByName.get(candidate.name);
    const tool = parentTool ?? candidate;
    const reasons = stripReasons({
      tool,
      parentVisible: parentTool !== undefined,
      config: input.config,
      request: input.request,
      explicitAllowedTools,
      explicitAllowedToolsets,
      hasExplicitAllowedTools,
      hasExplicitAllowedToolsets
    });

    if (reasons.length === 0) {
      allowedTools.push(tool);
    } else {
      strippedTools.push(diagnostic(tool, reasons));
    }
  }

  const childCandidateNames = new Set(input.childCandidateTools.map((tool) => tool.name));
  const rejectedRequestedTools = [...explicitAllowedTools]
    .filter((name) => !childCandidateNames.has(name) || !parentByName.has(name))
    .sort()
    .map((name) => ({
      name,
      reasons: ["not-parent-visible" as const]
    }));
  const candidateToolsets = new Set(input.childCandidateTools.flatMap((tool) => tool.toolsets));
  const parentToolsets = new Set(input.parentVisibleTools.flatMap((tool) => tool.toolsets));
  const rejectedRequestedToolsets = [...explicitAllowedToolsets]
    .filter((name) => !candidateToolsets.has(name) || !parentToolsets.has(name))
    .sort()
    .map((name) => ({
      name,
      reasons: ["not-parent-visible" as const]
    }));
  const blockedTools = strippedTools.filter((entry) =>
    entry.reasons.some((reason) =>
      reason === "blocked-exact-name" ||
      reason === "blocked-prefix" ||
      reason === "disallowed-risk-class" ||
      reason === "excluded-toolset" ||
      reason === "unknown-unclassified-mcp-like-tool" ||
      reason === "leaf-delegation-disabled" ||
      reason === "spawn-depth-exceeded"
    )
  );

  return {
    effectiveAllowedTools: allowedTools.map((tool) => tool.name),
    effectiveAllowedToolsets: sortedToolsets(new Set(allowedTools.flatMap((tool) => tool.toolsets))),
    strippedTools,
    blockedTools,
    rejectedRequestedTools,
    rejectedRequestedToolsets
  };
}

export function applyChildToolAccessResult(registry: ToolRegistry, result: ChildToolAccessResult): void {
  for (const tool of result.strippedTools) {
    registry.unregister(tool.name);
  }
}

function stripReasons(input: {
  tool: ToolDefinition;
  parentVisible: boolean;
  config: DelegationConfig;
  request: ChildToolAccessRequest;
  explicitAllowedTools: ReadonlySet<string>;
  explicitAllowedToolsets: ReadonlySet<ToolsetName>;
  hasExplicitAllowedTools: boolean;
  hasExplicitAllowedToolsets: boolean;
}): ChildToolStripReason[] {
  const reasons: ChildToolStripReason[] = [];
  const canDelegate = input.request.role === "orchestrator" && input.request.depth < input.config.maxSpawnDepth;
  const delegationToolAllowed = input.tool.name === "delegate_task" && canDelegate;

  if (!input.parentVisible) {
    reasons.push("not-parent-visible");
  }
  if (input.tool.name === "delegate_task") {
    if (!canDelegate) {
      reasons.push(input.request.role === "leaf" ? "leaf-delegation-disabled" : "spawn-depth-exceeded");
    }
  } else if (input.config.blockedToolNames.includes(input.tool.name)) {
    reasons.push("blocked-exact-name");
  }
  if (input.config.blockedToolPrefixes.some((prefix) => input.tool.name.startsWith(prefix))) {
    reasons.push("blocked-prefix");
  }
  if (!delegationToolAllowed && !input.config.defaultAllowedRiskClasses.includes(input.tool.riskClass)) {
    reasons.push("disallowed-risk-class");
  }
  if (input.config.defaultExcludedToolsets.some((toolset) => input.tool.toolsets.includes(toolset))) {
    reasons.push("excluded-toolset");
  }
  if (isMcpLike(input.tool) && !input.tool.toolsets.includes("mcp")) {
    reasons.push("unknown-unclassified-mcp-like-tool");
  }
  if (input.hasExplicitAllowedTools && !input.explicitAllowedTools.has(input.tool.name)) {
    reasons.push("outside-requested-allowed-tools");
  }
  if (
    input.hasExplicitAllowedToolsets &&
    !input.tool.toolsets.some((toolset) => input.explicitAllowedToolsets.has(toolset))
  ) {
    reasons.push("outside-requested-allowed-toolsets");
  }
  if (!input.hasExplicitAllowedTools && !input.hasExplicitAllowedToolsets && input.config.defaultAllowedToolsets.length > 0) {
    const defaultToolsets = new Set(input.config.defaultAllowedToolsets);
    if (!input.tool.toolsets.some((toolset) => defaultToolsets.has(toolset))) {
      reasons.push("outside-requested-allowed-toolsets");
    }
  }

  return uniqueReasons(reasons);
}

function diagnostic(tool: ToolDefinition, reasons: ChildToolStripReason[]): ChildToolDiagnostic {
  return {
    name: tool.name,
    reasons,
    riskClass: tool.riskClass,
    toolsets: [...tool.toolsets].sort()
  };
}

function normalizeNames(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0));
}

function normalizeToolsets(values: readonly ToolsetName[] | undefined): ReadonlySet<ToolsetName> {
  return new Set((values ?? []).map((value) => value.trim()).filter((value): value is ToolsetName => value.length > 0));
}

function uniqueReasons(reasons: ChildToolStripReason[]): ChildToolStripReason[] {
  return [...new Set(reasons)];
}

function sortedToolsets(toolsets: ReadonlySet<ToolsetName>): ToolsetName[] {
  return [...toolsets].sort();
}

function isMcpLike(tool: ToolDefinition): boolean {
  return tool.name.startsWith("mcp.") || tool.name.startsWith("mcp:");
}
