import { loadRuntimeConfig } from "../config/runtime-config.js";
import { canRunInteractive, createReadlinePrompt, type Prompt } from "./readline-prompt.js";
import type { UiLocale } from "../contracts/ui.js";
import { collectSetupRoute, type SetupRouteDecision } from "../onboarding/setup-router.js";

export type LaunchOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
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

  const setupRoute = await collectSetupRoute({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId
  });
  const currentLocale = await loadLaunchLocale(options);

  if (setupRoute.state.kind === "configured-degraded") {
    const prompt = options.prompt ?? createReadlinePrompt();
    const answer = await prompt(`${setupRoute.summary}\nContinue in limited mode? [y/N]: `);
    if (options.prompt === undefined) {
      prompt.close?.();
    }
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      return {
        launched: false,
        onboardingTriggered: false,
        output: "Launch skipped. Run `estacoda setup --interactive` to review or repair setup.",
        exitCode: 0,
        locale: currentLocale
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

  if (setupRoute.state.kind === "untrusted-workspace") {
    return {
      launched: false,
      onboardingTriggered: false,
      output: "Workspace trust is required before launch. Run `estacoda setup --interactive` to review trust repair.",
      exitCode: 1,
      locale: currentLocale
    };
  }

  if (!canLaunchWithoutSetup(setupRoute)) {
    const prompt = options.prompt ?? createReadlinePrompt();
    const answer = await prompt(`${setupRoute.summary}\nRun setup now? [Y/n]: `);
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

    return {
      launched: false,
      onboardingTriggered: false,
      output: "Setup is incomplete. Run `estacoda setup --interactive` to review, apply, verify, and then launch.",
      exitCode: 0,
      locale: currentLocale
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

function canLaunchWithoutSetup(decision: SetupRouteDecision): boolean {
  return decision.state.kind === "configured-ready";
}

async function loadLaunchLocale(options: LaunchOptions): Promise<UiLocale> {
  try {
    const config = await loadRuntimeConfig({
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      profileId: options.profileId
    });
    return config.ui.language === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}
