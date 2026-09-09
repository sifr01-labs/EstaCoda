import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import type { SecurityAssessorRuntimeConfig } from "./security-policy-factory.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "./workspace-approval-controller.js";

function createMockExecutor(ok = true, content = JSON.stringify({ risk_score: 10, reasoning: "Test assessor response.", confidence: "high" })) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    response: ok ? {
      content,
      provider: "openai",
      model: "gpt-4"
    } : undefined,
    attempts: [
      {
        provider: "openai",
        model: "gpt-4",
        ok,
        content: ok ? "ok" : "failed",
        errorClass: ok ? undefined : "server"
      }
    ]
  });
  return {
    complete: fn as unknown as ProviderExecutor["complete"]
  } as unknown as ProviderExecutor;
}

const baseRequest = {
  toolName: "test.tool",
  riskClass: "destructive-local" as const,
  description: "test description",
  context: {
    trustedWorkspace: true,
    activeChannel: "cli" as const,
    targetChannel: "cli" as const,
    targetConversationIsActive: true
  }
};

const localAssessorRoute: ResolvedModelRoute = {
  provider: "local",
  id: "assessor-model",
  profile: {
    id: "assessor-model",
    provider: "local",
    contextWindowTokens: 32_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  }
};

const localMainRoute: ResolvedModelRoute = {
  provider: "local",
  id: "main-model",
  profile: {
    id: "main-model",
    provider: "local",
    contextWindowTokens: 32_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true
  }
};

const localAuxiliaryAssessorRoute: ResolvedAuxiliaryRoute = {
  task: "assessor",
  route: localAssessorRoute,
  source: "explicit",
  fallbackToMain: false,
  timeoutMs: 1000,
  diagnostics: []
};

