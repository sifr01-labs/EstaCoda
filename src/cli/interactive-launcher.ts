import { getOnboardingStatus } from "../onboarding/onboarding-flow.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { runInteractiveOnboarding, canRunInteractive, createReadlinePrompt, type Prompt } from "../onboarding/interactive-onboarding.js";
import { kemetBlueTheme } from "../theme/kemet-blue.js";
import type { UiLocale } from "../contracts/ui.js";

export type LaunchOptions = {
  workspaceRoot: string;
  homeDir?: string;
  prompt?: Prompt;
};

export type LaunchResult = {
  launched: boolean;
  onboardingTriggered: boolean;
  output: string;
  exitCode: number;
  workspaceRoot?: string;
  locale?: UiLocale;
};

export async function launchInteractiveSession(options: LaunchOptions): Promise<LaunchResult> {
  if (!canRunInteractive()) {
    return {
      launched: false,
      onboardingTriggered: false,
      output: "Interactive session requires a TTY. Use estacoda <prompt> for one-shot mode.",
      exitCode: 1
    };
  }

  const onboarding = await getOnboardingStatus({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir
  });
  const currentLocale = await loadLaunchLocale(options);

  if (onboarding.needed) {
    const prompt = options.prompt ?? createReadlinePrompt();
    const answer = await prompt(`${onboarding.reason}\nRun setup now? [Y/n]: `);
    if (options.prompt === undefined) {
      prompt.close?.();
    }
    if (answer.trim().length > 0 && !["y", "yes"].includes(answer.trim().toLowerCase())) {
      return {
        launched: false,
        onboardingTriggered: false,
        output: "Setup skipped. Run `estacoda init` to bootstrap state, then `estacoda` when you are ready.",
        exitCode: 0,
        locale: currentLocale
      };
    }

    const result = await runInteractiveOnboarding({
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      prompt: options.prompt,
      theme: kemetBlueTheme,
      continueToSession: true
    });
    const workspaceRoot = result.workspaceRoot ?? options.workspaceRoot;

    return {
      launched: result.exitCode === 0,
      onboardingTriggered: true,
      output: result.output,
      exitCode: result.exitCode,
      workspaceRoot: result.workspaceRoot,
      locale: await loadLaunchLocale({ ...options, workspaceRoot })
    };
  }

  return {
    launched: true,
    onboardingTriggered: false,
    output: "",
    exitCode: 0,
    locale: currentLocale
  };
}

async function loadLaunchLocale(options: LaunchOptions): Promise<UiLocale> {
  const config = await loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir
  });
  return config.ui.language === "ar" ? "ar" : "en";
}
