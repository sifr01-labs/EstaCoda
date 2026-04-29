import type { ProviderId } from "../contracts/provider.js";
import { loadRuntimeConfig, setupProviderConfig, type ProviderSetupInput } from "../config/runtime-config.js";

export type OnboardingStep =
  | {
      id: "welcome";
      title: string;
      body: string;
    }
  | {
      id: "provider";
      title: string;
      body: string;
      options: Array<{
        provider: ProviderId;
        model: string;
        label: string;
      }>;
    }
  | {
      id: "api-key";
      title: string;
      body: string;
      secret: true;
    }
  | {
      id: "ready";
      title: string;
      body: string;
    };

export type OnboardingStatus = {
  needed: boolean;
  reason: string;
  configuredModel?: string;
  sources: string[];
  steps: OnboardingStep[];
};

export type OnboardingOptions = {
  workspaceRoot: string;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
};

export async function getOnboardingStatus(options: OnboardingOptions): Promise<OnboardingStatus> {
  const config = await loadRuntimeConfig(options);
  const configured = config.model.provider !== "unconfigured" && config.model.id !== "unconfigured";

  return {
    needed: !configured,
    reason: configured
      ? "Provider is already configured."
      : "No configured provider/model was found.",
    configuredModel: configured ? `${config.model.provider}/${config.model.id}` : undefined,
    sources: config.sources,
    steps: configured ? [readyStep(`${config.model.provider}/${config.model.id}`)] : defaultOnboardingSteps()
  };
}

export async function completeOnboarding(options: OnboardingOptions & {
  input: ProviderSetupInput;
}): Promise<OnboardingStatus & {
  configPath: string;
  secretPath?: string;
}> {
  const result = await setupProviderConfig({
    ...options,
    input: {
      scope: "user",
      credentialPoolStrategy: "fill_first",
      ...options.input
    }
  });
  const status = await getOnboardingStatus(options);

  return {
    ...status,
    configPath: result.path,
    secretPath: result.secretPath
  };
}

export function defaultOnboardingSteps(): OnboardingStep[] {
  return [
    {
      id: "welcome",
      title: "Welcome to EstaCoda",
      body: "We'll connect one model provider, save a credential reference, and then start the first agent session."
    },
    {
      id: "provider",
      title: "Choose a provider",
      body: "Pick the provider/model you want EstaCoda to use first. You can add fallback providers later.",
      options: [
        { provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat" },
        { provider: "kimi", model: "kimi-k2.5", label: "Kimi K2.5" },
        { provider: "openrouter", model: "qwen/qwen3.6-plus", label: "OpenRouter Qwen 3.6 Plus" },
        { provider: "local", model: "ollama/auto", label: "Local Ollama-compatible" }
      ]
    },
    {
      id: "api-key",
      title: "Connect key",
      body: "Paste the provider API key once. EstaCoda stores an environment-variable reference, not the raw secret.",
      secret: true
    },
    readyStep("selected provider")
  ];
}

function readyStep(model: string): OnboardingStep {
  return {
    id: "ready",
    title: "Ready",
    body: `EstaCoda is configured for ${model}.`
  };
}
