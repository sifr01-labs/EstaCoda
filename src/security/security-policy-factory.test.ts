import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import type { SecurityAssessorRuntimeConfig } from "./security-policy-factory.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "./workspace-approval-controller.js";

function createMockExecutor(ok = true, content = JSON.stringify({ decision: "allow", risk: "low", reason: "test", confidence: 0.9 })) {
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

    it("bypasses non-hardline destructive command handling in docker", async () => {
      const policy = createSecurityPolicyForMode("adaptive");
      const result = await policy.assess!({
        ...baseRequest,
        command: "sudo apt update",
        environmentType: "docker"
      });

      expect(result.decision).toBe("allow");
      expect(result.deterministicRule).toBe("non-host-command-bypass");
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
        command: "sudo apt update",
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
    it("uses security.assessor.provider/model override when set", async () => {
      const executor = createMockExecutor();
      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        provider: "openai",
        model: "gpt-4o",
        timeoutMs: 5000,
        providerExecutor: executor
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      await policy.assess!(baseRequest);

      expect(executor.complete).toHaveBeenCalledTimes(1);
      const [request, preferences, executionOptions] = (executor.complete as any).mock.calls[0];
      expect(request.model).toBe("gpt-4o");
      expect(preferences!.providerOrder).toBeUndefined();
      expect(executionOptions!.primaryRoute).toBeDefined();
      expect(executionOptions!.primaryRoute.provider).toBe("openai");
      expect(executionOptions!.primaryRoute.id).toBe("gpt-4o");
      expect(executionOptions!.primaryRoute.apiMode).toBe("openai_chat_completions");
      expect(executionOptions!.primaryRoute.baseUrl).toBe("https://api.openai.com/v1");
      expect(executionOptions!.primaryRoute.apiKeyEnv).toBe("OPENAI_API_KEY");
    });

    it("does not synthesize a placeholder route for provider/model overrides without real defaults", async () => {
      const executor = createMockExecutor();
      const assessor: SecurityAssessorRuntimeConfig = {
        enabled: true,
        provider: "nous",
        model: "hermes-4",
        timeoutMs: 5000,
        providerExecutor: executor
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      const result = await policy.assess!(baseRequest);

      expect(executor.complete).not.toHaveBeenCalled();
      expect(result.assessor).toEqual({ used: false, status: "unavailable" });
    });

    it("uses full auxiliaryModels.assessor resolved route when override absent", async () => {
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
        route: resolvedRoute
      };

      const policy = createSecurityPolicyForMode("adaptive", { assessor });
      await policy.assess!(baseRequest);

      expect(executor.complete).toHaveBeenCalledTimes(1);
      const [, preferences, executionOptions] = (executor.complete as any).mock.calls[0];
      expect(executionOptions!.primaryRoute).toEqual(resolvedRoute);
      expect(preferences!.providerOrder).toBeUndefined();
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
        route: resolvedRoute
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
            content: JSON.stringify({ decision: "allow", risk: "low", reason: "fallback", confidence: 0.9 }),
            provider: "openai",
            model: "gpt-4o"
          },
          attempts: [{ provider: "openai", model: "gpt-4o", ok: true, content: "ok" }]
        });

      const policy = createSecurityPolicyForMode("adaptive", {
        assessor: {
          enabled: true,
          provider: "openai",
          model: "gpt-4.1-mini",
          providerExecutor: { complete } as unknown as ProviderExecutor,
          route: assessorRoute,
          mainRoute,
          fallbackToMain: true
        }
      });
      const result = await policy.assess!(baseRequest);

      expect(complete).toHaveBeenCalledTimes(2);
      expect((complete as any).mock.calls[1][2].primaryRoute).toEqual(mainRoute);
      expect(result.assessor?.status).toBe("ok");
      expect(result.assessor?.model).toBe("gpt-4o");
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
          provider: "openai",
          model: "gpt-4.1-mini",
          providerExecutor: { complete } as unknown as ProviderExecutor,
          route: assessorRoute,
          mainRoute,
          fallbackToMain: false
        }
      });
      const result = await policy.assess!(baseRequest);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(result.assessor?.status).toBe("unavailable");
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
          provider: "openai",
          model: "gpt-4.1-mini",
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
