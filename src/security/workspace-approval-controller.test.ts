import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { SecurityPolicy, SecurityRequest } from "../contracts/security.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { assessHardlineFloor } from "./command-safety.js";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore, type SmartApprovalAssessorRuntimeConfig } from "./workspace-approval-controller.js";

const model = {
  id: "assessor-model",
  provider: "local" as const,
  contextWindowTokens: 32_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true
};

const route: ResolvedModelRoute = {
  provider: "local",
  id: "assessor-model",
  profile: model
};

const assessorRoute: ResolvedAuxiliaryRoute = {
  task: "assessor",
  route,
  source: "explicit",
  fallbackToMain: false,
  timeoutMs: 1000,
  diagnostics: []
};

const request: SecurityRequest = {
  toolName: "terminal.run",
  riskClass: "destructive-local",
  targetKey: "terminal.run:cmd=rm -rf ./build",
  targetSummary: "rm -rf ./build",
  command: "rm -rf ./build",
  description: "run terminal command",
  context: {
    trustedWorkspace: true,
    targetConversationIsActive: true
  }
};

function basePolicy(): SecurityPolicy {
  return createSecurityPolicyForMode("adaptive");
}

async function controller() {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-smart-approval-"));
  return new WorkspaceApprovalController({
    store: new WorkspaceApprovalStore({ path: join(directory, "workspace-approvals.json") })
  });
}

function smartApproval(decision: "APPROVE" | "DENY" | "ESCALATE"): SmartApprovalAssessorRuntimeConfig {
  return {
    enabled: true,
    assessorRoute,
    mainRoute: route,
    providerExecutor: { complete: vi.fn() } as unknown as ProviderExecutor,
    scopeKey: "profile-test",
    assessCommandRisk: vi.fn().mockResolvedValue(decision)
  };
}

describe("WorkspaceApprovalController smart approvals", () => {
  it("allows adaptive flagged commands when smart approval returns APPROVE", async () => {
    const approvals = await controller();
    const smart = smartApproval("APPROVE");

    const result = await approvals.assess(basePolicy(), request, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("allow");
    expect(result.deterministicRule).toBe("smart-approval");
    expect(smart.assessCommandRisk).toHaveBeenCalledWith(request.command, expect.objectContaining({
      assessorRoute,
      mainRoute: route,
      scopeKey: "profile-test"
    }));
  });

  it("denies adaptive flagged commands when smart approval returns DENY", async () => {
    const approvals = await controller();
    const smart = smartApproval("DENY");

    const result = await approvals.assess(basePolicy(), request, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("deny");
    expect(result.deterministicRule).toBe("smart-approval");
  });

  it("escalates adaptive flagged commands to manual approval when smart approval returns ESCALATE", async () => {
    const approvals = await controller();
    const smart = smartApproval("ESCALATE");

    const result = await approvals.assess(basePolicy(), request, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("ask");
    expect(result.deterministicRule).toBe("smart-approval-escalated");
  });

  it("does not call smart approval for hardline commands", async () => {
    const approvals = await controller();
    const smart = smartApproval("APPROVE");

    const result = await approvals.assess(basePolicy(), {
      ...request,
      targetKey: "terminal.run:cmd=rm -rf /",
      targetSummary: "rm -rf /",
      command: "rm -rf /"
    }, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("deny");
    expect(result.deterministicRule).toBe("destructive-delete-root-or-broad-path");
    expect(smart.assessCommandRisk).not.toHaveBeenCalled();
  });

  it.each([
    "credential-access",
    "sandbox-escape",
    "spend-money"
  ] as const)("preserves adaptive hard-risk-class denial for %s despite flagged commands", async (riskClass) => {
    const approvals = await controller();
    const smart = smartApproval("APPROVE");

    const result = await approvals.assess(basePolicy(), {
      ...request,
      riskClass,
      targetKey: `terminal.run:${riskClass}`,
      targetSummary: "rm -rf ./build",
      command: "rm -rf ./build"
    }, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("deny");
    expect(result.deterministicRule).not.toBe("smart-approval");
    expect(result.deterministicRule).not.toBe("smart-approval-escalated");
    expect(smart.assessCommandRisk).not.toHaveBeenCalled();
  });

  it("does not call smart approval in strict mode", async () => {
    const approvals = await controller();
    const smart = smartApproval("APPROVE");

    const result = await approvals.assess(createSecurityPolicyForMode("strict"), request, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "strict",
      smartApproval: smart
    });

    expect(result.decision).toBe("ask");
    expect(smart.assessCommandRisk).not.toHaveBeenCalled();
  });

  it("does not call smart approval for open-mode non-host bypass", async () => {
    const approvals = await controller();
    const smart = smartApproval("DENY");

    const result = await approvals.assess(createSecurityPolicyForMode("open"), {
      ...request,
      environmentType: "docker"
    }, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "open",
      smartApproval: smart
    });

    expect(result.decision).toBe("allow");
    expect(result.deterministicRule).toBe("non-host-command-bypass");
    expect(smart.assessCommandRisk).not.toHaveBeenCalled();
  });

  it("fails safe to manual escalation when auxiliary assessment escalates", async () => {
    const approvals = await controller();
    const smart = smartApproval("ESCALATE");

    const result = await approvals.assess(basePolicy(), request, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("ask");
  });

  it("does not call smart approval for unflagged safe commands", async () => {
    const approvals = await controller();
    const smart = smartApproval("DENY");

    const result = await approvals.assess(basePolicy(), {
      ...request,
      riskClass: "workspace-write",
      targetKey: "terminal.run:cmd=pnpm test",
      targetSummary: "pnpm test",
      command: "pnpm test"
    }, {
      workspaceRoot: process.cwd(),
      sessionId: "session",
      mode: "adaptive",
      smartApproval: smart
    });

    expect(result.decision).toBe("allow");
    expect(smart.assessCommandRisk).not.toHaveBeenCalled();
  });

  it("preflights gateway approvals against the hardline floor", async () => {
    const approvals = await controller();

    expect(approvals.preflightGatewayApproval({
      toolName: "terminal.run",
      commandPreview: "rm -rf /",
      commandPayload: "rm -rf /"
    })).toMatchObject({
      decision: "deny",
      deterministicRule: "destructive-delete-root-or-broad-path"
    });

    expect(approvals.preflightGatewayApproval({
      toolName: "terminal.run",
      commandPreview: "sudo apt update",
      commandPayload: "sudo apt update"
    })).toMatchObject({
      decision: "deny",
      deterministicRule: "privilege-escalation"
    });

    expect(approvals.preflightGatewayApproval({
      toolName: "terminal.run",
      commandPreview: "rm -rf ./build",
      commandPayload: "rm -rf ./build"
    })).toBeUndefined();
  });

  it("treats hardBlock existence as non-overridable regardless of severity", async () => {
    const approvals = await controller();
    const highSeverityHardBlock = assessHardlineFloor("sudo apt update");

    expect(highSeverityHardBlock).toMatchObject({
      severity: "high",
      code: "privilege-escalation"
    });
    expect(approvals.preflightGatewayApproval({
      toolName: "terminal.run",
      commandPreview: "sudo apt update",
      commandPayload: "sudo apt update"
    })).toMatchObject({
      decision: "deny",
      deterministicRule: "privilege-escalation"
    });
  });
});