describe("security policy factory", () => {
  describe("hardline and environment handling", () => {
    it("defaults missing environmentType to host command safety", async () => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        command: "sudo apt update"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("privilege-escalation");
    });

    it("enforces host-only command blocks on host", async () => {
      const policy = createSecurityPolicyForMode("strict");
      const result = await policy.assess!({
        ...baseRequest,
        command: "git reset --hard"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("git-destructive");
    });

    it("does not let a docker label bypass command handling", async () => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        command: "sudo apt update",
        environmentType: "docker"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("privilege-escalation");
    });

    it.each([
      "credential-access",
      "sandbox-escape",
      "spend-money"
    ] as const)("does not let docker bypass adaptive %s denial", async (riskClass) => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        riskClass,
        command: "echo fixture",
        environmentType: "docker"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("hard-risk-class");
    });

    it("does not bypass hardline commands in docker", async () => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        command: "rm -rf /",
        environmentType: "docker"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("destructive-delete-root-or-broad-path");
    });

    it("does not bypass hardline commands in open mode", async () => {
      const policy = createSecurityPolicyForMode("open");
      const result = await policy.assess!({
        ...baseRequest,
        command: "shutdown now"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("self-termination");
    });

    it("preserves safe command behavior", async () => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        riskClass: "workspace-write",
        command: "pnpm exec vitest run src/security/security-policy-factory.test.ts"
      });

      expect(result.decision).toBe("allow");
      expect(result.deterministicRule).toBe("capability-first");
    });

    it("keeps hardline commands above persistent approvals", async () => {
      const directory = await mkdtemp(join(tmpdir(), "estacoda-approval-test-"));
      const controller = new WorkspaceApprovalController({
        store: new WorkspaceApprovalStore({ path: join(directory, "workspace-approvals.json") })
      });
      const policy = createSecurityPolicyForMode("open");
      const request = {
        ...baseRequest,
        toolName: "terminal.run",
        targetKey: "terminal.run:cmd=rm -rf /",
        command: "rm -rf /",
        environmentType: "docker" as const
      };

      await controller.grant({
        workspaceRoot: process.cwd(),
        sessionId: "test-session",
        toolName: request.toolName,
        riskClass: request.riskClass,
        targetKey: request.targetKey,
        scope: "always"
      });

      const result = await controller.assess(policy, request, {
        workspaceRoot: process.cwd(),
        sessionId: "test-session",
        mode: "open"
      });

      expect(result.decision).toBe("deny");
      expect(result.deterministicRule).toBe("destructive-delete-root-or-broad-path");
    });
  });

  describe("assessor routing", () => {
    it("does not execute legacy provider/model assessor construction without a resolved route", async () => {
      const executor = createMockExecutor();
      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        provider: "openai",
        model: "gpt-4o",
        timeoutMs: 5000,
        providerExecutor: executor
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      const result = await policy.assess!(baseRequest);

      expect(executor.complete).not.toHaveBeenCalled();
      expect(result.decision).toBe("ask");
      expect(result.assessor).toEqual({ used: false, status: "unavailable" });
    });

    it("fails safe to manual approval when the resolved assessor route is missing", async () => {
      const executor = createMockExecutor();
      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        providerExecutor: executor,
        auxiliaryRoute: {
          task: "assessor",
          route: undefined,
          source: "disabled",
          fallbackToMain: false,
          diagnostics: ["No assessor route configured"]
        },
        mainRoute: localMainRoute
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      const result = await policy.assess!(baseRequest);

      expect(executor.complete).not.toHaveBeenCalled();
      expect(result.assessor).toEqual({ used: false, status: "unavailable" });
    });

    it("uses full auxiliaryModels.assessor resolved route when present", async () => {
      const executor = createMockExecutor();
      const resolvedRoute: ResolvedModelRoute = {
        provider: "anthropic",
        id: "claude-3-opus",
        profile: {
          id: "claude-3-opus",
          provider: "anthropic",
          contextWindowTokens: 200000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        },
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY"
      };

      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        timeoutMs: 5000,
        providerExecutor: executor,
        auxiliaryRoute: {
          task: "assessor",
          route: resolvedRoute,
          source: "explicit",
          fallbackToMain: false,
          diagnostics: []
        },
        mainRoute: localMainRoute
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      await policy.assess!(baseRequest);

      expect(executor.complete).toHaveBeenCalledTimes(1);
      const [, preferences, executionOptions] = (executor.complete as any).mock.calls[0];
      expect(executionOptions!.primaryRoute).toEqual(resolvedRoute);
      expect(preferences!.providerOrder).toBeUndefined();
      expect((executor.complete as any).mock.calls[0][0].tools).toEqual([]);
    });

    it("preserves route-level baseUrl and apiKeyEnv", async () => {
      const executor = createMockExecutor();
      const resolvedRoute: ResolvedModelRoute = {
        provider: "custom",
        id: "custom-model",
        profile: {
          id: "custom-model",
          provider: "custom",
          contextWindowTokens: 100000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        },
        baseUrl: "https://custom.internal/v1",
        apiKeyEnv: "CUSTOM_KEY"
      };

      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        timeoutMs: 5000,
        providerExecutor: executor,
        auxiliaryRoute: {
          task: "assessor",
          route: resolvedRoute,
          source: "explicit",
          fallbackToMain: false,
          diagnostics: []
        },
        mainRoute: localMainRoute
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      await policy.assess!(baseRequest);

      expect(executor.complete).toHaveBeenCalledTimes(1);
      const [, , executionOptions] = (executor.complete as any).mock.calls[0];
      expect(executionOptions!.primaryRoute).toEqual(resolvedRoute);
      expect(executionOptions!.primaryRoute!.baseUrl).toBe("https://custom.internal/v1");
      expect(executionOptions!.primaryRoute!.apiKeyEnv).toBe("CUSTOM_KEY");
    });

    it("honors fallbackToMain through auxiliary executor", async () => {
      const assessorRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4.1-mini",
        profile: {
          id: "gpt-4.1-mini",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        }
      };
      const mainRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      };
      const complete = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          attempts: [{ provider: "openai", model: "gpt-4.1-mini", ok: false, content: "failed", errorClass: "server" }]
        })
        .mockResolvedValueOnce({
          ok: true,
          response: {
            content: JSON.stringify({ risk_score: 10, reasoning: "Fallback assessor response.", confidence: "high" }),
            provider: "openai",
            model: "gpt-4o"
          },
          attempts: [{ provider: "openai", model: "gpt-4o", ok: true, content: "ok" }]
        });

      const policy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: { complete } as unknown as ProviderExecutor,
          auxiliaryRoute: {
            task: "assessor",
            route: assessorRoute,
            source: "explicit",
            fallbackToMain: true,
            diagnostics: []
          },
          mainRoute
        }
      });
      const result = await policy.assess!(baseRequest);

      expect(complete).toHaveBeenCalledTimes(2);
      expect((complete as any).mock.calls[1][2].primaryRoute).toEqual(mainRoute);
      expect(result.assessor?.status).toBe("ok");
      expect(result.assessor?.model).toBe("gpt-4o");
      expect(result.decision).toBe("allow");
    });

    it("does not fallback when fallbackToMain is false", async () => {
      const assessorRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4.1-mini",
        profile: {
          id: "gpt-4.1-mini",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        }
      };
      const mainRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      };
      const complete = vi.fn().mockResolvedValue({
        ok: false,
        attempts: [{ provider: "openai", model: "gpt-4.1-mini", ok: false, content: "failed", errorClass: "server" }]
      });

      const policy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: { complete } as unknown as ProviderExecutor,
          auxiliaryRoute: {
            task: "assessor",
            route: assessorRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          mainRoute
        }
      });
      const result = await policy.assess!(baseRequest);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(result.assessor?.status).toBe("unavailable");
    });

    it("uses the shared risk_score assessor schema for allow, deny, and malformed output", async () => {
      const lowRiskPolicy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: createMockExecutor(true, JSON.stringify({
            risk_score: 30,
            reasoning: "Low risk command.",
            confidence: "high"
          })),
          auxiliaryRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute
        }
      });
      const highRiskPolicy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: createMockExecutor(true, JSON.stringify({
            risk_score: 61,
            reasoning: "High risk command.",
            confidence: "high"
          })),
          auxiliaryRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute
        }
      });
      const malformedPolicy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: createMockExecutor(true, JSON.stringify({
            decision: "allow",
            risk: "low",
            reason: "obsolete schema",
            confidence: 0.9
          })),
          auxiliaryRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute
        }
      });

      await expect(lowRiskPolicy.assess!(baseRequest)).resolves.toMatchObject({
        decision: "allow",
        assessor: { status: "ok", decision: "allow", risk: "low" }
      });
      await expect(highRiskPolicy.assess!(baseRequest)).resolves.toMatchObject({
        decision: "deny",
        assessor: { status: "ok", decision: "deny", risk: "high" }
      });
      await expect(malformedPolicy.assess!(baseRequest)).resolves.toMatchObject({
        decision: "ask",
        assessor: { status: "malformed" }
      });
    });

    it.each([
      [JSON.stringify({ risk_score: 10, reasoning: "Low risk command.", confidence: "high" }), "allow"],
      [JSON.stringify({ risk_score: 90, reasoning: "High risk command.", confidence: "high" }), "deny"],
      ["not-json", "ask"]
    ] as const)("keeps base policy and controller assessor decisions aligned for %s", async (content, expectedDecision) => {
      const destructiveRequest = {
        ...baseRequest,
        targetKey: "terminal.run:cmd=rm -rf ./local-dir",
        targetSummary: "rm -rf ./local-dir",
        command: "rm -rf ./local-dir"
      };
      const baseExecutor = createMockExecutor(true, content);
      const controllerExecutor = createMockExecutor(true, content);
      const basePolicy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: baseExecutor,
          auxiliaryRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute
        }
      });
      const approvals = new WorkspaceApprovalController({
        store: new WorkspaceApprovalStore({ path: join(await mkdtemp(join(tmpdir(), "estacoda-policy-parity-")), "workspace-approvals.json") })
      });

      const [baseResult, controllerResult] = await Promise.all([
        basePolicy.assess!(destructiveRequest),
        approvals.assess(createSecurityPolicyForMode("adaptive"), destructiveRequest, {
          workspaceRoot: process.cwd(),
          sessionId: "session",
          mode: "adaptive",
          smartApproval: {
            enabled: true,
            assessorRoute: localAuxiliaryAssessorRoute,
            mainRoute: localMainRoute,
            providerExecutor: controllerExecutor,
            scopeKey: "profile-test"
          }
        })
      ]);

      expect(baseResult.decision).toBe(expectedDecision);
      expect(controllerResult.decision).toBe(expectedDecision);
      expect(baseExecutor.complete).toHaveBeenCalledTimes(1);
      expect(controllerExecutor.complete).toHaveBeenCalledTimes(1);
    });

    it("does not call the auxiliary assessor twice when a controller handles an adaptive assessment", async () => {
      const destructiveRequest = {
        ...baseRequest,
        targetKey: "terminal.run:cmd=rm -rf ./local-dir",
        targetSummary: "rm -rf ./local-dir",
        command: "rm -rf ./local-dir"
      };
      const complete = vi.fn().mockResolvedValue({
        ok: true,
        response: {
          content: JSON.stringify({ risk_score: 10, reasoning: "Low risk command.", confidence: "high" }),
          provider: "local",
          model: "assessor-model"
        },
        attempts: [{ provider: "local", model: "assessor-model", ok: true, content: "ok" }]
      });
      const executor = { complete } as unknown as ProviderExecutor;
      const basePolicy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: executor,
          auxiliaryRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute
        }
      });
      const approvals = new WorkspaceApprovalController({
        store: new WorkspaceApprovalStore({ path: join(await mkdtemp(join(tmpdir(), "estacoda-policy-single-call-")), "workspace-approvals.json") })
      });

      const result = await approvals.assess(basePolicy, destructiveRequest, {
        workspaceRoot: process.cwd(),
        sessionId: "session",
        mode: "adaptive",
        smartApproval: {
          enabled: true,
          assessorRoute: localAuxiliaryAssessorRoute,
          mainRoute: localMainRoute,
          providerExecutor: executor,
          scopeKey: "profile-test"
        }
      });

      expect(result.decision).toBe("allow");
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it("passes assessor timeoutMs into auxiliary execution", async () => {
      const route: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4.1-mini",
        profile: {
          id: "gpt-4.1-mini",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        }
      };
      let observedSignal: AbortSignal | undefined;
      const complete = vi.fn((_request, _preferences, options) => {
        observedSignal = options.signal;
        return new Promise(() => {});
      });

      const policy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          providerExecutor: { complete } as unknown as ProviderExecutor,
          auxiliaryRoute: {
            task: "assessor",
            route,
            source: "explicit",
            fallbackToMain: false,
            timeoutMs: 5,
            diagnostics: []
          },
          mainRoute: route
        }
      });
      const result = await policy.assess!(baseRequest);

      expect(result.assessor?.status).toBe("timeout");
      expect(observedSignal?.aborted).toBe(true);
    });

    it("remains disabled when enabled !== true", async () => {
      const executor = createMockExecutor();
      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: false,
        provider: "openai",
        model: "gpt-4",
        timeoutMs: 5000,
        providerExecutor: executor
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      const result = await policy.assess!(baseRequest);

      expect(executor.complete).not.toHaveBeenCalled();
      expect(result.assessor).toEqual({ used: false, status: "disabled" });
    });
  });
});
