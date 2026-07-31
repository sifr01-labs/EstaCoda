import { loadRuntimeConfig, type LoadedRuntimeConfig } from "../config/runtime-config.js";
import { createInteractivePrompt } from "./create-interactive-prompt.js";
import type { Prompt } from "./prompt-contract.js";
import { canRunInteractive } from "../ui/terminal-capabilities.js";
import type { UiLocale } from "../contracts/ui.js";
import { collectSetupRoute } from "../setup/setup-router.js";

export type LaunchOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  prompt?: Prompt;
  collectSetupRoute?: typeof collectSetupRoute;
  loadRuntimeConfig?: (options: {
    readonly workspaceRoot: string;
    readonly homeDir?: string;
    readonly profileId?: string;
  }) => Promise<LoadedRuntimeConfig>;
};

export type LaunchResult =
  | {
      readonly kind: "launch";
      readonly launched: true;
      readonly output: string;
      readonly exitCode: 0;
      readonly workspaceRoot: string;
      readonly locale: UiLocale;
    }
  | {
      readonly kind: "run-setup";
      readonly launched: false;
      readonly setupMode: "onboarding" | "repair";
      readonly output: string;
      readonly exitCode: 0;
      readonly workspaceRoot: string;
      readonly locale: UiLocale;
    }
  | {
      readonly kind: "exit";
      readonly launched: false;
      readonly output: string;
      readonly exitCode: number;
      readonly workspaceRoot: string;
      readonly locale?: UiLocale;
    };

export async function launchInteractiveSession(options: LaunchOptions): Promise<LaunchResult> {
  if (!canRunInteractive()) {
    return {
      kind: "exit",
      launched: false,
      output: "Interactive session requires a TTY. Use estacoda <prompt> for one-shot mode.",
      exitCode: 1,
      workspaceRoot: options.workspaceRoot,
    };
  }

  const collectRoute = options.collectSetupRoute ?? collectSetupRoute;
  const setupRoute = await collectRoute({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId
  });
  const currentLocale = await loadLaunchLocale(options);

  if (setupRoute.state.kind === "configured-degraded") {
    const prompt = options.prompt ?? createInteractivePrompt();
    const answer = await prompt(`${setupRoute.summary}\nContinue in limited mode? [y/N]: `);
    if (options.prompt === undefined) {
      prompt.close?.();
    }
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      return {
        kind: "exit",
        launched: false,
        output: "Launch skipped. Run `estacoda setup --interactive` to review or repair setup.",
        exitCode: 0,
        workspaceRoot: options.workspaceRoot,
        locale: currentLocale
      };
    }

    return {
      kind: "launch",
      launched: true,
      output: "",
      exitCode: 0,
      workspaceRoot: options.workspaceRoot,
      locale: currentLocale
    };
  }

  if (setupRoute.kind === "first-run-onboarding") {
    return {
      kind: "run-setup",
      launched: false,
      setupMode: "onboarding",
      output: "",
      exitCode: 0,
      workspaceRoot: options.workspaceRoot,
      locale: currentLocale
    };
  }

  if (setupRoute.state.kind !== "configured-ready") {
    return {
      kind: "run-setup",
      launched: false,
      setupMode: "repair",
      output: "",
      exitCode: 0,
      workspaceRoot: options.workspaceRoot,
      locale: currentLocale
    };
  }

  return {
    kind: "launch",
    launched: true,
    output: "",
    exitCode: 0,
    workspaceRoot: options.workspaceRoot,
    locale: currentLocale
  };
}

async function loadLaunchLocale(options: LaunchOptions): Promise<UiLocale> {
  try {
    const loadConfig = options.loadRuntimeConfig ?? loadRuntimeConfig;
    const config = await loadConfig({
      workspaceRoot: options.workspaceRoot,
      homeDir: options.homeDir,
      profileId: options.profileId
    });
    return config.ui.language === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}
