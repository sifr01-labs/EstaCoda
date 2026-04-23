import { randomUUID } from "node:crypto";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./config/runtime-config.js";
import { runCliCommand } from "./cli/cli.js";
import type { SessionDB } from "./contracts/session.js";
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

async function buildRuntime(input: {
  sessionId?: string;
  sessionDb?: SessionDB;
} = {}) {
  const latestConfig = await loadRuntimeConfig({
    workspaceRoot
  });

  return createRuntime({
    theme: kemetBlueTheme,
    model: latestConfig.model,
    workspaceRoot,
    sessionId: input.sessionId,
    sessionDb: input.sessionDb,
    providerRegistry: latestConfig.providerRegistry,
    credentialPools: latestConfig.credentialPools,
    auxiliaryProviders: latestConfig.auxiliaryProviders,
    browser: latestConfig.browser,
    enableWebNetwork: latestConfig.web.enableNetwork,
    webMaxContentChars: latestConfig.web.maxContentChars
  });
}

const runtime = await buildRuntime();

const command = await runCliCommand({
  argv,
  workspaceRoot,
  tools: runtime.tools(),
  runtime
});

if (command.handled) {
  console.log(command.output);
  process.exit(command.exitCode);
}

if (argv.length === 0 && canRunInteractive()) {
  await runSessionLoop({
    runtime,
    refreshRuntime: async () => buildRuntime({
      sessionId: randomUUID(),
      sessionDb: runtime.sessionDb
    })
  });
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
