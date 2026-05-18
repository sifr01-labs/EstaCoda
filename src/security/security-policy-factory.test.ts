import { describe, it, expect, vi } from "vitest";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import type { SecurityAssessorRuntimeConfig } from "./security-policy-factory.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";

function createMockExecutor(ok = true, content = JSON.stringify({ decision: "allow", risk: "low", reason: "test", confidence: 0.9 })) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    response: ok ? {
      content,
      provider: "openai",
      model: "gpt-4"
    } : undefined
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
