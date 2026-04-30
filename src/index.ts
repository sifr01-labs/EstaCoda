import { randomUUID } from "node:crypto";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./config/runtime-config.js";
import { PersistentCliSessionStore } from "./cli/cli-session-store.js";
import { runCliCommand } from "./cli/cli.js";
import type { SessionDB } from "./contracts/session.js";
import { canRunInteractive, createReadlinePrompt, runInteractiveOnboarding } from "./onboarding/interactive-onboarding.js";
import { getOnboardingStatus } from "./onboarding/onboarding-flow.js";
import { createRuntime } from "./runtime/create-runtime.js";
import { runSessionLoop } from "./cli/session-loop.js";
import { runOneShotPrompt } from "./cli/one-shot.js";
import { WorkspaceApprovalController } from "./security/workspace-approval-controller.js";
import { kemetBlueTheme } from "./theme/kemet-blue.js";

const argv = process.argv.slice(2);
let workspaceRoot = process.cwd();
const cliSessionStore = new PersistentCliSessionStore();
const cliApprovalController = new WorkspaceApprovalController();
let config: LoadedRuntimeConfig = await loadRuntimeConfig({
  workspaceRoot
});

if (argv.length === 0 && canRunInteractive()) {
  const onboarding = await getOnboardingStatus({
    workspaceRoot
  });

  if (onboarding.needed) {
    const prompt = createReadlinePrompt();
    const answer = await prompt(`${onboarding.reason}\nRun setup now? [Y/n]: `);
    prompt.close?.();
    if (answer.trim().length > 0 && !["y", "yes"].includes(answer.trim().toLowerCase())) {
      console.log("Setup skipped. Run `estacoda setup` when you are ready.");
      process.exit(0);
    }
    const result = await runInteractiveOnboarding({
      workspaceRoot,
      theme: kemetBlueTheme,
      continueToSession: true
    });
    console.log(result.output);

    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }

    if (result.workspaceRoot !== undefined) {
      workspaceRoot = result.workspaceRoot;
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
    externalSkillRoots: latestConfig.skills.externalDirs,
    skillAutonomy: latestConfig.skills.autonomy,
    skillConfig: latestConfig.skills.config,
    ui: latestConfig.ui,
    agentProfile: latestConfig.profile,
    providerRegistry: latestConfig.providerRegistry,
    credentialPools: latestConfig.credentialPools,
    auxiliaryProviders: latestConfig.auxiliaryProviders,
    mcpServers: latestConfig.mcp.servers,
    browser: latestConfig.browser,
    imageGen: latestConfig.imageGen,
    tts: latestConfig.tts,
    stt: latestConfig.stt,
    telegramReady: latestConfig.channels.telegram.ready,
    enableWebNetwork: latestConfig.web.enableNetwork,
    webMaxContentChars: latestConfig.web.maxContentChars,
    securityMode: latestConfig.security.approvalMode,
    securityAssessor: latestConfig.security.assessor,
    approvalController: cliApprovalController
  });
}

if (argv[0] === "acp") {
  const acpCommand = await runCliCommand({
    argv,
    workspaceRoot
  });

  if (acpCommand.handled) {
    if (acpCommand.output.length > 0) {
      console.log(acpCommand.output);
    }
    process.exit(acpCommand.exitCode);
  }
}

const runtime = await buildRuntime({
  sessionId: await cliSessionStore.getSessionId(workspaceRoot)
});
await cliSessionStore.setSessionId(workspaceRoot, runtime.sessionId);

const command = await runCliCommand({
  argv,
  workspaceRoot,
  tools: runtime.tools(),
  runtime
});

if (command.handled) {
  console.log(command.output);
  await runtime.dispose();
  process.exit(command.exitCode);
}

if (argv.length === 0 && canRunInteractive()) {
  await runSessionLoop({
    runtime,
    workspaceRoot,
    refreshRuntime: async (options) => {
      const nextRuntime = await buildRuntime({
        sessionId: options?.preserveSession === true ? runtime.sessionId : randomUUID(),
        sessionDb: runtime.sessionDb
      });
      await cliSessionStore.setSessionId(workspaceRoot, nextRuntime.sessionId);
      return nextRuntime;
    },
    switchRuntime: async (sessionId) => {
      const nextRuntime = await buildRuntime({
        sessionId,
        sessionDb: runtime.sessionDb
      });
      await cliSessionStore.setSessionId(workspaceRoot, nextRuntime.sessionId);
      return nextRuntime;
    }
  });
  await runtime.dispose();
  process.exit(0);
}

const oneShot = await runOneShotPrompt({
  runtime,
  argv
});

if (oneShot.handled) {
  console.log(oneShot.output);
  await runtime.dispose();
  process.exit(oneShot.exitCode);
}

console.log(runtime.describe());
console.log(`config sources: ${config.sources.join(", ") || "none"}`);
await runtime.dispose();
