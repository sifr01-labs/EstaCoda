import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { createChildFailClosedSecurityPolicy } from "../runtime/agent-loop-factory.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { writeDelegationDiagnostic } from "./delegation-diagnostics.js";
import { applyChildToolAccessResult, resolveChildToolAccess } from "./toolset-security.js";

const SECURITY_AUDIT_ITEMS = [
  "child-registry-tool-schema-bounds",
  "direct-stripped-tool-execution",
  "leaf-orchestrator-depth",
  "parent-tool-intersection",
  "default-read-only-risk-classes",
  "terminal-run-excluded",
  "memory-session-search-unavailable",
  "skill-config-trust-mutation-unavailable",
  "hardline-fail-closed-approval-policy",
  "parent-abort-stop-cleanup",
  "gateway-active-subagent-queueing",
  "heartbeat-timeout-cleanup",
  "batch-timeout-metadata-preserves-timeout",
  "diagnostics-bounded-redacted-no-full-prompts",
  "child-sessions-excluded-from-recall-search-memory-prompt-packing",
  "gateway-active-turn-stability"
] as const;

describe("delegation MVP security audit checklist", () => {
  it("keeps the audit checklist complete for shipped MVP delegation surfaces", () => {
    expect([...SECURITY_AUDIT_ITEMS].sort()).toEqual([
      "batch-timeout-metadata-preserves-timeout",
      "child-registry-tool-schema-bounds",
      "child-sessions-excluded-from-recall-search-memory-prompt-packing",
      "default-read-only-risk-classes",
      "diagnostics-bounded-redacted-no-full-prompts",
      "direct-stripped-tool-execution",
      "gateway-active-subagent-queueing",
      "gateway-active-turn-stability",
      "hardline-fail-closed-approval-policy",
      "heartbeat-timeout-cleanup",
      "leaf-orchestrator-depth",
      "memory-session-search-unavailable",
      "parent-abort-stop-cleanup",
      "parent-tool-intersection",
      "skill-config-trust-mutation-unavailable",
      "terminal-run-excluded"
    ]);
  });

  it("keeps default child authority read-only after parent intersection and block stripping", () => {
    const parentTools = [
      tool("file.read", "read-only-local", ["files"]),
      tool("web.search", "read-only-network", ["web"]),
      tool("terminal.run", "workspace-write", ["shell-write"]),
      tool("session_search", "read-only-local", ["memory"]),
      tool("memory.read", "read-only-local", ["memory"]),
      tool("skill.evolve", "shared-state-mutation", ["dangerous"]),
      tool("config.set", "shared-state-mutation", ["dangerous"]),
      tool("workspace.trust.grant", "shared-state-mutation", ["dangerous"]),
      tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
    ];
    const childCandidateTools = [
      ...parentTools,
      tool("file.grep", "read-only-local", ["files"])
    ];
    const result = resolveChildToolAccess({
      parentVisibleTools: parentTools,
      childCandidateTools,
      config: DEFAULT_DELEGATION_CONFIG,
      request: { role: "leaf", depth: 1 }
    });
    const effective = new Set(result.effectiveAllowedTools);

    expect(effective.has("file.read")).toBe(true);
    expect(effective.has("web.search")).toBe(true);
    expect(effective.has("file.grep")).toBe(false);
    expect(effective.has("terminal.run")).toBe(false);
    expect(effective.has("session_search")).toBe(false);
    expect(effective.has("memory.read")).toBe(false);
    expect(effective.has("skill.evolve")).toBe(false);
    expect(effective.has("config.set")).toBe(false);
    expect(effective.has("workspace.trust.grant")).toBe(false);
    expect(effective.has("delegate_task")).toBe(false);

    const registry = new ToolRegistry();
    for (const definition of childCandidateTools) {
      registry.register({
        ...definition,
        isAvailable: () => true,
        run: async () => ({ ok: true, content: definition.name })
      });
    }
    applyChildToolAccessResult(registry, result);
    expect(registry.get("terminal.run")).toBeUndefined();
    expect(registry.get("session_search")).toBeUndefined();
    expect(registry.get("file.grep")).toBeUndefined();
  });

  it("keeps delegate_task available only to orchestrators below max depth", () => {
    const delegateTool = tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"]);
    const config = { ...DEFAULT_DELEGATION_CONFIG, maxSpawnDepth: 2 };
    const leaf = resolveChildToolAccess({
      parentVisibleTools: [delegateTool],
      childCandidateTools: [delegateTool],
      config,
      request: { role: "leaf", depth: 1 }
    });
    const orchestrator = resolveChildToolAccess({
      parentVisibleTools: [delegateTool],
      childCandidateTools: [delegateTool],
      config,
      request: { role: "orchestrator", depth: 1 }
    });
    const atLimit = resolveChildToolAccess({
      parentVisibleTools: [delegateTool],
      childCandidateTools: [delegateTool],
      config,
      request: { role: "orchestrator", depth: 2 }
    });

    expect(leaf.effectiveAllowedTools).not.toContain("delegate_task");
    expect(orchestrator.effectiveAllowedTools).toContain("delegate_task");
    expect(atLimit.effectiveAllowedTools).not.toContain("delegate_task");
  });

  it("keeps child approvals fail-closed and independent of asks or grants", async () => {
    const policy = createChildFailClosedSecurityPolicy();
    await expect(policy.assess?.({
      toolName: "terminal.run",
      riskClass: "destructive-local",
      targetSummary: "rm -rf /",
      command: "rm -rf /",
      description: "run terminal command",
      context: { trustedWorkspace: true, targetConversationIsActive: true }
    })).resolves.toMatchObject({ decision: "deny" });

    await expect(policy.assess?.({
      toolName: "file.write",
      riskClass: "workspace-write",
      targetSummary: "write a file",
      description: "write file",
      context: { trustedWorkspace: false, targetConversationIsActive: true }
    })).resolves.toMatchObject({ decision: "deny" });
  });

  it("keeps child runtime suppression and diagnostics bounded by default", async () => {
    expect(DEFAULT_DELEGATION_CONFIG.childRuntime).toEqual({
      memoryRecall: "disabled",
      skillLearning: "disabled",
      sessionCompression: "disabled",
      projectContext: "bounded"
    });
    expect(DEFAULT_DELEGATION_CONFIG.diagnostics).toEqual({
      enabled: true,
      includePromptPreview: false
    });

    const diagnosticsRoot = await mkdtemp(join(tmpdir(), "estacoda-delegation-audit-"));
    try {
      const diagnostic = await writeDelegationDiagnostic({
        diagnosticsRoot,
        config: DEFAULT_DELEGATION_CONFIG.diagnostics,
        reason: "timeout",
        parentSessionId: "parent",
        childSessionId: "child",
        task: "inspect apiKey=sk-test-secret",
        prompt: "full delegated prompt apiKey=sk-test-secret",
        role: "leaf",
        depth: 1,
        effectiveTools: ["file.read"],
        provider: "audit",
        model: "audit-model",
        lastSafeEventSummaries: ["started"]
      });
      expect(diagnostic.path).toBeDefined();
      const payload = await readFile(diagnostic.path!, "utf8");
      expect(payload).toContain("\"reason\": \"timeout\"");
      expect(payload).not.toContain("promptPreview");
      expect(payload).not.toContain("sk-test-secret");
    } finally {
      await rm(diagnosticsRoot, { recursive: true, force: true });
    }
  });
});

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskClass,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1000
  };
}
