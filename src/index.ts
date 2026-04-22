import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./config/runtime-config.js";
import { runCliCommand } from "./cli/cli.js";
import { canRunInteractive, runInteractiveOnboarding } from "./onboarding/interactive-onboarding.js";
import { getOnboardingStatus } from "./onboarding/onboarding-flow.js";
import { createRuntime } from "./runtime/create-runtime.js";
import { runSessionLoop } from "./cli/session-loop.js";
import { runOneShotPrompt } from "./cli/one-shot.js";
import { kemetBlueTheme } from "./theme/kemet-blue.js";

const argv = process.argv.slice(2);
const workspaceRoot = process.cwd();
let config: LoadedRuntimeConfig = await loadRuntimeConfig({
  workspaceRoot
});

if (argv.length === 0 && canRunInteractive()) {
  const onboarding = await getOnboardingStatus({
    workspaceRoot
  });

  if (onboarding.needed) {
    const result = await runInteractiveOnboarding({
      workspaceRoot,
      theme: kemetBlueTheme,
      continueToSession: true
    });
    console.log(result.output);

    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }

    config = await loadRuntimeConfig({
      workspaceRoot
    });
  }
}

const runtime = await createRuntime({
  theme: kemetBlueTheme,
  model: config.model,
  workspaceRoot,
  providerRegistry: config.providerRegistry,
  credentialPools: config.credentialPools,
  auxiliaryProviders: config.auxiliaryProviders,
  browser: config.browser,
  enableWebNetwork: config.web.enableNetwork,
  webMaxContentChars: config.web.maxContentChars
});

const command = await runCliCommand({
  argv,
  workspaceRoot,
  tools: runtime.tools()
});

if (command.handled) {
  console.log(command.output);
  process.exit(command.exitCode);
}

if (argv.length === 0 && canRunInteractive()) {
  await runSessionLoop({ runtime });
  process.exit(0);
}

const oneShot = await runOneShotPrompt({
  runtime,
  argv
});

if (oneShot.handled) {
  console.log(oneShot.output);
  process.exit(oneShot.exitCode);
}

console.log(runtime.describe());
console.log(`config sources: ${config.sources.join(", ") || "none"}`);
