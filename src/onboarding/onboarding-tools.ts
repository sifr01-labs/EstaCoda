import type { RegisteredTool } from "../contracts/tool.js";
import { completeOnboarding, getOnboardingStatus, type OnboardingOptions } from "./onboarding-flow.js";
import type { ProviderSetupInput } from "../config/runtime-config.js";

export function createOnboardingTools(options: OnboardingOptions): RegisteredTool[] {
  return [
    {
      name: "onboarding.status",
      description: "Check whether EstaCoda needs first-run provider onboarding and return the setup steps.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["core"],
      progressLabel: "checking onboarding",
      maxResultSizeChars: 6000,
      isAvailable: () => true,
      run: async () => {
        const status = await getOnboardingStatus(options);

        return {
          ok: true,
          content: renderStatus(status),
          metadata: status
        };
      }
    },
    {
      name: "onboarding.complete",
      description: "Complete first-run provider onboarding by saving provider/model config and credential references.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          baseUrl: { type: "string" },
          apiKeyEnv: { type: "string" },
          apiKey: { type: "string" },
          enableNetwork: { type: "boolean" },
          scope: { type: "string", enum: ["user", "project"] },
          credentialPoolStrategy: { type: "string" }
        },
        required: ["provider", "model"]
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "finishing onboarding",
      maxResultSizeChars: 6000,
      isAvailable: () => true,
      run: async (input: ProviderSetupInput) => {
        const result = await completeOnboarding({
          ...options,
          input
        });

        return {
          ok: !result.needed,
          content: [
            result.reason,
            `Config: ${result.configPath}`,
            result.secretPath === undefined ? undefined : `Secret store: ${result.secretPath}`
          ].filter((line) => line !== undefined).join("\n"),
          metadata: result
        };
      }
    }
  ];
}

function renderStatus(status: Awaited<ReturnType<typeof getOnboardingStatus>>): string {
  return [
    `Onboarding needed: ${status.needed ? "yes" : "no"}`,
    `Reason: ${status.reason}`,
    `Config sources: ${status.sources.join(", ") || "none"}`,
    ...status.steps.map((step, index) => `${index + 1}. ${step.title} — ${step.body}`)
  ].join("\n");
}
