import { runCliCommand, type CliCommandResult, type CliOptions } from "./cli.js";
import {
  launchInteractiveSession,
  type LaunchOptions,
  type LaunchResult,
} from "./interactive-launcher.js";
import type { Prompt } from "./prompt-contract.js";
import type { UiLocale } from "../contracts/ui.js";

export type InteractiveStartupOptions = {
  readonly workspaceRoot: string;
  readonly homeDir?: string;
  readonly profileId?: string;
  readonly prompt?: Prompt;
  readonly launch?: (options: LaunchOptions) => Promise<LaunchResult>;
  readonly runSetup?: (options: CliOptions) => Promise<CliCommandResult>;
};

export type SetupStartupOptions = InteractiveStartupOptions & {
  readonly setupArgv?: readonly string[];
  readonly locale?: UiLocale;
};

export type InteractiveStartupResult = {
  readonly launched: boolean;
  readonly output: string;
  readonly exitCode: number;
  readonly workspaceRoot: string;
  readonly locale?: UiLocale;
};

export async function runInteractiveStartup(
  options: InteractiveStartupOptions
): Promise<InteractiveStartupResult> {
  const launch = options.launch ?? launchInteractiveSession;
  const initialDecision = await launch(launchOptions(options, options.workspaceRoot));
  if (initialDecision.kind !== "run-setup") {
    return startupResult(initialDecision);
  }

  return runSetupStartup({
    ...options,
    setupArgv: ["setup", "--interactive"],
    locale: initialDecision.locale,
  });
}

export async function runSetupStartup(
  options: SetupStartupOptions
): Promise<InteractiveStartupResult> {
  const launch = options.launch ?? launchInteractiveSession;
  const dispatchSetup = options.runSetup ?? runCliCommand;
  const setupResult = await dispatchSetup({
    argv: [...(options.setupArgv ?? ["setup", "--interactive"])],
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  });
  if (!setupResult.handled) {
    return {
      launched: false,
      output: joinOutput(setupResult.output, "Interactive setup was not handled."),
      exitCode: 1,
      workspaceRoot: options.workspaceRoot,
      locale: options.locale,
    };
  }
  if (setupResult.exitCode !== 0 || setupResult.launchHandoff === undefined) {
    return {
      launched: false,
      output: setupResult.output,
      exitCode: setupResult.exitCode,
      workspaceRoot: options.workspaceRoot,
      locale: options.locale,
    };
  }

  const handoff = setupResult.launchHandoff;
  const postSetupDecision = await launch(launchOptions(options, handoff.workspaceRoot));
  if (postSetupDecision.kind !== "launch") {
    return {
      launched: false,
      output: joinOutput(
        setupResult.output,
        postSetupDecision.output,
        "Setup completed, but launch readiness changed. Run `estacoda setup --interactive` to review the current state."
      ),
      exitCode: 1,
      workspaceRoot: handoff.workspaceRoot,
      locale: postSetupDecision.locale ?? handoff.locale,
    };
  }

  return {
    launched: true,
    output: joinOutput(setupResult.output, postSetupDecision.output),
    exitCode: 0,
    workspaceRoot: postSetupDecision.workspaceRoot,
    locale: postSetupDecision.locale,
  };
}

function launchOptions(options: InteractiveStartupOptions, workspaceRoot: string): LaunchOptions {
  return {
    workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  };
}

function startupResult(result: Exclude<LaunchResult, { readonly kind: "run-setup" }>): InteractiveStartupResult {
  return {
    launched: result.launched,
    output: result.output,
    exitCode: result.exitCode,
    workspaceRoot: result.workspaceRoot,
    locale: result.locale,
  };
}

function joinOutput(...values: readonly string[]): string {
  return values.filter((value) => value.trim().length > 0).join("\n");
}
