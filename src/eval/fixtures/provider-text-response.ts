import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../../contracts/provider.js";
import { ProviderExecutor } from "../../providers/provider-executor.js";
import { ProviderRegistry } from "../../providers/provider-registry.js";
import { assertTrue, assertEqual, assertContains, buildResult } from "../eval-runner.js";

export const providerTextResponseCase: EvalCase = {
  id: "provider-text-response",
  name: "Provider returns text without tool calls",
  description: "A fake provider responds with plain text and no tool calls.",
  tags: ["provider", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const registry = new ProviderRegistry();
    registry.register(createFakeTextProvider());

    const executor = new ProviderExecutor({ registry });
    const result = await executor.complete(
      {
        provider: "fake",
        model: "fake-model",
        messages: [{ role: "user", content: "hello" }]
      },
      { providerOrder: ["fake"] },
      {
        primaryRoute: {
          provider: "fake",
          id: "fake-model",
          profile: {
            id: "fake-model",
            provider: "fake",
            contextWindowTokens: 4096,
            supportsTools: false,
            supportsVision: false,
            supportsStructuredOutput: false
          }
        }
      }
    );

    const assertions = [
      assertTrue("execution ok", result.ok === true),
      assertEqual("no tool calls", result.toolCalls.length, 0),
      assertContains("response content", result.response?.content ?? "", "hello back"),
      assertEqual("provider id", result.response?.provider, "fake")
    ];

    return buildResult(
      "provider-text-response",
      "Provider returns text without tool calls",
      assertions,
      Date.now() - startedAt
    );
  }
};

function createFakeTextProvider(): ProviderAdapter {
  return {
    id: "fake",
    name: "Fake Provider",
    health: () => ({ available: true }),
    listModels: () => Promise.resolve([{
      id: "fake-model",
      provider: "fake",
      name: "Fake Model",
      contextWindowTokens: 4096,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: false
    }]),
    complete: async (_request: ProviderRequest): Promise<ProviderResponse> => ({
      ok: true,
      content: "hello back from fake provider",
      model: "fake-model",
      provider: "fake"
    })
  };
}
