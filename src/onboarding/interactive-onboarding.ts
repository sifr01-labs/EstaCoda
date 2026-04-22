import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Writable, Readable } from "node:stream";
import { defaultEnvKey, loadRuntimeConfig } from "../config/runtime-config.js";
import { diagnoseProviderConfig, renderProviderDiagnostic } from "../config/provider-diagnostics.js";
import type { ThemeDefinition } from "../contracts/theme.js";
import { kemetBlueTheme } from "../theme/kemet-blue.js";
import { completeOnboarding, defaultOnboardingSteps, getOnboardingStatus, type OnboardingOptions } from "./onboarding-flow.js";

export type Prompt = ((question: string, options?: { secret?: boolean }) => Promise<string>) & {
  close?: () => void;
};

export type InteractiveOnboardingResult = {
  completed: boolean;
  output: string;
  exitCode: number;
};

export async function runInteractiveOnboarding(options: OnboardingOptions & {
  prompt?: Prompt;
  theme?: ThemeDefinition;
  continueToSession?: boolean;
}): Promise<InteractiveOnboardingResult> {
  const status = await getOnboardingStatus(options);
  const theme = options.theme ?? kemetBlueTheme;

  if (!status.needed) {
    return {
      completed: true,
      exitCode: 0,
      output: `EstaCoda is already configured for ${status.configuredModel}.`
    };
  }

  const prompt = options.prompt ?? createReadlinePrompt();
  const providerStep = defaultOnboardingSteps().find((step) => step.id === "provider");
  const welcomeStep = defaultOnboardingSteps().find((step) => step.id === "welcome");

  if (providerStep === undefined) {
    return {
      completed: false,
      exitCode: 1,
      output: "Onboarding provider step is unavailable."
    };
  }

  try {
    await prompt(`${renderWelcome({ theme, body: welcomeStep?.body ?? providerStep.body })}\nPress Enter to begin... `);

    const selectedRaw = await prompt(`${renderProviderPicker({ providerStep })}\nChoose provider [1-${providerStep.options.length}, default 1]: `);
    const parsedIndex = Number.parseInt(selectedRaw, 10) - 1;
    const selectedIndex = Number.isFinite(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0;
    const selected = providerStep.options[selectedIndex] ?? providerStep.options[0];
    const envName = selected.provider === "local"
      ? undefined
      : await prompt(`Environment variable for ${selected.label} API key [${defaultEnvKey(selected.provider)}]: `);
    const apiKey = selected.provider === "local"
      ? undefined
      : await prompt("Paste API key now, or press Enter if it is already in your shell environment: ", { secret: true });
    const normalizedEnvName = envName?.trim() === "" || envName === undefined
      ? selected.provider === "local" ? undefined : defaultEnvKey(selected.provider)
      : envName.trim();
    const reviewLines = renderReview({
      provider: selected.provider,
      model: selected.model,
      credential: normalizedEnvName === undefined
        ? "local provider, no hosted API key"
        : apiKey?.trim() === "" || apiKey === undefined
          ? `from ${normalizedEnvName}`
          : `save reference to ${normalizedEnvName}; show shell export once`
    });
    await prompt(`${reviewLines}\nPress Enter to save this setup... `);
    const result = await completeOnboarding({
      ...options,
      input: {
        provider: selected.provider,
        model: selected.model,
        apiKey: apiKey?.trim() === "" ? undefined : apiKey,
        apiKeyEnv: normalizedEnvName,
        enableNetwork: selected.provider !== "local"
      }
    });
    const loaded = await loadRuntimeConfig(options);
    const diagnostic = await diagnoseProviderConfig(loaded);
    const sessionLine = options.continueToSession === true
      ? "Starting your first EstaCoda agent session now."
      : "Next: run estacoda";

    return {
      completed: !result.needed,
      exitCode: result.needed ? 1 : 0,
      output: [
        "Setup complete.",
        `Configured: ${formatProviderModel(selected.provider, selected.model)}`,
        `Config: ${result.configPath}`,
        result.envExport === undefined ? undefined : `Add this to your shell config:\n${result.envExport}`,
        result.envExport === undefined && normalizedEnvName !== undefined
          ? `Using credential from ${normalizedEnvName}.`
          : undefined,
        "",
        "Setup check",
        renderProviderDiagnostic(diagnostic),
        sessionLine
      ].filter((line) => line !== undefined).join("\n")
    };
  } finally {
    prompt.close?.();
  }
}

export function createReadlinePrompt(input: Readable = defaultInput, output: Writable = defaultOutput): Prompt {
  const readline = createInterface({
    input,
    output
  });

  return Object.assign(
    async (question: string) => readline.question(question),
    {
      close: () => readline.close()
    }
  );
}

export function canRunInteractive(input: NodeJS.ReadStream = defaultInput): boolean {
  return input.isTTY === true;
}

function formatProviderModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function renderWelcome(input: {
  theme: ThemeDefinition;
  body: string;
}): string {
  const brand = input.theme.branding;
  const rule = "─".repeat(64);

  return [
    `${brand.responseLabel} first-run setup`,
    brand.taglinePrimary,
    brand.taglineSecondary,
    rule,
    "",
    "Welcome. We’ll get three things in place:",
    "1. Pick the first model route.",
    "2. Connect a hosted key or use a local model.",
    "3. Save a clean config reference and enter the agent session.",
    "",
    input.body
  ].join("\n");
}

function renderProviderPicker(input: {
  providerStep: Extract<ReturnType<typeof defaultOnboardingSteps>[number], { id: "provider" }>;
}): string {
  return [
    input.providerStep.title,
    input.providerStep.body,
    "",
    ...input.providerStep.options.map((option, index) => {
      const credential = option.provider === "local" ? "no API key" : `${defaultEnvKey(option.provider)}`;
      return `${index + 1}. ${option.label.padEnd(26)} ${formatProviderModel(option.provider, option.model)} (${credential})`;
    })
  ].join("\n");
}

function renderReview(input: {
  provider: string;
  model: string;
  credential: string;
}): string {
  return [
    "Review setup",
    `Provider:   ${input.provider}`,
    `Model:      ${input.model}`,
    `Credential: ${input.credential}`,
    "",
    "EstaCoda stores configuration and credential references, not raw hosted API keys."
  ].join("\n");
}
