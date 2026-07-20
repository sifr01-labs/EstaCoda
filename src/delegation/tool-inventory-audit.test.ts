import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ModelProfile } from "../contracts/provider.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { resolveChildToolAccess, type ChildToolDiagnostic } from "./toolset-security.js";

const mockModel: ModelProfile = {
  id: "delegation-audit-model",
  provider: "audit",
  contextWindowTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
};

const RESERVED_BLOCKED_TOOL_NAMES = new Set<string>();
const RESERVED_BLOCKED_TOOL_PREFIXES = new Set<string>();

const DANGEROUS_RISK_CLASSES = new Set([
  "workspace-write",
  "external-side-effect",
  "credential-access",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape"
]);

const DANGEROUS_TOOLSETS = new Set<ToolsetName>([
  "shell-write",
  "dangerous",
  "memory",
  "browser",
  "media",
  "mcp"
]);

const DANGEROUS_NAME_PREFIXES = [
  "memory.",
  "skill.",
  "config.",
  "cron",
  "workspace.trust",
  "knowledge.memory."
];

const DANGEROUS_EXACT_NAMES = new Set([
  "delegate_task",
  "execute_code",
  "terminal.run",
  "process.start",
  "process.stop",
  "file.write",
  "file.patch",
  "session_search"
]);

const REQUIRED_IF_REGISTERED_READ_ONLY_TOOLS = [
  "file.read",
  "file.search",
  "file.glob",
  "file.grep",
  "terminal.inspect",
  "process.list",
  "process.logs",
  "web.search",
  "web.extract"
];

describe("delegation child tool inventory audit", () => {
  it("audits real registered tools against the default child policy", async () => {
    const tools = await registeredRuntimeTools();
    const result = resolveChildToolAccess({
      parentVisibleTools: tools,
      childCandidateTools: tools,
      config: DEFAULT_DELEGATION_CONFIG,
      request: { role: "leaf", depth: 1 }
    });
    const effective = new Set(result.effectiveAllowedTools);
    const strippedByName = new Map(result.strippedTools.map((tool) => [tool.name, tool]));
    const violations = tools
      .filter(isDangerousForDefaultChild)
      .filter((tool) => effective.has(tool.name) || !hasDefaultStripReason(strippedByName.get(tool.name)))
      .map(describeTool);

    expect(violations, `dangerous registered tools escaped default child policy:\n${violations.join("\n")}`).toEqual([]);
  });

  it("keeps exact and prefix blocklists attached to real registered tools or explicit reservations", async () => {
    const tools = await registeredRuntimeTools();
    const names = new Set(tools.map((tool) => tool.name));
    const staleExactBlocks = DEFAULT_DELEGATION_CONFIG.blockedToolNames.filter((name) =>
      !names.has(name) && !RESERVED_BLOCKED_TOOL_NAMES.has(name)
    );
    const stalePrefixBlocks = DEFAULT_DELEGATION_CONFIG.blockedToolPrefixes.filter((prefix) =>
      !tools.some((tool) => tool.name.startsWith(prefix)) && !RESERVED_BLOCKED_TOOL_PREFIXES.has(prefix)
    );

    expect(staleExactBlocks, `blockedToolNames no longer match registered tools: ${staleExactBlocks.join(", ")}`).toEqual([]);
    expect(stalePrefixBlocks, `blockedToolPrefixes no longer match registered tools: ${stalePrefixBlocks.join(", ")}`).toEqual([]);
  });

  it("allows useful registered read-only local and network tools by default", async () => {
    const tools = await registeredRuntimeTools();
    const result = resolveChildToolAccess({
      parentVisibleTools: tools,
      childCandidateTools: tools,
      config: DEFAULT_DELEGATION_CONFIG,
      request: { role: "leaf", depth: 1 }
    });
    const registeredNames = new Set(tools.map((tool) => tool.name));
    const effective = new Set(result.effectiveAllowedTools);
    const missingAllowed = REQUIRED_IF_REGISTERED_READ_ONLY_TOOLS.filter((name) =>
      registeredNames.has(name) && !effective.has(name)
    );

    expect(missingAllowed, `registered useful read-only tools were not allowed by default: ${missingAllowed.join(", ")}`).toEqual([]);
  });
});

async function registeredRuntimeTools(): Promise<ToolDefinition[]> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-delegation-tool-audit-"));
  const registry = new ProviderRegistry();
  registry.register({
    id: "audit",
    name: "Audit",
    health: () => ({ available: true }),
    listModels: () => [mockModel],
    complete: async () => ({ ok: true, provider: "audit", model: mockModel.id, content: "" })
  });
  const runtime = await createRuntime({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: mockModel,
    providerRegistry: registry,
    workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId: "delegation-tool-audit",
    sessionDb: await createSQLiteSessionDB({ path: join(workspaceRoot, "sessions.sqlite") })
  });

  try {
    return runtime.tools();
  } finally {
    await runtime.dispose();
  }
}

function isDangerousForDefaultChild(tool: ToolDefinition): boolean {
  return DANGEROUS_RISK_CLASSES.has(tool.riskClass) ||
    tool.toolsets.some((toolset) => DANGEROUS_TOOLSETS.has(toolset)) ||
    DANGEROUS_EXACT_NAMES.has(tool.name) ||
    DANGEROUS_NAME_PREFIXES.some((prefix) => tool.name.startsWith(prefix));
}

function hasDefaultStripReason(tool: ChildToolDiagnostic | undefined): boolean {
  return tool !== undefined && tool.reasons.some((reason) =>
    reason === "blocked-exact-name" ||
    reason === "blocked-prefix" ||
    reason === "disallowed-risk-class" ||
    reason === "excluded-toolset" ||
    reason === "unknown-unclassified-mcp-like-tool" ||
    reason === "leaf-delegation-disabled" ||
    reason === "spawn-depth-exceeded"
  );
}

function describeTool(tool: ToolDefinition): string {
  return `${tool.name} risk=${tool.riskClass} toolsets=${tool.toolsets.join(",")}`;
}
